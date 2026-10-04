import { runWithTools } from './adapter';
import type { ProviderGetters } from './provider_getters';

type ToolLoopArguments = Parameters<typeof runWithTools>;

/** Named channel inputs; the adapter retains sole ownership of execution and budgets. */
export interface ToolSessionOptions {
  messages: ToolLoopArguments[0];
  registry: ToolLoopArguments[1];
  config: ToolLoopArguments[2];
  onToolCall?: ToolLoopArguments[3];
  maxIterations?: ToolLoopArguments[4];
  onStreamChunk?: ToolLoopArguments[10];
  context?: ToolLoopArguments[11];
  getters?: Partial<ProviderGetters>;
}

export function runToolSession(input: ToolSessionOptions): ReturnType<typeof runWithTools> {
  const getters = input.getters || {};
  return runWithTools(
    input.messages, input.registry, input.config, input.onToolCall, input.maxIterations,
    getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic,
    getters.getQwen, input.onStreamChunk, input.context, getters.getOllama,
    getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi,
    getters.getGlm, getters.getRelay,
  );
}
