import { createTableSession, prepareTableCommit } from '../../server/db/table_session';
/** Keep test database doubles faithful to production's detached, staged table boundary. */
export function withTableDatabaseMock<T extends Record<string, any>>(mocked: T): T & Record<string, any> {
  if (typeof mocked.readDB !== 'function' || typeof mocked.readDatabaseTables === 'function') return mocked;
  return { ...mocked,
    readDatabaseTables: (keys: readonly string[]) => createTableSession(mocked.readDB(), keys),
    commitDatabaseTables: (draft: unknown) => {
      if (typeof mocked.writeDB !== 'function') throw new Error('Test database is read-only');
      const current = mocked.readDB(); const staged = prepareTableCommit(draft, current);
      if (Object.keys(staged.changes).length) { mocked.writeDB({ ...current, ...staged.changes }); staged.accept(); }
    },
  };
}
