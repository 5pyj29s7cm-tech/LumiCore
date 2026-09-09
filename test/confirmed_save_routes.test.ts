import { makeApp, JWT_SECRET } from './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as database from '../db_layer';
import { mountContactsRoutes } from '../server/routes/contacts_routes';
import { mountMemoryRoutes } from '../server/routes/memory_routes';
import { mountSystemRoutes } from '../server/routes/system_routes';
import { lapRoutes } from '../server/lap/routes';
import { createSession } from '../server/lap/session';
import { getLocalAgent } from '../server/lap/transport';
import { claimSession } from '../server/lap/access';
import { shareContext, getActiveSharedContexts } from '../server/lap/context';

vi.mock('../server/llm/embedding_provider', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/embedding_provider')>(),
  generateConfiguredEmbedding: vi.fn(async () => ({ provider: 'openai', model: 'synthetic', vector: [1, 0] })),
}));

describe('save responses wait for durable persistence', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  const userId = 'confirmed-save-user';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ uid: userId, username: userId }, JWT_SECRET)}` };
  beforeAll(async () => {
    app = await makeApp();
    mountContactsRoutes(app.apiRouter, JWT_SECRET);
    mountMemoryRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: () => null, getGemini: () => null });
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit() {} }, { getDeepSeek: () => null });
    app.apiRouter.use(lapRoutes);
  });
  it('does not report tool preferences saved after a persistence failure', async () => {
    const flush = vi.spyOn(database, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic disk failure'));
    try {
      const response = await fetch(`${app.url}/api/settings`, {
        method: 'POST', headers,
        body: JSON.stringify({ key: 'tool_overrides', value: { web_search: { enabled: false } } }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE', persistence: 'pending' });
    } finally { flush.mockRestore(); }
  });
  afterAll(() => app.cleanup());
  it.each([
    ['/contacts', { name: 'Synthetic contact', relationship: 'friend' }],
    ['/reminders', { content: 'Synthetic reminder', dueAt: '2030-01-01T00:00:00Z' }],
  ])('returns a pending save error for %s when disk persistence fails', async (route, body) => {
    const flush = vi.spyOn(database, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic disk failure'));
    try {
      const response = await fetch(`${app.url}/api${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE', persistence: 'pending', retryable: false });
      expect(flush).toHaveBeenCalled();
    } finally { flush.mockRestore(); }
  });
  it('does not acknowledge LAP memory absorption before the save succeeds', async () => {
    const peer = { agentId: 'synthetic-peer', userId: 'peer-user', name: 'Peer', publicKey: 'synthetic', capabilities: ['memory'] };
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const session = createSession(peer, getLocalAgent(), 'public', ['share_context'], scope);
    expect(claimSession({ sessionId: session.sessionId, peerAgentId: peer.agentId, scope }).ok).toBe(true);
    shareContext({ lap: '2.0', id: 'synthetic-context', timestamp: new Date().toISOString(), sessionId: session.sessionId, method: 'lap.context.share', contexts: [{ type: 'knowledge', scope: 'session', payload: 'A public synthetic observation.', confidence: 0.5 }] }, session);
    const entry = getActiveSharedContexts(session.sessionId)[0];
    expect(entry).toBeDefined();
    const flush = vi.spyOn(database, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic disk failure'));
    try {
      const response = await fetch(`${app.url}/api/lap/sessions/${session.sessionId}/contexts/${entry.id}/absorb`, { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ persistence: 'pending' });
      expect(flush).toHaveBeenCalled();
    } finally { flush.mockRestore(); }
  });
});
