import type { MessageContent, NormalizedMessage } from './providers';
import {
  ModelRequestSourceProvenanceError,
  resolveAnnotatedSourceUserIndex,
} from './request_context_budget';

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
  toolDeclarations: LocalContextToolDeclaration[];
  maxTokens: number;
  contextTokens: number;
  inputBudgetTokens: number;
  estimatedInputTokens: number;
  compacted: boolean;
  toolDeclarationsCompacted: boolean;
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

function toolContinuationBatches(
  messages: NormalizedMessage[],
  contextTokens: number,
): number[][] {
  const batches: Array<{
    assistantIndex: number;
    callIds: string[];
    resultIndexes: number[];
    seenResultIds: Set<string>;
  }> = [];
  const batchByCallId = new Map<string, typeof batches[number]>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'assistant' && (message.toolCalls || []).length > 0) {
      const calls = message.toolCalls || [];
      const callIds = calls.map(call => String(call.id || '').trim());
      if (
        callIds.some(id => !id)
        || new Set(callIds).size !== callIds.length
        || callIds.some(id => batchByCallId.has(id))
      ) {
        throw new LocalModelContextBudgetError(
          'Local model preflight blocked a malformed assistant tool_call batch; every call must have one unique id.',
          contextTokens,
          0,
        );
      }
      const batch = {
        assistantIndex: index,
        callIds,
        resultIndexes: [],
        seenResultIds: new Set<string>(),
      };
      batches.push(batch);
      for (const id of callIds) batchByCallId.set(id, batch);
      continue;
    }
    if (message.role === 'tool') {
      const resultId = String(message.toolCallId || '').trim();
      const batch = resultId ? batchByCallId.get(resultId) : undefined;
      if (!batch || batch.seenResultIds.has(resultId)) {
        throw new LocalModelContextBudgetError(
          'Local model preflight blocked an orphan or duplicate tool receipt; assistant tool_call and tool receipts are an indivisible boundary.',
          contextTokens,
          0,
        );
      }
      batch.seenResultIds.add(resultId);
      batch.resultIndexes.push(index);
    }
  }

  for (const batch of batches) {
    if (batch.callIds.some(id => !batch.seenResultIds.has(id))) {
      throw new LocalModelContextBudgetError(
        'Local model preflight blocked an incomplete tool continuation; every assistant tool_call requires its matching tool receipt.',
        contextTokens,
        0,
      );
    }
  }
  return batches.map(batch => [batch.assistantIndex, ...batch.resultIndexes]);
}

