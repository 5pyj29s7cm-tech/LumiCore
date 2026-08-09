import type { MessageContent, NormalizedMessage } from './providers';

export interface LocalContextToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface PreparedLocalModelRequest {
  messages: NormalizedMessage[];
  maxTokens: number;
  contextTokens: number;
  inputBudgetTokens: number;
  estimatedInputTokens: number;
  compacted: boolean;
}

export class LocalModelContextBudgetError extends Error {
  readonly contextTokens: number;
  readonly requiredToolTokens: number;

  constructor(message: string, contextTokens: number, requiredToolTokens: number) {
    super(message);
    this.name = 'LocalModelContextBudgetError';
    this.contextTokens = contextTokens;
    this.requiredToolTokens = requiredToolTokens;
  }
}

function configuredContextTokens(): number {
  return Math.max(
    2_048,
    Math.min(131_072, Number(process.env.LUMI_LOCAL_MODEL_CONTEXT_TOKENS) || 4_096),
  );
}

export function estimateLocalTextTokens(value: string): number {
  const text = String(value || '');
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) || []).length;
  const other = Math.max(0, text.length - cjk);
  // Deliberately conservative for small local contexts. JSON/tool schemas and
  // Chinese text routinely tokenize more densely than the four-chars rule.
  return Math.ceil(cjk + other / 3) + 4;
}

function contentTokens(content: MessageContent): number {
  if (typeof content === 'string') return estimateLocalTextTokens(content);
  if (!content) return 0;
  return content.reduce((total, part) => (
    total + (part.type === 'text' ? estimateLocalTextTokens(part.text) : 1_100)
  ), 0);
}

function messageTokens(message: NormalizedMessage): number {
  return 8
    + contentTokens(message.content)
    + estimateLocalTextTokens(message.reasoningContent || '')
    + estimateLocalTextTokens(JSON.stringify(message.toolCalls || []));
}

function clipTextToTokens(value: string, budget: number, label: string): string {
  const text = String(value || '');
  if (estimateLocalTextTokens(text) <= budget) return text;
  if (budget <= 24) return `[${label} omitted]`;
  const ratio = Math.max(0.02, Math.min(1, budget / Math.max(1, estimateLocalTextTokens(text))));
  const charBudget = Math.max(48, Math.floor(text.length * ratio) - 80);
  const head = Math.max(24, Math.floor(charBudget * 0.68));
  const tail = Math.max(16, charBudget - head);
  return `${text.slice(0, head)}\n[${label} compacted for local context]\n${text.slice(-tail)}`;
}

function clipContent(content: MessageContent, budget: number, label: string): MessageContent {
  if (typeof content === 'string') return clipTextToTokens(content, budget, label);
  if (!content) return content;
  const images = content.filter(part => part.type === 'image_url');
  const imageBudget = images.length * 1_100;
  const textBudget = Math.max(32, budget - imageBudget);
  const textParts = content.filter(part => part.type === 'text');
  const perText = Math.max(24, Math.floor(textBudget / Math.max(1, textParts.length)));
  return content.map(part => part.type === 'text'
    ? { ...part, text: clipTextToTokens(part.text, perText, label) }
    : part);
}

function compactMessage(message: NormalizedMessage, budget: number, label: string): NormalizedMessage {
  return {
    ...message,
    content: clipContent(message.content, Math.max(32, budget - 12), label),
    reasoningContent: null,
  };
}

function declarationTokens(toolDeclarations: LocalContextToolDeclaration[]): number {
  return estimateLocalTextTokens(JSON.stringify(toolDeclarations || []));
}

export function estimateLocalRequestInputTokens(
  messages: NormalizedMessage[],
  toolDeclarations: LocalContextToolDeclaration[],
): number {
  return declarationTokens(toolDeclarations)
    + messages.reduce((total, message) => total + messageTokens(message), 0);
}

export function prepareLocalModelRequest(input: {
  messages: NormalizedMessage[];
  toolDeclarations: LocalContextToolDeclaration[];
  maxTokens?: number;
  contextTokens?: number;
}): PreparedLocalModelRequest {
  const contextTokens = Math.max(2_048, input.contextTokens || configuredContextTokens());
  const maxTokens = Math.max(128, Math.min(
    Number(input.maxTokens) || 768,
    1_024,
    Math.floor(contextTokens * 0.25),
  ));
  const safetyTokens = Math.max(384, Math.floor(contextTokens * 0.1));
  const inputBudgetTokens = contextTokens - maxTokens - safetyTokens;
  const toolTokens = declarationTokens(input.toolDeclarations);
  if (toolTokens > inputBudgetTokens - 384) {
    throw new LocalModelContextBudgetError(
      `Local model preflight blocked the request: tool declarations require about ${toolTokens} tokens, exceeding the ${inputBudgetTokens}-token input budget for a ${contextTokens}-token context.`,
      contextTokens,
      toolTokens,
    );
  }

  const original = input.messages.map(message => ({ ...message }));
  const originalEstimate = estimateLocalRequestInputTokens(original, input.toolDeclarations);
  if (originalEstimate <= inputBudgetTokens) {
    return {
      messages: original,
      maxTokens,
      contextTokens,
      inputBudgetTokens,
      estimatedInputTokens: originalEstimate,
      compacted: false,
    };
  }

  const messageBudget = inputBudgetTokens - toolTokens;
  const systemIndexes = original
    .map((message, index) => message.role === 'system' ? index : -1)
    .filter(index => index >= 0);
  let latestUserIndex = -1;
  for (let index = original.length - 1; index >= 0; index -= 1) {
    if (original[index].role === 'user') { latestUserIndex = index; break; }
  }
  const selected = new Map<number, NormalizedMessage>();
  const systemBudget = Math.max(256, Math.floor(messageBudget * 0.58));
  const perSystem = Math.max(96, Math.floor(systemBudget / Math.max(1, systemIndexes.length)));
  for (const index of systemIndexes) {
    selected.set(index, compactMessage(original[index], perSystem, 'system message'));
  }
  if (latestUserIndex >= 0) {
    selected.set(
      latestUserIndex,
      compactMessage(original[latestUserIndex], Math.max(192, Math.floor(messageBudget * 0.27)), 'latest user message'),
    );
  }

  let used = [...selected.values()].reduce((total, message) => total + messageTokens(message), 0);
  for (let index = original.length - 1; index >= 0 && used < messageBudget; index -= 1) {
    if (selected.has(index)) continue;
    const remaining = messageBudget - used;
    if (remaining < 64) break;
    const candidate = messageTokens(original[index]) <= remaining
      ? { ...original[index], reasoningContent: null }
      : compactMessage(original[index], remaining, `${original[index].role} message`);
    const cost = messageTokens(candidate);
    if (cost > remaining) continue;
    selected.set(index, candidate);
    used += cost;
  }

  const messages = [...selected.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, message]) => message);
  const estimatedInputTokens = estimateLocalRequestInputTokens(messages, input.toolDeclarations);
  if (estimatedInputTokens > inputBudgetTokens) {
    throw new LocalModelContextBudgetError(
      `Local model preflight could not compact the request below ${inputBudgetTokens} input tokens.`,
      contextTokens,
      toolTokens,
    );
  }
  return {
    messages,
    maxTokens,
    contextTokens,
    inputBudgetTokens,
    estimatedInputTokens,
    compacted: true,
  };
}
