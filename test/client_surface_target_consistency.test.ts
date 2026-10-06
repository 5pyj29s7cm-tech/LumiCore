import './helpers';
import { describe, expect, it } from 'vitest';
import { normalizeDesktopSurfaceTarget } from '../src/components/desktop/useClientSurfaceActions';
import {
  getClientActionExpectation,
  verifyClientActionResult,
  type ClientStateSnapshot,
} from '../server/client/self_model';

describe('native client target and receipt verification agreement', () => {
  it.each([
    ['聊天', 'command-center'],
    ['聊天窗口', 'command-center'],
    [' CHAT ', 'command-center'],
    ['sanctuary', 'memory-avatar'],
    ['记忆领地', 'memory-avatar'],
  ])('does not claim %s is closed while its actual surface remains open', (alias, canonical) => {
    const nativeTarget = normalizeDesktopSurfaceTarget(alias);
    expect(nativeTarget).toBe(canonical);
    const expectation = getClientActionExpectation({ action: 'close_client_surface', target: alias });
    expect(expectation.target).toBe(nativeTarget);
    const open: ClientStateSnapshot = {
      mode: 'assistant',
      activeTab: 'home',
      windows: { open: [], focused: null },
      surfaces: {
        commandCenterOpen: canonical === 'command-center',
        memoryAvatarOpen: canonical === 'memory-avatar',
        openSurfaceIds: [canonical],
      },
      updatedAt: 1000,
    };
    const stillOpen = { ...open, updatedAt: 2000 };
    const pending = verifyClientActionResult(
      { action: 'close_client_surface', target: alias }, open, stillOpen, { ok: true },
    );
    expect(pending.status).toBe('pending');
    expect(pending.missing).toEqual(['surface:' + canonical + ':closed']);
    const closed: ClientStateSnapshot = {
      ...open,
      surfaces: { commandCenterOpen: false, memoryAvatarOpen: false, openSurfaceIds: [] },
      updatedAt: 3000,
    };
    expect(verifyClientActionResult(
      { action: 'close_client_surface', target: alias }, open, closed, { ok: true },
    ).status).toBe('verified');
  });
});
