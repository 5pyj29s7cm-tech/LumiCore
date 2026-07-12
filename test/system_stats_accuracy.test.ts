import './helpers';
import { describe, expect, it } from 'vitest';
import { getSystemStatsSnapshot } from '../server/routes/system_routes';

describe('kernel monitor system facts', () => {
  it('deduplicates concurrent sampling and labels hardware truthfully', async () => {
    const [first, second] = await Promise.all([
      getSystemStatsSnapshot(),
      getSystemStatsSnapshot(),
    ]);
    expect(first).toBe(second);
    expect(first.computerScope).toBe('lumi_server_host');
    expect(first.logicalCpus).toBeGreaterThan(0);
    expect(first.cpuModel).toEqual(expect.any(String));
    expect(first.ram.total).toBeGreaterThan(0);
    expect(first.cpu).toBeGreaterThanOrEqual(0);
    expect(first.cpu).toBeLessThanOrEqual(100);
    if (first.gpu) expect(first.gpu.name).toEqual(expect.any(String));
  });
});
