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
import { authenticateMcpUpgradeRequest } from './auth';
import type { AuthUser } from '../middleware/auth';

export class WebSocketServerTransport implements Transport {
  private _socket: WebSocket;
  public sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: WebSocket, request?: IncomingMessage) {
    this._socket = socket;
    this.sessionId = randomUUID();

    socket.on('message', (data: Buffer) => {
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
    if (this._socket.readyState === WebSocket.OPEN) {
      this._socket.close(1000, 'Server closing');
    }
  }
}

/**
 * Connect Lumi's MCP server to a remote MCP client via an outbound WebSocket.
 * Used when the remote device (e.g. xiaozhi broker) expects Lumi to initiate
 * the connection, then acts as the MCP client on that connection.
 */
export function connectMcpServerToRemote(
  url: string,
  mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  deviceName?: string,
  onConnect?: (sessionId: string) => void,
  onDisconnect?: () => void,
): void {
  const name = deviceName || new URL(url).hostname;
  console.log(`[MCP Server] Connecting to remote device "${name}": ${url}`);

  const ws = new WebSocket(url, 'mcp');

  ws.on('open', () => {
    const transport = new WebSocketServerTransport(ws);
    mcpServer.connect(transport).then(() => {
      console.log(`[MCP Server] Remote device "${name}" connected: ${transport.sessionId}`);
      onConnect?.(transport.sessionId);
    }).catch((err) => {
      console.error(`[MCP Server] Remote connect error for "${name}":`, err.message);
    });
  });

  ws.on('error', (err) => {
    console.error(`[MCP Server] Remote WebSocket error for "${name}":`, err.message);
  });

  ws.on('close', () => {
    console.log(`[MCP Server] Remote device "${name}" disconnected, reconnecting in 5s...`);
    onDisconnect?.();
    setTimeout(() => connectMcpServerToRemote(url, mcpServer, deviceName, onConnect, onDisconnect), 5000);
  });
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
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (url.pathname === '/mcp/ws') {
      const user = authenticateMcpUpgradeRequest(request);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const transport = new WebSocketServerTransport(ws, request);
        onConnection(transport, request, user);
      });
    }
  });

  return wss;
}
