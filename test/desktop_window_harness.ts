import { loadSourceModule } from './source_expression';

/** Execute the production owner while source-expression tests emulate pending React renders. */
export function desktopWindowCommand(state: Record<string, any>) {
  const { useDesktopWindows } = loadSourceModule<{ useDesktopWindows: (id: string | null) => any }>(
    'src/components/desktop/useDesktopWindows.ts', {
      react: {
        useState: () => [{ openWindows: state.openWindows, minimizedWindows: state.minimizedWindows, focusedWindow: state.focusedWindow },
          (next: any) => Object.assign(state, next)],
        useRef: (current: any) => ({ current }),
        useCallback: (callback: any) => callback,
      },
    },
  );
  return useDesktopWindows(null).command;
}
