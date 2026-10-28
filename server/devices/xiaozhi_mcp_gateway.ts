import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

const PREFIX = '/api/devices/xiaozhi';
export type XiaozhiGatewayKind = 'device' | 'mcp';
export interface XiaozhiPrivateBinding {
  id: string; ownerUid: string; deviceId: string; clientId: string | null; publicBaseUrl: string;
  createdAt: number; pairingExpiresAt: number; pairedAt: number | null;
  bootstrapSecret: string; deviceSecret: string; bridgeSecret: string;
}
export interface XiaozhiDeviceStatus {
  id: string; ownerUid: string; deviceId: string; clientId: string | null;
  state: 'pending' | 'expired' | 'active'; connected: boolean; observedAt: string;
  pairingExpiresAt: string; pairedAt: string | null; audioSupported: false;
}
export interface XiaozhiGatewayOptions {
  localBaseUrl: string;
  bindings?: XiaozhiPrivateBinding[];
  onBindingsChanged?: (bindings: XiaozhiPrivateBinding[]) => void;
  onDeviceReady?: (status: XiaozhiDeviceStatus) => void | Promise<void>;
  onDeviceDisconnected?: (status: XiaozhiDeviceStatus) => void | Promise<void>;
  onLifecycleError?: (operation: 'device_ready' | 'device_disconnected', error: unknown) => void;
  requestTimeoutMs?: number;
  now?: () => number;
}
export interface XiaozhiDeviceCredentials { token: string; deviceId: string; clientId?: string }
type JsonObject = Record<string, any>;
type Pending = { client: WebSocket; originalId: string | number; timer: ReturnType<typeof setTimeout> };
type Session = { socket: WebSocket; ready: boolean; sessionId: string; pending: Map<number, Pending>; nextId: number; helloTimer: ReturnType<typeof setTimeout> };
type BindingRuntime = { binding: XiaozhiPrivateBinding; session?: Session; clients: Set<WebSocket> };

export class XiaozhiGatewayError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = () => randomBytes(32).toString('hex');
const textId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
function sameSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function origin(value: string, local: boolean): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('A plain HTTP origin is required.');
  if (local && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('The MCP bridge must use a loopback origin.');
  if (['0.0.0.0', '[::]'].includes(url.hostname)) throw new Error('Use the actual listening interface address.');
  return url.origin;
}
function endpoint(base: string, kind: string, id: string, token?: string): string {
  const url = new URL(`${PREFIX}/${kind}/${id}`, base);
  if (kind !== 'bootstrap') url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) url.searchParams.set('token', token);
  return url.href;
}
function send(socket: WebSocket, value: JsonObject) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function rpcError(client: WebSocket, id: string | number, code: number, message: string) {
  send(client, { jsonrpc: '2.0', id, error: { code, message } });
}
function parse(data: RawData): JsonObject | null {
  try { const value = JSON.parse(data.toString()); return object(value) ? value : null; } catch { return null; }
}
function validRpc(value: JsonObject): boolean { return JSONRPCMessageSchema.safeParse(value).success; }

/** Device-side Xiaozhi protocol to standard local MCP; no model, audio engine, listener or device configuration writes. */
export class XiaozhiMcpGateway {
  private readonly runtimes = new Map<string, BindingRuntime>();
  private readonly websocketServers = new Set<WebSocketServer>();
  private readonly detachers = new Set<() => void>();
  private readonly localBaseUrl: string;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private closed = false;

