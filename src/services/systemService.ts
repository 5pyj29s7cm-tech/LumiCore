/**
 * System Service Bridge
 * Abstracts communication between the React frontend and the Desktop shell (Tauri/Electron).
 */

export interface CommandResponse {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

export interface TempReading {
  label: string;
  celsius: number;
}

export interface LiveStats {
  cpu_percent: number;
  memory_used_gb: number;
  memory_total_gb: number;
  memory_percent: number;
  gpu_vendor: string | null;
  gpu_utilization: number | null;
  temperatures: TempReading[];
  fan_speed_rpm: number | null;
  hostname: string;
  uptime_seconds: number;
}

export interface WallpaperModeState {
  enabled: boolean;
  presentation: WallpaperPresentation;
  workspace: WallpaperWorkspace;
}

export type WallpaperPresentation = 'workbench' | 'desktop-control';
export type WallpaperWorkspace = 'personal' | 'command-center' | 'organization';

class SystemService {
  private isTauri: boolean;
  private isElectron: boolean;

  constructor() {
    this.isTauri = typeof window !== 'undefined' && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI_IPC__ || !!(window as any).__TAURI__);
    this.isElectron = typeof window !== 'undefined' && (!!(window as any).lumiElectron || navigator.userAgent.toLowerCase().includes('electron'));
  }

