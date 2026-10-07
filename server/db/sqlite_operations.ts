import type sqlite3 from 'sqlite3';

/** Raw operations use the one live handle; admission and transaction ownership stay in db_layer. */
export function createSqliteOperations(getDb: () => sqlite3.Database) {
  function run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      getDb().run(sql, params, function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Bound native binding memory while amortizing statement preparation. */
  async function insertSnapshotRows(sql: string, rows: any[][]): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += 512) {
      await insertSnapshotBatch(sql, rows.slice(offset, offset + 512));
    }
  }

  /** Reuse one prepared statement within the caller's atomic snapshot transaction. */
  function insertSnapshotBatch(sql: string, rows: any[][]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const statement = getDb().prepare(sql, prepareError => {
        if (prepareError) {
          statement.finalize(() => reject(prepareError));
          return;
        }
        let firstError: Error | null = null;
        // sqlite3 serializes operations on a Statement. Queue its rows together
        // rather than re-preparing SQL and making a JS/native round trip for
        // every row. Finalize waits for every queued callback before settling,
        // so a rejected row still rolls back the whole surrounding transaction.
        try {
          for (const row of rows) {
            statement.run(row, error => { if (error && !firstError) firstError = error; });
          }
        } catch (error) {
          firstError ||= error instanceof Error ? error : new Error(String(error));
        }
        statement.finalize(error => {
          if (firstError || error) reject(firstError || error);
          else resolve();
        });
      });
    });
  }

  function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      getDb().all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    });
  }

  return { query, run, insertSnapshotRows };
}
