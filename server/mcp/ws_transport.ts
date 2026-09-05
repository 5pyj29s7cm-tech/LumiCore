/**
 * WebSocket Server Transport for MCP — allows MCP clients (e.g. xiaozhi device)
 * to connect to Lumi's MCP server over WebSocket.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { authenticateMcpUpgradeRequest, mcpScopeFromAuthUser, sameMcpScope } from './auth';
import type { AuthUser } from '../middleware/auth';
import { sanitizeMcpEndpoint, sanitizeMcpLogValue } from './public_security';

export class WebSocketServerTransport implements Transport {
  private _socket: WebSocket;
  public sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: WebSocket, request?: IncomingMessage, authorizeMessage?: () => boolean) {
    this._socket = socket;
    this.sessionId = randomUUID();

    let authorizationRevoked = false;
    socket.on('message', (data: Buffer) => {
      if (authorizationRevoked) return;
      if (authorizeMessage) {
        let authorized = false;
        try { authorized = authorizeMessage(); } catch {}
        if (!authorized) {
          authorizationRevoked = true;
          socket.close(1008, 'MCP authentication expired or scope changed');
          return;
        }
      }
      try {
        const message = JSON.parse(data.toString()) as JSONRPCMessage;
        this.onmessage?.(message);
      } catch (err: any) {
        this.onerror?.(new Error(`Invalid JSON: ${err.message}`));
      }
    });

    socket.on('close', () => {
      this.onclose?.();
    });

    socket.on('error', (err: Error) => {
      this.onerror?.(err);
    });
  }

  async start(): Promise<void> {
    // WebSocket is already open when constructor is called
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this._socket.readyState === WebSocket.OPEN) {
      this._socket.send(JSON.stringify(message));
    }
  }

  async close(): Promise<void> {
    if (this._socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      this._socket.once('close', () => resolve());
      if (this._socket.readyState === WebSocket.OPEN) this._socket.close(1000, 'Server closing');
      else if (this._socket.readyState === WebSocket.CONNECTING) this._socket.terminate();
    });
  }
}

/**
 * Connect Lumi's MCP server to a remote MCP client via an outbound WebSocket.
 * Used when the remote device (e.g. xiaozhi broker) expects Lumi to initiate
 * the connection, then acts as the MCP client on that connection.
 */
export function connectMcpServerToRemote(
  url: string,
  createMcpServer: () => import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  deviceName?: string,
  onConnect?: (sessionId: string) => void,
  onDisconnect?: () => void,
): { stop: () => void; close: () => Promise<void> } {
  const name = String(deviceName || new URL(url).hostname)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 120) || 'remote-device';
  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 5000);
    reconnectTimer.unref?.();
  };
  const connect = () => {
    if (stopped) return;
    console.log(`[MCP Server] Connecting to remote device "${name}": ${sanitizeMcpEndpoint(url) || '[configured endpoint]'}`);
    let current: WebSocket;
    try {
      current = new WebSocket(url, 'mcp');
    } catch (error: any) {
      console.error(`[MCP Server] Remote connection setup failed for "${name}":`, sanitizeMcpLogValue(error?.message || error));
      scheduleReconnect();
      return;
    }
    socket = current;
    let connected = false;
    current.on('open', () => {
      // MCP's protocol object owns exactly one transport. A new instance per
      // device AND attempt also isolates request ids and initialization state.
      const transport = new WebSocketServerTransport(current);
      void (async () => {
        if (stopped || socket !== current) return;
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        if (stopped || socket !== current || current.readyState !== WebSocket.OPEN) {
          await mcpServer.close();
          return;
        }
        connected = true;
        console.log(`[MCP Server] Remote device "${name}" connected: ${transport.sessionId}`);
        onConnect?.(transport.sessionId);
      })().catch((error) => {
        console.error(`[MCP Server] Remote connect error for "${name}":`, sanitizeMcpLogValue(error?.message || error));
        // Do not leave an open socket with no MCP server. Its close event owns
        // retry scheduling, so failed initialization cannot strand this device.
        current.terminate();
      });
    });
    current.on('error', (error) => {
      console.error(`[MCP Server] Remote WebSocket error for "${name}":`, sanitizeMcpLogValue(error?.message || error));
    });
    current.on('close', () => {
      if (socket === current) socket = undefined;
      if (connected) onDisconnect?.();
      if (!stopped) {
        console.log(`[MCP Server] Remote device "${name}" disconnected, reconnecting in 5s...`);
        scheduleReconnect();
      }
    });
  };
  connect();
  const stop = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };
  return {
    stop,
    close: async () => {
      stop();
      const current = socket;
      socket = undefined;
      if (!current || current.readyState === WebSocket.CLOSED) return;
      await new Promise<void>(resolve => {
        current.once('close', () => resolve());
        current.terminate();
      });
    },
  };
}

/**
 * Attach a WebSocket server to the HTTP server for incoming MCP connections.
 */
export function attachMcpWebSocket(
  httpServer: Server,
  onConnection: (
    transport: WebSocketServerTransport,
    request: IncomingMessage,
    user: AuthUser,
  ) => void,
  isAccepting: () => boolean = () => true,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (url.pathname === '/mcp/ws') {
      if (!isAccepting()) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const user = authenticateMcpUpgradeRequest(request);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const admittedScope = mcpScopeFromAuthUser(user)!;
        const transport = new WebSocketServerTransport(ws, request, () => {
          // The MCP instance captures its caller scope. Never let an old
          // socket retain expired JWT authority or an obsolete organization
          // role: reauthenticate each message and require a fresh connection
          // when the scope changes.
          if (!isAccepting()) return false;
          const currentUser = authenticateMcpUpgradeRequest(request);
          const currentScope = currentUser ? mcpScopeFromAuthUser(currentUser) : null;
          return currentScope !== null && sameMcpScope(admittedScope, currentScope);
        });
        onConnection(transport, request, user);
      });
    }
  });

  return wss;
}
