import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { commitDatabaseTables, initDatabase, readDatabaseTables } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { personalityRegistry } from '../server/personality';
import * as memory from '../server/memory';
import * as rag from '../server/agents/rag';
import * as knowledge from '../server/knowledge/conversation_retrieval';
import * as contacts from '../server/contacts/store';
import * as contactContext from '../server/contacts/context';
import * as clientSelf from '../server/client/self_model';
import * as capabilityContext from '../server/cognition/capability_context';
import * as professions from '../server/autonomy/professions';
import * as personaEngine from '../server/personality/engine';
import { retrieveChatContext } from '../server/socket/chat/context_retrieval';
import { prepareChatPromptContext } from '../server/socket/chat/prompt_context';
import { prepareChatModelTurn } from '../server/socket/chat/model_execution';
import { prepareModelRequestContext, resolveAnnotatedSourceUserIndex } from '../server/llm/request_context_budget';
import { formatDeepSeekRequest } from '../server/llm/provider/openai_compatible';
import { getPrimaryUserText } from '../server/llm/tool_loop/summaries';

beforeAll(() => initDatabase());
afterEach(() => vi.restoreAllMocks());

describe('normal chat uses native history and explicitly obtained sources', () => {
  it('injects retrieved scoped saved memory while excluding generated summaries, topics and unrelated context and retaining complete native history', async () => {
    const uid = 'native-context-' + randomUUID();
    const conversation = getOrCreateActiveConversation(uid, 'lumi', 'personal', '');
    const currentId = randomUUID(), requestId = 'request-' + randomUUID();
    const longHistory = 'HISTORY START ' + 'ordinary native discussion. '.repeat(400) + ' EXACT NATIVE MIDDLE ' + 'more supplied material. '.repeat(400) + ' HISTORY END';
    const text = 'Answer from the supplied discussion and the attached material without creating files.';
    const db = readDatabaseTables(['conversations', 'interactions']);
    const stored = db.conversations.find(row => row.id === conversation.id)!;
    stored.summary = 'AUTO-SUMMARY-DO-NOT-INJECT';
    stored.recentTopics = ['AUTO-TOPIC-DO-NOT-INJECT'];
    db.interactions.push({ id: randomUUID(), userId: uid, conversationId: conversation.id, role: 'user', message: longHistory, timestamp: new Date(Date.now() - 1000).toISOString() },
      { id: currentId, userId: uid, conversationId: conversation.id, role: 'user', message: text, requestId, externalMessageId: requestId, source: 'chat', channel: 'chat', timestamp: new Date().toISOString() });
    commitDatabaseTables(db);
    const savedMemory = memory.addMemory({ userId: uid, type: 'preference',
      content: 'For the native discussion and supplied material, the owner prefers concise replies.',
      keywords: ['discussion', 'material'], confidence: 0.95, sourceInteractionId: 'prior-dialogue-' + randomUUID(),
      source: 'chat', domain: 'personal', orgId: '', privacyClass: 'private', retention: 'long_term',
    }, { agentId: 'lumi', generateEmbedding: false });
    const personality = personalityRegistry.getDefault();
    const build = vi.spyOn(personalityRegistry, 'buildSystemPrompt').mockImplementation((_id, _context, options) => ({
      config: personality, systemPrompt: 'Actual user-configured personality.\n\n' + memory.formatMemoriesForContext(options?.memories || [], { currentTurnText: text }),
    }));
    const base: any = { uid, conversationId: conversation.id, requestId, acceptedUserMessageId: currentId, text, visibleUserText: text,
      resolvedDomain: 'personal', resolvedOrgId: '', isMemoryAvatar: false, personalityId: 'lumi', conversationAgentId: 'lumi',
      conversationMode: '', operationMode: 'assistant',
      requestScope: { domain: 'personal', orgId: '' }, turnAuthorization: { assertCurrent: () => {} },
      ragChunks: ['AUTO-RAG-DO-NOT-INJECT'], kbContext: 'AUTO-KB-DO-NOT-INJECT', attachments: [{ path: 'D:/fixtures/explicit-source.txt' }],
      persistedConversationHistory: [], sensoryFn: () => ({}), buildNaturalReplyStyleOverlay: () => '',
      toolSecurityContext: { executionBoundary: 'local' }, eventSource: 'chat', activeProvider: 'relay', activeModel: 'fixture-model',
      toolSessionActive: false, modelCapabilityPolicy: { maxIterations: 4 }, effectiveOperationMode: 'assistant', abortController: new AbortController(),
      allToolRecords: [], actionTaskExecution: {}, desktopRelay: { getControlPauseReason: () => null }, markTurnTiming: () => {},
      emitToolLifecycle: () => {}, emitAgent: () => {}, formatToolResultForUi: (s: string) => s, formatMediaArtifactReceiptForUi: () => undefined,
      rememberRequestToolRecord: () => {}, taskAwareRecords: (records: any[]) => records, isChatCancelled: () => false };
    vi.spyOn(contacts, 'matchContactsFromText').mockReturnValue([{ name: 'Named contact' }] as any);
    vi.spyOn(contactContext, 'formatContactsForContext').mockReturnValue('AUTO-CONTACT-DO-NOT-INJECT');
    const loaded = await retrieveChatContext(base);
    expect(loaded.relevantMemories).toEqual([expect.objectContaining({ id: savedMemory.id, userId: uid, sourceInteractionId: savedMemory.sourceInteractionId })]);
    const setup = await prepareChatPromptContext({ ...base, ...loaded });
    const assembled = await setup.assemble({ turnIntent: { flow: { promptOverlay: '', currentAttachmentPaths: [], routeText: '' }, promptOverlay: '' }, executionRequested: false } as any);
    const turn = await prepareChatModelTurn({ ...base, ...assembled } as any);
    expect(JSON.stringify(turn.messages)).not.toMatch(/AUTO-(?:SUMMARY|TOPIC|RAG|KB|CONTACT)-DO-NOT-INJECT/);
    expect(build.mock.calls[0][2]?.memories).toEqual(loaded.relevantMemories);
    expect(turn.messages[0].content).toContain(savedMemory.content);
    expect(turn.messages[0].content).toContain('source=chat; interaction=' + savedMemory.sourceInteractionId);
    expect(turn.messages).toContainEqual({ role: 'user', content: longHistory });
    expect(turn.messages.at(-1)).toEqual({ role: 'user', content: text, sourceMessageId: currentId });
    expect(turn.messages[0].content).toBe(assembled.effectiveSystemPrompt);
    expect(turn.messages.filter(message => message.sourceMessageId)).toHaveLength(1);
    expect(setup.planning.userText).toBe(text);
    expect(assembled.executionTaskText).toBe(text);
    expect(assembled.turnFlow.currentAttachmentPaths).toEqual(['D:/fixtures/explicit-source.txt']);
    expect(getPrimaryUserText(turn.messages)).toBe(text);
    const prepared = prepareModelRequestContext({ messages: turn.messages, toolDeclarations: [], inputTokenBudget: 12000 });
    expect(resolveAnnotatedSourceUserIndex(prepared.messages)).toBe(prepared.messages.length - 1);
    const wire = formatDeepSeekRequest({ model: 'fixture-model', messages: prepared.messages, toolDeclarations: [], maxTokens: 512 });
    expect(wire.messages).toContainEqual({ role: 'user', content: longHistory });
    expect(wire.messages.at(-1)).toMatchObject({ role: 'user', content: text });
    expect(readDatabaseTables(['conversations']).conversations.find(row => row.id === conversation.id)!.summary).toBe('AUTO-SUMMARY-DO-NOT-INJECT');
  });

  it('loads scoped local saved memory and configured personality without vector, agent RAG or knowledge queries', async () => {
    const query = vi.spyOn(memory, 'queryMemories').mockReturnValue([]);
    const vector = vi.spyOn(memory, 'queryMemoriesVector').mockRejectedValue(new Error('unexpected vector query'));
    const chunks = vi.spyOn(rag, 'retrieveChunks').mockRejectedValue(new Error('automatic agent RAG query'));
    const kb = vi.spyOn(knowledge, 'retrieveConversationKnowledge').mockRejectedValue(new Error('automatic knowledge query'));
    const uid = 'no-auto-retrieval-' + randomUUID();
    const loaded = await retrieveChatContext({ uid, text: 'A normal conversation', personalityId: 'lumi', conversationAgentId: 'lumi',
      resolvedDomain: 'personal', resolvedOrgId: '', requestScope: { domain: 'personal', orgId: '' }, isMemoryAvatar: false,
      abortController: new AbortController(), turnAuthorization: { assertCurrent: () => {} }, markTurnTiming: () => {} } as any);
    expect(loaded.personalityConfig).toBeTruthy();
    expect(loaded.emotionalState).toBeTruthy();
    expect(loaded.himState).toBeTruthy();
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ userId: uid, domain: 'personal', orgId: '',
      agentIds: ['', 'lumi'], recordRetrieval: false, useVector: false }));
    expect(loaded.relevantMemories).toEqual([]);
    expect(vector).not.toHaveBeenCalled();
    expect(chunks).not.toHaveBeenCalled();
    expect(kb).not.toHaveBeenCalled();
  });
  it('keeps explicit persona, mode, confirmation and continuation without injecting guessed capability or response instructions', async () => {
    const personality = personalityRegistry.getDefault();
    vi.spyOn(personalityRegistry, 'buildSystemPrompt').mockReturnValue({config:personality,systemPrompt:'EXPLICIT PERSONA'});
    vi.spyOn(personaEngine, 'buildModeOverlay').mockReturnValue('EXPLICIT USER MODE');
    const client = vi.spyOn(clientSelf, 'formatClientSelfPromptForTurn').mockReturnValue('AUTOMATIC CLIENT INSTRUCTIONS');
    const capability = vi.spyOn(capabilityContext, 'buildLumiRuntimeCapabilityContext').mockReturnValue('AUTOMATIC CAPABILITY INVENTORY');
    const profession = vi.spyOn(professions, 'buildProfessionOverlay').mockReturnValue('AUTOMATIC GUESSED PROFESSION');
    const naturalStyle = vi.fn(()=>'AUTOMATIC REPLY STYLE');
    const text = 'The current user instruction.';
    const setup = await prepareChatPromptContext({uid:'explicit-context',text,visibleUserText:text,personalityId:'lumi',conversationAgentId:'lumi',conversationId:'context-only',
      resolvedDomain:'personal',resolvedOrgId:'',conversationMode:'user-selected',operationMode:'assistant',isMemoryAvatar:false,attachments:[],persistedConversationHistory:[],
      sensoryFn:()=>({}),buildNaturalReplyStyleOverlay:naturalStyle,pendingConfirmationPrompt:'ACTUAL PENDING CONFIRMATION',actionContinuationBridge:'ACTUAL CONTINUATION',
      toolSecurityContext:{executionBoundary:'local'},eventSource:'chat'} as any);
    const assembled = await setup.assemble({turnIntent:{promptOverlay:'AUTOMATIC DECISION ORDER',flow:{promptOverlay:'AUTOMATIC FLOW GOVERNANCE',routeText:text,currentAttachmentPaths:[]}},executionRequested:true} as any);
    expect(assembled.effectiveSystemPrompt).toBe('EXPLICIT PERSONA\n\nEXPLICIT USER MODE\n\nACTUAL PENDING CONFIRMATION\n\nACTUAL CONTINUATION');
    expect(client).not.toHaveBeenCalled();expect(capability).not.toHaveBeenCalled();expect(profession).not.toHaveBeenCalled();expect(naturalStyle).not.toHaveBeenCalled();
    expect(setup.planning.userText).toBe(text);
    expect(setup.planning.registry).toBeTruthy();expect(setup.planning.personalityToolPolicy).toBe(personality.toolPolicy);
    expect(setup.planning.dispatch.continuationContext).toBe('ACTUAL CONTINUATION\n\nACTUAL PENDING CONFIRMATION');
  });
});
