import { apiJson } from './apiClient';
import type { getSystemStatsSnapshot } from '../../server/routes/system_routes';
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

export type SystemStats = Omit<Awaited<ReturnType<typeof getSystemStatsSnapshot>>, 'physicalCpus' | 'gpu'> & {
  physicalCpus: number | null;
  gpu: { name: string; util?: number | null } | null;
};

function checkedSystemStats(value: SystemStats): SystemStats {
  const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!value || !['native_client', 'lumi_server_host'].includes(value.computerScope)
    || ![value.cpu, value.ram?.used, value.ram?.total, value.ram?.percent, value.uptime].every(nonnegative)
    || value.cpu > 100 || value.ram.percent > 100 || value.ram.total <= 0
    || !Number.isInteger(value.logicalCpus) || value.logicalCpus < 1
    || (value.physicalCpus !== null && (!Number.isInteger(value.physicalCpus) || value.physicalCpus < 1))
    || ![value.hostname, value.platform, value.release, value.arch, value.cpuModel].every(item => typeof item === 'string')
    || (value.gpu !== null && (typeof value.gpu?.name !== 'string' || (value.gpu.util != null && (!nonnegative(value.gpu.util) || value.gpu.util > 100))))) {
    throw new Error('Invalid system statistics');
  }
  return value;
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
  private nativeInfo: Promise<any> | undefined;
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
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<number>('get_system_volume');
    }
    throw new Error('System volume requires the desktop app');
  }

  async setVolume(level: number): Promise<void> {
    if (!this.isTauri) throw new Error('System volume requires the desktop app');
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_system_volume', { level });
    localStorage.setItem('lumi_volume', String(level));
    document.documentElement.style.setProperty('--lumi-volume', String(level));
  }

  async getBrightness(): Promise<number> {
    if (this.isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<number>('get_screen_brightness');
    }
    throw new Error('Screen brightness is unavailable outside the desktop app');
  }

  async setBrightness(level: number): Promise<void> {
    if (!this.isTauri) throw new Error('Screen brightness is unavailable outside the desktop app');
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_screen_brightness', { level });
    localStorage.setItem('lumi_brightness', String(level));
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

  async getSystemStats(signal: AbortSignal): Promise<SystemStats> {
    signal.throwIfAborted();
    if (this.isTauri) {
      let aborted = () => {};
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        signal.throwIfAborted();
        const cancellation = new Promise<never>((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); });
        const [info, live] = await Promise.race([Promise.all([this.nativeInfo ??= invoke<any>('get_system_info'), invoke<any>('get_live_stats')]), cancellation]);
        signal.throwIfAborted();
        return checkedSystemStats({
          computerScope: 'native_client', cpu: live.cpu_percent, cpuModel: info.cpu_model,
          logicalCpus: info.logical_cpus, physicalCpus: info.cpus, cpus: info.logical_cpus,
          ram: { used: live.memory_used_gb, total: live.memory_total_gb, percent: live.memory_percent },
          platform: info.platform, release: info.release, arch: info.arch, hostname: live.hostname, uptime: live.uptime_seconds,
          gpu: live.gpu_vendor ? { name: live.gpu_vendor, util: live.gpu_utilization } : null,
        });
      } catch {
        this.nativeInfo = undefined;
        signal.throwIfAborted();
      } finally { signal.removeEventListener('abort', aborted); }
    }
    const stats = await apiJson<SystemStats>('/api/system/stats', { signal });
    signal.throwIfAborted();
    return checkedSystemStats(stats);
  }
}

export const systemService = new SystemService();
