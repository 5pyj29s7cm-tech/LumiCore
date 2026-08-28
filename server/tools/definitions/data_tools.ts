import { querySQL } from '../../../db_layer';
import { ToolRegistry } from '../registry';

const IDENTIFIER = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)';
const TABLE_REFERENCE_RE = new RegExp(`\\b(FROM|JOIN)\\s+(${IDENTIFIER})`, 'gi');
const SAFE_PRAGMA_RE = new RegExp(
  `^PRAGMA\\s+(?:(?:main|temp)\\.)?` +
  `(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|database_list|quick_check|integrity_check|compile_options)` +
  `(?:\\s*\\(\\s*(${IDENTIFIER})\\s*\\))?$`,
  'i',
);
const UNSAFE_SELECT_FUNCTION_RE = /\b(?:load_extension|readfile|writefile|fts3_tokenizer)\s*\(/i;

type SqliteSchemaRow = { name: string; type: string };

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) return trimmed.slice(1, -1);
  return trimmed;
}

function normalizedIdentifier(value: string): string {
  return unquoteIdentifier(value).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function assertSingleReadOnlyStatement(rawQuery: string): string {
  const query = rawQuery.trim().replace(/;\s*$/, '').trim();
  if (!query) throw new Error('SQL query is required.');
  if (query.includes(';') || /--|\/\*/.test(query)) {
    throw new Error('database_query accepts exactly one read-only statement without SQL comments.');
  }
  if (!/^(?:SELECT|PRAGMA)\b/i.test(query)) {
    throw new Error('Only SELECT and allowlisted read-only PRAGMA queries are allowed.');
  }
  if (/^SELECT\b/i.test(query) && UNSAFE_SELECT_FUNCTION_RE.test(query)) {
    throw new Error('The requested SQLite function is outside the read-only database_query boundary.');
  }
  return query;
}

function tableLookup(schema: SqliteSchemaRow[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const row of schema) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    lookup.set(normalizedIdentifier(name), name);
  }
  // sqlite_master is intentionally queryable but does not list itself.
  lookup.set('sqlitemaster', 'sqlite_master');
  lookup.set('sqliteschema', 'sqlite_schema');
  return lookup;
}

function resolveIdentifier(value: string, lookup: Map<string, string>): string {
  return lookup.get(normalizedIdentifier(value)) || unquoteIdentifier(value);
}

/**
 * Translate the public logical table contract (for example
 * `conversationActionTasks`) to the real SQLite table name
 * (`conversation_action_tasks`). Normalization is comparison-only: the
 * original identifier is never lower-cased and then used as an object key.
 */
export function rewriteLogicalDatabaseTables(
  query: string,
  schema: SqliteSchemaRow[],
): string {
  const lookup = tableLookup(schema);
  return query.replace(TABLE_REFERENCE_RE, (_match, keyword: string, identifier: string) => {
    return `${keyword} ${quotedIdentifier(resolveIdentifier(identifier, lookup))}`;
  });
}

function rewriteReadOnlyPragma(query: string, schema: SqliteSchemaRow[]): string {
  const match = query.match(SAFE_PRAGMA_RE);
  if (!match) {
    throw new Error('This PRAGMA is not in the database_query read-only allowlist.');
  }
  const pragma = match[1].toLowerCase();
  const identifier = match[2];
  const requiresTarget = new Set([
    'table_info',
    'table_xinfo',
    'index_list',
    'index_info',
    'index_xinfo',
    'foreign_key_list',
  ]).has(pragma);
  if (requiresTarget && !identifier) {
    throw new Error(`PRAGMA ${pragma} requires one table or index identifier.`);
  }
  if (!identifier) return `PRAGMA ${pragma}`;
  const resolved = resolveIdentifier(identifier, tableLookup(schema));
  return `PRAGMA ${pragma}(${quotedIdentifier(resolved)})`;
}

async function databaseQueryHandler(args: Record<string, any>): Promise<string> {
  const query = assertSingleReadOnlyStatement(String(args.query || ''));
  const maxRows = Math.min(Math.max(Number(args.maxRows) || 50, 1), 200);
  const schema = await querySQL<SqliteSchemaRow>(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')",
  );

  if (/^PRAGMA\b/i.test(query)) {
    const rows = await querySQL<Record<string, unknown>>(rewriteReadOnlyPragma(query, schema));
    return JSON.stringify(rows.slice(0, maxRows), null, 2);
  }

  const rewritten = rewriteLogicalDatabaseTables(query, schema);
  const bounded = `SELECT * FROM (${rewritten}) AS lumi_readonly_query LIMIT ${maxRows}`;
  const rows = await querySQL<Record<string, unknown>>(bounded);
  return JSON.stringify(rows, null, 2);
}

export function registerDataOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'database_query',
    description:
      'Run one bounded read-only SQLite SELECT or allowlisted PRAGMA against the local LumiCore database. ' +
      'Both logical camelCase names (conversationActionTasks) and physical snake_case names ' +
      '(conversation_action_tasks), plus sqlite_master introspection, are supported.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'One read-only SELECT or allowlisted PRAGMA statement' },
        maxRows: { type: 'number', description: 'Maximum rows to return (default 50, max 200)' },
      },
      required: ['query'],
    },
    handler: databaseQueryHandler,
    permission: 'admin',
    securityLevel: 'confirm',
  });
}
