import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { captureChatAuthorization } from '../server/socket/chat_authorization';
let sequence = 0;
beforeAll(async () => { await initDatabase(); });
function workScope() {
  const userId = 'captured-scope-user-' + ++sequence;
  const org = createOrg('Captured scope organization', 'captured-scope-org-' + sequence, 'captured-scope-owner-' + sequence);
  addMember(org.id, userId, 'member');
  return { userId, org, scope: { domain: 'work' as 'work' | 'personal', orgId: org.id } };
}
describe('request authorization captures its admitted scope', () => {
  it.each(['personal', 'another-organization'] as const)('cannot become authorized through a later %s scope', async replacement => {
    const f = workScope(); const guard = captureChatAuthorization(f.userId, f.scope);
    const controller = new AbortController(); const stop = guard.watch(controller);
    try {
      if (replacement === 'personal') { f.scope.domain = 'personal'; f.scope.orgId = ''; }
      else {
        const another = createOrg('Replacement org', 'replacement-scope-org-' + sequence, 'replacement-scope-owner-' + sequence);
        addMember(another.id, f.userId, 'member'); f.scope.orgId = another.id;
      }
      removeMember(f.org.id, f.userId);
      await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
      expect(guard.isCurrent()).toBe(false);
      expect(() => guard.assertCurrent()).toThrow('Organization access changed');
    } finally { stop(); }
  });
  it('keeps a personal request personal after its caller switches to a work scope', () => {
    const f = workScope(); const scope = { domain: 'personal' as 'personal' | 'work', orgId: '' };
    const guard = captureChatAuthorization(f.userId, scope); const controller = new AbortController(); const stop = guard.watch(controller);
    try {
      scope.domain = 'work'; scope.orgId = f.org.id; removeMember(f.org.id, f.userId);
      expect(guard.isCurrent()).toBe(true); expect(() => guard.assertCurrent()).not.toThrow();
      expect(controller.signal.aborted).toBe(false);
    } finally { stop(); }
  });
  it('never restores an admitted organization identity after removal and rejoin', () => {
    const f = workScope(); const guard = captureChatAuthorization(f.userId, f.scope);
    removeMember(f.org.id, f.userId); expect(guard.isCurrent()).toBe(false);
    addMember(f.org.id, f.userId, 'member'); expect(guard.isCurrent()).toBe(false);
    const lateController = new AbortController(); const stop = guard.watch(lateController);
    try { expect(lateController.signal.aborted).toBe(true); } finally { stop(); }
  });
});