  /**
   * Execute a system command
   */
  async runCommand(command: string): Promise<CommandResponse> {
    if (this.isTauri) {
      try {
        // Tauri 'run_command' would be a custom command defined in src-tauri/src/main.rs
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke('run_command', { command, cwd: null });
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    }

    if (this.isElectron && (window as any).lumiElectron) {
      return await (window as any).lumiElectron.runCommand(command);
    }

    // Web: no shell access
    return {
      success: false,
      output: '',
      error: 'System commands require the desktop app (Tauri). Browser mode has no shell access.',
    };
  }
  async getVolume(): Promise<number> {
    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<number>('get_system_volume');
      } catch { /* fallback */ }
    }
    return parseFloat(localStorage.getItem('lumi_volume') || '50');
  }

  async setVolume(level: number): Promise<void> {
    localStorage.setItem('lumi_volume', String(level));
    document.documentElement.style.setProperty('--lumi-volume', String(level));
    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_system_volume', { level });
      } catch { /* web fallback */ }
    }
  }

  async getBrightness(): Promise<number> {
    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<number>('get_screen_brightness');
      } catch { /* fallback */ }
    }
    return parseFloat(localStorage.getItem('lumi_brightness') || '85');
  }

  async setBrightness(level: number): Promise<void> {
    localStorage.setItem('lumi_brightness', String(level));
    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_screen_brightness', { level });
      } catch { /* web fallback */ }
    }
  }

  syncWallpaperDocumentMode(
    enabled: boolean,
    presentation: WallpaperPresentation = 'workbench',
    workspace: WallpaperWorkspace = 'personal',
  ): void {
    if (enabled) {
      document.documentElement.classList.add('lumi-wallpaper-mode');
      document.documentElement.dataset.wallpaperPresentation = presentation;
      document.documentElement.dataset.wallpaperWorkspace = workspace;
      try { sessionStorage.setItem('lumi.wallpaper.workspace', workspace); } catch {}
    } else {
      document.documentElement.classList.remove('lumi-wallpaper-mode');
      delete document.documentElement.dataset.wallpaperPresentation;
      delete document.documentElement.dataset.wallpaperWorkspace;
      try { sessionStorage.removeItem('lumi.wallpaper.workspace'); } catch {}
    }
  }

  /**
   * Toggle the full-screen wallpaper surface. Workbench remains interactive;
   * desktop-control preserves the legacy click-through overlay behavior.
   */
  async setWallpaperMode(
    enabled: boolean,
    presentation: WallpaperPresentation = 'workbench',
    workspace: WallpaperWorkspace = this.getDocumentWallpaperWorkspace(),
  ): Promise<WallpaperModeState> {
    const previous = document.documentElement.classList.contains('lumi-wallpaper-mode');
    const previousPresentation = this.getDocumentWallpaperPresentation();
    const previousWorkspace = this.getDocumentWallpaperWorkspace();
    this.syncWallpaperDocumentMode(enabled, presentation, workspace);

    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const state = await invoke<WallpaperModeState | null>('set_wallpaper_mode', {
          enabled,
          presentation,
          workspace,
        });
        const resolved = typeof state?.enabled === 'boolean' ? state.enabled : enabled;
        const resolvedPresentation = this.isWallpaperPresentation(state?.presentation)
          ? state.presentation
          : presentation;
        const resolvedWorkspace = this.isWallpaperWorkspace(state?.workspace)
          ? state.workspace
          : workspace;
        this.syncWallpaperDocumentMode(resolved, resolvedPresentation, resolvedWorkspace);
        return { enabled: resolved, presentation: resolvedPresentation, workspace: resolvedWorkspace };
      } catch (err) {
        this.syncWallpaperDocumentMode(previous, previousPresentation, previousWorkspace);
        console.error('Failed to set wallpaper mode:', err);
        throw err;
      }
    }
    return { enabled, presentation, workspace };
  }

  async getWallpaperMode(): Promise<WallpaperModeState> {
    if (this.isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const state = await invoke<WallpaperModeState>('get_wallpaper_mode');
      const enabled = Boolean(state?.enabled);
      const presentation = this.isWallpaperPresentation(state?.presentation)
        ? state.presentation
        : 'workbench';
      const storedWorkspace = this.getStoredWallpaperWorkspace();
      const workspace = storedWorkspace
        || (this.isWallpaperWorkspace(state?.workspace) ? state.workspace : 'personal');
      this.syncWallpaperDocumentMode(enabled, presentation, workspace);
      return { enabled, presentation, workspace };
    }
    return {
      enabled: document.documentElement.classList.contains('lumi-wallpaper-mode'),
      presentation: this.getDocumentWallpaperPresentation(),
      workspace: this.getDocumentWallpaperWorkspace(),
    };
  }

  private isWallpaperPresentation(value: unknown): value is WallpaperPresentation {
    return value === 'workbench' || value === 'desktop-control';
  }

  private getDocumentWallpaperPresentation(): WallpaperPresentation {
    const value = document.documentElement.dataset.wallpaperPresentation;
    return this.isWallpaperPresentation(value) ? value : 'workbench';
  }

  private isWallpaperWorkspace(value: unknown): value is WallpaperWorkspace {
    return value === 'personal' || value === 'command-center' || value === 'organization';
  }

  private getDocumentWallpaperWorkspace(): WallpaperWorkspace {
    const value = document.documentElement.dataset.wallpaperWorkspace;
    return this.isWallpaperWorkspace(value) ? value : 'personal';
  }

  private getStoredWallpaperWorkspace(): WallpaperWorkspace | null {
    try {
      const value = sessionStorage.getItem('lumi.wallpaper.workspace');
      return this.isWallpaperWorkspace(value) ? value : null;
    } catch {
      return null;
    }
  }

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    if (!this.isTauri) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setAlwaysOnTop(enabled);
  }

  /**
   * Get system info (CPU, RAM, etc)
   */
  async getSystemStats(): Promise<any> {
    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke('get_system_info');
      } catch (err) {
        console.error("Failed to get system stats:", err);
        return { cpu: 0, ram: 'N/A', disk: 'N/A' };
      }
    }
    if (this.isElectron) {
      return { cpu: 'N/A', ram: 'N/A', disk: 'N/A', platform: 'electron' };
    }
    // Web: use browser APIs where available
    const nav = navigator as any;
    return {
      cpu: nav.hardwareConcurrency || 'unknown',
      ram: nav.deviceMemory ? `${nav.deviceMemory}GB` : 'unknown',
      platform: navigator.platform,
      userAgent: navigator.userAgent.slice(0, 80),
    };
  }

  /**
   * Get live system stats with CPU%, GPU, temperatures
   */
  async getLiveStats(): Promise<LiveStats> {
    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<LiveStats>('get_live_stats');
      } catch (err) {
        console.error("Failed to get live stats:", err);
      }
    }
    return this.getServerStats();
  }

  /**
   * Fallback: get system stats from Express server (works in web/dev mode)
   */
  async getServerStats(): Promise<LiveStats> {
    try {
      const res = await fetch('/api/system/stats');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();
      return {
        cpu_percent: s.cpu ?? 0,
        memory_used_gb: s.ram?.used ?? 0,
        memory_total_gb: s.ram?.total ?? 0,
        memory_percent: s.ram?.percent ?? 0,
        gpu_vendor: s.gpu?.name ?? null,
        gpu_utilization: s.gpu?.util ?? null,
        temperatures: [],
        fan_speed_rpm: null,
        hostname: s.hostname ?? 'web',
        uptime_seconds: s.uptime ?? 0,
      };
    } catch {
      return {
        cpu_percent: 0,
        memory_used_gb: 0,
        memory_total_gb: 0,
        memory_percent: 0,
        gpu_vendor: null,
        gpu_utilization: null,
        temperatures: [],
        fan_speed_rpm: null,
        hostname: 'web',
        uptime_seconds: 0,
      };
    }
  }
}

export const systemService = new SystemService();
