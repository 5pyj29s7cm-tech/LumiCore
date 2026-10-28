import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { getPhysicalLanInterfaces, isOnLan, type LanDiscoveryInterface } from './lan_discovery';
import { XiaozhiMcpGateway, XiaozhiGatewayError, type XiaozhiPrivateBinding, type XiaozhiDeviceStatus } from './xiaozhi_mcp_gateway';
import { EncryptedXiaozhiRepository, type XiaozhiBindingRepository } from './xiaozhi_repository';
import { mcpManager, registerConnectedSkillTools, unregisterServerTools, type MCPServerConfig, type MCPToolDef } from '../mcp';
import { mapMCPTools } from '../mcp/client/security';

export interface XiaozhiPairingConfiguration { id: string; expiresAt: string; otaUrl: string; mcpUrl: string }
export interface XiaozhiPairingInput { deviceId: string; clientId?: string; localAddress: string }
export interface XiaozhiPublicRuntimeStatus extends XiaozhiDeviceStatus {
  localAddress: string; toolState: 'disconnected' | 'initializing' | 'registered' | 'error';
  toolCount: number; registeredToolNames: string[]; toolError: string | null;
}
export interface XiaozhiServiceSnapshot {
  devices: XiaozhiPublicRuntimeStatus[];
  errors: Array<{ code: string; message: string }>;
  listener: { state: 'stopped' | 'listening' | 'error'; localAddress: string | null; port: number | null };
}
type CatalogueClient = Pick<Client, 'connect' | 'listTools' | 'close'>;
export interface XiaozhiServiceOptions {
  repository?: XiaozhiBindingRepository;
  interfaces?: () => Promise<LanDiscoveryInterface[]>;
  /** Internal test seams only. The product singleton always uses the dedicated port 17840. */
  lanPort?: number;
  createClient?: () => CatalogueClient;
  registerTools?: typeof registerConnectedSkillTools;
  unregisterTools?: typeof unregisterServerTools;
  disconnectServer?: (name: string) => Promise<void>;
}
interface ToolRuntime { toolState: XiaozhiPublicRuntimeStatus['toolState']; registeredToolNames: string[]; toolError: string | null }
interface ListenerRuntime { gateway: XiaozhiMcpGateway; lan: Server; loopback: Server; selected: LanDiscoveryInterface; port: number }
const BOOTSTRAP = /^\/api\/devices\/xiaozhi\/bootstrap\/([A-Za-z0-9_-]{1,128})$/;
const DEVICE = /^\/api\/devices\/xiaozhi\/device\/[A-Za-z0-9_-]{1,128}$/;
const MCP = /^\/api\/devices\/xiaozhi\/mcp\/[A-Za-z0-9_-]{1,128}$/;
const MAX_BOOTSTRAP_BYTES = 65536;
function validIdentity(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value); }
function requestPath(request: IncomingMessage): string { try { return new URL(request.url ?? '/', 'http://localhost').pathname; } catch { return ''; } }
function address(value: string | undefined): string { return String(value ?? '').replace(/^::ffff:/, ''); }
function reply(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
  response.end(JSON.stringify(value));
}
async function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); const bound = server.address();
      if (!bound || typeof bound === 'string') reject(new Error('Device listener did not provide an IP port.')); else resolve(bound.port); };
    server.once('error', failed); server.once('listening', ready); server.listen({ host, port, exclusive: true });
  });
}
async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()); });
}
function drainBootstrap(request: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const finish = (error?: Error) => { clearTimeout(timer); request.off('data', data); request.off('end', ended); request.off('error', failed); request.off('aborted', aborted); if (error) { request.pause(); reject(error); } else resolve(); };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BOOTSTRAP_BYTES) finish(new XiaozhiGatewayError(413, 'Device bootstrap body is too large.')); };
    const ended = () => finish(); const failed = (error: Error) => finish(error); const aborted = () => finish(new Error('Device bootstrap was interrupted.'));
    const timer = setTimeout(() => finish(new XiaozhiGatewayError(408, 'Device bootstrap body timed out.')), 5000); timer.unref?.();
    request.on('data', data); request.once('end', ended); request.once('error', failed); request.once('aborted', aborted);
    if (request.readableEnded) finish(); else request.resume();
  });
}

