import { useEffect, useCallback } from "react";
import { Sparkles, Box } from "lucide-react";
import { toast } from "sonner";
import { systemService, type WallpaperPresentation, type WallpaperWorkspace } from "@/services/systemService";
import type { useDesktopRuntimeAndPreferences } from './use_desktop_runtime_and_preferences';

export function useDesktopWallpaper(previousBindings: ReturnType<typeof useDesktopRuntimeAndPreferences>) {
  const { wallpaperAutomationTimerRef, wallpaperPresentationRef, inferWallpaperWorkspace, wallpaperWorkspaceRef, isWallpaperModeRef, syncWallpaperModeView, wallpaperNativeTransitionDepthRef, chatOpen, isDesktopWidgetMode, wallpaperBeforeAutomationRef, addNotification, t, isWallpaperMode, setWallpaperWorkPromptVisible, socket, setMcpActivities } = previousBindings;


  const applyWallpaperMode = useCallback(async (
    enabled: boolean,
    options: {
      silent?: boolean;
      timeoutMs?: number;
      presentation?: WallpaperPresentation;
      workspace?: WallpaperWorkspace;
    } = {},
  ) => {
    if (wallpaperAutomationTimerRef.current) {
      clearTimeout(wallpaperAutomationTimerRef.current);
      wallpaperAutomationTimerRef.current = null;
    }

    const requestedPresentation = options.presentation
      || (enabled ? 'workbench' : wallpaperPresentationRef.current);
    const requestedWorkspace = options.workspace
      || (enabled && requestedPresentation === 'workbench'
        ? inferWallpaperWorkspace()
        : wallpaperWorkspaceRef.current);
    const previous = {
      enabled: isWallpaperModeRef.current,
      presentation: wallpaperPresentationRef.current,
      workspace: wallpaperWorkspaceRef.current,
    };
    syncWallpaperModeView(enabled, requestedPresentation, requestedWorkspace);
    let resolvedState = {
      enabled,
      presentation: requestedPresentation,
      workspace: requestedWorkspace,
    };

    try {
      wallpaperNativeTransitionDepthRef.current += 1;
      const actual = await systemService.setWallpaperMode(
        enabled,
        requestedPresentation,
        requestedWorkspace,
      );
      resolvedState = actual;
      syncWallpaperModeView(actual.enabled, actual.presentation, actual.workspace);
      await systemService.setAlwaysOnTop(
        actual.enabled
          ? actual.presentation === 'desktop-control'
          : chatOpen || isDesktopWidgetMode,
      );
    } catch (error) {
      syncWallpaperModeView(previous.enabled, previous.presentation, previous.workspace);
      await systemService.setAlwaysOnTop(
        previous.enabled
          ? previous.presentation === 'desktop-control'
          : chatOpen || isDesktopWidgetMode,
      ).catch(() => {});
      console.error('Wallpaper mode transition failed:', error);
      toast.error('Wallpaper mode could not be changed');
      throw error;
    } finally {
      wallpaperNativeTransitionDepthRef.current = Math.max(
        0,
        wallpaperNativeTransitionDepthRef.current - 1,
      );
    }

    if (enabled && requestedPresentation === 'desktop-control' && options.timeoutMs) {
      wallpaperAutomationTimerRef.current = setTimeout(() => {
        const restore = wallpaperBeforeAutomationRef.current || {
          enabled: false,
          presentation: 'workbench' as WallpaperPresentation,
          workspace: wallpaperWorkspaceRef.current,
        };
        wallpaperAutomationTimerRef.current = null;
        wallpaperNativeTransitionDepthRef.current += 1;
        void systemService.setWallpaperMode(restore.enabled, restore.presentation, restore.workspace)
          .then(actual => {
            wallpaperBeforeAutomationRef.current = null;
            syncWallpaperModeView(actual.enabled, actual.presentation, actual.workspace);
            void systemService.setAlwaysOnTop(
              actual.enabled
                ? actual.presentation === 'desktop-control'
                : chatOpen || isDesktopWidgetMode,
            ).catch(() => {});
            addNotification({
              type: 'system',
              title: 'Lumi',
              message: t.wallpaperAutoRestored || 'Wallpaper mode restored after desktop control timeout',
            });
          })
          .catch(async error => {
            console.error('Wallpaper mode restore failed:', error);
            try {
              const safeState = await systemService.setWallpaperMode(false, 'workbench', restore.workspace);
              wallpaperBeforeAutomationRef.current = null;
              syncWallpaperModeView(safeState.enabled, safeState.presentation, safeState.workspace);
              await systemService.setAlwaysOnTop(chatOpen || isDesktopWidgetMode).catch(() => {});
            } catch (safeExitError) {
              console.error('Wallpaper mode safe exit failed:', safeExitError);
              addNotification({
                type: 'warning',
                title: 'Lumi',
                message: 'Desktop-control wallpaper could not be restored automatically.',
              });
            }
          })
          .finally(() => {
            wallpaperNativeTransitionDepthRef.current = Math.max(
              0,
              wallpaperNativeTransitionDepthRef.current - 1,
            );
          });
      }, Math.max(15_000, options.timeoutMs));
    }

    if (!options.silent) {
      toast(enabled ? (t.wallpaperFusionActive || 'Wallpaper Fusion Active') : (t.standardFocusMode || 'Standard Desktop'), {
        icon: enabled ? <Sparkles className="text-celestial-saturn" /> : <Box className="text-white/40" />
      });
    }
    return resolvedState;
  }, [wallpaperAutomationTimerRef, wallpaperPresentationRef, inferWallpaperWorkspace, wallpaperWorkspaceRef, isWallpaperModeRef, syncWallpaperModeView, wallpaperNativeTransitionDepthRef, chatOpen, isDesktopWidgetMode, wallpaperBeforeAutomationRef, addNotification, t.wallpaperAutoRestored, t.wallpaperFusionActive, t.standardFocusMode]);

  useEffect(() => {
    let disposed = false;
    let unlisten: undefined | (() => void);

    void systemService.getWallpaperMode()
      .then(state => {
        if (!disposed) syncWallpaperModeView(state.enabled, state.presentation, state.workspace);
      })
      .catch(error => console.error('Failed to read wallpaper mode:', error));

    const hasTauriRuntime = Boolean(
      (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__ || (window as any).__TAURI__,
    );
    if (hasTauriRuntime) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) => listen<{
          enabled?: boolean;
          presentation?: WallpaperPresentation;
          workspace?: WallpaperWorkspace;
        }>('lumi:wallpaper-mode-changed', event => {
          if (!disposed) {
            const enabled = Boolean(event.payload?.enabled);
            if (!enabled && wallpaperNativeTransitionDepthRef.current === 0) {
              if (wallpaperAutomationTimerRef.current) {
                clearTimeout(wallpaperAutomationTimerRef.current);
                wallpaperAutomationTimerRef.current = null;
              }
              wallpaperBeforeAutomationRef.current = null;
            }
            syncWallpaperModeView(
              enabled,
              event.payload?.presentation || wallpaperPresentationRef.current,
              event.payload?.workspace || wallpaperWorkspaceRef.current,
            );
          }
        }))
        .then(stop => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(error => console.error('Failed to listen for wallpaper mode changes:', error));
    }

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [syncWallpaperModeView, wallpaperAutomationTimerRef, wallpaperBeforeAutomationRef, wallpaperNativeTransitionDepthRef, wallpaperPresentationRef, wallpaperWorkspaceRef]);

  useEffect(() => () => {
    if (!isWallpaperModeRef.current || wallpaperPresentationRef.current !== 'desktop-control') return;
    const restore = wallpaperBeforeAutomationRef.current || {
      enabled: false,
      presentation: 'workbench' as WallpaperPresentation,
      workspace: wallpaperWorkspaceRef.current,
    };
    wallpaperBeforeAutomationRef.current = null;
    void systemService.setWallpaperMode(
      restore.enabled,
      restore.presentation,
      restore.workspace,
    ).catch(error => console.error('Failed to safely exit desktop-control wallpaper:', error));
  }, [isWallpaperModeRef, wallpaperBeforeAutomationRef, wallpaperPresentationRef, wallpaperWorkspaceRef]);

  const toggleWallpaperMode = useCallback(() => {
    void applyWallpaperMode(!isWallpaperMode, { presentation: 'workbench' });
  }, [applyWallpaperMode, isWallpaperMode]);

  const dismissWallpaperWorkPrompt = useCallback(() => {
    setWallpaperWorkPromptVisible(false);
  }, [setWallpaperWorkPromptVisible]);

  const enterWallpaperFromWorkPrompt = useCallback(() => {
    dismissWallpaperWorkPrompt();
    void applyWallpaperMode(true, { presentation: 'workbench' });
  }, [applyWallpaperMode, dismissWallpaperWorkPrompt]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        enabled?: boolean;
        timeoutMs?: number;
        respond?: (result: any) => void;
        reject?: (message: string) => void;
      }>).detail || {};
      void (async () => {
        const enabled = Boolean(detail.enabled);
        const capturedRestore = enabled && !wallpaperBeforeAutomationRef.current;
        try {
          if (capturedRestore) {
            wallpaperBeforeAutomationRef.current = {
              enabled: isWallpaperModeRef.current,
              presentation: wallpaperPresentationRef.current,
              workspace: wallpaperWorkspaceRef.current,
            };
          } else if (!enabled && wallpaperBeforeAutomationRef.current) {
            const restore = wallpaperBeforeAutomationRef.current;
            if (wallpaperAutomationTimerRef.current) {
              clearTimeout(wallpaperAutomationTimerRef.current);
              wallpaperAutomationTimerRef.current = null;
            }
            const restored = await applyWallpaperMode(restore.enabled, {
              silent: true,
              presentation: restore.presentation,
              workspace: restore.workspace,
            });
            wallpaperBeforeAutomationRef.current = null;
            detail.respond?.(restored);
            return;
          }

          const result = await applyWallpaperMode(enabled, {
            silent: true,
            presentation: 'desktop-control',
            timeoutMs: enabled ? detail.timeoutMs : undefined,
          });
          if (!enabled) wallpaperBeforeAutomationRef.current = null;
          detail.respond?.(result);
        } catch (error: any) {
          if (capturedRestore) wallpaperBeforeAutomationRef.current = null;
          detail.reject?.(error?.message || String(error));
        }
      })();
    };
    window.addEventListener('lumi:set-wallpaper-mode', handler);
    return () => {
      window.removeEventListener('lumi:set-wallpaper-mode', handler);
      if (wallpaperAutomationTimerRef.current) {
        clearTimeout(wallpaperAutomationTimerRef.current);
        wallpaperAutomationTimerRef.current = null;
      }
    };
  }, [applyWallpaperMode, isWallpaperModeRef, wallpaperAutomationTimerRef, wallpaperBeforeAutomationRef, wallpaperPresentationRef, wallpaperWorkspaceRef]);

  // MCP Live Activity socket listener
  useEffect(() => {
    if (!socket) return;
    const handler = (data: any) => {
      const activity = { ...data, id: Date.now().toString(), time: Date.now() };
      setMcpActivities(prev => [activity, ...prev].slice(0, 20));
      const status = String(data?.status || '').toLowerCase();
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(status)) {
        addNotification({
          type: status === 'completed' ? 'success' : 'warning',
          title: data?.title || data?.action || 'MCP',
          message: data?.error || data?.message || data?.path || status,
        });
      }
    };
    socket.on('mcp:activity', handler);
    return () => { socket.off('mcp:activity', handler); };
  }, [socket, addNotification, setMcpActivities]);
  return {
    ...previousBindings, toggleWallpaperMode, applyWallpaperMode, enterWallpaperFromWorkPrompt, dismissWallpaperWorkPrompt
  } as const;
}
