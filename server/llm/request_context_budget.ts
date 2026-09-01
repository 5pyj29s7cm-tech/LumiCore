import type { MessageContent, NormalizedMessage } from './providers';

export interface ModelRequestToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface PreparedModelRequestContext {
  messages: NormalizedMessage[];
  toolDeclarations: ModelRequestToolDeclaration[];
  budgetTokens: number;
  estimatedInputTokens: number;
  originalEstimatedInputTokens: number;
  compacted: boolean;
  currentInputCompacted: boolean;
  droppedToolNames: string[];
}

/**
 * A model request may bind exactly one durable transcript row to its provider
 * input evidence. Silently choosing between multiple annotated rows would make
 * the evidence ambiguous, so malformed or multi-source requests fail closed
 * before any provider formatting or network call can occur.
 */
export class ModelRequestSourceProvenanceError extends Error {
  readonly code = 'model_request_source_provenance_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ModelRequestSourceProvenanceError';
  }
}

export const DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS = 24_000;
const MIN_MODEL_REQUEST_INPUT_BUDGET_TOKENS = 4_096;
const MAX_MODEL_REQUEST_INPUT_BUDGET_TOKENS = 131_072;
const IMAGE_INPUT_TOKEN_ESTIMATE = 1_100;

export function resolveModelRequestInputBudget(value?: unknown): number {
  const configured = Number(value ?? process.env.LUMI_MODEL_INPUT_TOKEN_BUDGET);
  const selected = Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS;
  return Math.max(
    MIN_MODEL_REQUEST_INPUT_BUDGET_TOKENS,
    Math.min(MAX_MODEL_REQUEST_INPUT_BUDGET_TOKENS, selected),
  );
}

/** Conservative mixed-language estimate used before the provider sees data. */
export function estimateModelRequestTextTokens(value: unknown): number {
  const text = String(value || '');
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) || []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.25 + other / 3) + (text ? 4 : 0);
}

function contentTokens(content: MessageContent): number {
  if (typeof content === 'string') return estimateModelRequestTextTokens(content);
  if (!content) return 0;
  return content.reduce((total, part) => total + (
    part.type === 'text'
      ? estimateModelRequestTextTokens(part.text)
      : IMAGE_INPUT_TOKEN_ESTIMATE
  ), 0);
}

function messageTokens(message: NormalizedMessage): number {
  return 8
    + contentTokens(message.content)
    + estimateModelRequestTextTokens(message.reasoningContent || '')
    + estimateModelRequestTextTokens(JSON.stringify(message.toolCalls || []));
}

function declarationTokens(declarations: ModelRequestToolDeclaration[]): number {
  return declarations.length > 0
    ? estimateModelRequestTextTokens(JSON.stringify(declarations))
    : 0;
}

export function estimateModelRequestInputTokens(
  messages: NormalizedMessage[],
  toolDeclarations: ModelRequestToolDeclaration[],
): number {
  return declarationTokens(toolDeclarations)
    + messages.reduce((total, message) => total + messageTokens(message), 0);
}

export function resolveAnnotatedSourceUserIndex(messages: NormalizedMessage[]): number {
  let sourceUserIndex = -1;
  for (const [index, message] of (messages || []).entries()) {
    const sourceMessageId = (message as NormalizedMessage | undefined)?.sourceMessageId;
    if (sourceMessageId === undefined || sourceMessageId === null) continue;
    if (typeof sourceMessageId !== 'string' || !sourceMessageId || sourceMessageId.trim() !== sourceMessageId) {
      throw new ModelRequestSourceProvenanceError(
        `Model request sourceMessageId at message ${index} must be a non-empty trimmed string`,
      );
    }
    if (message.role !== 'user') {
      throw new ModelRequestSourceProvenanceError(
        `Model request sourceMessageId at message ${index} must annotate a user message`,
      );
    }
    if (sourceUserIndex >= 0) {
      throw new ModelRequestSourceProvenanceError(
        `Model request contains multiple sourceMessageId annotations at messages ${sourceUserIndex} and ${index}`,
      );
    }
    sourceUserIndex = index;
  }
  return sourceUserIndex;
}

