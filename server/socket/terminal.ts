import { spawn, ChildProcess } from 'child_process';
import os from 'os';

interface TerminalSession {
  proc: ChildProcess;
  socketId: string;
  createdAt: number;
}

const sessions: Map<string, TerminalSession> = new Map();

function getShell(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    // Use PowerShell with UTF-8
    return { cmd: 'powershell.exe', args: [] };
  }
  // Unix — use $SHELL or fallback to bash
  const sh = process.env.SHELL || '/bin/bash';
  return { cmd: sh, args: ['--login'] };
}

function socketGuard(fn: (...args: any[]) => void | Promise<void>) {
  return (...args: any[]) => {
    try {
      const ret = fn(...args);
      if (ret && typeof (ret as any).catch === 'function') {
        (ret as any).catch((e: any) => console.error('[Terminal] Handler error:', e.message || String(e)));
      }
    } catch (e: any) {
      console.error('[Terminal] Handler error:', e.message || String(e));
    }
  };
}

export function registerTerminalHandlers(socket: any, _getUserId: (s: any) => string) {
  // This handler bypasses ToolRegistry and spawns an interactive host shell.
  // Keep the guard here as well as at the runtime registration call so a
  // future mount site cannot accidentally expose it to an ordinary web socket.
  if (socket.data?.trustedLocalExecution !== true) return;

  // Create a new terminal session
  socket.on('terminal:create', socketGuard(() => {
    const sessionId = socket.id;

    // Clean up existing session for this socket
    if (sessions.has(sessionId)) {
      try { sessions.get(sessionId)!.proc.kill(); } catch {}
      sessions.delete(sessionId);
    }

    const { cmd, args } = getShell();

    const proc = spawn(cmd, args, {
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const session: TerminalSession = {
      proc,
      socketId: sessionId,
      createdAt: Date.now(),
    };
    sessions.set(sessionId, session);

    proc.stdout?.on('data', (data: Buffer) => {
      socket.emit('terminal:output', { data: data.toString('utf-8') });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      socket.emit('terminal:output', { data: data.toString('utf-8') });
    });

    proc.on('exit', (code: number | null) => {
      socket.emit('terminal:exit', { code: code ?? -1 });
      sessions.delete(sessionId);
    });

    proc.on('error', (err: Error) => {
      socket.emit('terminal:output', { data: `\r\n\x1b[31mTerminal error: ${err.message}\x1b[0m\r\n` });
      sessions.delete(sessionId);
    });

    socket.emit('terminal:ready', { sessionId });
    console.log(`[Terminal] Session created for socket ${socket.id}, shell: ${cmd}`);
  }));

  // User input from xterm
  socket.on('terminal:input', socketGuard((payload: { data: string }) => {
    const session = sessions.get(socket.id);
    if (session && session.proc.stdin?.writable) {
      session.proc.stdin.write(payload.data);
    }
  }));

  // Resize pty
  socket.on('terminal:resize', socketGuard((payload: { cols: number; rows: number }) => {
    const session = sessions.get(socket.id);
    if (session) {
      if (process.platform === 'win32') {
        try {
          session.proc.stdin?.write(
            `$Host.UI.RawUI.WindowSize = New-Object System.Management.Automation.Host.Size(${payload.cols},${payload.rows}); ` +
            `$Host.UI.RawUI.BufferSize = New-Object System.Management.Automation.Host.Size(${payload.cols},${Math.max(payload.rows, 9000)})\r\n`
          );
        } catch {}
      } else {
        try {
          const stdin = (session.proc as any).stdin;
          if (stdin) {
            stdin.columns = payload.cols;
            stdin.rows = payload.rows;
          }
          session.proc.kill('SIGWINCH');
        } catch {}
      }
    }
  }));

  // Clean up on disconnect
  socket.on('terminal:destroy', socketGuard(() => {
    const session = sessions.get(socket.id);
    if (session) {
      try { session.proc.kill(); } catch {}
      sessions.delete(socket.id);
      console.log(`[Terminal] Session destroyed for socket ${socket.id}`);
    }
  }));

  socket.on('disconnect', socketGuard(() => {
    const session = sessions.get(socket.id);
    if (session) {
      try { session.proc.kill(); } catch {}
      sessions.delete(socket.id);
      console.log(`[Terminal] Cleaned up session for disconnected socket ${socket.id}`);
    }
  }));
}
