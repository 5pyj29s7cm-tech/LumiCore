import { rememberFailedModelCandidates } from "../model_turn_state";
import type { UserLLMSelectionMode } from "../user_preferences";
import { modelAttemptCompletion, modelRoutingErrorDigest, modelRoutingErrorReason, persistModelRoutingReceipt, type ModelRoutingTrace } from "../model_routing_receipts";
import type { ProviderOutboundMessagesEvidence } from "../outbound_message_evidence";
import type { LLMCallConfig } from './contracts';
import type { NormalizedLLMResponse } from '../../tools/types';
import { ModelAttemptDeadlineError } from './deadlines';
import { traceWithProviderOutboundEvidence } from './outbound_evidence';

// ── LLM Call Router ──

export function directRoutingTrace(config: LLMCallConfig, status: 'succeeded' | 'failed', error?: unknown, completion?: Pick<NormalizedLLMResponse, 'finishReason' | 'usage'>): ModelRoutingTrace {
  const reason = status === 'failed' ? modelRoutingErrorReason(error) : '';
  return {
    requestedProvider: config.provider,
    requestedModel: config.model,
    selectionMode: 'pinned',
    selectedProvider: status === 'succeeded' ? config.provider : '',
    selectedModel: status === 'succeeded' ? config.model : '',
    fallbackReason: reason,
    attempts: [{
      provider: config.provider,
      model: config.model,
      status,
      ...(reason ? { reason, errorDigest: modelRoutingErrorDigest(error) } : {}),
      ...modelAttemptCompletion(completion || (error instanceof ModelAttemptDeadlineError ? error : {})),
    }],
  };
}

export function persistRoutingTrace(
  config: LLMCallConfig,
  trace: ModelRoutingTrace,
  status: 'succeeded' | 'failed',
  startedAtMs: number,
  outboundMessagesEvidence?: ProviderOutboundMessagesEvidence,
): string | undefined {
  rememberFailedModelCandidates(config.modelTurnState, trace.attempts);
  try {
    const persistedTrace = traceWithProviderOutboundEvidence(
      trace,
      outboundMessagesEvidence,
      status,
    );
    const receipt = persistModelRoutingReceipt({
      userId: config.userId || 'anonymous',
      domain: config.domain || 'personal',
      orgId: config.orgId || '',
      conversationId: config.conversationId || '',
      requestId: config.requestId || '',
      nativeDeviceId: config.nativeDeviceId || '',
      executionSessionId: config.executionSessionId || '',
      nativeClientIdentitySha256: config.nativeClientIdentitySha256 || '',
      audioInputKind: config.audioInputKind,
      syntheticAudio: config.syntheticAudio,
      captureSessionId: config.captureSessionId || '',
      sttReceiptId: config.sttReceiptId || '',
      contextChainId: config.contextChainId || '',
      previousRequestId: config.previousRequestId || '',
      interactionId: config.interactionId || '',
      source: config.source || '',
      status,
      ...persistedTrace,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });
    return receipt.id;
  } catch (error) {
    // Production initializes the durable database before serving calls. Some
    // isolated provider harnesses intentionally omit it; never replace a real
    // model result with a fabricated receipt in that environment.
    console.warn('[ModelRouting] Could not persist routing receipt:', (error as Error)?.message || error);
    return undefined;
  }
}

export function resolvedSelectionMode(config: LLMCallConfig): UserLLMSelectionMode {
  // An exact candidate is deliberately reduced to the direct provider path.
  // In particular, `auto` is not meaningful under this contract and will be
  // rejected by the direct adapter instead of silently expanding into a route.
  if (config.noImplicitFailover === true) return 'pinned';
  if (config.provider === 'auto') return 'auto';
  if (config.selectionMode === 'ordered_fallback') return 'ordered_fallback';
  return 'pinned';
}
