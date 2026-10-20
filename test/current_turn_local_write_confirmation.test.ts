import './helpers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { canAutoApproveAction } from '../server/tools/action_constitution';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import { clearAllPendingConfirmationsForTests, recordPendingConfirmationDurably, buildTransportNeutralConfirmationScope, getPendingConfirmation, type PendingToolConfirmation } from '../server/tools/pending_confirmation';

beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); });
beforeEach(() => clearAllPendingConfirmationsForTests());

describe('existing current-turn local-write authority reaches the single confirmation owner', () => {
  const userId = 'explicit-write-bit-owner';
  const scope = buildTransportNeutralConfirmationScope({ conversationId: 'write-bit-conversation', taskId: 'write-bit-task', domain: 'personal' });
  const args = { path: 'D:/isolated-write-bit.txt', content: 'synthetic bytes' };
  const build = (extra: Partial<Parameters<typeof createTurnConfirmation>[0]> = {}) => {
    const created: PendingToolConfirmation[] = [];
    const confirm = createTurnConfirmation({ userId, source: 'test', requestId: 'write-bit-current-request', actionIntent: 'Please handle the document with these members.', allowLocalFileWrites: false,
      consumeScope: () => scope, proposalScope: () => scope, onPending: pending => created.push(pending), ...extra });
    return { confirm, created };
  };

  it('does not auto-approve a local write when the existing current-turn authority is explicitly false', async () => {
    expect(canAutoApproveAction('write_file', args, { allowLocalFileWrites: false })).toBe(false);
    const { confirm, created } = build();
    expect(await confirm('write_file', args)).toBe(false);
    expect(created).toHaveLength(1);
    expect(getPendingConfirmation(userId, scope)).toMatchObject({ toolName: 'write_file', originRequestId: 'write-bit-current-request', taskId: 'write-bit-task', exactArgs: args });
  });

  it('keeps ordinary explicitly requested local output eligible without adding a confirmation', async () => {
    expect(canAutoApproveAction('write_file', args, { allowLocalFileWrites: true })).toBe(true);
    const { confirm, created } = build({ actionIntent: 'Create a local file.', allowLocalFileWrites: true });
    expect(await confirm('write_file', args)).toBe(true);
    expect(created).toHaveLength(0);
    expect(getPendingConfirmation(userId, scope)).toBeNull();
  });

  it('does not turn a false write authority into a read prohibition', async () => {
    expect(canAutoApproveAction('read_file', { path: args.path }, { allowLocalFileWrites: false })).toBe(true);
    const { confirm, created } = build();
    expect(await confirm('read_file', { path: args.path })).toBe(true);
    expect(created).toHaveLength(0);
  });

  it('does not let a true local-write bit bypass the existing typed fresh-confirmation boundary', async () => {
    const { confirm, created } = build({ actionIntent: 'Prepare the file and ask me before writing.', allowLocalFileWrites: true, correctionRequiresFreshConfirmation: true });
    expect(await confirm('write_file', args)).toBe(false);
    expect(created).toHaveLength(1);
  });

  it('consumes a resolved exact grant once without promoting the authority for a second write', async () => {
    const pending = await recordPendingConfirmationDurably(userId, 'write_file', args, 'test', { ...scope, originRequestId: 'write-bit-proposal-request' });
    const { confirm, created } = build({ actionIntent: 'Confirm.', pending });
    expect(await confirm('write_file', args)).toBe(true);
    expect(await confirm('write_file', args)).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].id).not.toBe(pending.id);
    expect(created[0].originRequestId).toBe('write-bit-current-request');
  });

  it('keeps the old undefined-authority behavior explicit rather than claiming remote/autonomy are secured', () => {
    expect(canAutoApproveAction('write_file', args)).toBe(true);
  });
});
