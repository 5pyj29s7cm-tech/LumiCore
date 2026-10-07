import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import path from 'node:path';
import { loadKeys } from '../../config/keys';
import { expandPortablePath, isNpxCommand } from './package_paths';
import type { MCPServerConfig, ConnectedServer } from './contracts';

/** Construct the reviewed transport; lifecycle ownership stays in MCPConnectionLifecycle. */
export function createMCPTransport(
  name: string, config: MCPServerConfig, resolveRuntimeTsxCli: () => string | null,
): ConnectedServer['transport'] {
    const transportType = config.transport || (config.url ? (config.url.startsWith('wss://') || config.url.startsWith('ws://') ? 'ws' : 'http') : 'stdio');
    let transport: StdioClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;

    if (transportType === 'ws' && config.url) {
      transport = new WebSocketClientTransport(new URL(config.url));
    } else if (transportType === 'http' && config.url) {
      transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        },
      );
    } else if (config.command) {
      const expandedCommand = expandPortablePath(config.command);
      const expandedArgs = (config.args || []).map(arg => expandPortablePath(arg));
      const tsxCli = isNpxCommand(expandedCommand) && expandedArgs[0] === 'tsx'
        ? resolveRuntimeTsxCli()
        : null;
      const command = tsxCli ? process.execPath : expandedCommand;
      const args = tsxCli ? [tsxCli, ...expandedArgs.slice(1)] : expandedArgs;
      // Expand ${VAR_NAME} placeholders in env values using process.env + stored keys
      const storedKeys: Record<string, string> = {};
      try {
        Object.assign(storedKeys, loadKeys());
      } catch {}
      const resolvedEnv: Record<string, string> = {};
      if (config.env) {
        for (const [k, v] of Object.entries(config.env)) {
          resolvedEnv[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || storedKeys[name] || '');
        }
      }
      transport = new StdioClientTransport({
        command,
        args,
        cwd: config.cwd ? path.resolve(expandPortablePath(config.cwd)) : undefined,
        env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : (config.env || undefined),
      });
    } else {
      throw new Error(`MCP server "${name}": must provide "url" for http/ws transport or "command" for stdio transport`);
    }

  return transport;
}