/** Dedicated device-only listeners. Main HTTP binding/configuration and global mcp_config are never changed. */
export class XiaozhiDeviceService {
  private readonly repository: XiaozhiBindingRepository;
  private saved: XiaozhiPrivateBinding[] = [];
  private loaded = false;
  private restoreError: string | null = null;
  private listenerError: string | null = null;
  private runtime: ListenerRuntime | null = null;
  private closed = false;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly epochs = new Map<string, number>();
  private readonly toolRuntime = new Map<string, ToolRuntime>();
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly clients = new Map<string, CatalogueClient>();
  constructor(private readonly options: XiaozhiServiceOptions = {}) { this.repository = options.repository ?? new EncryptedXiaozhiRepository(); }
  private safeError(error: unknown): string {
    let text = error instanceof Error ? error.message : String(error);
    text = text.replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
    for (const b of this.saved) for (const secret of [b.bootstrapSecret, b.deviceSecret, b.bridgeSecret]) if (secret) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  private load(): void {
    if (this.loaded) { if (this.restoreError) throw new Error(this.restoreError); return; }
    this.loaded = true;
    try { this.saved = this.repository.load(); } catch (error) { this.restoreError = this.safeError(error); throw new Error(this.restoreError); }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.catch(() => undefined).then(operation); this.mutations = next.catch(() => undefined); return next;
  }
  private assertOpen(): void { if (this.closed) throw new XiaozhiGatewayError(503, 'Device service is closed.'); }
  private serverName(id: string): string { return 'xiaozhi-' + createHash('sha256').update(id).digest('hex'); }
  private bump(id: string): number { const next = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, next); return next; }
  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.jobs.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.jobs.set(id, next); void next.finally(() => { if (this.jobs.get(id) === next) this.jobs.delete(id); }).catch(() => undefined); return next;
  }
  private active(runtime: ListenerRuntime, id: string, epoch: number): boolean {
    return !this.closed && this.runtime === runtime && this.epochs.get(id) === epoch && runtime.gateway.publicStatus(id)?.connected === true;
  }
  private onReady(runtime: ListenerRuntime, status: XiaozhiDeviceStatus): Promise<void> {
    if (this.closed || this.runtime !== runtime) return Promise.resolve();
    const epoch = this.bump(status.id);
    this.toolRuntime.set(status.id, { toolState: 'initializing', registeredToolNames: [], toolError: null });
    return this.enqueue(status.id, async () => {
      if (!this.active(runtime, status.id, epoch)) return;
      const name = this.serverName(status.id);
      const unregister = this.options.unregisterTools ?? unregisterServerTools;
      const disconnect = this.options.disconnectServer ?? (serverName => mcpManager.disconnectServer(serverName));
      let client: CatalogueClient | undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Device MCP catalogue timed out.')), 30000); timer.unref?.();
      try {
        unregister(name); await disconnect(name);
        if (!this.active(runtime, status.id, epoch)) return;
        client = (this.options.createClient ?? (() => new Client({ name: 'lumi-xiaozhi-catalogue', version: '1.0.0' }, { capabilities: {} })))();
        this.clients.set(status.id, client);
        const url = runtime.gateway.getMcpUrl(status.id, status.ownerUid);
        await client.connect(new WebSocketClientTransport(new URL(url)), { timeout: 10000, maxTotalTimeout: 10000, signal: controller.signal });
        const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
        const cursors = new Set<string>(); let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 10000, maxTotalTimeout: 10000, signal: controller.signal });
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor !== undefined) { if (cursors.has(cursor)) throw new Error('Device MCP catalogue repeated a cursor.'); cursors.add(cursor); }
        } while (cursor !== undefined);
        if (!this.active(runtime, status.id, epoch)) return;
        const serverConfig: MCPServerConfig & { runtimeOwnerUid: string } = { enabled: true, source: 'external', transport: 'ws', url,
          runtimeOwnerUid: status.ownerUid, description: 'Local Xiaozhi device MCP bridge' };
        const mapped: MCPToolDef[] = mapMCPTools(name, tools);
        const activated = await (this.options.registerTools ?? registerConnectedSkillTools)(name, mapped, { serverConfig });
        if (!this.active(runtime, status.id, epoch)) { unregister(name); await disconnect(name); return; }
        this.toolRuntime.set(status.id, { toolState: 'registered', registeredToolNames: [...activated.registeredToolNames], toolError: null });
      } catch (error) {
        unregister(name); await disconnect(name).catch(() => undefined);
        if (this.active(runtime, status.id, epoch)) this.toolRuntime.set(status.id, { toolState: 'error', registeredToolNames: [], toolError: this.safeError(error) });
      } finally {
        clearTimeout(timer); if (this.clients.get(status.id) === client) this.clients.delete(status.id);
        await client?.close().catch(() => undefined);
      }
    });
  }
  private onDisconnected(runtime: ListenerRuntime, status: XiaozhiDeviceStatus): Promise<void> {
    if (this.runtime !== runtime) return Promise.resolve();
    this.bump(status.id);
    (this.options.unregisterTools ?? unregisterServerTools)(this.serverName(status.id));
    this.toolRuntime.set(status.id, { toolState: 'disconnected', registeredToolNames: [], toolError: null });
    void this.clients.get(status.id)?.close().catch(() => undefined);
    return this.enqueue(status.id, async () => { await (this.options.disconnectServer ?? (name => mcpManager.disconnectServer(name)))(this.serverName(status.id)); });
  }
  private allowed(request: IncomingMessage, selected: LanDiscoveryInterface): boolean {
    const remote = address(request.socket.remoteAddress);
    return remote === selected.address || isOnLan(remote, [selected]);
  }
  private async ensureListener(localAddress: string): Promise<ListenerRuntime> {
    this.assertOpen();
    const selected = (await (this.options.interfaces ?? getPhysicalLanInterfaces)()).find(item => item.address === localAddress);
    if (!selected) throw new XiaozhiGatewayError(400, 'Select a current physical private IPv4 LAN interface.');
    if (this.runtime) {
      if (this.runtime.selected.address !== selected.address || this.runtime.selected.netmask !== selected.netmask) throw new XiaozhiGatewayError(409, 'Revoke existing bindings before selecting a different device interface.');
      return this.runtime;
    }
    const configuredPort = this.options.lanPort ?? 17840;
    if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('Invalid device listener port.');
    const loopback = createServer((_request, response) => reply(response, 404, { error: 'Not found.' }));
    let runtime: ListenerRuntime | null = null;
    const lan = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
      try {
        if (!runtime || !this.allowed(request, selected)) { reply(response, runtime ? 403 : 503, { error: 'Device bootstrap is unavailable for this source.' }); return; }
        const url = new URL(request.url ?? '/', 'http://localhost'); const match = BOOTSTRAP.exec(url.pathname);
        if (!match) { reply(response, 404, { error: 'Not found.' }); return; }
        if (request.method !== 'GET' && request.method !== 'POST') { reply(response, 405, { error: 'Use GET or POST.' }); return; }
        if (url.searchParams.getAll('token').length !== 1) throw new XiaozhiGatewayError(401, 'Device authentication failed.');
        const credentials = { token: url.searchParams.get('token')!, deviceId: String(request.headers['device-id'] ?? ''), clientId: typeof request.headers['client-id'] === 'string' ? request.headers['client-id'] : undefined };
        const result = runtime.gateway.bootstrap(match[1], credentials);
        await drainBootstrap(request); // Body may contain SSID/system metadata: discard without parsing, persisting or logging.
        reply(response, 200, result);
      } catch (error) { if (!response.headersSent) reply(response, error instanceof XiaozhiGatewayError ? error.statusCode : 500, { error: error instanceof XiaozhiGatewayError ? error.message : 'Device bootstrap failed.' }); }
    });
    const listenerFailed = (error: Error) => { this.listenerError = this.safeError(error); };
    lan.on('error', listenerFailed); loopback.on('error', listenerFailed);
    lan.requestTimeout = 5000; lan.headersTimeout = 5000; lan.keepAliveTimeout = 1000;
    lan.on('upgrade', (request, socket) => { if (!DEVICE.test(requestPath(request))) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    loopback.on('upgrade', (request, socket) => { if (!MCP.test(requestPath(request))) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    try {
      const localPort = await listen(loopback, '127.0.0.1', 0);
      const port = await listen(lan, selected.address, configuredPort);
      const publicBaseUrl = 'http://' + selected.address + ':' + port;
      if (this.saved.some(binding => binding.publicBaseUrl !== publicBaseUrl)) throw new XiaozhiGatewayError(409, 'Saved device bindings use a different interface or port. The encrypted file was preserved.');
      const gateway = new XiaozhiMcpGateway({ localBaseUrl: 'http://127.0.0.1:' + localPort, bindings: this.saved,
        onBindingsChanged: bindings => { this.repository.save(bindings); this.saved = structuredClone(bindings); },
        onDeviceReady: status => this.onReady(runtime!, status), onDeviceDisconnected: status => this.onDisconnected(runtime!, status),
        onLifecycleError: () => { this.listenerError = 'Device MCP lifecycle failed.'; },
      });
      runtime = { gateway, selected, lan, loopback, port };
      gateway.attachUpgrade(lan, { kind: 'device', authorizeRequest: request => this.allowed(request, selected) });
      gateway.attachUpgrade(loopback, { kind: 'mcp' });
      this.runtime = runtime; this.listenerError = null; return runtime;
    } catch (error) { await Promise.all([stop(lan), stop(loopback)]); this.listenerError = this.safeError(error); throw error; }
  }
  async startSaved(): Promise<void> {
    return this.serialize(async () => { this.assertOpen(); this.load(); if (!this.saved.length) return;
      const selected = new URL(this.saved[0].publicBaseUrl).hostname; await this.ensureListener(selected); });
  }
  async list(ownerUid: string): Promise<XiaozhiServiceSnapshot> {
    try { this.load(); } catch { /* Preserve and report restoration failure; never replace the file with an empty store. */ }
    const statuses = this.runtime?.gateway.publicStatus() ?? this.saved.map(binding => ({ id: binding.id, ownerUid: binding.ownerUid, deviceId: binding.deviceId, clientId: binding.clientId,
      state: binding.pairedAt !== null ? 'active' as const : Date.now() >= binding.pairingExpiresAt ? 'expired' as const : 'pending' as const, connected: false,
      observedAt: new Date().toISOString(), pairingExpiresAt: new Date(binding.pairingExpiresAt).toISOString(), pairedAt: binding.pairedAt === null ? null : new Date(binding.pairedAt).toISOString(), audioSupported: false as const }));
    const devices = statuses.filter(status => status.ownerUid === ownerUid).map(status => {
      const runtime = this.toolRuntime.get(status.id) ?? { toolState: 'disconnected' as const, registeredToolNames: [], toolError: null };
      return { ...status, localAddress: new URL(this.saved.find(binding => binding.id === status.id)!.publicBaseUrl).hostname,
        ...runtime, toolCount: runtime.registeredToolNames.length, registeredToolNames: [...runtime.registeredToolNames] };
    });
    const errors = [{ code: 'restore_failed', message: this.restoreError }, { code: 'listener_failed', message: this.listenerError }].filter((item): item is { code: string; message: string } => item.message !== null);
    return { devices, errors, listener: { state: errors.length ? 'error' : this.runtime ? 'listening' : 'stopped', localAddress: this.runtime?.selected.address ?? null, port: this.runtime?.port ?? null } };
  }
  private async closeEmpty(runtime: ListenerRuntime): Promise<void> {
    if (!this.saved.length && this.runtime === runtime) { await runtime.gateway.close(); await Promise.all([stop(runtime.lan), stop(runtime.loopback)]); this.runtime = null; }
  }
  async createPairing(ownerUid: string, input: XiaozhiPairingInput): Promise<XiaozhiPairingConfiguration> {
    return this.serialize(async () => { this.assertOpen(); this.load();
      if (!validIdentity(ownerUid) || !validIdentity(input.deviceId) || (input.clientId !== undefined && !validIdentity(input.clientId))) throw new XiaozhiGatewayError(400, 'An owner and known device identity are required.');
      const runtime = await this.ensureListener(input.localAddress);
      try { return runtime.gateway.createPairing({ ownerUid, deviceId: input.deviceId, clientId: input.clientId, publicBaseUrl: 'http://' + runtime.selected.address + ':' + runtime.port }); }
      catch (error) { await this.closeEmpty(runtime); throw error; } });
  }
  async getPairingConfiguration(id: string, ownerUid: string): Promise<XiaozhiPairingConfiguration> {
    return this.serialize(async () => { this.assertOpen(); this.load(); const binding = this.saved.find(item => item.id === id && item.ownerUid === ownerUid);
      if (!binding) throw new XiaozhiGatewayError(404, 'Device binding not found.');
      const runtime = await this.ensureListener(new URL(binding.publicBaseUrl).hostname); return runtime.gateway.getPairingConfiguration(id, ownerUid); });
  }
  async revoke(id: string, ownerUid: string): Promise<void> {
    return this.serialize(async () => { this.assertOpen(); this.load(); const binding = this.saved.find(item => item.id === id && item.ownerUid === ownerUid);
      if (!binding) throw new XiaozhiGatewayError(404, 'Device binding not found.');
      if (this.runtime) this.runtime.gateway.revoke(id, ownerUid);
      else { const remaining = this.saved.filter(item => item.id !== id); this.repository.save(remaining); this.saved = remaining; }
      this.bump(id); (this.options.unregisterTools ?? unregisterServerTools)(this.serverName(id));
      void this.clients.get(id)?.close().catch(() => undefined);
      await this.enqueue(id, async () => { await (this.options.disconnectServer ?? (name => mcpManager.disconnectServer(name)))(this.serverName(id)); });
      this.toolRuntime.delete(id);
      if (this.runtime) await this.closeEmpty(this.runtime);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.serialize(async () => {
      const runtime = this.runtime;
      for (const binding of this.saved) { this.bump(binding.id); (this.options.unregisterTools ?? unregisterServerTools)(this.serverName(binding.id)); }
      await Promise.allSettled([...this.clients.values()].map(client => client.close()));
      if (runtime) await runtime.gateway.close();
      await Promise.allSettled([...this.jobs.values()]);
      await Promise.allSettled(this.saved.map(binding => (this.options.disconnectServer ?? (name => mcpManager.disconnectServer(name)))(this.serverName(binding.id))));
      if (runtime) await Promise.all([stop(runtime.lan), stop(runtime.loopback)]);
      this.runtime = null; this.toolRuntime.clear();
    });
  }
}
export const xiaozhiDeviceService = new XiaozhiDeviceService();
