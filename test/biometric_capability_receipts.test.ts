import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { registerBiometricTools } from '../server/tools/definitions/biometric_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

describe('biometric capability truth', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('does not claim that instruction-only enrollment or verification started', async () => {
    const registry = new ToolRegistry();
    registerBiometricTools(registry);
    for (const name of ['biometric_enroll', 'biometric_verify']) {
      const record = await executeToolCall({ registry, name, context: { userId: 'biometric-receipt-user' } });
      expect(record.error).toBeUndefined();
      expect(record.terminalVerification?.status).toBe('verified');
      expect(JSON.parse(record.result)).toMatchObject({
        ok: true,
        status: 'requires_user_action',
        initiated: false,
      });
    }
  });

  it('verifies a no-op deletion from post-operation store counts', async () => {
    const registry = new ToolRegistry();
    registerBiometricTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'biometric_forget',
      arguments: { type: 'all' },
      context: { userId: `biometric-empty-${Date.now()}`, requestConfirmation: async () => true },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'no_op',
      deleted: 0,
      remainingVoiceprints: 0,
      remainingFaces: 0,
    });
  });
});
