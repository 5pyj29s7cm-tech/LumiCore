import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabaseInitialized, querySQL } from '../db_layer';
import {
  buildTransportNeutralConfirmationScope,
  clearAllPendingConfirmationsForTests,
  clearPendingConfirmationDurably,
  configurePendingConfirmationPersistence,
  consumePendingConfirmationDurably,
  getPendingConfirmation,
  recordPendingConfirmationDurably,
} from '../server/tools/pending_confirmation';
import { PendingConfirmationRepository } from '../server/tools/pending_confirmation_repository';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumicore-confirmation-test-'));
const keyPath = path.join(tempRoot, 'pending-confirmations.key');

describe('encrypted pending confirmation repository', () => {
  beforeAll(async () => {
    await ensureDatabaseInitialized();
  });

  afterAll(() => {
    clearAllPendingConfirmationsForTests();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('encrypts exact arguments, hydrates after restart, and lets desktop chat consume a remote-message grant once', async () => {
    clearAllPendingConfirmationsForTests();
    const repository = new PendingConfirmationRepository({ keyPath, platform: 'linux' });
    await repository.initializeAndHydrate();
    configurePendingConfirmationPersistence(repository);

    const nonce = `${Date.now()}-${Math.random()}`;
    const userId = `confirmation-user-${nonce}`;
    const conversationId = `conversation-${nonce}`;
    const taskId = `task-${nonce}`;
    const scope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId,
      taskId,
    });
    const pending = await recordPendingConfirmationDurably(
      userId,
      'wechat_send_message',
      { contact: 'Alice', message: 'Exact payload', apiToken: 'never-store-this-plaintext' },
      'feishu_bot',
      {
        ...scope,
        originRequestId: `feishu-request-${nonce}`,
        actionIntent: 'Send this confidential draft to Alice',
      },
    );

    const storedRows = await querySQL<any>(
      'SELECT exactArgsCiphertext, safeArgs, target, actionIntent, status, revision FROM pending_tool_confirmations WHERE id = ?',
      [pending.id],
    );
    expect(storedRows).toHaveLength(1);
    expect(storedRows[0]).toMatchObject({ status: 'pending', revision: 1 });
    expect(String(storedRows[0].exactArgsCiphertext)).not.toContain('never-store-this-plaintext');
    expect(String(storedRows[0].safeArgs)).not.toContain('never-store-this-plaintext');
    expect(String(storedRows[0].safeArgs)).not.toContain('Exact payload');
    expect(String(storedRows[0].target)).not.toContain('Alice');
    expect(String(storedRows[0].actionIntent)).not.toContain('confidential draft');

    // Simulate a process restart: drop all in-memory grants, then decrypt and
    // hydrate from SQLite with the same host-protected key.
    clearAllPendingConfirmationsForTests();
    const restarted = new PendingConfirmationRepository({ keyPath, platform: 'linux' });
    expect(await restarted.initializeAndHydrate()).toBeGreaterThanOrEqual(1);
    configurePendingConfirmationPersistence(restarted);

    const typedLookupScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId,
      taskId,
    });
    const hydrated = getPendingConfirmation(userId, typedLookupScope);
    expect(hydrated).toMatchObject({
      id: pending.id,
      source: 'feishu_bot',
      target: 'Alice',
      actionIntent: 'Send this confidential draft to Alice',
    });
    expect(await consumePendingConfirmationDurably(
      userId,
      pending.id,
      pending.toolName,
      pending.exactArgs,
      typedLookupScope,
    )).toBe(true);
    expect(await consumePendingConfirmationDurably(
      userId,
      pending.id,
      pending.toolName,
      pending.exactArgs,
      typedLookupScope,
    )).toBe(false);

    const consumedRows = await querySQL<any>(
      'SELECT status, revision FROM pending_tool_confirmations WHERE id = ?',
      [pending.id],
    );
    expect(consumedRows[0]).toMatchObject({ status: 'consumed', revision: 2 });
  });

  it('allows exactly one repository instance to win the CAS claim', async () => {
    clearAllPendingConfirmationsForTests();
    const first = new PendingConfirmationRepository({ keyPath, platform: 'linux' });
    await first.initializeAndHydrate();
    configurePendingConfirmationPersistence(first);
    const nonce = `${Date.now()}-${Math.random()}`;
    const pending = await recordPendingConfirmationDurably(
      `cas-user-${nonce}`,
      'desktop_open',
      { target: 'WPS' },
      'chat',
      buildTransportNeutralConfirmationScope({
        domain: 'personal',
        conversationId: `cas-conversation-${nonce}`,
        taskId: `cas-task-${nonce}`,
      }),
    );
    const second = new PendingConfirmationRepository({ keyPath, platform: 'linux' });
    await second.initializeAndHydrate();
    const claims = await Promise.all([
      first.consume({ id: pending.id, userId: pending.userId, revision: 1 }),
      second.consume({ id: pending.id, userId: pending.userId, revision: 1 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('keeps reviewed patch bodies and display metadata inside authenticated ciphertext', async () => {
    clearAllPendingConfirmationsForTests();
    const repository = new PendingConfirmationRepository({ keyPath, platform: 'linux' });
    await repository.initializeAndHydrate();
    configurePendingConfirmationPersistence(repository);
    const nonce = `${Date.now()}-${Math.random()}`;
    const marker = `PATCH_SECRET_MARKER_${nonce}`;
    const pending = await recordPendingConfirmationDurably(
      `patch-user-${nonce}`,
      'self_improvement_stage_patch',
      {
        proposalId: `proposal-${nonce}`,
        expectedBaseCommit: '0123456789abcdef',
        expectedDeliveryBranch: 'review/test',
        commitMessage: `private review ${marker}`,
        patch: `diff --git a/private.txt b/private.txt\n+++ b/private.txt\n@@\n+${marker}\n`,
      },
      'chat',
      buildTransportNeutralConfirmationScope({
        domain: 'personal',
        conversationId: `patch-conversation-${nonce}`,
      }),
    );

    const rows = await querySQL<any>(
      'SELECT * FROM pending_tool_confirmations WHERE id = ?',
      [pending.id],
    );
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain(marker);
    expect(stored).not.toContain('+++ b/private.txt');
    expect(JSON.parse(String(rows[0].safeArgs))).toMatchObject({ encrypted: true });
  });

  it('does not hydrate a grant after SQLite cancellation fails behind a durable revocation barrier', async () => {
    clearAllPendingConfirmationsForTests();
    const repository = new PendingConfirmationRepository({ keyPath, platform: 'linux' });
    await repository.initializeAndHydrate();
    configurePendingConfirmationPersistence(repository);
    const nonce = `${Date.now()}-${Math.random()}`;
    const userId = `revoke-user-${nonce}`;
    const conversationId = `revoke-conversation-${nonce}`;
    const pending = await recordPendingConfirmationDurably(
      userId,
      'desktop_open',
      { target: 'WPS' },
      'chat',
      buildTransportNeutralConfirmationScope({
        domain: 'personal',
        conversationId,
      }),
    );

    const originalClaim = (repository as any).claim.bind(repository);
    (repository as any).claim = async (
      _input: unknown,
      _status: unknown,
      beforeClaim?: () => void,
    ) => {
      beforeClaim?.();
      throw new Error('simulated SQLite cancellation failure');
    };
    await expect(clearPendingConfirmationDurably(
      userId,
      buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId }),
    )).rejects.toThrow('simulated SQLite cancellation failure');
    expect(getPendingConfirmation(
      userId,
      buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId }),
    )).toBeNull();
    (repository as any).claim = originalClaim;

    const revocationText = fs.readFileSync(`${keyPath}.revocations.json`, 'utf8');
    expect(revocationText).not.toContain(userId);
    expect(revocationText).not.toContain(pending.id);
    const beforeRestart = await querySQL<any>(
      'SELECT status FROM pending_tool_confirmations WHERE id = ?',
      [pending.id],
    );
    expect(beforeRestart[0]?.status).toBe('pending');

    clearAllPendingConfirmationsForTests();
    const restarted = new PendingConfirmationRepository({ keyPath, platform: 'linux' });
    await restarted.initializeAndHydrate();
    configurePendingConfirmationPersistence(restarted);
    expect(getPendingConfirmation(
      userId,
      buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId }),
    )).toBeNull();
    const afterRestart = await querySQL<any>(
      'SELECT status FROM pending_tool_confirmations WHERE id = ?',
      [pending.id],
    );
    expect(afterRestart[0]?.status).toBe('cancelled');
  });

  it('fails closed on macOS instead of storing a plaintext data-root key', async () => {
    clearAllPendingConfirmationsForTests();
    const statements: string[] = [];
    const session = {
      query: async <T = any>() => [] as T[],
      run: async (sql: string) => { statements.push(sql); },
    };
    const sql = {
      initialize: async () => {},
      query: session.query,
      run: session.run,
      withWriteLock: async <T>(operation: (value: typeof session) => Promise<T>) => operation(session),
    };
    const darwinKeyPath = path.join(tempRoot, `darwin-${Date.now()}.key`);
    const repository = new PendingConfirmationRepository({
      keyPath: darwinKeyPath,
      platform: 'darwin',
      sql,
    });
    await repository.initializeAndHydrate();
    configurePendingConfirmationPersistence(repository);

    await expect(recordPendingConfirmationDurably(
      'darwin-user',
      'desktop_open',
      { target: 'WPS', privateNote: 'must remain memory-only' },
      'chat',
      buildTransportNeutralConfirmationScope({
        domain: 'personal',
        conversationId: 'darwin-conversation',
      }),
    )).rejects.toThrow(/macOS Keychain/i);
    expect(fs.existsSync(darwinKeyPath)).toBe(false);
    expect(statements.filter(sqlText => /INSERT INTO pending_tool_confirmations/i.test(sqlText))).toHaveLength(0);
    expect(statements.join('\n')).not.toContain('must remain memory-only');
  });

  it('keeps every production entrance on the durable API while retaining sync helpers only as compatibility exports', () => {
    const productionFiles = [
      'server/socket/chat.ts',
      'server/socket/voice.ts',
      'server/socket/task.ts',
      'server/regions/packs/cn/messaging_routes.ts',
    ];
    for (const file of productionFiles) {
      const source = fs.readFileSync(path.resolve(file), 'utf8');
      expect(source).not.toMatch(/\b(?:record|get|consume|clear)PendingConfirmation\s*\(/);
    }
    const messagingSource = fs.readFileSync(
      path.resolve('server/regions/packs/cn/messaging_routes.ts'),
      'utf8',
    );
    expect(messagingSource).toContain('buildTransportNeutralConfirmationScope');
    expect(messagingSource).toContain('ensurePendingConfirmationPersistenceInitialized');
    expect(messagingSource).toContain('consumePendingConfirmationDurably');
    expect(messagingSource).toContain('recordPendingConfirmationDurably');
  });
});
