import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Tracks admitted MCP work, including child work that outlives a reply. */
export class McpCallLifecycle {
  private acceptingCalls = true;
  private pending = new Set<Promise<unknown>>();

  get accepting(): boolean { return this.acceptingCalls; }

  stopAdmission(): void { this.acceptingCalls = false; }

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.acceptingCalls) return Promise.reject(new Error('Lumi MCP is shutting down; new calls are unavailable.'));
    return this.track(Promise.resolve().then(operation));
  }

  /** Child work belongs to a call already admitted, even during shutdown. */
  track<T>(operation: Promise<T>): Promise<T> {
    const pending = Promise.resolve(operation);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  async drain(): Promise<void> {
    // Settling one parent may enqueue background finalization or extraction.
    // Re-read the set instead of assuming the initial snapshot is complete.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

/** Wrap actual registered callbacks; transport response completion is insufficient. */
export function attachMcpCallLifecycle(server: McpServer, lifecycle: McpCallLifecycle): void {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: any, callback: (...args: any[]) => any) => (
    register(name, config, (...args: any[]) => lifecycle.run(() => callback(...args)))
  )) as McpServer['registerTool'];
}
