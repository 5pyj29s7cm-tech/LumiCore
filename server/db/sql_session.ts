export interface DatabaseSqlWriteSession {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  run(sql: string, params?: any[]): Promise<void>;
}
