import { readDB } from '../../db_layer';

export interface ConversationExecutionFactScope {
  conversationId: string;
  userId: string;
  domain?: string;
  orgId?: string;
}

export interface ConversationExecutionFacts {
  toolCalls: Array<{ name: string; error: boolean }>;
  tasks: Array<{ id: string; status: string }>;
}

function parseToolCalls(value: unknown): any[] {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === 'string' && parsed.trim(); depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

export function isConversationExecutionFactQuestion(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  const conversationScope = /(?:这|本|当前|刚才|刚刚|整个).{0,10}(?:轮|段|次)?(?:对话|会话|聊天)|\b(?:this|current|that)\s+(?:conversation|chat|session)\b/iu.test(normalized);
  const asksWhether = /(?:有没有|有没|是否|究竟|到底|真的)|\b(?:did|have|was|were)\b/iu.test(normalized);
  const executionSubject = /(?:(?:调用|执行|使用|跑).{0,10}(?:工具|插件|技能)|(?:创建|新建|建立).{0,10}(?:任务|计划))|\b(?:call|use|run|execute)(?:d|ing)?\s+(?:any\s+)?tools?\b|\bcreat(?:e|ed|ing)\s+(?:any\s+)?tasks?\b/iu.test(normalized);
  return conversationScope && asksWhether && executionSubject;
}

export function getConversationExecutionFacts(scope: ConversationExecutionFactScope): ConversationExecutionFacts {
  const db = readDB();
  const domain = scope.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(scope.orgId || '') : '';
  const interactions = (db.interactions || []).filter((item: any) => (
    String(item.conversationId || '') === scope.conversationId
    && String(item.userId || '') === scope.userId
    && String(item.domain || 'personal') === domain
    && (domain !== 'work' || String(item.orgId || '') === orgId)
  ));
  const toolCalls = interactions.flatMap((item: any) => parseToolCalls(item.toolCalls))
    .map((record: any) => ({
      name: String(record?.name || record?.toolName || '').trim(),
      error: Boolean(record?.error),
    }))
    .filter((record: { name: string }) => Boolean(record.name));
  const tasks = (db.conversationActionTasks || []).filter((task: any) => (
    String(task.conversationId || '') === scope.conversationId
    && String(task.userId || '') === scope.userId
    && String(task.domain || 'personal') === domain
    && (domain !== 'work' || String(task.orgId || '') === orgId)
  )).map((task: any) => ({
    id: String(task.id || ''),
    status: String(task.status || 'unknown'),
  }));
  return { toolCalls, tasks };
}

export function formatConversationExecutionFactAnswer(
  facts: ConversationExecutionFacts,
  text: string,
): string {
  const zh = /[\u3400-\u9fff]/u.test(text);
  const toolNames = Array.from(new Set(facts.toolCalls.map(record => record.name)));
  const taskStatuses = Array.from(new Set(facts.tasks.map(task => task.status)));
  if (zh) {
    if (facts.toolCalls.length === 0 && facts.tasks.length === 0) {
      return '没有。这段对话没有记录到工具调用，也没有创建任务。';
    }
    const parts = [
      facts.toolCalls.length > 0
        ? `记录到 ${facts.toolCalls.length} 次工具调用：${toolNames.join('、')}。`
        : '没有记录到工具调用。',
      facts.tasks.length > 0
        ? `创建了 ${facts.tasks.length} 个任务，当前状态：${taskStatuses.join('、')}。`
        : '没有创建任务。',
    ];
    return parts.join('');
  }
  if (facts.toolCalls.length === 0 && facts.tasks.length === 0) {
    return 'No. This conversation has no recorded tool calls and no created tasks.';
  }
  return [
    facts.toolCalls.length > 0
      ? `${facts.toolCalls.length} tool call(s) were recorded: ${toolNames.join(', ')}.`
      : 'No tool calls were recorded.',
    facts.tasks.length > 0
      ? `${facts.tasks.length} task(s) were created; current status: ${taskStatuses.join(', ')}.`
      : 'No tasks were created.',
  ].join(' ');
}
