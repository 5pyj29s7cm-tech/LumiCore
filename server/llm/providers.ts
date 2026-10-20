import type { ProviderArguments } from "./provider_getters";
import type { NormalizedLLMResponse } from "../tools/types";
import { isStrictPrivacy } from "../config/privacy";
import type { ModelRoutingTrace } from "./model_routing_receipts";
import type { NormalizedMessage, ToolDeclaration, LLMCallConfig, StreamCallback } from './provider/contracts';
import { resolvedSelectionMode, directRoutingTrace, persistRoutingTrace } from './provider/routing_trace';
import { pinnedFailoverDispatchPreference, autoDispatchPreference, autoDispatchGetters } from './provider/dispatch_preferences';
import { makeLLMCallStreamingDirect } from './provider/streaming';
import { makeLLMCallDirect } from './provider/buffered';
import { providerOutboundEvidenceFrom, withoutPrivateProviderOutboundEvidence } from './provider/outbound_evidence';

export type { MessageContent } from './provider/contracts';
export type { LLMResponseFormat } from './provider/contracts';
export type { ReasoningProvider } from './provider/contracts';
export type { LLMCallConfig } from './provider/contracts';
export type { ModelAttemptTimeouts } from './provider/contracts';
export { DEFAULT_MODEL_ATTEMPT_TIMEOUTS } from './provider/deadlines';
export type { ModelAttemptDeadlineStage } from './provider/contracts';
export { ModelAttemptDeadlineError } from './provider/deadlines';
export { resolveModelAttemptTimeouts } from './provider/deadlines';
export type { NormalizedMessage } from './provider/contracts';
export { parseLegacyXmlToolCalls } from './provider/legacy_protocol';
export { resolveModelMaxTokens } from './provider/dispatch_preferences';
export { formatDeepSeekRequest } from './provider/openai_compatible';
export { ModelToolArgumentsError } from './provider/response';
export { parseDeepSeekResponse } from './provider/openai_compatible';
export { formatGeminiRequest } from './provider/gemini';
export { parseGeminiResponse } from './provider/gemini';
export { formatOpenAIRequest } from './provider/openai_compatible';
export { parseOpenAIResponse } from './provider/openai_compatible';
export { formatQwenRequest } from './provider/openai_compatible';
export { formatAnthropicRequest } from './provider/anthropic';
export { parseAnthropicResponse } from './provider/anthropic';
export { makeLLMCallDirect } from './provider/buffered';
export type { StreamCallback } from './provider/contracts';
export { makeLLMCallStreamingDirect } from './provider/streaming';
export { estimateTokenCount } from './provider/tokens';

async function callRoutedModel(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
  getters: ProviderArguments,
  stream?: { onChunk: StreamCallback },
): Promise<NormalizedLLMResponse> {
  const startedAt = Date.now();
  const selectionMode = resolvedSelectionMode(config);
  const pinnedFailover = selectionMode === 'pinned'
    ? pinnedFailoverDispatchPreference(config)
    : null;
  try {
    let result: NormalizedLLMResponse;
    if (selectionMode === 'auto' || selectionMode === 'ordered_fallback' || pinnedFailover) {
      const dispatch = await import("./dispatch");
      const dispatchConfig = selectionMode === 'auto'
        ? autoDispatchPreference({ ...config, selectionMode })
        : pinnedFailover || {
            ...config,
            selectionMode,
            requestedProvider: config.provider,
            requestedModel: config.model,
            allowCloudFallback: config.allowCloudFallback !== false && !isStrictPrivacy(),
          };
      const clients = autoDispatchGetters(...getters);
      result = stream
        ? await dispatch.dispatchLLMCallStreaming(messages, toolDeclarations, dispatchConfig, stream.onChunk, clients)
        : await dispatch.dispatchLLMCall(messages, toolDeclarations, dispatchConfig, clients);
    } else {
      const directConfig = { ...config, selectionMode: 'pinned' as const };
      result = stream
        ? await makeLLMCallStreamingDirect(messages, toolDeclarations, directConfig, stream.onChunk, ...getters)
        : await makeLLMCallDirect(messages, toolDeclarations, directConfig, ...getters);
    }
    const trace = result.routing || directRoutingTrace(config, 'succeeded', undefined, result);
    const routingReceiptId = persistRoutingTrace(
      config, trace, 'succeeded', startedAt, providerOutboundEvidenceFrom(result),
    );
    return {
      ...withoutPrivateProviderOutboundEvidence(result),
      routing: trace,
      ...(routingReceiptId ? { routingReceiptId } : {}),
    };
  } catch (error) {
    const trace = (error as any)?.routing as ModelRoutingTrace | undefined
      || directRoutingTrace(config, 'failed', error);
    persistRoutingTrace(config, trace, 'failed', startedAt, providerOutboundEvidenceFrom(error));
    throw error;
  }
}

export function makeLLMCall(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
  ...getters: ProviderArguments
): Promise<NormalizedLLMResponse> {
  return callRoutedModel(messages, toolDeclarations,
    config.relayStreaming ? { ...config, bufferStreamUntilCandidateSuccess: true } : config,
    getters, config.relayStreaming ? { onChunk: () => {} } : undefined);
}

export function makeLLMCallStreaming(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
  onChunk: StreamCallback,
  ...getters: ProviderArguments
): Promise<NormalizedLLMResponse> {
  return callRoutedModel(messages, toolDeclarations, config, getters, { onChunk });
}
