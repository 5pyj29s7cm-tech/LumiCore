import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';

/** File routes own these six tables; unrelated runtime and organization tables never escape. */
export function readKnowledgeFileState() {
  return readDatabaseTables(['knowledgeFiles', 'memories', 'settings', 'users', 'conversations', 'interactions']);
}

export const commitKnowledgeFileState = commitDatabaseTables;
