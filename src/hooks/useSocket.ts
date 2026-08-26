import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { isTauriRuntime } from '@/services/apiBridge';
import { socketService } from '@/services/socketService';
import {
  beginDesktopAutomationActivity,
  endDesktopAutomationActivity,
} from '@/services/desktopAutomationActivity';
import { desktopCommandRelayOutput } from '@/lib/desktopCommandReceipt';

const isTauri = isTauriRuntime();
let registeredSocket: Socket | null = null;
let deviceConnectHandler: (() => void) | null = null;
let cursorGlowWatchdog: ReturnType<typeof setTimeout> | null = null;
const activeDesktopExecutions = new Set<string>();
const cancelledDesktopExecutions = new Set<string>();

function normalizeCursorGlowPoint(args: Record<string, any>) {
  const rawX = Number(args.x) || 0;
  const rawY = Number(args.y) || 0;
  const screenWidth = Number(args.screenWidth || args.screen_width || args.width || 0);
  const screenHeight = Number(args.screenHeight || args.screen_height || args.height || 0);
  const screenX = Number(args.screenX || args.screen_x || 0);
  const screenY = Number(args.screenY || args.screen_y || 0);
  const isScreenPoint = args.coordinateSpace === 'screen' || screenWidth > 0 || screenHeight > 0;

  if (!isScreenPoint || screenWidth <= 0 || screenHeight <= 0) {
    return { x: rawX, y: rawY };
  }

  return {
    x: Math.round((rawX - screenX) * (window.innerWidth / screenWidth)),
    y: Math.round((rawY - screenY) * (window.innerHeight / screenHeight)),
  };
}

function registerSharedSocketHandlers(socket: Socket) {
  if (registeredSocket === socket) return;

  if (registeredSocket) {
    if (deviceConnectHandler) registeredSocket.off('connect', deviceConnectHandler);
    registeredSocket.off('tool:desktop_exec', desktopExecHandler);
    registeredSocket.off('tool:desktop_cancel', desktopCancelHandler);
  }

  const registerDevice = () => {
    socket.emit('device:register', {
      name: navigator.platform || 'Unknown Device',
      type: isTauri ? 'desktop' : 'web',
      capabilities: {
        audio: true,
        video: false,
        spatial: false,
        haptic: false,
        holographic: false,
      },
      osInfo: navigator.platform || '',
    });
  };

  socket.on('connect', registerDevice);
  socket.on('tool:desktop_exec', desktopExecHandler);
  socket.on('tool:desktop_cancel', desktopCancelHandler);
  if (socket.connected) registerDevice();

  registeredSocket = socket;
  deviceConnectHandler = registerDevice;
}

function desktopCancelHandler(data: { correlationId?: string; name?: string }) {
  const correlationId = String(data?.correlationId || '').trim();
  if (!correlationId) return;
  cancelledDesktopExecutions.add(correlationId);
  window.setTimeout(() => cancelledDesktopExecutions.delete(correlationId), 5 * 60 * 1000);
  if (data?.name === 'desktop_run_command' && activeDesktopExecutions.has(correlationId) && isTauri) {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('cancel_command', { commandId: correlationId }))
      .catch(() => {});
  }
}

function desktopExecHandler(data: {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
}) {
  const socket = socketService.getSocket();
  if (socket) void handleDesktopExec(socket, data);
}

