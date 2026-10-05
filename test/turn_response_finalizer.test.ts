import { describe, expect, it } from 'vitest';
import { createTurnResponseFinalizer } from '../server/cognition/turn_response_finalizer';
import { formatPendingConfirmationRequest, type PendingToolConfirmation } from '../server/tools/pending_confirmation';

const pending: PendingToolConfirmation = {
  id: 'pending', userId: 'owner', toolName: 'send_email', argsHash: 'args', target: 'exact@example.test', payloadDigest: 'payload',
  exactArgs: { to: 'exact@example.test', body: 'approved body' }, safeArgs: { to: 'exact@example.test' }, actionIntent: 'Send an email',
  source: 'chat', domain: 'personal', orgId: '', channelId: 'conversation', taskId: 'task', originRequestId: 'request',
  createdAt: '2026-10-05', expiresAt: Date.now() + 60_000,
};
describe('shared chat and voice response decision', () => {
  it.each(['chat', 'voice_guard_recovery'])('preserves the exact waiting grant instead of applying a missing-evidence or pause verdict (%s)', source => {
    const finalizer = createTurnResponseFinalizer({ taskText: 'Send an email', taskId: 'task', requestId: 'request',
      pendingConfirmation: () => pending, controlPauseReason: () => 'desktop_control_paused_for_user_activity' });
    expect(finalizer.finalize({ responseText: 'The email has already been sent.', toolRecords: [], source })).toMatchObject({
      text: formatPendingConfirmationRequest(pending), blocked: false, reason: 'waiting_confirmation',
    });
    expect(finalizer.isDesktopPaused([])).toBe(false);
  });
  it('observes confirmation changes made during execution or recovery', () => {
    let active: PendingToolConfirmation | null = null;
    const finalizer = createTurnResponseFinalizer({ taskText: 'Send an email', pendingConfirmation: () => active, controlPauseReason: () => null });
    expect(finalizer.finalize({ responseText: 'The email has been sent.', toolRecords: [], source: 'chat' }).blocked).toBe(true);
    active = pending;
    expect(finalizer.finalize({ responseText: 'candidate', toolRecords: [], source: 'chat_guard_recovery' }).reason).toBe('waiting_confirmation');
  });
  it('uses the same pause adjudication for normal and recovery candidates without treating it as cancellation', () => {
    const finalizer = createTurnResponseFinalizer({ taskText: 'Open the app and edit the document', pendingConfirmation: () => null,
      controlPauseReason: () => 'desktop_control_paused_for_user_activity' });
    expect(finalizer.isDesktopPaused([])).toBe(true);
    const normal = finalizer.finalize({ responseText: 'Done.', toolRecords: [], source: 'voice' });
    const recovery = finalizer.finalize({ responseText: 'Recovered.', toolRecords: [], source: 'voice_guard_recovery' });
    expect(normal.blocked).toBe(true); expect(normal.reason).not.toMatch(/cancel/i);
    expect(recovery).toMatchObject({ text: normal.text, blocked: true, reason: normal.reason });
  });
});
