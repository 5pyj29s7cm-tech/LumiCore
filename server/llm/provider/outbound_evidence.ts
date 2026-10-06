import type { NormalizedLLMResponse } from "../../tools/types";
import type { ModelRoutingTrace } from "../model_routing_receipts";
import { normalizeProviderOutboundMessagesEvidence, type ProviderOutboundMessagesEvidence } from "../outbound_message_evidence";
import type { PreparedModelRequestContext } from "../request_context_budget";
import { attachModelRequestContext } from './request_context';

export type ResponseWithProviderOutboundEvidence = NormalizedLLMResponse & {
  _providerOutboundMessagesEvidence?: ProviderOutboundMessagesEvidence;
};

export type ErrorWithProviderOutboundEvidence = Error & {
  providerOutboundMessagesEvidence?: ProviderOutboundMessagesEvidence;
};

export function attachProviderOutboundEvidence(
  response: NormalizedLLMResponse,
  evidence: ProviderOutboundMessagesEvidence,
): ResponseWithProviderOutboundEvidence {
  return { ...response, _providerOutboundMessagesEvidence: evidence };
}

export function providerOutboundEvidenceFrom(value: unknown): ProviderOutboundMessagesEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return normalizeProviderOutboundMessagesEvidence(
    (value as ResponseWithProviderOutboundEvidence)._providerOutboundMessagesEvidence
      || (value as ErrorWithProviderOutboundEvidence).providerOutboundMessagesEvidence,
  ) || undefined;
}

export function attachProviderOutboundEvidenceToError(
  error: unknown,
  evidence: ProviderOutboundMessagesEvidence,
): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  try {
    Object.defineProperty(target, 'providerOutboundMessagesEvidence', {
      configurable: true,
      enumerable: false,
      value: evidence,
      writable: false,
    });
    return target;
  } catch {
    const wrapped = new Error(target.message, { cause: target });
    wrapped.name = target.name;
    Object.defineProperty(wrapped, 'providerOutboundMessagesEvidence', {
      configurable: false,
      enumerable: false,
      value: evidence,
      writable: false,
    });
    return wrapped;
  }
}

export async function executeWithProviderOutboundEvidence(
  evidence: ProviderOutboundMessagesEvidence,
  operation: () => Promise<NormalizedLLMResponse>,
  preparedContext?: PreparedModelRequestContext,
  deliveredToolNames?: readonly string[],
): Promise<ResponseWithProviderOutboundEvidence> {
  try {
    const response = await operation();
    if (preparedContext) attachModelRequestContext(response, preparedContext, deliveredToolNames);
    return attachProviderOutboundEvidence(response, evidence);
  } catch (error) {
    throw attachProviderOutboundEvidenceToError(error, evidence);
  }
}

export function withoutPrivateProviderOutboundEvidence(
  response: ResponseWithProviderOutboundEvidence,
): NormalizedLLMResponse {
  const result = { ...response };
  delete result._providerOutboundMessagesEvidence;
  return result;
}

export function traceWithProviderOutboundEvidence(
  trace: ModelRoutingTrace,
  evidence: ProviderOutboundMessagesEvidence | undefined,
  status: 'succeeded' | 'failed',
): ModelRoutingTrace {
  if (!evidence) return trace;
  let attached = false;
  const attempts = trace.attempts.map(attempt => {
    const matches = attempt.provider === evidence.provider
      && attempt.model === evidence.model
      && attempt.status === status;
    if (!matches || attached) return attempt;
    attached = true;
    return { ...attempt, outboundMessagesEvidence: evidence };
  });
  if (!attached) {
    // Never mint a new routing attempt from evidence alone. A provider payload
    // without the matching real attempt remains intentionally unpersisted.
    return trace;
  }
  return { ...trace, attempts };
}
