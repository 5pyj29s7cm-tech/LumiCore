import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import sqlite3 from 'sqlite3';
import {
  flushDB,
  initDatabase,
  persistLegacySummaryRepairsBestEffort,
  readDB,
  writeDB,
} from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import {
  addMessage,
  beginConversationSummary,
  cancelConversationSummary,
  checkAutoSummary,
  getConversationSummary,
  getMessages,
  getMessagesByTokenBudget,
  getOrCreateActiveConversation,
  setConversationSummary,
} from '../server/conversation/manager';
import { isGuardGeneratedAssistantText } from '../server/conversation/guard_history';

function readPersistedConversationSummary(conversationId: string): Promise<{
  summary: string;
  summaryChain: string;
  lastSummaryMessageCount: number;
}> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'), sqlite3.OPEN_READONLY, error => {
      if (error) reject(error);
    });
    database.get(
      'SELECT summary, summaryChain, lastSummaryMessageCount FROM conversations WHERE id = ?',
      [conversationId],
      (error, row) => {
        database.close();
        if (error) reject(error);
        else resolve(row as any);
      },
    );
  });
}

describe('conversation guard history isolation', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('recognizes legacy verifier reports and standalone desktop relay codes', () => {
    expect(isGuardGeneratedAssistantText([
      '状态：受阻。',
      '证据：暂时没有可核验的执行结果。',
      '下一步：保留已有进度，先核验目标状态再继续。',
    ].join('\n'))).toBe(true);
    expect(isGuardGeneratedAssistantText([
      '状态：失败。',
      '具体阻塞：Desktop execution ended as target_mismatch.',
    ].join('\n'))).toBe(true);
    expect(isGuardGeneratedAssistantText('desktop_active_window returned target_mismatch')).toBe(true);
  });

  it('keeps guard output visible in storage but out of model prompt history', () => {
    const userId = `guard-history-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const guardText = [
      '我还没有真正开始读取或审查：这一轮没有记录到成功的工具执行。',
      '现在能确认的是：这次只是生成了文字回复，没有实际读到文件内容。',
    ].join('\n');

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '你对目前自己的能力是否满意',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: guardText,
      cognitiveIntent: 'work_product_guard',
    });

    expect(getMessages(conversation.id).some(message => message.message === guardText)).toBe(true);
    expect(getMessagesByTokenBudget(conversation.id).some(message => message.message === guardText)).toBe(false);
  });

  it('does not let optional legacy-summary persistence failure block safe startup state', () => {
    const repair = {
      id: 'legacy-readonly-conversation',
      summary: '',
      summaryChain: ['clean earlier summary'],
      lastSummaryMessageCount: 0,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => persistLegacySummaryRepairsBestEffort(
        [repair],
        (_item, complete) => complete(Object.assign(
          new Error('attempt to write a readonly database'),
          { code: 'SQLITE_READONLY' },
        )),
      )).not.toThrow();
      expect(() => persistLegacySummaryRepairsBestEffort(
        [repair],
        () => { throw new Error('database handle is closing'); },
      )).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps legacy combined user text while clearing its marked or recognizable guard response', () => {
    const userId = `guard-combined-history-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const legacyGuard = '我还没有真正操作客户端，这一轮没有记录到成功的工具执行。';

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '你对目前自己的能力是否满意',
      response: legacyGuard,
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '为什么不回我',
      response: '客户端状态还没有拿到。',
      cognitiveIntent: 'work_product_guard',
    });

    const promptHistory = getMessagesByTokenBudget(conversation.id);
    expect(promptHistory.map(message => message.message)).toEqual([
      '你对目前自己的能力是否满意',
      '为什么不回我',
    ]);
    expect(promptHistory.every(message => message.response === '')).toBe(true);
  });

  it('rejects contaminated summaries and accepts the next clean summary', () => {
    const userId = `guard-summary-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const db = readDB();
    const stored = db.conversations.find((item: any) => item.id === conversation.id);
    stored.summary = '用户询问助手能力满意度，助手回应尚未开始实际读取文件。';
    stored.summaryChain = ['用户此前在讨论对话自然度。'];
    stored.lastSummaryMessageCount = -1;
    writeDB(db);

    expect(isGuardGeneratedAssistantText(stored.summary)).toBe(true);
    expect(getConversationSummary(conversation.id)).toBe('Earlier: 用户此前在讨论对话自然度。');

    setConversationSummary(conversation.id, '用户询问了 Lumi 对当前能力的自我评价。');
    expect(getConversationSummary(conversation.id)).toBe([
      '用户询问了 Lumi 对当前能力的自我评价。',
      'Earlier: 用户此前在讨论对话自然度。',
    ].join('\n'));
  });

  it('isolates a legacy current summary and only contaminated chain entries before continuity use', async () => {
    const userId = `guard-summary-load-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const contaminatedCurrent = [
      '用户此前查看过桌面状态，随后询问助手是否满意目前能力，',
      '助手回应尚未开始实际读取文件。',
    ].join('');
    const contaminatedChainEntry = '我还没有真正开始读取或审查：这一轮没有记录到成功的工具执行。';
    const cleanChainEntry = '用户此前讨论了对话自然度和任务连续性。';
    const db = readDB();
    const stored = db.conversations.find((item: any) => item.id === conversation.id);
    stored.summary = contaminatedCurrent;
    stored.summaryChain = [cleanChainEntry, contaminatedChainEntry];
    stored.lastSummaryMessageCount = -1;
    writeDB(db);

    // The ordinary conversation lookup happens before prompt, continuation,
    // and learning consumers. It must expose only the isolated state.
    const resumed = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    expect(resumed).toMatchObject({
      summary: '',
      summaryChain: [cleanChainEntry],
      lastSummaryMessageCount: 0,
    });
    expect(getConversationSummary(conversation.id)).toBe(`Earlier: ${cleanChainEntry}`);

    await flushDB();
    await expect(readPersistedConversationSummary(conversation.id)).resolves.toEqual({
      summary: '',
      summaryChain: JSON.stringify([cleanChainEntry]),
      lastSummaryMessageCount: 0,
    });
  });

  it('preserves clean legacy summaries and positive-marker summaries that discuss the old failure', async () => {
    const cleanLegacyUserId = `guard-summary-clean-legacy-${Date.now()}-${Math.random()}`;
    const cleanLegacy = getOrCreateActiveConversation(cleanLegacyUserId, 'lumi', 'personal', '');
    const db = readDB();
    const cleanLegacyStored = db.conversations.find((item: any) => item.id === cleanLegacy.id);
    cleanLegacyStored.summary = '用户正在评估 Lumi 的对话自然度和能力边界。';
    cleanLegacyStored.summaryChain = ['用户此前完成了客户端稳定性测试。'];
    cleanLegacyStored.lastSummaryMessageCount = -1;

    const positiveUserId = `guard-summary-positive-${Date.now()}-${Math.random()}`;
    const positive = getOrCreateActiveConversation(positiveUserId, 'lumi', 'personal', '');
    const positiveStored = db.conversations.find((item: any) => item.id === positive.id);
    const legitimateMixedSummary = '用户复盘了助手曾回应尚未开始实际读取文件的问题，并要求改进对话连续性。';
    const legitimateMixedChain = '此前测试记录了“这一轮没有记录到成功的工具执行”这一错误回复。';
    positiveStored.summary = legitimateMixedSummary;
    positiveStored.summaryChain = [legitimateMixedChain];
    positiveStored.lastSummaryMessageCount = 42;
    writeDB(db);

    expect(getConversationSummary(cleanLegacy.id)).toBe([
      cleanLegacyStored.summary,
      `Earlier: ${cleanLegacyStored.summaryChain[0]}`,
    ].join('\n'));
    expect(getConversationSummary(positive.id)).toBe([
      legitimateMixedSummary,
      `Earlier: ${legitimateMixedChain}`,
    ].join('\n'));
    expect(positiveStored).toMatchObject({
      summary: legitimateMixedSummary,
      summaryChain: [legitimateMixedChain],
      lastSummaryMessageCount: 42,
    });

    await flushDB();
    await expect(readPersistedConversationSummary(positive.id)).resolves.toEqual({
      summary: legitimateMixedSummary,
      summaryChain: JSON.stringify([legitimateMixedChain]),
      lastSummaryMessageCount: 42,
    });
  });

  it('reserves one auto-summary per twenty new messages and advances only through the captured count', () => {
    const userId = `summary-cadence-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    let sequence = 0;
    const addTurns = (count: number, lastCognitiveIntent = '') => {
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        addMessage({
          userId,
          agentId: 'lumi',
          conversationId: conversation.id,
          role: sequence % 2 === 1 ? 'user' : 'assistant',
          content: `message-${sequence}-${Math.random()}`,
          cognitiveIntent: index === count - 1 ? lastCognitiveIntent : undefined,
        });
      }
    };

    addTurns(19);
    addTurns(1, 'work_product_guard');
    const first = checkAutoSummary(conversation.id);
    expect(first.needed).toBe(true);
    expect(first.summarizedThroughMessageCount).toBe(20);
    expect(first.recentMessages.some(message => message.cognitiveIntent === 'work_product_guard')).toBe(false);
    // Eligibility checks are pure. Only beginConversationSummary owns the
    // concurrency reservation, so diagnostics cannot accidentally consume it.
    expect(checkAutoSummary(conversation.id).needed).toBe(true);
    expect(beginConversationSummary(conversation.id, first.summarizedThroughMessageCount)).toBe(true);
    expect(beginConversationSummary(conversation.id, first.summarizedThroughMessageCount)).toBe(false);

    // A message arriving while the LLM is summarizing must remain outside the
    // completed interval rather than being silently marked summarized.
    addTurns(1);
    expect(setConversationSummary(
      conversation.id,
      '前二十条消息的干净摘要。',
      first.summarizedThroughMessageCount,
    )).toBe(true);
    expect(readDB().conversations.find((item: any) => item.id === conversation.id).lastSummaryMessageCount).toBe(20);

    addTurns(18);
    expect(checkAutoSummary(conversation.id).needed).toBe(false);
    addTurns(1);
    const second = checkAutoSummary(conversation.id);
    expect(second.needed).toBe(true);
    expect(second.summarizedThroughMessageCount).toBe(40);
    expect(beginConversationSummary(conversation.id, second.summarizedThroughMessageCount)).toBe(true);
    cancelConversationSummary(conversation.id, second.summarizedThroughMessageCount);
    expect(beginConversationSummary(conversation.id, second.summarizedThroughMessageCount)).toBe(true);
    cancelConversationSummary(conversation.id, second.summarizedThroughMessageCount);
  });

  it('persists the inferred cadence baseline for a pre-marker conversation', async () => {
    const userId = `summary-migration-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    for (let index = 0; index < 25; index += 1) {
      addMessage({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `legacy-message-${index}`,
      });
    }
    const db = readDB();
    const stored = db.conversations.find((item: any) => item.id === conversation.id);
    stored.summary = '旧数据库中已经存在的干净摘要。';
    stored.lastSummaryMessageCount = -1;
    writeDB(db);

    expect(checkAutoSummary(conversation.id).needed).toBe(false);
    expect(stored.lastSummaryMessageCount).toBe(25);
    await flushDB();

    expect(readDB().conversations.find((item: any) => item.id === conversation.id)).toMatchObject({
      lastSummaryMessageCount: 25,
      summaryChain: [],
    });
  });

  it('does not treat a contaminated legacy summary as a completed cadence baseline', () => {
    const userId = `summary-contaminated-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    for (let index = 0; index < 20; index += 1) {
      addMessage({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `contaminated-legacy-message-${index}`,
      });
    }
    const db = readDB();
    const stored = db.conversations.find((item: any) => item.id === conversation.id);
    stored.summary = '用户询问助手能力满意度，助手回应尚未开始实际读取文件。';
    stored.lastSummaryMessageCount = -1;
    writeDB(db);

    const check = checkAutoSummary(conversation.id);
    expect(check.needed).toBe(true);
    expect(check.summarizedThroughMessageCount).toBe(20);
    expect(stored.lastSummaryMessageCount).toBe(0);
  });

  it('accepts a clean mixed summary that describes the historical guard failure', () => {
    const userId = `summary-mixed-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const mixedSummary = '用户复盘了助手曾回应尚未开始实际读取文件的问题，并要求改进对话连续性。';

    expect(isGuardGeneratedAssistantText(mixedSummary)).toBe(true);
    expect(setConversationSummary(conversation.id, mixedSummary)).toBe(true);
    expect(getConversationSummary(conversation.id)).toBe(mixedSummary);
  });
});
