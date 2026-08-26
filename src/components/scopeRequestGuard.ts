export interface ScopeRequestToken {
  scopeKey: string;
  generation: number;
}

export function isCurrentScopeRequest(
  request: ScopeRequestToken,
  currentScopeKey: string,
  currentGeneration: number,
): boolean {
  return request.scopeKey === currentScopeKey && request.generation === currentGeneration;
}
