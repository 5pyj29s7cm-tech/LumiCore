import type { NormalizedMessage } from './providers';
import { estimateModelRequestInputTokens, prepareModelRequestContext, resolveAnnotatedSourceUserIndex, resolveModelRequestInputBudget, type PreparedModelRequestContext } from './request_context_budget';
export { estimateModelRequestInputTokens as estimateLocalRequestInputTokens, estimateModelRequestTextTokens as estimateLocalTextTokens } from './request_context_budget';

export interface LocalContextToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface PreparedLocalModelRequest extends PreparedModelRequestContext {
  maxTokens: number;
  contextTokens: number;
  inputBudgetTokens: number;
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

const messageTokens = (message: NormalizedMessage) => estimateModelRequestInputTokens([message], []);
const declarationTokens = (tools: LocalContextToolDeclaration[]) => estimateModelRequestInputTokens([], tools);

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

export function prepareLocalModelRequest(input: {
  messages: NormalizedMessage[];
  toolDeclarations: LocalContextToolDeclaration[];
  maxTokens?: number;
  contextTokens?: number;
  inputTokenBudget?: number;
  compactToolDeclarations?: boolean;
  requiredToolNames?: string[];
}): PreparedLocalModelRequest {
  const contextTokens = Math.max(2_048, input.contextTokens || configuredContextTokens());
  const structuredOutput = input.toolDeclarations.some(tool => Object.entries(tool.function.parameters?.properties || {}).some(([key, schema]: [string, any]) => (key === 'code' && schema?.type === 'string') || (schema?.type === 'array' && schema.items?.type === 'object')));
  const defaultMaxTokens = structuredOutput ? 1536 : 768;
  const requestedMaxTokens = Number.isFinite(input.maxTokens) && input.maxTokens! > 0 ? Math.trunc(input.maxTokens!) : defaultMaxTokens;
  const safetyTokens = Math.max(384, Math.floor(contextTokens * 0.1));
  const workingInputTokens = Math.max(2048, Math.min(32768, Number(process.env.LUMI_LOCAL_MODEL_INPUT_BUDGET_TOKENS) || 6144));
  const inputBudgetTokens = Math.min(contextTokens - Math.min(requestedMaxTokens, defaultMaxTokens) - safetyTokens, workingInputTokens, resolveModelRequestInputBudget(input.inputTokenBudget));
  if (inputBudgetTokens < 128) throw new LocalModelContextBudgetError('Local model context capacity cannot retain the requested output and original input budget.', contextTokens, 0);
  const original = input.messages;
  const sourceUserIndex = resolveAnnotatedSourceUserIndex(original);
  let latestUserIndex = -1;
  for (let index = original.length - 1; index >= 0; index--) if (original[index].role === 'user') { latestUserIndex = index; break; }
  const requiredUsers = original.map((message, index) => message.role === 'user' && message.promptBlock?.required ? index : -1);
  const protectedUsers = [sourceUserIndex, latestUserIndex, ...requiredUsers].filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position);
  const continuationTokens = original.slice(latestUserIndex + 1).filter(message => message.role === 'tool' || (message.role === 'assistant' && message.toolCalls?.length)).reduce((sum, message) => sum + messageTokens(message), 0);
  const systemTokens = original.filter(message => message.role === 'system').reduce((sum, message) => sum + (message.promptBlock?.required ? messageTokens(message) : Math.min(256, messageTokens(message))), 0);
  const protectedUserTokens = protectedUsers.reduce((sum, index) => sum + messageTokens(original[index]), 0);
  const toolDeclarations = input.compactToolDeclarations ? compactLocalToolDeclarations(input.toolDeclarations, inputBudgetTokens, contextTokens, input.requiredToolNames, continuationTokens + systemTokens + protectedUserTokens) : input.toolDeclarations;
  const toolTokens = declarationTokens(toolDeclarations);
  if (toolTokens > inputBudgetTokens - 384) throw new LocalModelContextBudgetError('Local model preflight blocked tool declarations exceeding the available input context.', contextTokens, toolTokens);
  const prepared = prepareModelRequestContext({ messages: original, toolDeclarations, inputTokenBudget: input.inputTokenBudget, maxInputTokens: inputBudgetTokens, atomicToolProtocol: true,
    protectedToolNames: input.compactToolDeclarations ? toolDeclarations.map(tool => tool.function.name) : input.requiredToolNames });
  if (prepared.currentInputCompacted) throw new LocalModelContextBudgetError('Local model context capacity cannot retain complete original user input.', contextTokens, toolTokens);
  const maxTokens = Math.min(requestedMaxTokens, contextTokens - safetyTokens - prepared.estimatedInputTokens);
  const droppedToolNames = input.toolDeclarations.map(tool => tool.function.name).filter(name => !prepared.toolDeclarations.some(tool => tool.function.name === name));
  return { ...prepared, maxTokens, contextTokens, inputBudgetTokens, originalEstimatedInputTokens: estimateModelRequestInputTokens(original, input.toolDeclarations), droppedToolNames,
    compacted: prepared.compacted || droppedToolNames.length > 0, toolDeclarationsCompacted: droppedToolNames.length > 0 };
}
