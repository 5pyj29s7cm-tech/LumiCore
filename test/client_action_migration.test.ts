import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  migratePersistedClientActionName,
} from '../shared/client_surfaces';
import {
  upsertAutonomousWorkflow,
} from '../server/autonomy/workflows';

describe('persisted client action migration', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('maps retired generic actions to explicit registered actions', () => {
    expect(migratePersistedClientActionName('open_runtime_log')).toBe('open_computer_adaptation');
    expect(migratePersistedClientActionName('open_app:tokens')).toBe('open_token_dashboard');
    expect(migratePersistedClientActionName('open_app:skills')).toBe('open_skills');
    expect(migratePersistedClientActionName('set_mode')).toBe('set_client_mode');
    expect(migratePersistedClientActionName('close_app')).toBe('close_client_surface');
    expect(migratePersistedClientActionName('open_app')).toBeNull();
  });

  it('normalizes legacy actions before saving an autonomous workflow', () => {
    const workflow = upsertAutonomousWorkflow('client-action-migration-user', {
      title: 'Legacy client workflow',
      allowedActions: [
        'open_runtime_log',
        'open_app:tokens',
        'set_mode',
        'close_app',
      ],
    });

    expect(workflow.allowedActions).toEqual([
      'open_computer_adaptation',
      'open_token_dashboard',
      'set_client_mode',
      'close_client_surface',
    ]);
  });
});
