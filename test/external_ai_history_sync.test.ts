import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, flushDB, initDatabase, readDB, writeDB } from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import {
  configureExternalAiHistoryRuntimeForTests,
  externalAiHistoryStatus,
  queryExternalAiHistory,
  recoverInterruptedExternalAiHistorySyncs,
  registerExternalAiHistorySource,
  resetExternalAiHistoryForTests,
  resolveExternalAiHistoryDesktopVisionForTests,
  revokeExternalAiHistorySource,
  syncExternalAiHistory,
} from '../server/agents/external_ai_history_sync';
import { saveLocalModelConfig } from '../server/llm/local_models';
import { upsertUserPreferredVision } from '../server/llm/vision_preferences';
import { registerExternalAiHistoryTools } from '../server/tools/definitions/external_ai_history_tools';
import { ToolRegistry } from '../server/tools/registry';

let sequence = 0;

function id(label: string): string {
  sequence += 1;
  return `${label}-${Date.now()}-${sequence}`;
}

function context(extras: Record<string, any> = {}) {
  return {
    userId: 'external-ai-history-user',
    domain: 'personal' as const,
    userConfirmed: true,
    taskId: id('history-task'),
    requestId: id('history-request'),
    ...extras,
  };
}

function registerSource(
  overrides: Record<string, any> = {},
  ctx = context(),
): any {
  return JSON.parse(registerExternalAiHistorySource({
    sourceKind: 'connector',
    targetId: 'chatgpt',
    scopes: ['conversation_list', 'message_metadata', 'message_content', 'attachment_metadata'],
    allowAllConversations: true,
    connectorToolName: 'chatgpt_history_read_test',
    ...overrides,
  }, ctx));
}

