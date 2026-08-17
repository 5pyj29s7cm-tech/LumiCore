import { describe, expect, it } from 'vitest';
import {
  getRenderedClientSurfaceSelector,
  isClientSurfaceRendered,
  waitForClientSurfaceRendered,
} from '../src/lib/clientSurfaceCommit';

describe('visible client surface commit', () => {
  it('only accepts an exact rendered surface marker', () => {
    const root = {
      querySelector(selector: string) {
        return selector === '[data-lumi-rendered-surface="command-center"]' ? {} as Element : null;
      },
    };

    expect(getRenderedClientSurfaceSelector('command-center')).toBe('[data-lumi-rendered-surface="command-center"]');
    expect(isClientSurfaceRendered('command-center', root)).toBe(true);
    expect(isClientSurfaceRendered('chat', root)).toBe(false);
  });

  it('waits for a real surface commit and times out when none appears', async () => {
    let ticks = 0;
    let rendered = false;
    const committed = await waitForClientSurfaceRendered('command-center', {
      root: { querySelector: () => rendered ? {} as Element : null },
      timeoutMs: 500,
      now: () => ticks * 16,
      schedule: callback => {
        ticks += 1;
        if (ticks === 2) rendered = true;
        callback();
      },
    });
    expect(committed).toBe(true);

    let now = 0;
    const missing = await waitForClientSurfaceRendered('command-center', {
      root: { querySelector: () => null },
      timeoutMs: 50,
      now: () => now,
      schedule: callback => {
        now += 25;
        callback();
      },
    });
    expect(missing).toBe(false);
  });
});
