/** Request-owned state shared by the tool loop and its guarded recovery.
 * Never persist it or reuse it across user turns/conversations. */
export interface ModelTurnState {
  modelWaitMs: number;
  failedCandidates: Set<string>;
}

export function createModelTurnState(): ModelTurnState {
  return { modelWaitMs: 0, failedCandidates: new Set() };
}

export function modelCandidateKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

export function rememberFailedModelCandidates(state: ModelTurnState | undefined, attempts: ReadonlyArray<{
  provider: string; model: string; status: string; reason?: string;
}>): void {
  if (!state) return;
  for (const attempt of attempts) {
    // Malformed arguments/content may be repaired by another prompt. Only
    // transport/account failures make this candidate unavailable this turn.
    if (attempt.status === 'failed' && ['timeout', 'provider_unreachable', 'provider_auth_failed',
      'quota_or_billing', 'model_unavailable'].includes(attempt.reason || '')) {
      state.failedCandidates.add(modelCandidateKey(attempt.provider, attempt.model));
    }
  }
}
