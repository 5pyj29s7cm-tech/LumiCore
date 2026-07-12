import { describe, expect, it } from 'vitest';
import { mergeNotificationState, notificationClearStorageKey } from '../src/lib/notificationState';

describe('notification client state', () => {
  it('does not resurrect server notifications at or before the local clear boundary', () => {
    const merged = mergeNotificationState(
      [],
      [
        { id: 'old-1', type: 'info', timestamp: 100, read: false },
        { id: 'old-2', type: 'warning', timestamp: 200, read: false },
        { id: 'new-1', type: 'info', timestamp: 301, read: false },
      ],
      { clearedAt: 300 },
    );

    expect(merged.map(item => item.id)).toEqual(['new-1']);
  });

  it('preserves optimistic local read state when an older fetch arrives later', () => {
    const merged = mergeNotificationState(
      [{ id: 'same', type: 'info', timestamp: 400, read: true }],
      [{ id: 'same', type: 'info', timestamp: 400, read: false }],
    );

    expect(merged).toEqual([{ id: 'same', type: 'info', timestamp: 400, read: true }]);
  });

  it('keeps clear boundaries isolated per Lumi user', () => {
    expect(notificationClearStorageKey('user-a')).not.toBe(notificationClearStorageKey('user-b'));
  });
});
