import type { NormalizedLLMResponse } from "../../tools/types";
import type { PreparedModelRequestContext } from "../request_context_budget";

export const providerSourceUserSlots = new WeakMap<object, string>();

export function markProviderSourceUserSlot<T extends object>(message: T, sourceMessageId: unknown): T {
  const durableId = String(sourceMessageId || '').trim();
  if (durableId) providerSourceUserSlots.set(message, durableId);
  return message;
}

export function attachModelRequestContext<T extends NormalizedLLMResponse>(
  response: T,
  prepared: PreparedModelRequestContext,
  deliveredToolNames?: readonly string[],
): T {
  const preparedToolNames = prepared.toolDeclarations.map(declaration => declaration.function.name);
  const delivered = deliveredToolNames
    ? Array.from(new Set(deliveredToolNames.map(name => String(name || '').trim()).filter(Boolean)))
    : preparedToolNames;
  const deliveredSet = new Set(delivered);
  response.modelRequestContext = {
    deliveredToolNames: delivered,
    droppedToolNames: Array.from(new Set([
      ...prepared.droppedToolNames,
      ...preparedToolNames.filter(name => !deliveredSet.has(name)),
    ])),
  };
  return response;
}

export function providerSourceUserSlot(messages: object[]): {
  sourceMessageId?: string;
  sourceMessageIndex: number | null;
} {
  let found: { sourceMessageId: string; sourceMessageIndex: number } | null = null;
  messages.forEach((message, sourceMessageIndex) => {
    const sourceMessageId = providerSourceUserSlots.get(message);
    if (!sourceMessageId) return;
    if (found) throw new Error('provider_outbound_multiple_source_messages');
    found = { sourceMessageId, sourceMessageIndex };
  });
  return found || { sourceMessageIndex: null };
}