describe('authorized external AI history synchronization', () => {
  beforeEach(async () => {
    await initDatabase();
    resetExternalAiHistoryForTests({ clearPersisted: true });
    await flushDB();
  });

  afterEach(async () => {
    configureExternalAiHistoryRuntimeForTests(null);
    resetExternalAiHistoryForTests({ clearPersisted: true });
    await flushDB();
  });

  it('requires confirmation, rejects credentials, and binds changed scope as a new authorization', () => {
    expect(() => registerExternalAiHistorySource({
      sourceKind: 'connector', targetId: 'chatgpt', scopes: ['conversation_list', 'message_metadata'],
      allowAllConversations: true, connectorToolName: 'chatgpt_history_read_test',
    }, { ...context(), userConfirmed: false })).toThrow(/explicit confirmation/i);

    expect(() => registerExternalAiHistorySource({
      sourceKind: 'authorized_session', targetId: 'chatgpt', scopes: ['conversation_list', 'message_metadata'],
      allowAllConversations: true, connectorToolName: 'chatgpt_history_read_test', sessionProfileId: 'profile-1',
      cookie: 'must-never-be-stored',
    }, context())).toThrow(/not allowed/i);

    const first = registerSource({ scopes: ['conversation_list', 'message_metadata'] });
    const duplicate = registerSource({ scopes: ['conversation_list', 'message_metadata'] });
    const expanded = registerSource({ scopes: ['conversation_list', 'message_metadata', 'message_content'] });
    expect(duplicate).toMatchObject({ status: 'already_registered', sourceId: first.sourceId });
    expect(expanded.sourceId).not.toBe(first.sourceId);
    expect(expanded.authorizationDigest).not.toBe(first.authorizationDigest);
    expect(JSON.stringify(readDB().externalAiHistorySources)).not.toContain('must-never-be-stored');
  });

  it('imports a confirmed JSON export page by page and deduplicates messages and attachments', async () => {
    const exportPath = path.join(path.dirname(getDataPath('lumi.db')), id('external-history-export') + '.json');
    fs.writeFileSync(exportPath, JSON.stringify({
      conversations: [
        {
          id: 'conversation-a', title: 'Architecture', messages: [
            { id: 'message-1', role: 'user', content: 'Review the design', createdAt: '2026-07-01T10:00:00.000Z' },
            {
              id: 'message-2', role: 'assistant', content: 'Use durable receipts.', createdAt: '2026-07-01T10:00:01.000Z',
              attachments: [{ id: 'file-1', name: 'review.txt', mimeType: 'text/plain', textContent: 'not authorized' }],
            },
          ],
        },
        { id: 'conversation-b', title: 'Testing', messages: [{ id: 'message-3', role: 'assistant', content: 'Inject failures.' }] },
      ],
    }), 'utf8');
    const ctx = context();
    const source = registerSource({
      sourceKind: 'export',
      targetId: 'chatgpt',
      scopes: ['conversation_list', 'message_metadata', 'message_content', 'attachment_metadata'],
      connectorToolName: undefined,
      exportPath,
    }, ctx);

    const first = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId, pageSize: 1, maxPages: 1 }, ctx));
    expect(first).toMatchObject({ status: 'partial', pageCount: 1, nextCursor: '1', completeness: 'incremental' });
    const completed = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId, jobId: first.jobId, pageSize: 1, maxPages: 2 }, ctx));
    expect(completed).toMatchObject({ status: 'completed', counts: { inserted: 3, attachments: 1 } });
    expect(readDB().externalAiHistoryMessages).toHaveLength(3);
    expect(readDB().externalAiHistoryAttachments[0]).not.toHaveProperty('textContent');

    const repeated = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId, pageSize: 2 }, ctx));
    expect(repeated.counts).toMatchObject({ inserted: 0, skipped: 3 });
    expect(readDB().externalAiHistoryMessages).toHaveLength(3);
    expect(readDB().externalAiHistoryConversations).toHaveLength(2);

    const queried = JSON.parse(queryExternalAiHistory({ sourceId: source.sourceId, query: 'durable' }, ctx));
    expect(queried.messages).toHaveLength(1);
    expect(queried.messages[0]).toMatchObject({ sourceExternalMessageId: 'message-2', content: 'Use durable receipts.' });
    expect(queried.messages[0].sourceEvidence).toMatchObject({ sourceKind: 'export', targetId: 'chatgpt' });

    const contentAuthorized = registerSource({
      sourceKind: 'export',
      targetId: 'chatgpt',
      scopes: ['conversation_list', 'message_metadata', 'message_content', 'attachment_metadata', 'attachment_content'],
      connectorToolName: undefined,
      exportPath,
    }, context());
    await syncExternalAiHistory({ sourceId: contentAuthorized.sourceId, pageSize: 2 }, context());
    expect(readDB().externalAiHistoryAttachments.find((item: any) => item.sourceId === contentAuthorized.sourceId)).toMatchObject({
      sourceExternalAttachmentId: 'file-1',
      textContent: 'not authorized',
    });
  });

  it('coalesces concurrent synchronization for the same source and job identity', async () => {
    const ctx = context();
    const source = registerSource({}, ctx);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const connector = vi.fn(async () => {
      await gate;
      return {
        conversations: [{ id: 'coalesced', messages: [{ id: 'coalesced-message', role: 'assistant', content: 'once' }] }],
        hasMore: false,
        completeness: 'complete',
      };
    });
    configureExternalAiHistoryRuntimeForTests({ connector });

    const first = syncExternalAiHistory({ sourceId: source.sourceId }, ctx);
    const second = syncExternalAiHistory({ sourceId: source.sourceId }, ctx);
    await Promise.resolve();
    expect(connector).toHaveBeenCalledTimes(1);
    release();
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
    expect(secondReceipt).toBe(firstReceipt);
    expect(JSON.parse(firstReceipt)).toMatchObject({ status: 'completed', counts: { inserted: 1 } });
    expect(readDB().externalAiHistoryMessages).toHaveLength(1);
    expect(readDB().externalAiHistorySyncJobs).toHaveLength(1);
  });

  it('validates an exact read-only adapter, checkpoints cursors, filters unauthorized conversations, and versions conflicts', async () => {
    const registry = new ToolRegistry();
    const pages = [
      {
        conversations: [
          { id: 'allowed', messages: [{ id: 'm1', role: 'assistant', content: 'version one' }] },
          { id: 'outside', messages: [{ id: 'm2', role: 'assistant', content: 'must be skipped' }] },
        ],
        nextCursor: 'page-2', hasMore: true, completeness: 'incremental',
      },
      { conversations: [{ id: 'allowed', messages: [{ id: 'm3', role: 'user', content: 'second page' }] }], hasMore: false, completeness: 'complete' },
    ];
    const adapter = vi.fn(async (args: Record<string, any>) => JSON.stringify(args.cursor ? pages[1] : pages[0]));
    registry.register({
      name: 'chatgpt_history_read_test',
      description: 'ChatGPT read-only paginated history connector.',
      parameters: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'number' } } },
      permission: 'user', securityLevel: 'safe',
      capability: {
        id: 'chatgpt.history.read.test', family: 'chatgpt-history', lane: 'agents', source: 'mcp', provider: 'chatgpt',
        operation: 'observe', risk: 'low', tags: ['chatgpt', 'history'],
        sideEffects: [{ type: 'network_read', scope: 'chatgpt history', reversible: true }],
        verification: { strategy: 'terminal_receipt', required: true, requiredFields: [], successSignals: [], limitations: [] },
      },
      evidence: { capability: 'chatgpt.history.read.test', operation: 'observe', assurance: 'verified' },
      handler: adapter,
    });
    const ctx = context({ toolRegistry: registry });
    const source = registerSource({ allowAllConversations: false, allowedConversationIds: ['allowed'] }, ctx);
    const result = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId, pageSize: 20, maxPages: 5 }, ctx));
    expect(result).toMatchObject({ status: 'completed', pageCount: 2, counts: { inserted: 2 } });
    expect(result.limitations.join(' ')).toContain('outside the authorized conversation scope');
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(adapter.mock.calls[1][0].cursor).toBe('page-2');
    expect(readDB().externalAiHistoryMessages.map((item: any) => item.content)).toEqual(['version one', 'second page']);

    configureExternalAiHistoryRuntimeForTests({ connector: async () => ({
      conversations: [{ id: 'allowed', messages: [{ id: 'm1', role: 'assistant', content: 'version two' }] }],
      hasMore: false, completeness: 'complete',
    }) });
    const conflict = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId }, ctx));
    expect(conflict.counts).toMatchObject({ updated: 1, conflicted: 1 });
    expect(readDB().externalAiHistoryMessages.find((item: any) => item.sourceExternalMessageId === 'm1')).toMatchObject({
      content: 'version two', version: 2, conflict: true,
    });
  });

  it('rejects connector manifests that can communicate or mutate', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'chatgpt_history_read_test', description: 'ChatGPT unsafe history connector.',
      parameters: { type: 'object', properties: {} }, permission: 'user', securityLevel: 'confirm',
      capability: {
        id: 'chatgpt.history.unsafe', family: 'chatgpt', lane: 'agents', source: 'mcp', provider: 'chatgpt',
        operation: 'communicate', risk: 'high', sideEffects: [{ type: 'external_communication', scope: 'chatgpt', reversible: false }],
        verification: { strategy: 'provider_ack', required: true, requiredFields: [], successSignals: [], limitations: [] },
      },
      handler: async () => JSON.stringify({ conversations: [] }),
    });
    const ctx = context({ toolRegistry: registry });
    const source = registerSource({}, ctx);
    const result = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId }, ctx));
    expect(result).toMatchObject({ status: 'blocked', blocker: 'authorized_source_unavailable' });
    expect(result.error).toMatch(/observe-only/i);
  });

  it('marks desktop-visible reads as incomplete and prefers a healthy local vision model', async () => {
    const ctx = context({
      llmGetters: {
        getDeepSeek: () => null, getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => null,
        getQwen: () => null, getArk: () => null, getOllama: () => ({}), getLmStudio: () => null, getRelay: () => null,
      },
    });
    upsertUserPreferredVision(ctx.userId, { provider: 'openai', model: 'gpt-4o' });
    saveLocalModelConfig('ollama', {
      baseUrl: 'http://127.0.0.1:11434', detected: true, serviceReachable: true, inferenceHealthy: true,
      healthStatus: 'healthy', models: ['qwen2.5vl:7b'], updatedAt: new Date().toISOString(),
    });
    const source = registerSource({
      sourceKind: 'desktop_visible', connectorToolName: undefined,
      scopes: ['conversation_list', 'message_metadata', 'message_content'], allowCloudVision: true,
    }, ctx);
    const sourceRecord = readDB().externalAiHistorySources.find((item: any) => item.id === source.sourceId);
    await expect(resolveExternalAiHistoryDesktopVisionForTests(sourceRecord, ctx)).resolves.toEqual({ provider: 'ollama', model: 'qwen2.5vl:7b' });

    configureExternalAiHistoryRuntimeForTests({ desktopVisible: async () => ({
      conversations: [{ id: 'visible-current', messages: [{ id: 'visible-1', role: 'assistant', content: 'visible only' }] }],
      nextCursor: '', hasMore: false, completeness: 'partial_visible',
      limitations: ['Only the current visible viewport was read; no automatic scrolling occurred.'],
      evidence: { screenshotDigest: 'screen-digest', extractionProvider: 'ollama', extractionModel: 'qwen2.5vl:7b' },
    }) });
    const result = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId }, ctx));
    expect(result).toMatchObject({ status: 'completed', completeness: 'partial_visible' });
    expect(result.note).toMatch(/foreground viewport/i);
    expect(readDB().externalAiHistoryMessages[0].sourceEvidence).toMatchObject({
      completeness: 'partial_visible', screenshotDigest: 'screen-digest', extractionProvider: 'ollama',
    });
  });

  it('persists a page checkpoint across restart and recovers running jobs without duplicating messages', async () => {
    const ctx = context();
    const source = registerSource({}, ctx);
    configureExternalAiHistoryRuntimeForTests({ connector: async (_source, cursor) => ({
      conversations: [{ id: 'restart-conversation', messages: [{ id: cursor ? 'm2' : 'm1', role: 'assistant', content: cursor ? 'after restart' : 'before restart' }] }],
      nextCursor: cursor ? '' : 'resume-here', hasMore: !cursor, completeness: cursor ? 'complete' : 'incremental',
    }) });
    const partial = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId, maxPages: 1 }, ctx));
    expect(partial).toMatchObject({ status: 'partial', nextCursor: 'resume-here' });
    const db = readDB();
    const job = db.externalAiHistorySyncJobs.find((item: any) => item.id === partial.jobId);
    job.status = 'running';
    writeDB(db);
    await flushDB();
    await closeDatabase();
    await initDatabase();

    expect(recoverInterruptedExternalAiHistorySyncs()).toBe(1);
    const recovered = readDB().externalAiHistorySyncJobs.find((item: any) => item.id === partial.jobId);
    expect(recovered).toMatchObject({ status: 'interrupted', nextCursor: 'resume-here' });
    const completed = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId, jobId: partial.jobId }, ctx));
    expect(completed).toMatchObject({ status: 'completed', counts: { inserted: 2 } });
    expect(readDB().externalAiHistoryMessages).toHaveLength(2);
  });

  it('isolates personal/work sources and stops future reads after revocation', async () => {
    const personal = context();
    const work = context({ domain: 'work' as const, orgId: 'org-1' });
    const source = registerSource({}, personal);
    expect(() => externalAiHistoryStatus({ sourceId: source.sourceId }, work)).toThrow(/not found/i);
    expect(JSON.parse(revokeExternalAiHistorySource({ sourceId: source.sourceId }, personal))).toMatchObject({ status: 'revoked' });
    const blocked = JSON.parse(await syncExternalAiHistory({ sourceId: source.sourceId }, personal));
    expect(blocked).toMatchObject({ status: 'blocked', blocker: 'authorization_revoked' });
  });

  it('registers all six history tools with explicit receipt contracts', () => {
    const registry = new ToolRegistry();
    registerExternalAiHistoryTools(registry);
    expect(registry.list().map(tool => tool.name)).toEqual([
      'external_ai_history_source_register',
      'external_ai_history_source_list',
      'external_ai_history_source_revoke',
      'external_ai_history_sync',
      'external_ai_history_status',
      'external_ai_history_query',
    ]);
    expect(registry.getCapabilityManifestEntry('external_ai_history_sync')).toMatchObject({
      operation: 'observe', risk: 'medium', hasEvidenceContract: true,
    });
  });
});
