import './helpers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import {
  clearAllPendingConfirmationsForTests, recordPendingConfirmationDurably,
  buildTransportNeutralConfirmationScope, getPendingConfirmation,
  type PendingToolConfirmation,
} from '../server/tools/pending_confirmation';

beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); });
beforeEach(() => clearAllPendingConfirmationsForTests());

describe('one immutable confirmation boundary across transports', () => {
  const userId = 'turn-confirmation-audit-owner';
  const scope = buildTransportNeutralConfirmationScope({ conversationId: 'confirmation-audit', taskId: 'task-audit', domain: 'personal' });
  const proposal = { path: 'D:/isolated-fixture.txt', content: 'synthetic content' };
  const build = (extra: Partial<Parameters<typeof createTurnConfirmation>[0]> = {}) => {
    const created: PendingToolConfirmation[] = [];
    const confirm = createTurnConfirmation({
      userId, source: 'test', requestId: 'current-audit-request', actionIntent: 'Prepare the file and ask me before writing.',
      consumeScope: () => scope, proposalScope: () => scope, onPending: pending => created.push(pending), ...extra,
    });
    return { confirm, created };
  };

  it('does not replace the first proposal or auto-approve another call after waiting starts', async () => {
    const { confirm, created } = build();
    expect(await confirm('desktop_write_text_file', proposal)).toBe(false);
    expect(await confirm('desktop_write_text_file', { ...proposal, path: 'D:/changed-fixture.txt' })).toBe(false);
    expect(await confirm('write_file', { path: 'D:/fixture.txt', content: 'fixture' })).toBe(false);
    expect(created).toHaveLength(1);
    expect(getPendingConfirmation(userId, scope)?.exactArgs).toEqual(proposal);
  });

  it('concurrent tool proposals cannot race into two pending confirmations', async () => {
    const { confirm, created } = build();
    expect(await Promise.all([confirm('desktop_write_text_file', proposal), confirm('desktop_write_text_file', { ...proposal, content: 'changed' })])).toEqual([false, false]);
    expect(created).toHaveLength(1);
  });

  it('consumes the exact grant once and records a fresh proposal on a later attempt', async () => {
    const pending = await recordPendingConfirmationDurably(userId, 'desktop_write_text_file', proposal, 'voice', { ...scope, originRequestId: 'original' });
    const { confirm, created } = build({ pending });
    expect(await confirm('desktop_write_text_file', proposal)).toBe(true);
    expect(await confirm('desktop_write_text_file', proposal)).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].originRequestId).toBe('current-audit-request');
  });

  it('rejects a corrected write that differs from the runtime-owned exact call', async () => {
    const { confirm, created } = build({
      correctionRequiresFreshConfirmation: true, exactWriteCorrection: true,
      recoveryCall: () => ({ name: 'write_file', arguments: { path: 'D:/fixture.txt', content: 'approved' } }),
    });
    await expect(confirm('write_file', { path: 'D:/fixture.txt', content: 'changed' })).rejects.toThrow('runtime-owned exact proposal');
    expect(created).toHaveLength(0);
    expect(await confirm('write_file', { path: 'D:/fixture.txt', content: 'approved' })).toBe(false);
    expect(created).toHaveLength(1);
  });

  it('cancelled callers cannot consume or replace an existing exact grant', async () => {
    const pending = await recordPendingConfirmationDurably(userId, 'desktop_write_text_file', proposal, 'task', scope);
    const { confirm, created } = build({ pending, isCancelled: () => true });
    expect(await confirm('desktop_write_text_file', proposal)).toBe(false);
    expect(created).toHaveLength(0);
    expect(getPendingConfirmation(userId, scope)?.id).toBe(pending.id);
  });
});
