import { describe, expect, it } from 'vitest';
import { getDomainReconciliation } from '../src/lib/domainSession';

describe('personal and organization session reconciliation', () => {
  it('keeps a valid personal token without bootstrapping again', () => {
    expect(getDomainReconciliation('personal', null, 'org-previous')).toBe('none');
  });

  it('clears organization claims when the client is in personal mode', () => {
    expect(getDomainReconciliation('personal', 'org-active', 'org-active')).toBe('switch_personal');
  });

  it('enters or changes organization scope when work mode requires it', () => {
    expect(getDomainReconciliation('work', null, 'org-target')).toBe('switch_work');
    expect(getDomainReconciliation('work', 'org-old', 'org-target')).toBe('switch_work');
    expect(getDomainReconciliation('work', 'org-target', 'org-target')).toBe('none');
  });
});