function clipTextToTokens(value: string, budget: number, label: string): string {
  const text = String(value || '');
  if (estimateModelRequestTextTokens(text) <= budget) return text;
  if (budget <= 20) return `[${label} omitted by request budget]`;
  const marker = `\n[${label} compacted by request budget]\n`;
  let characterBudget = Math.max(24, Math.floor(text.length * (
    budget / Math.max(1, estimateModelRequestTextTokens(text))
  )) - marker.length - 8);
  let clipped = '';
  while (characterBudget >= 16) {
    const head = Math.max(12, Math.floor(characterBudget * 0.72));
    const tail = Math.max(4, characterBudget - head);
    clipped = `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
    if (estimateModelRequestTextTokens(clipped) <= budget) return clipped;
    characterBudget = Math.floor(characterBudget * 0.82);
  }
  return `[${label} omitted by request budget]`;
}

function clipContentToTokens(content: MessageContent, budget: number, label: string): MessageContent {
  if (typeof content === 'string') return clipTextToTokens(content, budget, label);
  if (!content) return content;
  const imageCount = content.filter(part => part.type === 'image_url').length;
  const textParts = content.filter(part => part.type === 'text');
  const textBudget = Math.max(16, budget - imageCount * IMAGE_INPUT_TOKEN_ESTIMATE);
  const perText = Math.max(16, Math.floor(textBudget / Math.max(1, textParts.length)));
  return content.map(part => part.type === 'text'
    ? { ...part, text: clipTextToTokens(part.text, perText, label) }
    : part);
}

function compactMessage(message: NormalizedMessage, budget: number, label: string): NormalizedMessage {
  const fixedTokens = 8 + estimateModelRequestTextTokens(JSON.stringify(message.toolCalls || []));
  return {
    ...message,
    content: clipContentToTokens(message.content, Math.max(1, budget - fixedTokens), label),
    reasoningContent: null,
  };
}

// i18n-allow -- bilingual safety/task-continuity recognition; not user-visible copy.
const TASK_CAPSULE_SYSTEM_BLOCK = /(?:Current task capsule\s*\(TaskCapsuleV1\)|TaskCapsuleV1|当前任务胶囊)/i;
const CRITICAL_SYSTEM_BLOCK = /(?:security|safety|untrusted|prompt injection|action constitution|confirmation|privacy|credential|secret|forbidden|must not|never|execution boundary|cancell?ation|tool-output|Current task capsule\s*\(TaskCapsuleV1\)|TaskCapsuleV1|安全|权限|隐私|密钥|凭据|禁止|不得|必须|确认|取消|执行边界|当前任务胶囊)/i;

function compactSystemBlock(value: string, budget: number): string {
  if (estimateModelRequestTextTokens(value) <= budget) return value;
  const criticalWindows: string[] = [];
  const criticalPattern = new RegExp(CRITICAL_SYSTEM_BLOCK.source, 'gi');
  for (const match of value.matchAll(criticalPattern)) {
    const index = match.index ?? 0;
    criticalWindows.push(value.slice(Math.max(0, index - 180), Math.min(value.length, index + match[0].length + 260)));
    if (criticalWindows.length >= 8) break;
  }
  if (criticalWindows.length > 0) {
    const criticalBudget = Math.max(24, Math.floor(budget * 0.72));
    const critical = clipTextToTokens(
      Array.from(new Set(criticalWindows)).join('\n'),
      criticalBudget,
      'critical system rules',
    );
    const criticalCost = estimateModelRequestTextTokens(critical);
    const contextBudget = budget - criticalCost - 8;
    if (contextBudget >= 24) {
      const context = clipTextToTokens(value, contextBudget, 'system context');
      const combined = `${critical}\n[system context retained around critical rules]\n${context}`;
      if (estimateModelRequestTextTokens(combined) <= budget) return combined;
    }
    if (criticalCost <= budget) return critical;
  }
  const units = value
    .split(/(?<=[.!?。！？；;])\s*|\n+/)
    .map(unit => unit.trim())
    .filter(Boolean);
  if (units.length <= 1) return clipTextToTokens(value, budget, 'system section');
  const ranked = units.map((unit, index) => ({
    unit,
    index,
    score: (CRITICAL_SYSTEM_BLOCK.test(unit) ? 1_000 : 0)
      + (index === 0 ? 200 : 0)
      + (index === units.length - 1 ? 100 : 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = new Map<number, string>();
  let remaining = budget;
  for (const candidate of ranked) {
    if (remaining < 16) break;
    const unit = estimateModelRequestTextTokens(candidate.unit) <= remaining
      ? candidate.unit
      : clipTextToTokens(candidate.unit, remaining, 'system rule');
    const cost = estimateModelRequestTextTokens(unit) + 1;
    if (cost > remaining) continue;
    selected.set(candidate.index, unit);
    remaining -= cost;
  }
  return [...selected.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, unit]) => unit)
    .join('\n');
}

function compactSystemMessage(message: NormalizedMessage, budget: number): NormalizedMessage {
  if (typeof message.content !== 'string') return compactMessage(message, budget, 'system message');
  if (messageTokens(message) <= budget) return { ...message };
  const blocks = message.content.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  if (blocks.length <= 1) return compactMessage(message, budget, 'system message');

  const ranked = blocks.map((block, index) => ({
    block,
    index,
    score: (TASK_CAPSULE_SYSTEM_BLOCK.test(block) ? 10_000 : 0)
      + (CRITICAL_SYSTEM_BLOCK.test(block) ? 1_000 : 0)
      + (index === 0 ? 500 : 0)
      + (index === blocks.length - 1 ? 400 : 0)
      + (/^#{1,4}\s/m.test(block) ? 40 : 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const chosen = new Map<number, string>();
  let remaining = Math.max(32, budget - 24);
  // TaskCapsuleV1 is the durable bridge between terse follow-ups and the
  // task/receipt ledger. Losing it under budget pressure makes the provider
  // forget the confirmed target and latest correction even though the server
  // still owns both. Give the single current capsule a dedicated first share;
  // safety blocks continue to consume the remaining protected budget below.
  const currentTaskCapsule = ranked.find(candidate => TASK_CAPSULE_SYSTEM_BLOCK.test(candidate.block));
  if (currentTaskCapsule && remaining >= 32) {
    const capsuleBudget = Math.min(
      remaining,
      Math.max(512, Math.floor(budget * 0.35)),
    );
    const selected = compactSystemBlock(currentTaskCapsule.block, capsuleBudget);
    const selectedCost = estimateModelRequestTextTokens(selected) + 2;
    if (selectedCost <= remaining) {
      chosen.set(currentTaskCapsule.index, selected);
      remaining -= selectedCost;
    }
  }
  const protectedBlocks = ranked.filter(candidate => candidate.score >= 400 && !chosen.has(candidate.index));
  for (const [position, candidate] of protectedBlocks.entries()) {
    if (remaining < 20) break;
    const protectedLeft = protectedBlocks.length - position;
    const share = Math.max(20, Math.floor(remaining / Math.max(1, protectedLeft)));
    const selected = compactSystemBlock(candidate.block, share);
    const selectedCost = estimateModelRequestTextTokens(selected) + 2;
    if (selectedCost > remaining) continue;
    chosen.set(candidate.index, selected);
    remaining -= selectedCost;
  }
  for (const candidate of ranked.filter(item => !chosen.has(item.index))) {
    if (remaining < 20) break;
    const fullCost = estimateModelRequestTextTokens(candidate.block) + 2;
    if (fullCost > remaining) continue;
    chosen.set(candidate.index, candidate.block);
    remaining -= fullCost;
  }
  const content = [...chosen.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, block]) => block)
    .join('\n\n');
  return {
    ...message,
    content: content || '[system context compacted by request budget]',
    reasoningContent: null,
  };
}

const REDUNDANT_SCHEMA_KEYS = new Set([
  '$comment', 'examples', 'example', 'default', 'externalDocs', 'readOnly', 'writeOnly',
]);

function compactSchemaValue(value: unknown, depth = 0): unknown {
  if (depth > 24) return value;
  if (Array.isArray(value)) return value.map(item => compactSchemaValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (REDUNDANT_SCHEMA_KEYS.has(key)) continue;
    if (key === 'title' && depth > 0) continue;
    if (key === 'description' && typeof child === 'string') {
      result[key] = clipTextToTokens(child, 80, 'schema description');
      continue;
    }
    result[key] = compactSchemaValue(child, depth + 1);
  }
  return result;
}

function normalizeToolDeclarations(
  declarations: ModelRequestToolDeclaration[],
): Array<{ declaration: ModelRequestToolDeclaration; index: number }> {
  const seen = new Set<string>();
  const normalized: Array<{ declaration: ModelRequestToolDeclaration; index: number }> = [];
  for (const [index, declaration] of (declarations || []).entries()) {
    const name = String(declaration?.function?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push({
      index,
      declaration: {
        type: 'function',
        function: {
          name,
          description: clipTextToTokens(String(declaration.function.description || ''), 140, 'tool description'),
          parameters: compactSchemaValue(declaration.function.parameters || {}) as Record<string, any>,
        },
      },
    });
  }
  return normalized;
}

function toolRelevanceScore(name: string, currentInput: string, index: number): number {
  const normalizedName = name.toLowerCase();
  const normalizedInput = currentInput.toLowerCase();
  let score = normalizedInput.includes(normalizedName) ? 10_000 : 0;
  if (/(?:verify|verification|confirm|permission|health|status|receipt|cancel)/i.test(normalizedName)) {
    score += 2_000;
  }
  for (const token of normalizedName.split(/[^a-z0-9\u3400-\u9fff]+/i).filter(token => token.length >= 2)) {
    if (normalizedInput.includes(token)) score += 100;
  }
  // Registry/tool-router order remains the stable tie breaker.
  return score - index / 10_000;
}

function selectToolDeclarations(
  declarations: ModelRequestToolDeclaration[],
  currentInput: string,
  budget: number,
  protectedToolNames: ReadonlySet<string> = new Set(),
): { selected: ModelRequestToolDeclaration[]; dropped: string[] } {
  const normalized = normalizeToolDeclarations(declarations);
  if (declarationTokens(normalized.map(item => item.declaration)) <= budget) {
    return { selected: normalized.map(item => item.declaration), dropped: [] };
  }
  const protectedDeclarations = normalized.filter(item => (
    protectedToolNames.has(item.declaration.function.name)
  ));
  if (declarationTokens(protectedDeclarations.map(item => item.declaration)) > budget) {
    throw new Error('Model request budget cannot retain all protected tool declarations');
  }
  const ranked = normalized.filter(item => (
    !protectedToolNames.has(item.declaration.function.name)
  )).sort((left, right) => (
    toolRelevanceScore(right.declaration.function.name, currentInput, right.index)
    - toolRelevanceScore(left.declaration.function.name, currentInput, left.index)
  ));
  const selected: typeof normalized = [...protectedDeclarations];
  for (const candidate of ranked) {
    const trial = [...selected, candidate].map(item => item.declaration);
    if (declarationTokens(trial) <= budget) selected.push(candidate);
  }
  selected.sort((left, right) => left.index - right.index);
  const selectedNames = new Set(selected.map(item => item.declaration.function.name));
  return {
    selected: selected.map(item => item.declaration),
    dropped: normalized
      .map(item => item.declaration.function.name)
      .filter(name => !selectedNames.has(name)),
  };
}

function messageText(message: NormalizedMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!message.content) return '';
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function historySegments(messages: NormalizedMessage[], excluded: Set<number>): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (excluded.has(index)) continue;
    if (messages[index].role === 'user' && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(index);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function compactHistorySegment(
  messages: NormalizedMessage[],
  indexes: number[],
  budget: number,
): Array<[number, NormalizedMessage]> {
  const selected: Array<[number, NormalizedMessage]> = [];
  let remaining = budget;
  for (const [position, index] of indexes.entries()) {
    if (remaining < 24) break;
    const original = messages[index];
    const remainingMessages = indexes.length - position;
    const share = Math.max(24, Math.floor(remaining / Math.max(1, remainingMessages)));
    const candidate = messageTokens(original) <= remaining
      ? { ...original, reasoningContent: null }
      : compactMessage(original, Math.min(remaining, share), `${original.role} history`);
    const cost = messageTokens(candidate);
    if (cost > remaining) continue;
    selected.push([index, candidate]);
    remaining -= cost;
  }
  return selected;
}

/**
 * Enforces one budget over the actual provider payload: system messages,
 * history, current input, tool-call protocol, and function schemas. System
 * safety blocks and the latest user input are selected before conversation
 * history; redundant schema prose and old turns are removed first.
 */
export function prepareModelRequestContext(input: {
  messages: NormalizedMessage[];
  toolDeclarations: ModelRequestToolDeclaration[];
  inputTokenBudget?: number;
  /**
   * Declaration names selected by the server execution plan that must reach
   * the provider unchanged. Optional schemas may be ranked away, but a
   * continuation, verification, or recovery door fails closed instead of
   * silently disappearing at this final request boundary.
   */
  protectedToolNames?: readonly string[];
}): PreparedModelRequestContext {
  const budgetTokens = resolveModelRequestInputBudget(input.inputTokenBudget);
  const originalMessages = (input.messages || []).map(message => ({ ...message }));
  const originalTools = (input.toolDeclarations || []).map(declaration => ({
    ...declaration,
    function: { ...declaration.function, parameters: { ...(declaration.function.parameters || {}) } },
  }));
  const protectedToolNames = new Set(
    (input.protectedToolNames || []).map(name => String(name || '').trim()).filter(Boolean),
  );
  const sourceUserIndex = resolveAnnotatedSourceUserIndex(originalMessages);
  const originalEstimatedInputTokens = estimateModelRequestInputTokens(originalMessages, originalTools);
  if (originalEstimatedInputTokens <= budgetTokens) {
    return {
      messages: originalMessages,
      toolDeclarations: originalTools,
      budgetTokens,
      estimatedInputTokens: originalEstimatedInputTokens,
      originalEstimatedInputTokens,
      compacted: false,
      currentInputCompacted: false,
      droppedToolNames: [],
    };
  }

  let latestUserIndex = -1;
  for (let index = originalMessages.length - 1; index >= 0; index -= 1) {
    if (originalMessages[index].role === 'user') { latestUserIndex = index; break; }
  }
  const protectedUserIndexes = [sourceUserIndex, latestUserIndex]
    .filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position);
  const systemIndexes = originalMessages
    .map((message, index) => message.role === 'system' ? index : -1)
    .filter(index => index >= 0);
  const currentText = protectedUserIndexes
    .map(index => messageText(originalMessages[index]))
    .filter(Boolean)
    .join('\n');
  const originalCurrentCost = protectedUserIndexes
    .reduce((sum, index) => sum + messageTokens(originalMessages[index]), 0);
  const minimumSystemBudget = systemIndexes.length > 0
    ? Math.min(
        originalMessages.filter(message => message.role === 'system').reduce((sum, message) => sum + messageTokens(message), 0),
        Math.max(768, Math.floor(budgetTokens * 0.22)),
      )
    : 0;
  const baseToolBudget = originalTools.length > 0
    ? Math.max(512, Math.min(
        9_000,
        Math.floor(budgetTokens * 0.38),
        Math.max(512, budgetTokens - Math.min(originalCurrentCost, Math.floor(budgetTokens * 0.45)) - minimumSystemBudget - 256),
      ))
    : 0;
  const protectedToolCost = declarationTokens(
    normalizeToolDeclarations(originalTools)
      .filter(item => protectedToolNames.has(item.declaration.function.name))
      .map(item => item.declaration),
  );
  const minimumProtectedMessageBudget = protectedUserIndexes.length * 64
    + (systemIndexes.length > 0 ? minimumSystemBudget : 0);
  const maximumToolBudget = Math.max(0, budgetTokens - minimumProtectedMessageBudget);
  if (protectedToolCost > maximumToolBudget) {
    throw new Error(
      `Model request budget cannot retain ${protectedToolNames.size} protected tool declarations and protected messages`,
    );
  }
  const toolBudget = originalTools.length > 0
    ? Math.min(maximumToolBudget, Math.max(baseToolBudget, protectedToolCost))
    : 0;
  const toolSelection = selectToolDeclarations(
    originalTools,
    currentText,
    toolBudget,
    protectedToolNames,
  );
  const tools = toolSelection.selected;
  const toolCost = declarationTokens(tools);

  const selected = new Map<number, NormalizedMessage>();
  const availableForMessages = Math.max(256, budgetTokens - toolCost);
  const currentBudget = protectedUserIndexes.length > 0
    ? Math.max(0, availableForMessages - minimumSystemBudget)
    : 0;
  if (protectedUserIndexes.length > 0 && currentBudget < protectedUserIndexes.length * 64) {
    throw new ModelRequestSourceProvenanceError(
      `Model request budget cannot retain ${protectedUserIndexes.length} protected user messages`,
    );
  }
  let currentInputCompacted = false;
  let remainingCurrentBudget = currentBudget;
  for (const [position, index] of protectedUserIndexes.entries()) {
    const current = originalMessages[index];
    const protectedLeft = protectedUserIndexes.length - position - 1;
    const reservedForLater = protectedLeft * 64;
    const messageBudget = Math.max(64, remainingCurrentBudget - reservedForLater);
    const label = index === sourceUserIndex && index !== latestUserIndex
      ? 'annotated source user input'
      : index === latestUserIndex && index !== sourceUserIndex
        ? 'latest synthetic user input'
        : 'current user input';
    const preparedCurrent = messageTokens(current) <= messageBudget
      ? { ...current }
      : compactMessage(current, messageBudget, label);
    const preparedCost = messageTokens(preparedCurrent);
    if (preparedCost > messageBudget) {
      throw new ModelRequestSourceProvenanceError(
        `Model request budget could not retain protected user message ${index}`,
      );
    }
    currentInputCompacted ||= messageTokens(current) > preparedCost;
    selected.set(index, preparedCurrent);
    remainingCurrentBudget -= preparedCost;
  }

  let usedMessageTokens = [...selected.values()].reduce((sum, message) => sum + messageTokens(message), 0);
  let remaining = Math.max(0, availableForMessages - usedMessageTokens);
  const excluded = new Set([...systemIndexes, ...protectedUserIndexes]);
  const segments = historySegments(originalMessages, excluded);
  const hasHistory = segments.length > 0;
  const systemBudget = systemIndexes.length > 0
    ? Math.min(remaining, hasHistory ? Math.max(minimumSystemBudget, Math.floor(remaining * 0.72)) : remaining)
    : 0;
  let remainingSystemBudget = systemBudget;
  for (const [position, index] of systemIndexes.entries()) {
    const systemsLeft = systemIndexes.length - position;
    const share = Math.max(32, Math.floor(remainingSystemBudget / Math.max(1, systemsLeft)));
    const prepared = compactSystemMessage(originalMessages[index], share);
    const cost = messageTokens(prepared);
    if (cost > remainingSystemBudget) continue;
    selected.set(index, prepared);
    remainingSystemBudget -= cost;
  }
  usedMessageTokens = [...selected.values()].reduce((sum, message) => sum + messageTokens(message), 0);
  remaining = Math.max(0, availableForMessages - usedMessageTokens);

  for (let segmentIndex = segments.length - 1; segmentIndex >= 0 && remaining >= 32; segmentIndex -= 1) {
    const indexes = segments[segmentIndex];
    const fullCost = indexes.reduce((sum, index) => sum + messageTokens(originalMessages[index]), 0);
    const prepared = fullCost <= remaining
      ? indexes.map(index => [index, { ...originalMessages[index], reasoningContent: null }] as [number, NormalizedMessage])
      : compactHistorySegment(originalMessages, indexes, remaining);
    const cost = prepared.reduce((sum, [, message]) => sum + messageTokens(message), 0);
    if (cost > remaining) continue;
    for (const [index, message] of prepared) selected.set(index, message);
    remaining -= cost;
    // Once the newest segment itself needed compaction, older context has
    // lower priority and is not allowed to displace it.
    if (fullCost > cost) break;
  }

  const messages = [...selected.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, message]) => message);
  const estimatedInputTokens = estimateModelRequestInputTokens(messages, tools);
  if (estimatedInputTokens > budgetTokens) {
    // The selection math uses the same estimator, so this is only a defensive
    // invariant for malformed image/tool payloads rather than an ordinary path.
    throw new Error(`Model request context could not be compacted below ${budgetTokens} input tokens`);
  }
  return {
    messages,
    toolDeclarations: tools,
    budgetTokens,
    estimatedInputTokens,
    originalEstimatedInputTokens,
    compacted: true,
    currentInputCompacted,
    droppedToolNames: toolSelection.dropped,
  };
}
