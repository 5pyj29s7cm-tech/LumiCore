import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBackgroundDeliveryRegistryForTests,
  isLatestUserTurn,
  markLatestUserTurn,
} from '../server/agents/background_delivery';

describe('background terminal delivery', () => {
  beforeEach(() => clearBackgroundDeliveryRegistryForTests());

  it('delivers while the delegated turn is still the latest user turn', () => {
    const scope = { userId: 'user-1', domain: 'personal' };
    markLatestUserTurn(scope, 'request-1');
    expect(isLatestUserTurn(scope, 'request-1')).toBe(true);
  });

  it('suppresses a late result after the user has moved to a newer turn', () => {
    const scope = { userId: 'user-1', domain: 'personal' };
    markLatestUserTurn(scope, 'request-1');
    markLatestUserTurn(scope, 'request-2');
    expect(isLatestUserTurn(scope, 'request-1')).toBe(false);
    expect(isLatestUserTurn(scope, 'request-2')).toBe(true);
  });

  it('keeps personal and organization scopes isolated', () => {
    const personal = { userId: 'user-1', domain: 'personal' };
    const work = { userId: 'user-1', domain: 'work', orgId: 'org-1' };
    markLatestUserTurn(personal, 'personal-request');
    markLatestUserTurn(work, 'work-request');
    expect(isLatestUserTurn(personal, 'personal-request')).toBe(true);
    expect(isLatestUserTurn(work, 'work-request')).toBe(true);
  });
});
