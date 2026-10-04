import { RefreshCw, Minus, Minimize2, Maximize2, X } from "lucide-react";
import React, { useState, useEffect } from "react";
import { type ViewportSize, getDesktopChromeMetrics, resolveDesktopWindowBounds } from "@/lib/desktopLayout";
import { useDragControls, motion } from "motion/react";

export function LazyPanelFallback({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[180px] w-full items-center justify-center text-white/35">
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-black uppercase tracking-[0.16em]">
        <RefreshCw size={13} className="animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}


interface WindowProps {
  id: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClose: (id: string) => void;
  isActive: boolean;
  onFocus: (id: string) => void;
  onMinimize: (id: string) => void;
  onMinimizeComplete: (id: string) => void;
  isMinimized: boolean;
  t: any;
  colorClass?: string;
  width?: string | number;
  height?: string | number;
  zIndex?: number;
}


const getViewportSize = (): ViewportSize => {
  if (typeof window === 'undefined') return { width: 1280, height: 820 };
  const visualViewport = window.visualViewport;
  return {
    width: Math.min(window.innerWidth, visualViewport?.width ?? window.innerWidth),
    height: Math.min(window.innerHeight, visualViewport?.height ?? window.innerHeight),
  };
};


export function useViewportSize() {
  const [viewport, setViewport] = useState<ViewportSize>(() => getViewportSize());

  useEffect(() => {
    let frame = 0;
    const updateViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewport(getViewportSize()));
    };

    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
    };
  }, []);

  return viewport;
}


const parseWindowLength = (value: string | number | undefined, fallback: number) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};


export function OSWindow({
  id,
  title,
  icon,
  children,
  onClose,
  isActive,
  onFocus,
  onMinimize,
  onMinimizeComplete,
  isMinimized,
  t,
  colorClass = 'from-celestial-mars to-celestial-saturn',
  width = 'auto',
  height = 'auto',
  zIndex = 10,
}: WindowProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [snapZone, setSnapZone] = useState<'none' | 'left' | 'right'>('none');
  const [isDragging, setIsDragging] = useState(false);
  const dragControls = useDragControls();
  const constrainRef = React.useRef<HTMLDivElement>(null);
  const viewport = useViewportSize();

  const chrome = getDesktopChromeMetrics(viewport);
  const bounds = resolveDesktopWindowBounds(
    viewport,
    parseWindowLength(width, Math.min(900, chrome.availableWidth)),
    parseWindowLength(height, Math.min(700, chrome.availableHeight)),
    isMaximized ? 'maximized' : snapZone,
  );

  return (
    <>
      {/* Invisible drag boundary fills the viewport so windows can be dragged freely */}
      <div ref={constrainRef} className="fixed inset-0 pointer-events-none z-0" />
      <motion.div
        data-lumi-rendered-surface={isMinimized ? undefined : id}
        drag={!isMaximized && !isMinimized}
        dragListener={false}
        dragControls={dragControls}
        dragElastic={0.1}
        dragTransition={{ bounceStiffness: 400, bounceDamping: 25 }}
        dragConstraints={constrainRef}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={(_e, info) => {
          setIsDragging(false);
          if (info.point.x < bounds.safeInset + 80) setSnapZone('left');
          else if (info.point.x > viewport.width - bounds.safeInset - 80) setSnapZone('right');
          else setSnapZone('none');
        }}
        initial={{
          opacity: 0,
          scale: 0.92,
          y: 12,
          filter: 'blur(0px)',
          width: bounds.width,
          height: bounds.height,
          top: bounds.top,
          left: bounds.left,
          x: 0,
        }}
        animate={isMinimized
          ? { opacity: 0, scale: 0.3, y: 40, filter: 'blur(4px)', transition: { duration: 0.25, ease: [0.4, 0, 1, 1] } }
          : {
              opacity: 1,
              scale: 1,
              y: 0,
              filter: 'blur(0px)',
              width: bounds.width,
              height: bounds.height,
              top: bounds.top,
              left: bounds.left,
              x: 0,
              transition: { type: 'spring', stiffness: 300, damping: 26, mass: 0.8 },
            }
        }
        onAnimationComplete={() => {
          if (isMinimized) onMinimizeComplete(id);
        }}
        exit={{ opacity: 0, scale: 0.85, y: 20, filter: 'blur(4px)', transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
        style={{
          zIndex: isMinimized ? zIndex - 100 : zIndex,
          position: 'fixed',
          maxWidth: `calc(100vw - ${bounds.safeInset * 2}px)`,
          maxHeight: `${bounds.availableHeight}px`,
        }}
        onClick={() => !isMinimized && onFocus(id)}
        className={`os-window pointer-events-auto overflow-hidden ${isMaximized ? 'rounded-2xl' : 'rounded-3xl'} ${isActive ? 'ring-1 ring-white/15' : ''} ${isMinimized ? 'pointer-events-none' : ''} ${isDragging ? 'is-dragging' : ''}`}
      >
        <div
          className="os-window-header cursor-move"
          onPointerDown={(event) => {
            if (isMaximized || isMinimized) return;
            if ((event.target as HTMLElement).closest('button')) return;
            dragControls.start(event);
          }}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest('button')) return;
            setSnapZone('none');
            setIsMaximized(prev => !prev);
          }}
        >
          <div className="flex min-w-0 items-center gap-3 select-none">
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${colorClass} p-1.5 shadow-lg ring-1 ring-white/15 transition-transform`}>
              {React.isValidElement(icon)
                ? React.cloneElement(icon as React.ReactElement<any>, { size: 16, className: 'text-white' })
                : icon}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-black uppercase leading-none tracking-[0.16em] text-white/80">{title}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onMinimize(id); }}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
              title={t.minimize || 'Minimize'}
            >
              <Minus size={15} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSnapZone('none');
                setIsMaximized(prev => !prev);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
              title={isMaximized ? (t.restore || 'Restore') : (t.maximize || 'Maximize')}
            >
              {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(id); }}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-red-400/30 hover:bg-red-500/15 hover:text-red-100"
              title={t.close || 'Close'}
            >
              <X size={15} />
            </button>
          </div>
        </div>
        <div
          className="os-window-content bg-[#05050a]/98 backdrop-blur-3xl"
          style={isDragging ? { backdropFilter: 'none' } : undefined}
        >
          {children}
        </div>
      </motion.div>
    </>
  );
}
