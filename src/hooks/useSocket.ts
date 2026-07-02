import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { isTauriRuntime } from '@/services/apiBridge';
import { socketService } from '@/services/socketService';

const isTauri = isTauriRuntime();
let registeredSocket: Socket | null = null;
let deviceConnectHandler: (() => void) | null = null;
let cursorGlowWatchdog: ReturnType<typeof setTimeout> | null = null;

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
  if (socket.connected) registerDevice();

  registeredSocket = socket;
  deviceConnectHandler = registerDevice;
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
    try {
      const output = await dispatchClientAction(args);
      socket.emit(`tool:desktop_result:${correlationId}`, { output });
    } catch (err: any) {
      socket.emit(`tool:desktop_result:${correlationId}`, { error: err.message || String(err) });
    }
    return;
  }

  if (!isTauri) {
    socket.emit(`tool:desktop_result:${correlationId}`, {
      error: 'Desktop tools are only available in the Tauri desktop app',
    });
    return;
  }

  try {
    // Dynamic import — @tauri-apps/api only exists in Tauri context
    const { invoke } = await import('@tauri-apps/api/core');
    let output: string;

    switch (name) {
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
      case 'desktop_open': {
        const target: string = args.target || '';
        if (!target.trim()) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No target provided to open' });
          return;
        }
        const openResult: { success: boolean; output: string } = await invoke('open_item', { target: target.trim() });
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
        if (!cmd.trim()) {
          socket.emit(`tool:desktop_result:${correlationId}`, { error: 'No command provided' });
          return;
        }
        const result: { success: boolean; output: string } = await invoke('run_command', { command: cmd, cwd: cwd.trim() || null });
        output = (result.success ? '' : '[FAILED] ') + result.output;
        break;
      }
      case 'desktop_active_window': {
        const info = await invoke('get_active_window_info');
        output = JSON.stringify(info, null, 2);
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
        const width: number = (capture as any).width || 1920;
        const height: number = (capture as any).height || 1080;
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
          output = JSON.stringify({ image_base64: jpegBase64, width, height, format: 'jpeg' });
        } catch {
          // Fallback: return full PNG base64 if canvas conversion fails
          output = JSON.stringify({ image_base64: pngBase64, width, height, format: 'png' });
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
        const allowedSources = new Set(['computer_use', 'self_intro_demo', 'customer_takeover_workflow', 'design_delivery_workflow']);
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

    socket.emit(`tool:desktop_result:${correlationId}`, { output });
  } catch (err: any) {
    socket.emit(`tool:desktop_result:${correlationId}`, { error: err.message || String(err) });
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

export function useSocket() {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const s = socketService.connect();
    registerSharedSocketHandlers(s);
    setSocket(s);
  }, []);

  return socket;
}
