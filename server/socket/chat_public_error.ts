export const CHAT_PUBLIC_ERROR_MESSAGES = {
  CHAT_CONTROL_RECEIPT_WRITE_FAILED: 'Lumi could not durably reserve this control request. Refresh the task state before retrying.',
  CHAT_CONTROL_CANCEL_FAILED: 'Lumi could not confirm that cancellation settled. Refresh the task state before retrying.',
  CHAT_CONVERSATION_REFRESH_FAILED: 'This conversation is unavailable for the current user or workspace.',
  CHAT_ACTION_TURN_BIND_FAILED: 'Lumi could not bind this message to the active task. Refresh the task state before retrying.',
  CHAT_MODEL_ROUTES_UNAVAILABLE: 'Lumi tried the configured model route, but no model is currently available. Check provider balance or health, or start the configured local model, then retry.',
  CHAT_EXECUTION_FAILED: 'Lumi could not complete this chat turn. Check the task state before retrying.',
} as const;

export type ChatPublicErrorCode = keyof typeof CHAT_PUBLIC_ERROR_MESSAGES;

const CHAT_PUBLIC_ERROR_CODES = new Set<string>(Object.keys(CHAT_PUBLIC_ERROR_MESSAGES));

export function chatPublicErrorCodeForException(error: unknown): ChatPublicErrorCode {
  const candidate = error as any;
  if (
    candidate?.name === 'ModelRoutingDispatchError'
    || Array.isArray(candidate?.routing?.attempts)
  ) {
    return 'CHAT_MODEL_ROUTES_UNAVAILABLE';
  }
  return 'CHAT_EXECUTION_FAILED';
}

/**
 * `agent:error` is a public/durable terminal boundary. Never carry arbitrary
 * exception properties, messages, prompts or stacks into its socket payload or
 * terminal receipt. Only stable codes and their reviewed public text survive.
 */
export function sanitizeChatAgentErrorPayload(payload: Record<string, unknown> = {}) {
  const requestedCode = String(payload.code || '').trim();
  const code = (CHAT_PUBLIC_ERROR_CODES.has(requestedCode)
    ? requestedCode
    : 'CHAT_EXECUTION_FAILED') as ChatPublicErrorCode;
  return {
    message: CHAT_PUBLIC_ERROR_MESSAGES[code],
    code,
    agentName: 'Lumi',
    finalized: true,
    blocked: true,
    reason: code.toLowerCase(),
    ...(payload.sidecar === true ? { sidecar: true } : {}),
  };
}
