import { makeApp } from './helpers';
import { afterEach, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({ model: vi.fn(), retrieval: vi.fn(), extract: vi.fn() }));
vi.mock('../server/llm/adapter', async original => ({ ...await original<typeof import('../server/llm/adapter')>(), runWithTools: mocks.model }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCallStreaming: mocks.model, makeLLMCall: mocks.model }));
vi.mock('../server/memory', async original => ({
  ...await original<typeof import('../server/memory')>(), queryMemories: vi.fn(() => []), queryMemoriesVector: mocks.retrieval,
  extractMemories: mocks.extract,
}));
vi.mock('../server/agents/rag', async original => ({ ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []) }));

import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { getMessages, getOrCreateActiveConversation } from '../server/conversation/manager';
import { createMemoryAvatar, addMemoryAvatarMaterial, removeMemoryAvatarMaterial, archiveMemoryAvatar } from '../server/memory_avatar/store';
import { waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';

const marker = 'AVATAR_SYNTHETIC_PRIVATE_RESPONSE';
const outcome = () => ({ text: marker, toolCalls: [], usageRecords: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
let io: Server;
let client: Socket;
let sequence = 0;
const releasePending: Array<() => void> = [];
afterEach(async () => {
  releasePending.splice(0).forEach(release => release());
  client?.close();
  if (io) await new Promise<void>(resolve => io.close(() => resolve()));
  await waitForChatExecutionPersistence();
  vi.clearAllMocks();
});
async function openAvatarChat() {
  const app = await makeApp();
  const userId = `avatar-chat-owner-${++sequence}`;
  const avatar = await createMemoryAvatar({ userId, name: 'Private companion', clientRequestId: 'create', narrative: 'This companion remembers a synthetic lake.' });
  const material = await addMemoryAvatarMaterial(userId, avatar.id, { revision: 1, clientRequestId: 'append', title: 'Private diary', kind: 'text', text: 'PRIVATE_AVATAR_SOURCE: the observatory opens on Thursday.' });
  const conversationId = getOrCreateActiveConversation(userId, avatar.id, 'personal', '').id;
  if (!toolRegistry.get('desktop_active_window')) registerAllTools(toolRegistry);
  mocks.retrieval.mockImplementation(async () => []);
  mocks.extract.mockResolvedValue({ memories: [], reminders: [] });
  mocks.model.mockImplementation(async () => outcome());
  io = new Server(app.server, { transports: ['websocket'] });
  io.on('connection', socket => {
    Object.assign(socket.data, { authenticatedUserId: userId, authenticatedRole: 'user', trustedLocalExecution: true });
    socket.join(`user:${userId}:personal`);
    registerChatHandler(socket, {
      getDeepSeek: () => ({}), getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => ({}),
      getQwen: () => ({}), getOllama: () => ({}), isOllamaAvailable: () => false,
      getLmStudio: () => ({}), isLmStudioAvailable: () => false, getRelay: () => ({}),
    }, () => ({ audio: false, visual: false, spatial: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io);
  });
  client = createClient(app.url, { transports: ['websocket'], reconnection: false });
  await new Promise<void>(resolve => client.once('connect', resolve));
  const send = (requestId: string) => client.timeout(5000).emitWithAck('agent:chat', {
    userId, agentId: avatar.id, domain: 'personal', orgId: '', conversationId,
    text: 'Please recall the observatory diary details.', history: [], source: 'command-center-chat', requestId,
  });
  const terminal = (requestId: string) => new Promise<any>(resolve => {
    const listener = (data: any) => { if (data.requestId === requestId) { client.off('agent:response', listener); resolve(data); } };
    client.on('agent:response', listener);
  });
  return { userId, avatar: material.avatar, material: material.material, conversationId, send, terminal };
}

it('supplies the same private materials to the real text handler without enabling tools or learning', async () => {
  const h = await openAvatarChat();
  const response = h.terminal('avatar-normal');
  await h.send('avatar-normal');
  expect((await response).text).toContain(marker);
  expect(JSON.stringify(mocks.model.mock.calls)).toContain('PRIVATE_AVATAR_SOURCE');
  expect(mocks.extract).not.toHaveBeenCalled();
  expect(mocks.retrieval.mock.calls[0][0]).toMatchObject({ userId: h.userId, agentId: h.avatar.id, domain: 'personal', orgId: '' });
  expect(getMessages(h.conversationId, 20).filter((message: any) => message.role === 'assistant').map((message: any) => (message.content || message.message)).join('\n')).toContain(marker);
});

it.each(['archive', 'remove-material'])('cancels a real model turn after %s and never publishes or stores its stale reply', async operation => {
  const h = await openAvatarChat();
  const started = deferred(); const gate = deferred(); releasePending.push(gate.resolve);
  let signal: AbortSignal | undefined;
  mocks.model.mockImplementation(async (...args: any[]) => { signal = args[2]?.signal; started.resolve(); await gate.promise; return outcome(); });
  const response = h.terminal(`avatar-${operation}`);
  await h.send(`avatar-${operation}`);
  await started.promise;
  if (operation === 'archive') await archiveMemoryAvatar(h.userId, h.avatar.id, h.avatar.revision);
  else await removeMemoryAvatarMaterial(h.userId, h.avatar.id, h.material.id, h.avatar.revision);
  expect(signal?.aborted).toBe(true);
  gate.resolve();
  const terminal = await response;
  expect(terminal.reason).toBe('cancelled');
  expect(JSON.stringify(terminal)).not.toContain(marker);
  expect(JSON.stringify(getMessages(h.conversationId, 20))).not.toContain(marker);
  expect(mocks.extract).not.toHaveBeenCalled();
}, 10000);

