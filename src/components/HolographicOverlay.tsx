import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import {
  isAgentResponseBlocked,
  isUnverifiedActionClaim,
  type AgentResponseDelivery,
} from '@/lib/agentResponseDelivery';

interface HoloPosition { x: number; y: number; z: number }
interface HoloAnimation { type: string; durationMs: number; easing: string }

interface HoloElement {
  type: 'text' | 'mesh' | 'point_cloud' | 'ui_panel';
  text?: string;
  markdown?: string;
  modelUri?: string;
  points?: [number, number, number][];
  position: HoloPosition;
  fontSize?: number;
  color?: [number, number, number, number];
  pointSize?: number;
  size?: { width: number; height: number };
  actions?: { id: string; label: string; event: string }[];
  animation: HoloAnimation;
}

interface HoloOutput {
  contentType: 'holographic';
  content: HoloElement[];
  timing: 'immediate' | number;
  ttl: number;
}

interface HoloItem extends HoloOutput {
  _id: string;
  _receivedAt: number;
}

export function HolographicOverlay({ socket }: { socket: any }) {
  const [items, setItems] = useState<HoloItem[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!socket) return;

    const onResponse = (data: AgentResponseDelivery & { agentName?: string; holographic?: HoloOutput }) => {
      if (isAgentResponseBlocked(data) || isUnverifiedActionClaim(data)) return;
      if (data.holographic && data.holographic.contentType === 'holographic') {
        const item: HoloItem = {
          ...data.holographic,
          _id: `holo_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          _receivedAt: Date.now(),
        };
        setItems(prev => [...prev.slice(-4), item]);

        if (item.ttl > 0) {
          setTimeout(() => {
            setItems(prev => prev.filter(i => i._id !== item._id));
          }, item.ttl);
        }
      }
    };

    socket.on('agent:response', onResponse);
    return () => { socket.off('agent:response', onResponse); };
  }, [socket]);

  const dismiss = (id: string) => {
    setItems(prev => prev.filter(i => i._id !== id));
  };

  const mapPosition = (pos: HoloPosition) => {
    // Map 3D coordinates (-1..1 range typical) to screen percentage
    const x = 50 + pos.x * 30;
    const y = 50 - pos.y * 30;
    const scale = Math.max(0.4, 1 + pos.z * 0.3);
    return { left: `${x}%`, top: `${y}%`, transform: `translate(-50%, -50%) scale(${scale})` };
  };

  const getAnimProps = (anim: HoloAnimation) => {
    const dur = anim.durationMs / 1000;
    return {
      initial: { opacity: 0, y: 20 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -20 },
      transition: { duration: dur, ease: anim.easing.replace(/_/g, '-') as any },
    };
  };

  return (
    <div ref={containerRef} className="fixed inset-0 z-[200] pointer-events-none overflow-hidden">
      <AnimatePresence>
        {items.map(item => (
          <React.Fragment key={item._id}>
            {item.content.map((el, i) => {
              const pos = mapPosition(el.position);
              const anim = getAnimProps(el.animation);
              const rgba = el.color
                ? `rgba(${Math.round(el.color[0] * 255)}, ${Math.round(el.color[1] * 255)}, ${Math.round(el.color[2] * 255)}, ${el.color[3]})`
                : 'rgba(255, 220, 100, 0.85)';

              if (el.type === 'text') {
                return (
                  <motion.div
                    key={`${item._id}_${i}`}
                    {...anim}
                    className="absolute pointer-events-auto"
                    style={{
                      ...pos,
                      color: rgba,
                      fontSize: `${(el.fontSize || 24) * (1 + el.position.z * 0.15)}px`,
                      textShadow: `0 0 20px ${rgba}, 0 0 60px ${rgba.replace('0.85', '0.3')}`,
                      fontWeight: 900,
                      letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                      zIndex: Math.round(100 - el.position.z * 10),
                    }}
                  >
                    {el.text}
                  </motion.div>
                );
              }

              if (el.type === 'ui_panel') {
                return (
                  <motion.div
                    key={`${item._id}_${i}`}
                    {...anim}
                    className="absolute pointer-events-auto"
                    style={{
                      ...pos,
                      zIndex: Math.round(100 - el.position.z * 10),
                    }}
                  >
                    <div
                      className="backdrop-blur-2xl rounded-2xl border border-white/10 p-6 shadow-2xl"
                      style={{
                        width: (el.size?.width || 320) * (1 + el.position.z * 0.1),
                        height: (el.size?.height || 200) * (1 + el.position.z * 0.1),
                        background: 'linear-gradient(135deg, rgba(20,10,40,0.85), rgba(0,0,0,0.75))',
                        borderColor: rgba,
                        boxShadow: `0 0 40px ${rgba.replace('0.85', '0.15')}, inset 0 0 20px ${rgba.replace('0.85', '0.05')}`,
                      }}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-black uppercase tracking-[0.3em] text-white/55">
                          Lumi Holographic
                        </span>
                        <button
                          onClick={() => dismiss(item._id)}
                          className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-white/10 transition-all"
                        >
                          <X size={10} className="text-white/40" />
                        </button>
                      </div>
                      <div
                        className="text-xs text-white/80 font-medium leading-relaxed overflow-y-auto max-h-[80%] custom-scrollbar"
                        style={{ whiteSpace: 'pre-wrap' }}
                      >
                        {el.markdown || ''}
                      </div>
                      {el.actions && el.actions.length > 0 && (
                        <div className="flex gap-2 mt-3">
                          {el.actions.map(action => (
                            <button
                              key={action.id}
                              onClick={() => socket?.emit(action.event, { actionId: action.id })}
                              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-bold text-white/80 transition-all border border-white/10"
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              }

              return null;
            })}
          </React.Fragment>
        ))}
      </AnimatePresence>
    </div>
  );
}
