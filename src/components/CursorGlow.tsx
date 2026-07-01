import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface GlowPosition {
  x: number;
  y: number;
}

export function CursorGlow() {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<GlowPosition>({ x: 0, y: 0 });
  const [clicking, setClicking] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleShow = useCallback(() => setVisible(true), []);
  const handleHide = useCallback(() => setVisible(false), []);
  const handleUpdate = useCallback((e: Event) => {
    const { x, y } = (e as CustomEvent).detail as GlowPosition;
    setPos({ x, y });
  }, []);
  const handleClick = useCallback(() => {
    setClicking(true);
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => setClicking(false), 300);
  }, []);

  useEffect(() => {
    window.addEventListener('cursor-glow:show', handleShow);
    window.addEventListener('cursor-glow:hide', handleHide);
    window.addEventListener('cursor-glow:update', handleUpdate);
    window.addEventListener('cursor-glow:click', handleClick);
    return () => {
      window.removeEventListener('cursor-glow:show', handleShow);
      window.removeEventListener('cursor-glow:hide', handleHide);
      window.removeEventListener('cursor-glow:update', handleUpdate);
      window.removeEventListener('cursor-glow:click', handleClick);
    };
  }, [handleShow, handleHide, handleUpdate, handleClick]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{
            x: pos.x - 18,
            y: pos.y - 18,
            opacity: 1,
            scale: clicking ? 0.7 : 1,
          }}
          exit={{ opacity: 0, scale: 0.5 }}
          transition={{
            x: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
            y: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
            opacity: { duration: 0.25, ease: 'easeOut' },
            scale: { duration: 0.18, ease: [0.34, 1.56, 0.64, 1] },
          }}
          className="fixed pointer-events-none z-[99999]"
          style={{
            left: 0,
            top: 0,
            width: 36,
            height: 36,
          }}
        >
          {/* Outer halo */}
          <div
            className="absolute inset-0 rounded-full animate-pulse"
            style={{
              background:
                'radial-gradient(circle, rgba(240,168,48,0.25) 0%, rgba(240,168,48,0.08) 50%, transparent 70%)',
              boxShadow:
                '0 0 24px rgba(240,168,48,0.45), 0 0 48px rgba(240,168,48,0.18)',
            }}
          />
          {/* Ring */}
          <div
            className="absolute inset-1 rounded-full"
            style={{
              border: '2px solid rgba(240,168,48,0.75)',
              boxShadow:
                '0 0 8px rgba(240,168,48,0.5), inset 0 0 4px rgba(240,168,48,0.2)',
            }}
          />
          {/* Center dot */}
          <div
            className="absolute inset-[11px] rounded-full"
            style={{
              background: 'rgba(240,168,48,0.95)',
              boxShadow: '0 0 10px rgba(240,168,48,0.8)',
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
