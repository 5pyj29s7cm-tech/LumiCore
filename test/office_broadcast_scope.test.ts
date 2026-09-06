import './helpers';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeApp, JWT_SECRET } from './helpers';
import { setupMcpServer } from '../server/runtime/mcp_server';
import { initSocketRuntime } from '../server/runtime/socket';
import { WebSocketServerTransport } from '../server/mcp/ws_transport';
import { mcpManager } from '../server/mcp/client';
import { toolRegistry } from '../server/tools/registry';
import { registerOfficeTools } from '../server/tools/definitions/office_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { buildSocketToolSecurityContext } from '../server/socket/scope';
import { getDataRoot } from '../server/config/data_path';
import { createOrg, addMember } from '../server/org/db';

let app: Awaited<ReturnType<typeof makeApp>>;
let io: Server;
let shutdown: () => Promise<void>;
const sockets: Socket[] = [];
const mcpClients: Client[] = [];
const getter = () => null;
const llm = { getDeepSeek: getter, getGemini: getter, getOpenAI: getter, getAnthropic: getter,
  getQwen: getter, getArk: getter, getOllama: getter, getLmStudio: getter,
  getXiaomi: getter, getKimi: getter, getGlm: getter, getRelay: getter,
  isOllamaAvailable: () => false, isLmStudioAvailable: () => false };
beforeAll(async () => {
  app = await makeApp();
  vi.spyOn(mcpManager, 'getRemoteDevices').mockReturnValue({});
  vi.stubGlobal('fetch', () => { throw new Error('Office audit forbids network fetch and model calls'); });
  io = new Server(app.server, { transports: ['websocket'] });
  initSocketRuntime({ io, llm, jwtSecret: JWT_SECRET });
  registerOfficeTools(toolRegistry);
  shutdown = setupMcpServer(app.app, app.server, io, llm, process.cwd());
});
afterAll(async () => {
  for (const client of mcpClients) await client.close();
  await shutdown();
  for (const socket of sockets) socket.disconnect();
  await new Promise<void>(resolve => io.close(() => resolve()));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function observer(userId: string, orgId = '') {
  const token = jwt.sign({ uid: userId, username: userId, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET);
  const socket = connect(app.url, { transports: ['websocket'], auth: { token } }); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const events: any[] = [];
  socket.on('mcp:activity', data => events.push(data));
  expect(io.sockets.sockets.get(socket.id!)?.rooms.has(orgId ? `user:${userId}:org:${orgId}` : `user:${userId}:personal`)).toBe(true);
  return { userId, token, socket, events };
}
async function mcp(token: string) {
  const ws = new WebSocket(`${app.url.replace('http:', 'ws:')}/mcp/ws`, { headers: { Authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  const client = new Client({ name: 'isolated-office-audit', version: '1' }); mcpClients.push(client);
  await client.connect(new WebSocketServerTransport(ws));
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
}
async function create(userId: string, title: string, remote = false, orgId = '') {
  const requestId = randomUUID();
  const context = {
    ...buildSocketToolSecurityContext({ data: { authenticatedUserId: userId, authenticatedRole: 'user', trustedLocalExecution: !remote } } as any,
      { domain: orgId ? 'work' : 'personal', orgId }),
    userId, domain: orgId ? 'work' as const : 'personal' as const, orgId, source: 'chat', requestId, turnId: requestId,
    taskId: requestId, idempotencyKey: requestId, currentTurnExecutionRequested: true,
    actionIntent: 'Create the requested synthetic presentation file.', requestConfirmation: async () => true,
  };
  return executeToolCall({ registry: toolRegistry, name: 'create_ppt', arguments: { title, slides: [{ title: 'Synthetic slide', bullets: ['No real user content'] }] }, context });
}

it('a single owner MCP connection routes that owners real PPT activity only to their Socket room', async () => {
  const a = await observer(`office-owner-${randomUUID()}`);
  const b = await observer(`office-other-${randomUUID()}`);
  await mcp(a.token);
  const title = `SYNTHETIC_OWNER_ONLY_${randomUUID()}`;
  const result = await create(a.userId, title);
  const artifact = JSON.parse(result.result!);
  expect(artifact.status).toBe('created');
  expect(artifact.outputPath.startsWith(getDataRoot())).toBe(true);
  expect(fs.statSync(artifact.outputPath).size).toBeGreaterThan(0);
  await vi.waitFor(() => expect(a.events.some(event => event.path === artifact.outputPath)).toBe(true));
  expect(a.events.some(event => event.title === title)).toBe(true);
  expect(b.events).toEqual([]);
});

it('concurrent PPT activity stays in the exact original user, domain and organization', async () => {
  const userId = `office-multiple-${randomUUID()}`;
  const orgA = createOrg('Synthetic Office A', randomUUID(), userId).id;
  const orgB = createOrg('Synthetic Office B', randomUUID(), userId).id;
  addMember(orgA, userId, 'owner'); addMember(orgB, userId, 'owner');
  const otherId = `office-colleague-${randomUUID()}`;
  addMember(orgA, otherId, 'member');
  const a = await observer(userId, orgA);
  const b = await observer(userId, orgB);
  const personal = await observer(userId);
  const colleague = await observer(otherId, orgA);
  await mcp(colleague.token);
  const titleA = `SYNTHETIC_A_${randomUUID()}`, titleB = `SYNTHETIC_B_${randomUUID()}`;
  const [resultA, resultB] = await Promise.all([create(userId, titleA, false, orgA), create(userId, titleB, false, orgB)]);
  const fileA = JSON.parse(resultA.result!).outputPath, fileB = JSON.parse(resultB.result!).outputPath;
  await vi.waitFor(() => { expect(a.events.some(event => event.path === fileA)).toBe(true); expect(b.events.some(event => event.path === fileB)).toBe(true); });
  expect(a.events.some(event => event.title === titleA)).toBe(true);
  expect(b.events.some(event => event.title === titleB)).toBe(true);
  expect(a.events.some(event => event.path === fileB || event.title === titleB)).toBe(false);
  expect(b.events.some(event => event.path === fileA || event.title === titleA)).toBe(false);
  expect(personal.events).toEqual([]); expect(colleague.events).toEqual([]);
});

it('later other-user MCP connections cannot redirect the native owners PPT title and path', async () => {
  const a = await observer(`office-native-${randomUUID()}`);
  const b = await observer(`office-later-${randomUUID()}`);
  await mcp(a.token);
  await mcp(b.token);
  const denied = await create(b.userId, 'SYNTHETIC_REMOTE_DENIED', true);
  expect(denied.error).toBeTruthy();
  expect(a.events).toEqual([]); expect(b.events).toEqual([]);
  const title = `SYNTHETIC_A_PRIVATE_TITLE_${randomUUID()}`;
  const result = await create(a.userId, title);
  const artifact = JSON.parse(result.result!);
  expect(artifact.status).toBe('created');
  expect(fs.statSync(artifact.outputPath).size).toBeGreaterThan(0);
  await vi.waitFor(() => expect(a.events.some(event => event.path === artifact.outputPath)).toBe(true));
  expect(a.events.some(event => event.title === title)).toBe(true);
  expect(b.events).toEqual([]);
});
