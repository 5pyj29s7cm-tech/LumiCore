import { useDesktopSurfaceState } from './desktop/state/use_desktop_surface_state';
import { useDesktopCaptureAndIdentity } from './desktop/state/use_desktop_capture_and_identity';
import { useDesktopRuntimeAndPreferences } from './desktop/state/use_desktop_runtime_and_preferences';
import { useDesktopWallpaper } from './desktop/state/use_desktop_wallpaper';
import { useDesktopNotificationsAndShortcuts } from './desktop/state/use_desktop_notifications_and_shortcuts';
import { useDesktopSurfaceControls } from './desktop/state/use_desktop_surface_controls';
import { useDesktopPresentation } from './desktop/state/use_desktop_presentation';

declare global {
  interface Window {
    lumiElectron?: {
      getSystemInfo: () => Promise<{ platform: string; hostname: string; freeMemory: number }>;
      runCommand: (command: string) => Promise<{ success: boolean; output: string }>;
    };
  }
}

export function DesktopUI(props: Parameters<typeof useDesktopSurfaceState>[0]) {
  const state0 = useDesktopSurfaceState(props);
  const state1 = useDesktopCaptureAndIdentity(state0);
  const state2 = useDesktopRuntimeAndPreferences(state1);
  const state3 = useDesktopWallpaper(state2);
  const state4 = useDesktopNotificationsAndShortcuts(state3);
  const state5 = useDesktopSurfaceControls(state4);
  return useDesktopPresentation(state5);
}