  constructor(private readonly options: XiaozhiGatewayOptions) {
    this.localBaseUrl = origin(options.localBaseUrl, true);
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 300000) throw new Error('Invalid MCP request timeout.');
    for (const value of options.bindings ?? []) {
      if (!object(value) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || !textId(value.ownerUid) || !textId(value.deviceId)
        || !(value.clientId === null || textId(value.clientId)) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.pairingExpiresAt)
        || !(value.pairedAt === null || Number.isFinite(value.pairedAt)) || ![value.bootstrapSecret, value.deviceSecret, value.bridgeSecret].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))
        || this.runtimes.has(value.id)) throw new Error('Invalid private device binding.');
      const binding = { ...value, publicBaseUrl: origin(value.publicBaseUrl, false) };
      this.runtimes.set(binding.id, { binding, clients: new Set() });
    }
  }

  createPairing(input: { ownerUid: string; deviceId: string; clientId?: string; publicBaseUrl: string; pairingTtlMs?: number }) {
    if (this.closed) throw new XiaozhiGatewayError(503, 'Device gateway is closed.');
    if (!textId(input.ownerUid) || !textId(input.deviceId) || (input.clientId !== undefined && !textId(input.clientId))) throw new XiaozhiGatewayError(400, 'An owner and known device identity are required.');
    const ttl = input.pairingTtlMs ?? 300000;
    if (!Number.isFinite(ttl) || ttl < 1000 || ttl > 1800000) throw new XiaozhiGatewayError(400, 'Invalid pairing window.');
    const createdAt = this.now();
    const binding: XiaozhiPrivateBinding = { id: randomUUID(), ownerUid: input.ownerUid, deviceId: input.deviceId.toLowerCase(), clientId: input.clientId ?? null,
      publicBaseUrl: origin(input.publicBaseUrl, false), createdAt, pairingExpiresAt: createdAt + ttl, pairedAt: null,
      bootstrapSecret: secret(), deviceSecret: secret(), bridgeSecret: secret() };
    this.runtimes.set(binding.id, { binding, clients: new Set() });
    try { this.persist(); } catch (error) { this.runtimes.delete(binding.id); throw error; }
    return this.getPairingConfiguration(binding.id, binding.ownerUid);
  }

  /** Private persistence only: callers must never publish these records through an ordinary GET or model/tool output. */
  getPrivateBindings(): XiaozhiPrivateBinding[] { return structuredClone([...this.runtimes.values()].map(value => value.binding)); }
  private persist() { this.options.onBindingsChanged?.(this.getPrivateBindings()); }
  private notify(operation: 'device_ready' | 'device_disconnected', status: XiaozhiDeviceStatus) {
    const callback = operation === 'device_ready' ? this.options.onDeviceReady : this.options.onDeviceDisconnected;
    const report = (error: unknown) => { try { this.options.onLifecycleError?.(operation, error); } catch {} };
    try { Promise.resolve(callback?.(status)).catch(report); }
    catch (error) { report(error); }
  }
  private owned(id: string, ownerUid: string): BindingRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.binding.ownerUid !== ownerUid) throw new XiaozhiGatewayError(404, 'Device binding not found.');
    return runtime;
  }
  getMcpUrl(id: string, ownerUid: string): string { return endpoint(this.localBaseUrl, 'mcp', this.owned(id, ownerUid).binding.id, this.owned(id, ownerUid).binding.bridgeSecret); }
  getPairingConfiguration(id: string, ownerUid: string) {
    const { binding } = this.owned(id, ownerUid);
    return { id, expiresAt: new Date(binding.pairingExpiresAt).toISOString(), otaUrl: endpoint(binding.publicBaseUrl, 'bootstrap', id, binding.bootstrapSecret), mcpUrl: this.getMcpUrl(id, ownerUid) };
  }
  publicStatus(): XiaozhiDeviceStatus[];
  publicStatus(id: string): XiaozhiDeviceStatus | null;
  publicStatus(id?: string): XiaozhiDeviceStatus[] | XiaozhiDeviceStatus | null {
    if (id !== undefined) { const value = this.runtimes.get(id); return value ? this.status(value) : null; }
    return [...this.runtimes.values()].map(value => this.status(value));
  }
  private status({ binding, session }: BindingRuntime): XiaozhiDeviceStatus {
    return { id: binding.id, ownerUid: binding.ownerUid, deviceId: binding.deviceId, clientId: binding.clientId,
      state: binding.pairedAt !== null ? 'active' : this.now() >= binding.pairingExpiresAt ? 'expired' : 'pending', connected: session?.ready === true,
      observedAt: new Date(this.now()).toISOString(), pairingExpiresAt: new Date(binding.pairingExpiresAt).toISOString(), pairedAt: binding.pairedAt === null ? null : new Date(binding.pairedAt).toISOString(), audioSupported: false };
  }

  private authenticate(id: string, credentials: XiaozhiDeviceCredentials, kind: 'bootstrap' | 'device'): BindingRuntime {
    const runtime = this.runtimes.get(id), binding = runtime?.binding;
    if (this.closed || !runtime || !binding || !sameSecret(credentials.token, kind === 'bootstrap' ? binding.bootstrapSecret : binding.deviceSecret)
      || !textId(credentials.deviceId) || credentials.deviceId.toLowerCase() !== binding.deviceId || (binding.clientId !== null && credentials.clientId !== binding.clientId)
      || (binding.pairedAt === null && this.now() >= binding.pairingExpiresAt)) throw new XiaozhiGatewayError(401, 'Device authentication failed.');
    return runtime;
  }
  bootstrap(id: string, credentials: XiaozhiDeviceCredentials) {
    const { binding } = this.authenticate(id, credentials, 'bootstrap');
    // Deliberately no mqtt/firmware/activation fields: select WebSocket without requesting a firmware installation.
    return { websocket: { url: endpoint(binding.publicBaseUrl, 'device', id), token: binding.deviceSecret, version: 1 } };
  }

  /** Mount only the selected channel. Unrelated upgrades are untouched, including Socket.IO/Vite paths. */
  attachUpgrade(server: Server, options: { kind: XiaozhiGatewayKind; authorizeRequest?: (request: IncomingMessage) => boolean }): () => void {
    if (this.closed) throw new XiaozhiGatewayError(503, 'Device gateway is closed.');
    const wss = new WebSocketServer({ noServer: true, maxPayload: 262144 });
    this.websocketServers.add(wss);
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => { this.consumeUpgrade(request, socket, head, options, wss); };
    server.on('upgrade', upgrade);
    const detach = () => { server.off('upgrade', upgrade); this.detachers.delete(detach); };
    this.detachers.add(detach);
    return detach;
  }
  private consumeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, options: { kind: XiaozhiGatewayKind; authorizeRequest?: (request: IncomingMessage) => boolean }, wss: WebSocketServer): boolean {
    const { kind } = options;
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://localhost'); } catch { return false; }
    const match = /^\/api\/devices\/xiaozhi\/(device|mcp)\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (!match || match[1] !== kind) return false;
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} ${status === 503 ? 'Service Unavailable' : status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    try {
      if (options.authorizeRequest && options.authorizeRequest(request) !== true) throw new XiaozhiGatewayError(403, 'Device source is not allowed.');
      const id = match[2];
      if (kind === 'device') {
        const auth = request.headers.authorization;
        const credentials = { token: typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '', deviceId: String(request.headers['device-id'] ?? ''), clientId: typeof request.headers['client-id'] === 'string' ? request.headers['client-id'] : undefined };
        const runtime = this.authenticate(id, credentials, 'device');
        wss.handleUpgrade(request, socket, head, ws => this.deviceConnected(runtime, ws, credentials));
      } else {
        const runtime = this.runtimes.get(id);
        const remote = request.socket.remoteAddress;
        if (this.closed || !runtime || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') || url.searchParams.getAll('token').length !== 1
          || !sameSecret(url.searchParams.get('token'), runtime.binding.bridgeSecret)) throw new XiaozhiGatewayError(401, 'MCP bridge authentication failed.');
        if (!runtime.session?.ready) throw new XiaozhiGatewayError(503, 'Device is disconnected.');
        wss.handleUpgrade(request, socket, head, ws => this.clientConnected(runtime, ws));
      }
    } catch (error) { reject(error instanceof XiaozhiGatewayError ? error.statusCode : 401); }
    return true;
  }

  private deviceConnected(runtime: BindingRuntime, socket: WebSocket, credentials: XiaozhiDeviceCredentials) {
    if (runtime.session) this.endSession(runtime, runtime.session, 'Device connection replaced; an in-flight action outcome may be unknown.');
    const session: Session = { socket, ready: false, sessionId: randomUUID(), pending: new Map(), nextId: 1,
      helloTimer: setTimeout(() => socket.close(1008, 'Device hello required'), 10000) };
    session.helloTimer.unref?.(); runtime.session = session;
    socket.on('error', () => {});
    socket.on('close', () => this.endSession(runtime, session, 'Device disconnected; an in-flight action outcome may be unknown.'));
    socket.on('message', (data, binary) => {
      if (runtime.session !== session || binary) return; // Audio is unsupported and is neither decoded nor retained.
      const value = parse(data);
      if (!value) { socket.close(1008, 'Invalid device message'); return; }
      if (!session.ready) {
        if (value.type !== 'hello' || value.transport !== 'websocket' || value.features?.mcp !== true) { socket.close(1008, 'MCP device hello required'); return; }
        if (runtime.binding.pairedAt === null && this.now() >= runtime.binding.pairingExpiresAt) { socket.close(1008, 'Pairing window expired'); return; }
        clearTimeout(session.helloTimer);
        const previous = { ...runtime.binding };
        runtime.binding.pairedAt ??= this.now(); runtime.binding.clientId ??= credentials.clientId ?? null;
        try { this.persist(); } catch { runtime.binding = previous; socket.close(1011, 'Device binding could not be saved'); return; }
        session.ready = true;
        send(socket, { type: 'hello', transport: 'websocket', session_id: session.sessionId });
        this.notify('device_ready', this.publicStatus(runtime.binding.id)!);
        return;
      }
      if (value.type !== 'mcp') return;
      if (value.session_id !== session.sessionId || !object(value.payload)) { socket.close(1008, 'Invalid MCP session'); return; }
      const payload = value.payload;
      // v2.0.1 emits JSON-RPC errors without code. Preserve its message while supplying the required generic server-error code.
      if (object(payload.error) && payload.error.code === undefined && typeof payload.error.message === 'string') payload.error = { ...payload.error, code: -32000 };
      if (!validRpc(payload)) { socket.close(1008, 'Invalid device RPC'); return; }
      if (typeof payload.id === 'number') {
        const pending = session.pending.get(payload.id);
        if (!pending || ('method' in payload)) return;
        clearTimeout(pending.timer); session.pending.delete(payload.id);
        send(pending.client, { ...payload, id: pending.originalId });
      } else if (!('id' in payload) && 'method' in payload) runtime.clients.forEach(client => send(client, payload));
    });
  }
  private clientConnected(runtime: BindingRuntime, client: WebSocket) {
    runtime.clients.add(client); client.on('error', () => {});
    client.on('close', () => {
      runtime.clients.delete(client);
      for (const [id, pending] of runtime.session?.pending ?? []) if (pending.client === client) { clearTimeout(pending.timer); runtime.session!.pending.delete(id); }
    });
    client.on('message', (data, binary) => {
      if (binary) { client.close(1008, 'JSON-RPC text required'); return; }
      const payload = parse(data);
      if (!payload || !validRpc(payload)) { client.close(1008, 'Invalid MCP request'); return; }
      const session = runtime.session;
      const id = payload.id;
      if (!session?.ready || session.socket.readyState !== WebSocket.OPEN) { if (typeof id === 'string' || typeof id === 'number') rpcError(client, id, -32001, 'Device is disconnected.'); return; }
      if (!('method' in payload)) return;
      if (id === undefined) { send(session.socket, { type: 'mcp', session_id: session.sessionId, payload }); return; }
      if (typeof id !== 'string' && typeof id !== 'number') return;
      if (session.pending.size >= 256) { rpcError(client, id, -32000, 'Device request capacity reached.'); return; }
      if (session.nextId > 0x7fffffff) { rpcError(client, id, -32000, 'Device session request identifiers exhausted.'); return; }
      const wireId = session.nextId++;
      const timer = setTimeout(() => {
        if (runtime.session !== session || !session.pending.delete(wireId)) return;
        rpcError(client, id, -32001, 'Device request timed out; an action outcome may be unknown. The request was not replayed.');
      }, this.requestTimeoutMs);
      timer.unref?.(); session.pending.set(wireId, { client, originalId: id, timer });
      send(session.socket, { type: 'mcp', session_id: session.sessionId, payload: { ...payload, id: wireId } });
    });
  }
  private endSession(runtime: BindingRuntime, session: Session, reason: string) {
    clearTimeout(session.helloTimer);
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); rpcError(pending.client, pending.originalId, -32001, reason); }
    session.pending.clear(); session.socket.terminate();
    if (runtime.session !== session) return;
    runtime.session = undefined;
    runtime.clients.forEach(client => client.close(1012, 'Device disconnected'));
    if (session.ready) this.notify('device_disconnected', this.status(runtime));
  }
  revoke(id: string, ownerUid: string): void {
    const runtime = this.owned(id, ownerUid);
    this.runtimes.delete(id);
    try { this.persist(); } catch (error) { this.runtimes.set(id, runtime); throw error; }
    if (runtime.session) this.endSession(runtime, runtime.session, 'Device binding revoked; an action outcome may be unknown.');
  }
  async close(): Promise<void> {
    this.closed = true; this.detachers.forEach(detach => detach());
    for (const runtime of this.runtimes.values()) {
      if (runtime.session) this.endSession(runtime, runtime.session, 'Device gateway closed; an action outcome may be unknown.');
      runtime.clients.forEach(client => client.terminate());
    }
    await Promise.all([...this.websocketServers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    this.websocketServers.clear();
  }
}
