import './helpers';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { mountPreferencesRoutes } from '../server/routes/preferences_routes';

describe('desktop operation mode autonomy sync', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  const token = jwt.sign({ uid: 'mode-sync-user', username: 'mode-sync', role: 'user' }, JWT_SECRET);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  beforeEach(async () => {
    app = await makeApp();
    mountPreferencesRoutes(app.apiRouter, JWT_SECRET);
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    saveGateConfig({ autonomyLevel: 'semi' });
  });

  afterEach(() => {
    app.cleanup();
  });

  async function putMode(mode: string) {
    const res = await fetch(`${app.url}/api/preferences/operation_mode`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ mode }),
    });
    expect(res.ok).toBe(true);
    return res.json();
  }

  it('maps desktop Chat, Assistant, and Autonomy modes to the three autonomy levels', async () => {
    const { getGateConfig } = await import('../server/autonomy/safety_gate');

    await expect(putMode('chat')).resolves.toMatchObject({ autonomyLevel: 'reactive' });
    expect(getGateConfig().autonomyLevel).toBe('reactive');

    await expect(putMode('assistant')).resolves.toMatchObject({ autonomyLevel: 'semi' });
    expect(getGateConfig().autonomyLevel).toBe('semi');

    await expect(putMode('autonomous')).resolves.toMatchObject({ autonomyLevel: 'full' });
    expect(getGateConfig().autonomyLevel).toBe('full');
  });

  it('does not treat Meeting as a fourth autonomy permission level', async () => {
    const { getGateConfig, saveGateConfig } = await import('../server/autonomy/safety_gate');
    saveGateConfig({ autonomyLevel: 'full' });

    await expect(putMode('meeting')).resolves.toMatchObject({ ok: true });
    expect(getGateConfig().autonomyLevel).toBe('full');
  });
});
