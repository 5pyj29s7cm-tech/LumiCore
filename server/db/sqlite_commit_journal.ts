import type { ExternalCommitJournalAdapter, ExternalCommitJournalEntry } from '../tools/external_commit_journal';
import type { DatabaseSqlWriteSession } from './sql_session';

/** Auxiliary journal writes enter the database's shared SQL queue. */
export function createSqliteCommitJournal(withWrite: <T>(operation: (session: DatabaseSqlWriteSession) => Promise<T>) => Promise<T>): ExternalCommitJournalAdapter {
  const adapter: ExternalCommitJournalAdapter = {
    async lookup(idempotencyKey) {
      return withWrite(async ({ query, run }) => {
        const rows = await query<ExternalCommitJournalEntry>(
          'SELECT * FROM external_commit_journal WHERE idempotencyKey = ? LIMIT 1',
          [idempotencyKey],
        );
        return rows[0] || null;
      });
    },
    async claim(entry) {
      return withWrite(async ({ query, run }) => {
        await run(
          `INSERT OR IGNORE INTO external_commit_journal
            (idempotencyKey, taskId, userId, toolName, inputDigest, state, replayResult, claimToken, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.idempotencyKey,
            entry.taskId,
            entry.userId,
            entry.toolName,
            entry.inputDigest,
            entry.state,
            entry.replayResult,
            entry.claimToken,
            entry.createdAt,
            entry.updatedAt,
          ],
        );
        const rows = await query<ExternalCommitJournalEntry>(
          'SELECT * FROM external_commit_journal WHERE idempotencyKey = ? LIMIT 1',
          [entry.idempotencyKey],
        );
        const persisted = rows[0];
        if (!persisted) throw new Error('External commit journal claim was not persisted.');
        return {
          claimed: persisted.claimToken === entry.claimToken,
          entry: persisted,
        };
      });
    },
    async settle(input) {
      return withWrite(async ({ query, run }) => {
        const claimClause = input.recoverExisting ? '' : ' AND claimToken = ?';
        const params: any[] = [
          input.state,
          input.replayResult,
          input.updatedAt,
          input.idempotencyKey,
        ];
        if (!input.recoverExisting) params.push(input.claimToken);
        await run(
          `UPDATE external_commit_journal
           SET state = ?, replayResult = ?, updatedAt = ?
           WHERE idempotencyKey = ?${claimClause}`,
          params,
        );
        const rows = await query<ExternalCommitJournalEntry>(
          'SELECT * FROM external_commit_journal WHERE idempotencyKey = ? LIMIT 1',
          [input.idempotencyKey],
        );
        return rows[0]?.state === input.state
          && rows[0]?.replayResult === input.replayResult;
      });
    },
  };
  return adapter;
}
