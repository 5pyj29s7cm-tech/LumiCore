import './helpers';
import { expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, makeApp } from './helpers';
import { apiFetch } from '../src/services/apiClient';
import { mountCommandCenterPlanRoutes } from '../server/routes/command_center_plan_routes';
import { flushDBOrThrow, readDB } from '../db_layer';

it('keeps one stored plan when a completed creation response is lost', async () => {
  const fixture = await makeApp();
  mountCommandCenterPlanRoutes(fixture.apiRouter);
  const token = jwt.sign({ uid: 'plan-retry-user', username: 'Plan retry', role: 'user' }, JWT_SECRET);
  const nativeFetch = globalThis.fetch;
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(`${fixture.url}/api/command-center/plans`, init);
    expect(response.status).toBe(201);
    await response.text();
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(apiFetch('/api/command-center/plans', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'daily_task', title: 'One click', instruction: 'Synthetic test only', cadence: 'daily', timeOfDay: '09:00' }),
    })).rejects.toThrow('Failed to fetch');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readDB().commandCenterPlans.filter((plan: any) => plan.userId === 'plan-retry-user')).toHaveLength(1);
    await flushDBOrThrow();
  } finally {
    vi.unstubAllGlobals();
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});
