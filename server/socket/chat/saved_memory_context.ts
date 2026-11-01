import { affirmativeActionClauses, negatedActionInstructions } from '../../cognition/action_instruction_clauses';
import { queryMemories } from '../../memory';
import { CONVERSATIONAL_MEMORY_EVIDENCE, isMemoryAvatarAgentId, type Memory, type MemoryQuery, type MemoryType } from '../../memory/types';
import type { MemoryPolicy } from '../../personality/types';

const MAX_CHAT_MEMORY_CONTEXT = 20;
const DEFAULT_MEMORY_TYPES: MemoryType[] = ['preference', 'fact', 'habit', 'knowledge'];

export interface ChatSavedMemoryContextInput {
  userId: string;
  text: string;
  domain: 'personal' | 'work';
  orgId: string;
  agentId?: string;
  isMemoryAvatar?: boolean;
  executionBoundary?: string;
  memoryPolicy?: Partial<MemoryPolicy>;
  signal: AbortSignal;
  assertCurrent: () => void;
}

/** This veto only governs saved-memory context, not history or tool permission. */
export function hasSavedMemoryContextOptOut(text: string): boolean {
  const negative = negatedActionInstructions(text);
  // i18n-allow: Saved-memory operand grammar; quoted data is removed by the shared projection.
  const memory = /记忆|\bmemor(?:y|ies)\b/iu;
  // i18n-allow: Reading/using memory is distinct from saving a new memory or searching chat history.
  const reading = /^(?:(?:再|自动|继续|主动|从现在起)\s*)*(?:使用|利用|用|借助|依据|依赖|参考|读取|查询|检索|搜索|调用|访问|注入|带入|引入)|^(?:(?:automatically|again|ever)\s+)*(?:use|using|read|reading|retrieve|retrieving|search|searching|look\s+up|access|include|inject|consult|recall|rely\s+on|draw\s+on)\b/iu;
  // i18n-allow: An already negated bare-memory operand, such as "without saved memories".
  const bareMemory = /^(?:(?:任何|我的|之前的|以前的|已保存的?|跨会话的?|历史|长期)\s*)*记忆|^(?:(?:any|my|the|saved|stored|previous|past|long-term|cross-session)\s+)*memor(?:y|ies)\b/iu;
  if (negative.some(clause => {
    if (!memory.test(clause.instruction)) return false;
    if (reading.test(clause.instruction) || bareMemory.test(clause.instruction)) return true;
    // i18n-allow: A negated Chinese object-first context injection, not a memory-save prohibition.
    if (/^(?:把|将)\s*[^，,。；;！？!?\n]{0,60}记忆[^，,。；;！？!?\n]{0,20}(?:带入|注入|引入|加入|用于|用在|作为[^，,。；;！？!?\n]{0,12}依据)/u.test(clause.instruction)) return true;
    const delegatedUse = /^(?:want|allow|permit)\s+you\s+to\s+(.+)$/iu.exec(clause.instruction);
    return Boolean(delegatedUse && reading.test(delegatedUse[1]));
  })) return true;
  return affirmativeActionClauses(text).some(clause => {
    // i18n-allow: Bare Chinese negation of contextual use is not a tool-action predicate in the shared parser.
    if (/^(?:请\s*)?(?:(?:本次|这次|当前|现在|本轮)\s*)?不(?:使用|依赖|参考|利用|用)\s*[^，,。；;！？!?\n]{0,40}记忆/u.test(clause.trim())) return true;
    // i18n-allow: Explicitly disabling saved-memory context and current-conversation-only instructions.
    return /^(?:请\s*)?(?:关闭|禁用|停用)\s*(?:自动)?(?:跨会话|已保存的?|长期)?记忆|^(?:please\s+)?(?:disable|turn\s+off)\s+(?:automatic\s+)?(?:(?:saved|stored|cross-session)\s+)?memor(?:y|ies)\b/iu.test(clause.trim())
      // i18n-allow: Only-current-context grammar; this does not mean "do not search chat history".
      || /^(?:请\s*)?(?:只|仅)(?:根据|基于|使用|参考)\s*(?:本次|这次|当前|本轮)(?:的)?(?:对话|会话|消息)|^(?:please\s+)?(?:use|rely\s+on|answer\s+(?:from|using))\s+only\s+(?:the\s+)?(?:current|this)\s+(?:conversation|chat|message)\b/iu.test(clause.trim());
  });
}

/** Local keyword recall from the authoritative store; never trains retrieval or calls a provider. */
export function retrieveChatSavedMemories(input: ChatSavedMemoryContextInput): Memory[] {
  const assertCurrent = () => { input.signal.throwIfAborted(); input.assertCurrent(); };
  assertCurrent();
  if (!input.userId.trim() || !input.text.trim()
    || input.isMemoryAvatar || isMemoryAvatarAgentId(input.agentId)
    || input.executionBoundary === 'remote_restricted'
    || input.domain === 'work' && !input.orgId.trim()
    || hasSavedMemoryContextOptOut(input.text)) return [];

  const policy = input.memoryPolicy;
  const limit = Math.max(0, Math.min(MAX_CHAT_MEMORY_CONTEXT,
    Math.floor(Number.isFinite(policy?.retrieveLimit) ? policy!.retrieveLimit! : 5)));
  const types = Array.isArray(policy?.includeTypes)
    ? [...new Set(policy.includeTypes.filter(type => DEFAULT_MEMORY_TYPES.includes(type)))]
    : DEFAULT_MEMORY_TYPES;
  if (!limit || !types.length) return [];
  const query: MemoryQuery = {
    userId: input.userId,
    query: input.text,
    domain: input.domain,
    orgId: input.domain === 'work' ? input.orgId : '',
    agentIds: [...new Set(['', String(input.agentId || '').trim()])],
    types,
    limit,
    minConfidence: Math.max(0, Math.min(1, Number.isFinite(policy?.minConfidence) ? policy!.minConfidence! : 0.4)),
    nodeType: 'leaf',
    evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
    excludePrivacyClasses: ['secret'],
    excludeRetentions: ['session', 'ephemeral'],
    requireAcceptedFirewall: true,
    recordRetrieval: false,
    useVector: false,
    signal: input.signal,
  };
  const memories = queryMemories(query);
  assertCurrent();
  // Topic parents need not be selected. Flatten only the context projection so
  // the existing formatter retains every selected leaf; store rows stay intact.
  return memories.map(memory => ({ ...memory, parentId: null }));
}
