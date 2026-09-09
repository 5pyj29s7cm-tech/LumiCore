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
    saveGateConfig({ autonomyLevel: 'semi' }, 'mode-sync-user');
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

  it('accepts legacy mode values without changing background authorization or resource limits', async () => {
    const { getGateConfig, saveGateConfig } = await import('../server/autonomy/safety_gate');
    saveGateConfig({ autoProcessEnabled: false, maxTokensPerHour: 1234, requireIdle: true }, 'mode-sync-user');
    const before = getGateConfig('mode-sync-user');
    for (const mode of ['chat', 'assistant', 'autonomous']) {
      await expect(putMode(mode)).resolves.toMatchObject({ ok: true, mode: 'assistant' });
      expect(getGateConfig('mode-sync-user')).toEqual(before);
    }
    const response = await fetch(`${app.url}/api/preferences/operation_mode`, { headers });
    expect(await response.json()).toEqual({ mode: 'assistant' });
  });

  it('does not treat Meeting as a fourth autonomy permission level', async () => {
    const { getGateConfig, saveGateConfig } = await import('../server/autonomy/safety_gate');
    saveGateConfig({ autonomyLevel: 'full' }, 'mode-sync-user');

    await expect(putMode('meeting')).resolves.toMatchObject({ ok: true });
    expect(getGateConfig('mode-sync-user').autonomyLevel).toBe('full');
  });
});