async function handleDesktopExec(socket: Socket, data: {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
}) {
  const { correlationId, name, arguments: args } = data;

  if (name === 'client_action') {
    beginDesktopAutomationActivity();
    try {
      const output = await dispatchClientAction(args);
      socket.emit(`tool:desktop_result:${correlationId}`, { output });
    } catch (err: any) {
      socket.emit(`tool:desktop_result:${correlationId}`, { error: err.message || String(err) });
    } finally {
      endDesktopAutomationActivity();
    }
    return;
  }

  if (!isTauri) {
    socket.emit(`tool:desktop_result:${correlationId}`, {
      error: 'Desktop tools are only available in the Tauri desktop app',
    });
    return;
  }

  activeDesktopExecutions.add(correlationId);
  beginDesktopAutomationActivity();
  try {
    // Dynamic import — @tauri-apps/api only exists in Tauri context
    const { invoke } = await import('@tauri-apps/api/core');
    let output: string;

    switch (name) {
      case 'desktop_capability_status': {
        const status = await invoke('get_desktop_capability_status');
        output = JSON.stringify(status, null, 2);
        break;
      }
      case 'desktop_system_info': {
        const info = await invoke('get_system_info');
        output = JSON.stringify(info, null, 2);
        break;
      }
      case 'desktop_list_files': {
        const dirPath: string = args.path || '';
        const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 1000);
        const files: Array<{
          name: string;
          path: string;
          is_directory?: boolean;
          isDirectory?: boolean;
          size?: number;
          modified_ms?: number | null;
        }> = await invoke('list_directory', { path: dirPath, limit });
        output = JSON.stringify(
          files.map(f => ({
            name: f.name,
            path: f.path,
            type: (f.is_directory ?? f.isDirectory) ? 'directory' : 'file',
            size: f.size ?? 0,
            modifiedMs: f.modified_ms ?? null,
          })),
          null,
          2
        );
        break;
      }
      case 'desktop_list_apps': {
        const query: string = args.query || '';
        const limit = Math.min(Math.max(Number(args.limit) || 80, 1), 200);
        const apps = await invoke('list_native_apps', { query: query.trim() || null, limit });
        output = JSON.stringify(apps, null, 2);
        break;
      }
      case 'desktop_path_info': {
        const target: string = args.target || args.path || '';
        if (!target.trim()) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No path provided' });
          return;
        }
        const info = await invoke('path_info', { target: target.trim() });
        output = JSON.stringify(info, null, 2);
        break;
      }
      case 'desktop_write_text_file': {
        const targetPath = String(args.path || '').trim();
        const content = String(args.content ?? '');
        const encoding = String(args.encoding || 'utf-8').trim().toLowerCase();
        const overwritePolicy = String(args.overwritePolicy || 'fail_if_exists').trim().toLowerCase();
        if (!targetPath) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No text file path provided' });
          return;
        }
        const result: {
          success: boolean;
          status: string;
          path: string;
          bytesWritten: number;
          encoding: string;
          overwritePolicy: string;
          overwritten: boolean;
          readBackMatched: boolean;
          error?: string | null;
        } = await invoke('write_text_file', {
          path: targetPath,
          content,
          encoding,
          overwritePolicy,
        });
        if (!result.success) {
          throw new Error(result.error || `Failed to write text file: ${targetPath}`);
        }
        output = JSON.stringify(result);
        break;
      }
      case 'desktop_read_text_file': {
        const targetPath = String(args.path || '').trim();
        if (!targetPath) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No text file path provided' });
          return;
        }
        const result: {
          success: boolean;
          path: string;
          content: string;
          bytesRead: number;
          encoding: string;
          error?: string | null;
        } = await invoke('read_text_file', { path: targetPath });
        if (!result.success) {
          throw new Error(result.error || `Failed to read text file: ${targetPath}`);
        }
        output = JSON.stringify(result);
        break;
      }
      case 'desktop_open': {
        const target: string = args.target || '';
        const application: string = args.application || args.browser || '';
        if (!target.trim()) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No target provided to open' });
          return;
        }
        const openResult: { success: boolean; output: string } = await invoke('open_item', {
          target: target.trim(),
          application: application.trim() || null,
        });
        if (!openResult.success) {
          throw new Error(openResult.output || `Failed to open: ${target}`);
        }
        output = openResult.output || `Opened: ${target}`;
        break;
      }
      case 'desktop_show_lumi_window': {
        await invoke('show_main_window');
        output = 'Lumi window focused';
        break;
      }
      case 'desktop_run_command': {
        const cmd: string = args.command || '';
        const cwd: string = args.cwd || '';
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120000, 1000), 600000);
        if (!cmd.trim()) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No command provided' });
          return;
        }
        const result: { success: boolean; output: string } = await invoke('run_command', {
          command: cmd,
          cwd: cwd.trim() || null,
          timeoutMs,
          commandId: correlationId,
        });
        if (!result.success) {
          throw new Error(result.output || `Command failed: ${cmd}`);
        }
        output = desktopCommandRelayOutput(result, correlationId);
        break;
      }
      case 'desktop_active_window': {
        const info = await invoke('get_active_window_info');
        output = JSON.stringify(info, null, 2);
        break;
      }
      case 'desktop_window_control': {
        const result = await invoke('control_active_window', { action: String(args.action || '') });
        output = JSON.stringify(result, null, 2);
        break;
      }
      case 'desktop_running_processes': {
        const procs = await invoke('get_running_processes');
        output = JSON.stringify(procs, null, 2);
        break;
      }
      case 'desktop_capture_screen': {
        const capture = await invoke('capture_screen');
        const pngBase64: string = (capture as any).image_base64 || '';
        if (!pngBase64) {
          throw new Error('Screen capture returned no image. On macOS, grant LumiCore Screen Recording access in System Settings > Privacy & Security.');
        }
        const screenX: number = Number((capture as any).screen_x) || 0;
        const screenY: number = Number((capture as any).screen_y) || 0;
        const width: number = (capture as any).width || 1920;
        const height: number = (capture as any).height || 1080;
        const inputWidth: number = Number((capture as any).input_width) || width;
        const inputHeight: number = Number((capture as any).input_height) || height;
        const quality = args.quality || 60;
        // Convert PNG to JPEG via Canvas to reduce size for vision API / computer use
        try {
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Failed to load screenshot'));
            img.src = `data:image/png;base64,${pngBase64}`;
          });
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0, width, height);
          const jpegDataUrl = canvas.toDataURL('image/jpeg', quality / 100);
          const jpegBase64 = jpegDataUrl.split(',')[1];
          output = JSON.stringify({ image_base64: jpegBase64, screen_x: screenX, screen_y: screenY, width, height, input_width: inputWidth, input_height: inputHeight, format: 'jpeg' });
        } catch {
          // Fallback: return full PNG base64 if canvas conversion fails
          output = JSON.stringify({ image_base64: pngBase64, screen_x: screenX, screen_y: screenY, width, height, input_width: inputWidth, input_height: inputHeight, format: 'png' });
        }
        break;
      }
      case 'desktop_clipboard_read': {
        const text = await invoke('get_clipboard_text');
        output = (text as string) || '';
        break;
      }
      case 'desktop_clipboard_write': {
        const text: string = args.text || '';
        if (!text) { socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No text provided for clipboard' }); return; }
        const ok = await invoke('set_clipboard_text', { text });
        output = ok ? 'Clipboard updated' : 'Failed to set clipboard';
        break;
      }
      case 'desktop_clipboard_write_files': {
        const paths = (Array.isArray(args.paths) ? args.paths : [args.path])
          .map((value: unknown) => String(value || '').trim())
          .filter(Boolean);
        if (paths.length === 0) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No file paths provided for clipboard' });
          return;
        }
        const ok = await invoke('set_clipboard_files', { paths });
        output = ok ? `Clipboard file list updated (${paths.length})` : 'Failed to set clipboard files';
        break;
      }
      case 'desktop_idle_time': {
        const idle = await invoke('get_idle_time');
        output = JSON.stringify(idle, null, 2);
        break;
      }
      case 'desktop_poll_activity': {
        const snap = await invoke('poll_activity');
        output = JSON.stringify(snap, null, 2);
        break;
      }
      case 'desktop_mouse_move': {
        await invoke('mouse_move', { x: args.x, y: args.y });
        output = `Mouse moved to (${args.x}, ${args.y})`;
        break;
      }
      case 'desktop_mouse_click': {
        await invoke('mouse_click', { button: args.button || 'left' });
        output = `${args.button || 'left'} click`;
        break;
      }
      case 'desktop_mouse_drag': {
        await invoke('mouse_drag', { fromX: args.from_x, fromY: args.from_y, toX: args.to_x, toY: args.to_y, button: args.button || 'left' });
        output = 'Drag completed';
        break;
      }
      // Independent cursor: click at coords without stealing real mouse
      case 'desktop_mouse_click_at': {
        await invoke('mouse_click_at', { x: args.x, y: args.y, button: args.button || 'left' });
        output = `Virtual click ${args.button || 'left'} at (${args.x}, ${args.y})`;
        break;
      }
      case 'desktop_mouse_double_click_at': {
        await invoke('mouse_double_click_at', { x: args.x, y: args.y });
        output = `Virtual double-click at (${args.x}, ${args.y})`;
        break;
      }
      case 'desktop_mouse_right_click_at': {
        await invoke('mouse_right_click_at', { x: args.x, y: args.y });
        output = `Virtual right-click at (${args.x}, ${args.y})`;
        break;
      }
      case 'desktop_keyboard_type': {
        await invoke('keyboard_type', { text: args.text });
        output = `Typed ${args.text?.length || 0} chars`;
        break;
      }
      case 'desktop_keyboard_press': {
        await invoke('keyboard_press', { key: args.key });
        output = `Pressed: ${args.key}`;
        break;
      }
      case 'desktop_set_wallpaper_mode': {
        const source = String(args.source || '');
        const allowedSources = new Set(['computer_use', 'wechat_send_message', 'self_intro_demo']);
        if (!allowedSources.has(source)) {
          output = 'Wallpaper mode request ignored: only controlled desktop sessions may toggle it.';
          break;
        }
        window.dispatchEvent(new CustomEvent('lumi:set-wallpaper-mode', {
          detail: {
            enabled: Boolean(args.enabled),
            source,
            timeoutMs: Number(args.timeoutMs || 190000),
          },
        }));
        output = `Wallpaper mode ${args.enabled ? 'enabled' : 'disabled'} for ${source}`;
        break;
      }
      case 'desktop_cursor_glow_show': {
        window.dispatchEvent(new CustomEvent('cursor-glow:show'));
        if (cursorGlowWatchdog) clearTimeout(cursorGlowWatchdog);
        cursorGlowWatchdog = setTimeout(() => {
          window.dispatchEvent(new CustomEvent('cursor-glow:hide'));
          cursorGlowWatchdog = null;
        }, Number(args.timeoutMs || 190000));
        output = 'Glow shown';
        break;
      }
      case 'desktop_cursor_glow_update': {
        window.dispatchEvent(new CustomEvent('cursor-glow:update', { detail: normalizeCursorGlowPoint(args) }));
        output = `Glow updated: (${args.x}, ${args.y})`;
        break;
      }
      case 'desktop_cursor_glow_hide': {
        if (cursorGlowWatchdog) {
          clearTimeout(cursorGlowWatchdog);
          cursorGlowWatchdog = null;
        }
        window.dispatchEvent(new CustomEvent('cursor-glow:hide'));
        output = 'Glow hidden';
        break;
      }
      case 'desktop_cursor_glow_click': {
        window.dispatchEvent(new CustomEvent('cursor-glow:click', { detail: normalizeCursorGlowPoint(args) }));
        output = 'Glow click animation';
        break;
      }
      case 'client_action': {
        output = await dispatchClientAction(args);
        break;
      }
      default:
        socket.emit(`tool:desktop_result:${correlationId}`, {
          error: `Unknown desktop tool: ${name}`,
        });
        return;
    }

    if (!cancelledDesktopExecutions.has(correlationId)) {
      socket.emit(`tool:desktop_result:${correlationId}`, { output });
    }
  } catch (err: any) {
    if (!cancelledDesktopExecutions.has(correlationId)) {
      socket.emit(`tool:desktop_result:${correlationId}`, { error: err.message || String(err) });
    }
  } finally {
    endDesktopAutomationActivity();
    activeDesktopExecutions.delete(correlationId);
    cancelledDesktopExecutions.delete(correlationId);
  }
}

async function dispatchClientAction(args: Record<string, any>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Client action timed out'));
    }, 5000);

    window.dispatchEvent(new CustomEvent('lumi:client-action', {
      detail: {
        ...args,
        respond: (result: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(typeof result === 'string' ? result : JSON.stringify(result || { ok: true }));
        },
        reject: (message: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error(message || 'Client action failed'));
        },
      },
    }));
  });
}

/**
 * Register the desktop device and native tool relay as part of shell startup,
 * not only when a page component happens to mount. This is idempotent for the
 * shared Socket.IO instance and is also reused by React consumers.
 */
export function initializeSharedSocketRuntime(): Socket {
  const socket = socketService.connect();
  registerSharedSocketHandlers(socket);
  return socket;
}

export function useSocket() {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const s = initializeSharedSocketRuntime();
    setSocket(s);
  }, []);

  return socket;
}
