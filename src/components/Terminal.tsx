import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { useSocket } from '@/hooks/useSocket';
import '@xterm/xterm/css/xterm.css';

interface TerminalWindowProps {
  t: (key: string) => string;
  onClose: () => void;
  isActive: boolean;
}

const xtermTheme = {
  background: '#05050ae0',
  foreground: '#d4d4d4',
  cursor: '#2ecc71',
  cursorAccent: '#05050a',
  selectionBackground: '#ffffff20',
  black: '#1a1a2e',
  red: '#e06c75',
  green: '#2ecc71',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#4a4a5e',
  brightRed: '#ff6b7b',
  brightGreen: '#3bec88',
  brightYellow: '#f9d689',
  brightBlue: '#7ec8ff',
  brightMagenta: '#da8cff',
  brightCyan: '#6ce0ee',
  brightWhite: '#f0f0f0',
};

export function TerminalWindow({ t: _t, onClose, isActive }: TerminalWindowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<ReturnType<typeof useSocket> | null>(null);

  const socket = useSocket();

  const handleResize = useCallback(() => {
    try { fitAddonRef.current?.fit(); } catch {}
  }, []);

  useEffect(() => {
    if (!containerRef.current || xtermRef.current || !socket) return;

    const term = new XTerm({
      theme: xtermTheme,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "SF Mono", Consolas, monospace',
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      allowTransparency: true,
      scrollback: 5000,
      tabStopWidth: 4,
      cols: 100,
      rows: 30,
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    // Try WebGL renderer for better performance
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
    } catch {
      // Fallback to canvas renderer (default)
    }

    term.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    socketRef.current = socket;

    // Create terminal session
    socket.emit('terminal:create');

    const onReady = () => {
      term.clear();
      term.focus();
      term.writeln('\x1b[1;32m┌─────────────────────────────────────────┐\x1b[0m');
      term.writeln('\x1b[1;32m│\x1b[0m  \x1b[1;36mLumiCore Terminal\x1b[0m                        \x1b[1;32m│\x1b[0m');
      term.writeln('\x1b[1;32m│\x1b[0m  Type \x1b[33m`exit`\x1b[0m to close this session          \x1b[1;32m│\x1b[0m');
      term.writeln('\x1b[1;32m└─────────────────────────────────────────┘\x1b[0m');
      term.writeln('');
    };

    const onOutput = (payload: { data: string }) => {
      term.write(payload.data);
    };

    const onExit = (payload: { code: number }) => {
      term.writeln(`\r\n\x1b[33m[Process exited with code ${payload.code}]\x1b[0m`);
      term.writeln('\x1b[33m[Press Enter or close this window]\x1b[0m');
    };

    socket.on('terminal:ready', onReady);
    socket.on('terminal:output', onOutput);
    socket.on('terminal:exit', onExit);

    // Send keystrokes to the shell
    const keyHandler = term.onData((data: string) => {
      socket.emit('terminal:input', { data });
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      socket.emit('terminal:resize', {
        cols: term.cols,
        rows: term.rows,
      });
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    // Slight delay to ensure render is complete
    setTimeout(() => {
      fitAddon.fit();
      socket.emit('terminal:resize', { cols: term.cols, rows: term.rows });
    }, 100);

    return () => {
      resizeObserver.disconnect();
      keyHandler.dispose();
      socket.emit('terminal:destroy');
      socket.off('terminal:ready', onReady);
      socket.off('terminal:output', onOutput);
      socket.off('terminal:exit', onExit);
      term.dispose();
      xtermRef.current = null;
    };
  }, [socket]);

  // Track active state — when window becomes active, focus the terminal
  useEffect(() => {
    if (isActive && xtermRef.current) {
      setTimeout(() => {
        xtermRef.current?.focus();
        handleResize();
      }, 50);
    }
  }, [isActive, handleResize]);

  // Handle window close
  const handleClose = useCallback(() => {
    if (xtermRef.current) {
      const socket = socketRef.current;
      if (socket) {
        socket.emit('terminal:destroy');
      }
    }
    onClose();
  }, [onClose]);

  // Listen for close signal from parent
  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.emit('terminal:destroy');
      }
    };
  }, []);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-white/5 bg-black/20 shrink-0">
        <span className="text-[12px] font-black tracking-[0.2em] uppercase text-white/40">Terminal</span>
        <div className="flex-1" />
        <button
          onClick={handleClose}
          className="text-[12px] font-bold text-white/55 hover:text-red-400 transition-colors uppercase tracking-widest"
        >
          Close (Ctrl+D)
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden" style={{ minHeight: 0 }} />
    </div>
  );
}
