export interface BackgroundDeliveryScope {
  userId: string;
  domain?: string;
  orgId?: string | null;
}

const latestTurnByScope = new Map<string, string>();
const MAX_TRACKED_SCOPES = 2048;

function scopeKey(scope: BackgroundDeliveryScope): string {
  return `${scope.userId}:${scope.domain || 'personal'}:${scope.orgId || ''}`;
}

export function markLatestUserTurn(scope: BackgroundDeliveryScope, requestId: string): void {
  const key = scopeKey(scope);
  latestTurnByScope.delete(key);
  latestTurnByScope.set(key, requestId);
  while (latestTurnByScope.size > MAX_TRACKED_SCOPES) {
    const oldest = latestTurnByScope.keys().next().value;
    if (!oldest) break;
    latestTurnByScope.delete(oldest);
  }
}

export function isLatestUserTurn(scope: BackgroundDeliveryScope, requestId: string): boolean {
  return latestTurnByScope.get(scopeKey(scope)) === requestId;
}

export function clearBackgroundDeliveryRegistryForTests(): void {
  latestTurnByScope.clear();
}
