import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';

describe('autonomy levels', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('uses full autonomy as the low-friction autonomous preset', async () => {
    const { isAutonomousWorkAllowed, saveGateConfig } = await import('../server/autonomy/safety_gate');

    const config = saveGateConfig({ autonomyLevel: 'full' });

    expect(config.autonomyLevel).toBe('full');
    expect(config.alwaysOnline).toBe(true);
    expect(config.autoProcessEnabled).toBe(true);
    expect(config.requireIdle).toBe(false);
    expect(config.allowedHours).toEqual([{ start: 0, end: 24 }]);
    expect(config.maxConsecutiveTasks).toBe(25);
    expect(config.messagingSendRequiresConfirmation).toBe(false);
    expect(isAutonomousWorkAllowed('level_full_user').allowed).toBe(true);
  });

  it('keeps reactive mode as the only non-autonomous preset', async () => {
    const { isAutonomousWorkAllowed, saveGateConfig } = await import('../server/autonomy/safety_gate');

    const config = saveGateConfig({ autonomyLevel: 'reactive' });
    const decision = isAutonomousWorkAllowed('level_reactive_user');

    expect(config.autonomyLevel).toBe('reactive');
    expect(config.autoProcessEnabled).toBe(false);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('reactive');
  });

  it('keeps semi mode low-friction without adding extra external-app gates', async () => {
    const { isAutonomousWorkAllowed, saveGateConfig } = await import('../server/autonomy/safety_gate');

    const config = saveGateConfig({ autonomyLevel: 'semi' });

    expect(config.autonomyLevel).toBe('semi');
    expect(config.autoProcessEnabled).toBe(true);
    expect(config.requireIdle).toBe(false);
    expect(config.allowedHours).toEqual([{ start: 0, end: 24 }]);
    expect(config.maxConsecutiveTasks).toBe(6);
    expect(config.messagingSendRequiresConfirmation).toBe(false);
    expect(config).not.toHaveProperty('externalAppAutomationEnabled');
    expect(isAutonomousWorkAllowed('level_semi_user').allowed).toBe(true);
  });

  it('keeps autonomy policies isolated per user', async () => {
    const { getGateConfig, isAutonomousWorkAllowed, saveGateConfig } = await import('../server/autonomy/safety_gate');
    saveGateConfig({ autonomyLevel: 'reactive' }, 'isolated-reactive');
    saveGateConfig({ autonomyLevel: 'full' }, 'isolated-full');

    expect(getGateConfig('isolated-reactive').autonomyLevel).toBe('reactive');
    expect(getGateConfig('isolated-full').autonomyLevel).toBe('full');
    expect(isAutonomousWorkAllowed('isolated-reactive').allowed).toBe(false);
    expect(isAutonomousWorkAllowed('isolated-full').allowed).toBe(true);
  });
});
