import type { ConnectedServer, MCPServerConfig, MCPToolDef } from './contracts';
import { mcpServerConfigFingerprint } from './fingerprints';
import { isProcessBacked } from './readiness';
import { requireSafeMCPServerName } from './security';
import { PROCESS_IDLE_TIMEOUT_MS } from './timeouts';

type Transport = ConnectedServer['transport'];
type PendingConnection = {
  fingerprint: string;
  epoch: number;
  promise: Promise<MCPToolDef[]>;
  transport?: Transport;
};

/** Exact connection objects own calls and closure; a server name alone cannot retire a successor. */
export class MCPConnectionLifecycle {
  readonly live = new Map<string, ConnectedServer>();
  private pending = new Map<string, PendingConnection>();
  private epochs = new Map<string, number>();
  private intentionalClosings = new WeakSet<Transport>();
  private closes = new WeakMap<Transport, Promise<void>>();
  private failedClosures = new Map<Transport, string>();
  private activeCalls = new Map<ConnectedServer, number>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closingAll = false;

  constructor(
    private connect: (name: string, config: MCPServerConfig, epoch: number) => Promise<MCPToolDef[]>,
    private onIdleDisconnect: (name: string) => void,
  ) {}

  currentEpoch(name: string): number { return this.epochs.get(name) || 0; }
  isCurrent(name: string, epoch: number): boolean { return this.currentEpoch(name) === epoch; }

  ensure(name: string, config: MCPServerConfig): Promise<MCPToolDef[]> {
    name = requireSafeMCPServerName(name);
    if (this.closingAll) return Promise.reject(new Error('MCP connections are closing.'));
    config = structuredClone(config);
    const fingerprint = mcpServerConfigFingerprint(config);
    const prior = this.pending.get(name);
    if (prior?.fingerprint === fingerprint) return prior.promise;
    if (prior) this.epochs.set(name, this.currentEpoch(name) + 1);
    const epoch = this.currentEpoch(name);
    const connection = Promise.resolve()
      .then(() => this.connect(name, config, epoch))
      .finally(() => {
        if (this.pending.get(name)?.promise === connection) this.pending.delete(name);
      });
    this.pending.set(name, { fingerprint, epoch, promise: connection });
    return connection;
  }

  attachPending(name: string, epoch: number, transport: Transport): void {
    if (!this.isCurrent(name, epoch)) throw new Error('MCP connection was superseded.');
    const pending = this.pending.get(name);
    if (pending?.epoch === epoch) pending.transport = transport;
  }

  publish(name: string, epoch: number, server: ConnectedServer): void {
    if (!this.isCurrent(name, epoch)) throw new Error('MCP server "' + name + '" connection was superseded by a newer configuration.');
    this.live.set(name, server);
  }

  clearIdle(name: string): void {
    const timer = this.idleTimers.get(name);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(name);
  }

  closeTransport(name: string, transport: Transport): Promise<void> {
    const existing = this.closes.get(transport);
    if (existing) return existing;
    this.intentionalClosings.add(transport);
    const closing = Promise.resolve().then(() => transport.close())
      .then(() => { this.failedClosures.delete(transport); }, error => {
        this.closes.delete(transport);
        this.failedClosures.set(transport, name);
        throw error;
      })
      .finally(() => this.intentionalClosings.delete(transport));
    this.closes.set(transport, closing);
    return closing;
  }

  withdraw(name: string, transport: Transport): void {
    if (this.live.get(name)?.transport !== transport) return;
    this.live.delete(name);
    this.clearIdle(name);
  }

  async retire(name: string, server: ConnectedServer): Promise<void> {
    this.withdraw(name, server.transport);
    await this.closeTransport(name, server.transport);
  }

  timeout(name: string, transport: Transport, epoch?: number): void {
    if (epoch !== undefined && this.isCurrent(name, epoch)) {
      this.epochs.set(name, epoch + 1);
      if (this.pending.get(name)?.epoch === epoch) this.pending.delete(name);
    }
    this.withdraw(name, transport);
    void this.closeTransport(name, transport).catch(() => undefined);
  }

  unexpectedClose(name: string, transport: Transport): boolean {
    if (this.intentionalClosings.has(transport) || this.live.get(name)?.transport !== transport) return false;
    this.withdraw(name, transport);
    return true;
  }

  beginCall(name: string, server: ConnectedServer): () => void {
    this.clearIdle(name);
    this.activeCalls.set(server, (this.activeCalls.get(server) || 0) + 1);
    return () => {
      const remaining = (this.activeCalls.get(server) || 1) - 1;
      if (remaining > 0) this.activeCalls.set(server, remaining);
      else this.activeCalls.delete(server);
      if (this.live.get(name) === server) this.scheduleIdle(name);
    };
  }

  scheduleIdle(name: string): void {
    const server = this.live.get(name);
    if (!server || !isProcessBacked(server.config)) return;
    this.clearIdle(name);
    const timer = setTimeout(() => {
      if (this.live.get(name) !== server) return;
      this.idleTimers.delete(name);
      if ((this.activeCalls.get(server) || 0) > 0) {
        this.scheduleIdle(name);
        return;
      }
      void this.disconnect(name).then(() => this.onIdleDisconnect(name)).catch(() => undefined);
    }, PROCESS_IDLE_TIMEOUT_MS);
    timer.unref?.();
    this.idleTimers.set(name, timer);
  }

  async disconnect(name: string): Promise<void> {
    name = requireSafeMCPServerName(name);
    this.epochs.set(name, this.currentEpoch(name) + 1);
    const pending = this.pending.get(name);
    this.pending.delete(name);
    this.clearIdle(name);
    const server = this.live.get(name);
    if (server) this.live.delete(name);
    const failed = [...this.failedClosures].filter(([, owner]) => owner === name).map(([transport]) => transport);
    const transports = new Set([server?.transport, pending?.transport, ...failed].filter((t): t is Transport => Boolean(t)));
    const results = await Promise.allSettled([...transports].map(t => this.closeTransport(name, t)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw new Error('MCP server "' + name + '" did not close cleanly: ' + String(failure.reason?.message || failure.reason));
  }

  async disconnectAll(): Promise<void> {
    this.closingAll = true;
    try {
      const names = new Set([...this.live.keys(), ...this.pending.keys(), ...this.failedClosures.values()]);
      await Promise.allSettled([...names].map(name => this.disconnect(name)));
    } finally {
      this.closingAll = false;
    }
  }
}