function clipTextToTokens(value: string, budget: number, label: string): string {
  const text = String(value || '');
  if (estimateLocalTextTokens(text) <= budget) return text;
  const omitted = `[${label} omitted]`;
  if (budget <= 24) return estimateLocalTextTokens(omitted) <= budget ? omitted : '';
  const marker = `\n[${label} compacted for local context]\n`;
  let characterBudget = Math.max(24, Math.floor(text.length * (
    budget / Math.max(1, estimateLocalTextTokens(text))
  )) - marker.length - 8);
  while (characterBudget >= 16) {
    const head = Math.max(12, Math.floor(characterBudget * 0.68));
    const tail = Math.max(4, characterBudget - head);
    const clipped = `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
    if (estimateLocalTextTokens(clipped) <= budget) return clipped;
    characterBudget = Math.floor(characterBudget * 0.82);
  }
  return estimateLocalTextTokens(omitted) <= budget ? omitted : '';
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
  const fixedTokens = 8
    + estimateLocalTextTokens('')
    + estimateLocalTextTokens(JSON.stringify(message.toolCalls || []));
  return {
    ...message,
    content: clipContent(message.content, Math.max(1, budget - fixedTokens), label),
    reasoningContent: null,
  };
}

function declarationTokens(toolDeclarations: LocalContextToolDeclaration[]): number {
  return estimateLocalTextTokens(JSON.stringify(toolDeclarations || []));
}

function compactLocalToolDeclarations(
  declarations: LocalContextToolDeclaration[],
  inputBudgetTokens: number,
  contextTokens: number,
  requiredToolNames: string[] = [],
  minimumMessageTokens = 0,
): LocalContextToolDeclaration[] {
  if (declarations.length === 0) return declarations;

  // Local failover shares the cloud model's ordered semantic projection, but
  // a small local context cannot necessarily carry every schema in that
  // projection. Preserve the highest-priority prefix and the bounded discovery
  // capability while leaving enough room for the accepted user turn and a
  // compact system boundary. This narrows model visibility only; executor
  // authorization remains governed by the unchanged ToolPolicy.
  const baseMessageReserve = Math.min(
    1_024,
    Math.max(768, Math.floor(inputBudgetTokens * 0.35)),
  );
  const reservedMessageTokens = Math.min(
    Math.max(0, inputBudgetTokens - 256),
    Math.max(baseMessageReserve, minimumMessageTokens),
  );
  const toolBudget = Math.max(256, inputBudgetTokens - reservedMessageTokens);
  if (declarationTokens(declarations) <= toolBudget) return declarations;

  const declaredNames = new Set(declarations.map(declaration => declaration.function.name));
  const mandatoryNames = new Set(
    requiredToolNames
      .map(name => String(name || '').trim())
      .filter(name => declaredNames.has(name)),
  );
  // The first declaration is the semantic route winner. Discovery is kept as
  // the bounded route-expansion escape hatch. Callers may additionally mark a
  // hard/exact route or a previously executed continuation tool as required.
  mandatoryNames.add(declarations[0].function.name);
  if (declaredNames.has('client_capability_manifest')) {
    mandatoryNames.add('client_capability_manifest');
  }

  const mandatory = declarations.filter(declaration => (
    mandatoryNames.has(declaration.function.name)
  ));
  const mandatoryTokens = declarationTokens(mandatory);
  if (mandatoryTokens > toolBudget) {
    throw new LocalModelContextBudgetError(
      `Local model preflight blocked the request: required tool declarations (${mandatory.map(declaration => declaration.function.name).join(', ')}) require about ${mandatoryTokens} tokens, leaving too little room for the accepted task messages in a ${contextTokens}-token context.`,
      contextTokens,
      mandatoryTokens,
    );
  }

  const selectedNames = new Set(mandatoryNames);
  for (const declaration of declarations) {
    const name = declaration.function.name;
    if (selectedNames.has(name)) continue;
    const candidateNames = new Set([...selectedNames, name]);
    const candidate = declarations.filter(item => candidateNames.has(item.function.name));
    if (declarationTokens(candidate) <= toolBudget) selectedNames.add(name);
  }
  // Filter the original array instead of concatenating priority buckets so
  // the cloud route's declaration ordering remains identical for the subset.
  return declarations.filter(declaration => selectedNames.has(declaration.function.name));
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
  compactToolDeclarations?: boolean;
  /** Tool schemas that a local projection must retain or fail closed. */
  requiredToolNames?: string[];
}): PreparedLocalModelRequest {
  const contextTokens = Math.max(2_048, input.contextTokens || configuredContextTokens());
  const maxTokens = Math.max(128, Math.min(
    Number(input.maxTokens) || 768,
    1_024,
    Math.floor(contextTokens * 0.25),
  ));
  const safetyTokens = Math.max(384, Math.floor(contextTokens * 0.1));
  const inputBudgetTokens = contextTokens - maxTokens - safetyTokens;
  const original = input.messages.map(message => ({ ...message }));
  const sourceUserIndex = resolveAnnotatedSourceUserIndex(original);
  const systemIndexes = original
    .map((message, index) => message.role === 'system' ? index : -1)
    .filter(index => index >= 0);
  let latestUserIndex = -1;
  for (let index = original.length - 1; index >= 0; index -= 1) {
    if (original[index].role === 'user') { latestUserIndex = index; break; }
  }
  const protectedUserIndexes = [sourceUserIndex, latestUserIndex]
    .filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position);
  const continuationBatches = toolContinuationBatches(original, contextTokens);
  const toolProtocolIndexes = new Set(continuationBatches.flat());
  const latestContinuation = continuationBatches.at(-1) || [];
  const continuationIndexes = latestContinuation.length > 0
    && (latestUserIndex < 0 || latestContinuation[0] > latestUserIndex)
    ? latestContinuation
    : [];
  const continuationTokens = continuationIndexes.reduce(
    (total, index) => total + messageTokens(original[index]),
    0,
  );
  const minimumSystemTokens = systemIndexes.length > 0
    ? Math.min(256, systemIndexes.reduce(
        (total, index) => total + messageTokens(original[index]),
        0,
      ))
    : 0;
  const minimumMessageTokens = continuationTokens
    + minimumSystemTokens
    + protectedUserIndexes.length * 64;
  const toolDeclarations = input.compactToolDeclarations
    ? compactLocalToolDeclarations(
        input.toolDeclarations,
        inputBudgetTokens,
        contextTokens,
        input.requiredToolNames,
        minimumMessageTokens,
      )
    : input.toolDeclarations;
  const toolTokens = declarationTokens(toolDeclarations);
  if (toolTokens > inputBudgetTokens - 384) {
    throw new LocalModelContextBudgetError(
      `Local model preflight blocked the request: tool declarations require about ${toolTokens} tokens, exceeding the ${inputBudgetTokens}-token input budget for a ${contextTokens}-token context.`,
      contextTokens,
      toolTokens,
    );
  }

  const originalEstimate = estimateLocalRequestInputTokens(original, toolDeclarations);
  if (originalEstimate <= inputBudgetTokens) {
    return {
      messages: original,
      toolDeclarations,
      maxTokens,
      contextTokens,
      inputBudgetTokens,
      estimatedInputTokens: originalEstimate,
      compacted: toolDeclarations.length !== input.toolDeclarations.length,
      toolDeclarationsCompacted: toolDeclarations.length !== input.toolDeclarations.length,
    };
  }

  const messageBudget = inputBudgetTokens - toolTokens;
  const selected = new Map<number, NormalizedMessage>();
  const minimumSystemBudget = systemIndexes.length > 0
    ? Math.min(
        systemIndexes.reduce((total, index) => total + messageTokens(original[index]), 0),
        Math.max(256, Math.floor(messageBudget * 0.4)),
      )
    : 0;
  if (
    continuationTokens
      + minimumSystemBudget
      + protectedUserIndexes.length * 64
    > messageBudget
  ) {
    throw new LocalModelContextBudgetError(
      'Local model preflight could not retain the accepted source plus the complete assistant tool_call/tool receipt boundary.',
      contextTokens,
      toolTokens,
    );
  }
  for (const index of continuationIndexes) {
    selected.set(index, { ...original[index] });
  }
  const protectedUserBudget = Math.max(
    0,
    messageBudget - minimumSystemBudget - continuationTokens,
  );
  if (protectedUserIndexes.length > 0 && protectedUserBudget < protectedUserIndexes.length * 64) {
    throw new ModelRequestSourceProvenanceError(
      `Local model budget cannot retain ${protectedUserIndexes.length} protected user messages`,
    );
  }

  let remainingProtectedUserBudget = protectedUserBudget;
  for (const [position, index] of protectedUserIndexes.entries()) {
    const protectedLeft = protectedUserIndexes.length - position - 1;
    const reservedForLater = protectedLeft * 64;
    const userBudget = Math.max(64, remainingProtectedUserBudget - reservedForLater);
    const label = index === sourceUserIndex && index !== latestUserIndex
      ? 'annotated source user input'
      : index === latestUserIndex && index !== sourceUserIndex
        ? 'latest synthetic user input'
        : 'latest user message';
    const prepared = messageTokens(original[index]) <= userBudget
      ? { ...original[index] }
      : compactMessage(original[index], userBudget, label);
    const cost = messageTokens(prepared);
    if (cost > userBudget) {
      throw new ModelRequestSourceProvenanceError(
        `Local model budget could not retain protected user message ${index}`,
      );
    }
    selected.set(index, prepared);
    remainingProtectedUserBudget -= cost;
  }

  let used = [...selected.values()].reduce((total, message) => total + messageTokens(message), 0);
  let remaining = Math.max(0, messageBudget - used);
  const systemBudget = systemIndexes.length > 0
    ? Math.min(remaining, Math.max(minimumSystemBudget, Math.floor(remaining * 0.72)))
    : 0;
  let remainingSystemBudget = systemBudget;
  for (const [position, index] of systemIndexes.entries()) {
    const systemsLeft = systemIndexes.length - position;
    const perSystem = Math.max(64, Math.floor(remainingSystemBudget / Math.max(1, systemsLeft)));
    const prepared = messageTokens(original[index]) <= perSystem
      ? { ...original[index], reasoningContent: null }
      : compactMessage(original[index], perSystem, 'system message');
    const cost = messageTokens(prepared);
    if (cost > remainingSystemBudget) continue;
    selected.set(index, prepared);
    remainingSystemBudget -= cost;
  }

  used = [...selected.values()].reduce((total, message) => total + messageTokens(message), 0);
  for (let index = original.length - 1; index >= 0 && used < messageBudget; index -= 1) {
    if (selected.has(index)) continue;
    // Older tool-call batches may be omitted during compaction, but never
    // split into an orphan assistant call or receipt that formatting would
    // silently reinterpret as an ordinary user message.
    if (toolProtocolIndexes.has(index)) continue;
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
  const estimatedInputTokens = estimateLocalRequestInputTokens(messages, toolDeclarations);
  if (estimatedInputTokens > inputBudgetTokens) {
    throw new LocalModelContextBudgetError(
      `Local model preflight could not compact the request below ${inputBudgetTokens} input tokens.`,
      contextTokens,
      toolTokens,
    );
  }
  return {
    messages,
    toolDeclarations,
    maxTokens,
    contextTokens,
    inputBudgetTokens,
    estimatedInputTokens,
    compacted: true,
    toolDeclarationsCompacted: toolDeclarations.length !== input.toolDeclarations.length,
  };
}
