export type AgentActivityProjection =
  | 'thinking'
  | 'executing'
  | 'waiting_confirmation'
  | 'cancelling'
  | null;

export interface AgentStatusEvidence {
  /** Set only by a server-owned status emitter after accepting execution. */
  executionAccepted?: boolean;
  /** A real tool lifecycle/receipt already arrived for this exact request. */
  hasToolEvidence?: boolean;
}

/**
 * Project transport status into truthful user-visible activity.
 *
 * `responding` is language generation, not task execution. An `executing`
 * string is also insufficient by itself: it must be accompanied by a
 * server-owned acceptance marker or an observed tool event for this request.
 */
export function projectAgentActivity(
  status: unknown,
  evidence: AgentStatusEvidence = {},
): AgentActivityProjection {
  const normalized = String(status || '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'replacing'
    || normalized === 'acknowledged'
    || normalized === 'planning'
    || normalized === 'thinking'
    || normalized === 'responding'
  ) return 'thinking';
  if (normalized === 'executing') {
    return evidence.executionAccepted === true || evidence.hasToolEvidence === true
      ? 'executing'
      : 'thinking';
  }
  if (normalized === 'waiting_confirmation') return 'waiting_confirmation';
  if (normalized === 'cancelling') return 'cancelling';
  return null;
}
