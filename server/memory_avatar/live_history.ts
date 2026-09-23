import { querySQL, withDatabaseSqlWriteLock } from '../../db_layer';
import type { AvatarLiveHistoryTurn } from '../../shared/avatar_live';

/** Public broadcast history is archived separately from private memories. */
export async function saveLiveTurn(userId: string, avatarId: string, turn: AvatarLiveHistoryTurn): Promise<void> {
  await withDatabaseSqlWriteLock(({ run }) => run(
    `INSERT INTO avatar_live_turns(userId,avatarId,requestId,nickname,comment,reply,createdAt)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(userId,avatarId,requestId) DO NOTHING`,
    [userId,avatarId,turn.requestId,turn.nickname,turn.comment,turn.reply,turn.createdAt],
  ));
}

export async function acknowledgeLivePlayback(userId: string, avatarId: string, requestId: string): Promise<boolean> {
  return withDatabaseSqlWriteLock(async ({ run, query }) => {
    await run('UPDATE avatar_live_turns SET spokenAt=COALESCE(spokenAt,?) WHERE userId=? AND avatarId=? AND requestId=?',
      [new Date().toISOString(),userId,avatarId,requestId]);
    return (await query('SELECT requestId FROM avatar_live_turns WHERE userId=? AND avatarId=? AND requestId=?', [userId,avatarId,requestId])).length === 1;
  });
}

export async function listLiveHistory(userId: string, avatarId: string): Promise<AvatarLiveHistoryTurn[]> {
  const rows = await querySQL<AvatarLiveHistoryTurn>(
    'SELECT requestId,nickname,comment,reply,createdAt,spokenAt FROM avatar_live_turns WHERE userId=? AND avatarId=? ORDER BY createdAt DESC LIMIT 100',
    [userId,avatarId]);
  return rows.reverse();
}
