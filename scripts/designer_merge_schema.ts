/** Reviewed additive Designer history schemas only; never an application schema migration. */
export interface DesignerSchemaProjection {
  defaults: Record<string, string | null>;
  reordered: boolean;
}

const additions: Record<string, Record<string, { sql: string[]; value: string | null }>> = {
  command_center_plans: {
    membershipAuthorization: { sql: ['TEXT', 'NOT', 'NULL', 'DEFAULT', "''"], value: '' },
    authorizationBlockedReason: { sql: ['TEXT', 'NOT', 'NULL', 'DEFAULT', "''"], value: '' },
  },
  conversation_action_receipts: {
    turnRowId: { sql: ['TEXT', 'NOT', 'NULL', 'DEFAULT', "''"], value: '' },
    externalMessageId: { sql: ['TEXT', 'NOT', 'NULL', 'DEFAULT', "''"], value: '' },
  },
  conversations: { surface: { sql: ['TEXT', 'NOT', 'NULL', 'DEFAULT', "'chat'"], value: 'chat' } },
  memories: {
    embedding: { sql: ['TEXT'], value: null },
    embeddingNamespace: { sql: ['TEXT'], value: null },
    embeddingContentHash: { sql: ['TEXT'], value: null },
  },
  reminders: {
    domain: { sql: ['TEXT', 'NOT', 'NULL', 'DEFAULT', "'personal'"], value: 'personal' },
    orgId: { sql: ['TEXT', 'NOT', 'NULL', 'DEFAULT', "''"], value: '' },
  },
  interactions: {},
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identifier = (token: string) => /^(?:".*"|`.*`|\[.*\])$/.test(token) ? token.slice(1, -1) : token;
function definitions(sql: string, columns: string[]) {
  const tokens = sql.slice(sql.indexOf('(')).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g) || [];
  if (tokens[0] !== '(') return null;
  const parts: string[][] = []; let part: string[] = []; let depth = 1; let end = -1;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === ')') { depth--; if (depth === 0) { parts.push(part); end = i; break; } }
    if (token === ',' && depth === 1) { parts.push(part); part = []; continue; }
    part.push(token); if (token === '(') depth++;
  }
  if (end < 0 || parts.some(value => value.length === 0)) return null;
  const fields = new Map<string, string[]>(); const constraints: string[][] = [];
  for (const value of parts) {
    const name = identifier(value[0]);
    if (!columns.includes(name)) constraints.push(value);
    else { if (fields.has(name)) return null; fields.set(name, value.slice(1)); }
  }
  if (fields.size !== columns.length) return null;
  return { fields, constraints, suffix: tokens.slice(end + 1) };
}

export function reviewedDesignerSchemaProjection(name: string, sourceSql: string, targetSql: string, sourceColumns: string[], targetColumns: string[]): DesignerSchemaProjection | null {
  const allowed = additions[name]; if (!allowed) return null;
  const source = definitions(sourceSql, sourceColumns), target = definitions(targetSql, targetColumns);
  if (!source || !target || !same(source.constraints, target.constraints) || !same(source.suffix, target.suffix)) return null;
  for (const column of sourceColumns) {
    if (!target.fields.has(column) || !same(source.fields.get(column), target.fields.get(column))) return null;
  }
  const defaults: Record<string, string | null> = {};
  for (const column of targetColumns.filter(column => !source.fields.has(column))) {
    const definition = allowed[column];
    if (!definition || !same(target.fields.get(column), definition.sql)) return null;
    defaults[column] = definition.value;
  }
  return { defaults, reordered: !same(sourceColumns, targetColumns.filter(column => source.fields.has(column))) };
}
