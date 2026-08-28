import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { registerDataOpsTools, rewriteLogicalDatabaseTables } from '../server/tools/definitions/data_tools';
import { ToolRegistry } from '../server/tools/registry';

const adminContext = {
  userId: 'database-query-contract-admin',
  authenticated: true,
  authRole: 'admin',
  userConfirmed: true,
} as any;

describe('database_query logical and physical table contract', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('maps camelCase names by normalized identity without lower-casing the lookup key', () => {
    expect(rewriteLogicalDatabaseTables(
      'SELECT * FROM commandCenterPlans JOIN conversationActionTasks ON 1 = 1',
      [
        { name: 'command_center_plans', type: 'table' },
        { name: 'conversation_action_tasks', type: 'table' },
      ],
    )).toBe(
      'SELECT * FROM "command_center_plans" JOIN "conversation_action_tasks" ON 1 = 1',
    );
  });

  it('executes equivalent camelCase and snake_case aggregate queries', async () => {
    const registry = new ToolRegistry();
    registerDataOpsTools(registry);

    const logical = JSON.parse(await registry.execute(
      'database_query',
      { query: 'SELECT COUNT(*) AS total FROM conversationActionTasks' },
      adminContext,
    ));
    const physical = JSON.parse(await registry.execute(
      'database_query',
      { query: 'SELECT COUNT(*) AS total FROM conversation_action_tasks' },
      adminContext,
    ));

    expect(logical).toEqual(physical);
    expect(logical).toEqual([{ total: expect.any(Number) }]);
  });

  it('supports safe sqlite_master inspection and a logical-name PRAGMA', async () => {
    const registry = new ToolRegistry();
    registerDataOpsTools(registry);

    const tables = JSON.parse(await registry.execute(
      'database_query',
      {
        query: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_action_tasks'",
      },
      adminContext,
    ));
    const columns = JSON.parse(await registry.execute(
      'database_query',
      { query: 'PRAGMA table_info(conversationActionTasks)' },
      adminContext,
    ));

    expect(tables).toEqual([{ name: 'conversation_action_tasks' }]);
    expect(columns.some((column: any) => column.name === 'status')).toBe(true);
  });

  it.each([
    'DELETE FROM conversation_action_tasks',
    'SELECT * FROM conversation_action_tasks; DELETE FROM conversation_action_tasks',
    "SELECT readfile('C:/Windows/win.ini')",
    'PRAGMA journal_mode=WAL',
  ])('rejects statements outside the bounded read-only contract: %s', async query => {
    const registry = new ToolRegistry();
    registerDataOpsTools(registry);
    await expect(registry.execute(
      'database_query',
      { query },
      adminContext,
    )).rejects.toThrow();
  });
});
