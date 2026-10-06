import { useCallback, useRef, useState } from 'react';

type WindowStack = {
  openWindows: string[];
  minimizedWindows: string[];
  focusedWindow: string | null;
};

type WindowCommand = 'open' | 'focus' | 'close' | 'minimize' | 'remove' | 'reset';

/** One synchronous owner also covers commands delivered before React renders. */
export function useDesktopWindows(initialWindowId: string | null) {
  const [state, setState] = useState<WindowStack>(() => ({
    openWindows: initialWindowId ? [initialWindowId] : [],
    minimizedWindows: [],
    focusedWindow: initialWindowId,
  }));
  const current = useRef(state);
  const command = useCallback((action: WindowCommand, ...ids: string[]) => {
    const before = current.current;
    const id = ids[0];
    let { openWindows, minimizedWindows, focusedWindow } = before;
    if (action === 'reset') {
      openWindows = [];
      minimizedWindows = [];
      focusedWindow = null;
    } else if (action === 'open' || action === 'focus') {
      if (action === 'focus' && (!openWindows.includes(id) || minimizedWindows.includes(id))) return false;
      openWindows = [...openWindows.filter(value => value !== id), id];
      if (action === 'open') minimizedWindows = minimizedWindows.filter(value => value !== id);
      focusedWindow = id;
    } else {
      if (action === 'minimize') {
        if (!openWindows.includes(id) || minimizedWindows.includes(id)) return false;
        minimizedWindows = [...minimizedWindows, id];
      } else {
        openWindows = openWindows.filter(value => !ids.includes(value));
        minimizedWindows = minimizedWindows.filter(value => !ids.includes(value));
      }
      if (!openWindows.includes(focusedWindow || '') || minimizedWindows.includes(focusedWindow || '')) {
        focusedWindow = openWindows.filter(value => !minimizedWindows.includes(value)).at(-1) || null;
      }
    }
    current.current = { openWindows, minimizedWindows, focusedWindow };
    setState(current.current);
    return action === 'close' && before.focusedWindow === id && focusedWindow === null;
  }, []);
  return { ...state, command };
}
