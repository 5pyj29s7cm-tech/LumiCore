import React, { useMemo } from 'react';
import { motion } from 'motion/react';
import { useT } from '../lib/useT';

export function GlobalNodeMap({ variant = 'default', nodeCount }: { variant?: 'default' | 'subtle'; nodeCount?: number }) {
  const t = useT();
  const resolvedNodeCount = nodeCount ?? (variant === 'subtle' ? 30 : 60);
  const dots = useMemo(() => {
    return [...Array(resolvedNodeCount)].map((_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 2 + 1,
      delay: Math.random() * 5,
      active: Math.random() > 0.7
    }));
  }, [resolvedNodeCount]);

  return (
    <div className={`w-full h-full transition-all duration-1000 ${
      variant === 'default' 
        ? 'aspect-[21/9] bg-black/40 rounded-[3.5rem] border border-white/5 relative overflow-hidden group' 
        : 'bg-transparent relative overflow-hidden opacity-30 select-none pointer-events-none'
    }`}>
      {/* Background Grid */}
      {variant === 'default' && (
        <div className="absolute inset-0 opacity-10 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:40px_40px]" />
      )}
      
      {/* World Map Outline SVG (Simplified) */}
      <div className={`absolute inset-0 p-12 transition-all ${variant === 'default' ? 'opacity-[0.03]' : 'opacity-[0.05]'}`}>
        <svg viewBox="0 0 1000 500" className="w-full h-full text-white fill-current">
          <path d="M150,150 Q200,100 250,150 T350,150 Q400,200 350,300 T250,350 Q200,400 150,350 T50,350 Q0,300 50,200 T150,150" />
          <path d="M600,100 Q700,50 800,100 T900,150 Q950,250 850,350 T700,400 Q600,450 550,350 T600,100" />
          <path d="M450,250 Q500,200 550,250 T600,350 Q550,450 450,400 T400,300 T450,250" />
        </svg>
      </div>

      <div className="absolute inset-0 p-12 overflow-hidden">
        {dots.map(dot => {
          const className = `absolute rounded-full ${dot.active ? 'bg-celestial-saturn shadow-[0_0_10px_#ffcc00]' : 'bg-white/10'}`;
          const style = {
            left: `${dot.x}%`,
            top: `${dot.y}%`,
            width: dot.size,
            height: dot.size,
          };
          if (variant === 'subtle') {
            return (
              <div
                key={dot.id}
                className={className}
                style={{ ...style, opacity: dot.active ? 0.35 : 0.16 }}
              />
            );
          }
          return (
            <motion.div
              key={dot.id}
              initial={{ opacity: 0.1 }}
              animate={{
                opacity: dot.active ? [0.2, 0.8, 0.2] : [0.1, 0.3, 0.1],
                scale: dot.active ? [1, 1.5, 1] : 1
              }}
              transition={{ duration: 3, repeat: Infinity, delay: dot.delay }}
              className={className}
              style={style}
            />
          );
        })}
        {/* Global Connection Pulses - Only in default */}
        {variant === 'default' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
             <motion.div 
               animate={{ 
                 scale: [1, 1.5, 1],
                 opacity: [0.1, 0, 0.1]
               }}
               transition={{ duration: 10, repeat: Infinity }}
               className="w-1/2 aspect-square border-2 border-celestial-saturn/20 rounded-full"
             />
          </div>
        )}
      </div>

      {variant === 'default' && (
        <>
          <div className="absolute top-8 left-8 space-y-1">
            <div className="text-xs font-black text-white/40 uppercase tracking-widest leading-none mb-1">{t.deviceMesh || 'Device Mesh'}</div>
            <div className="text-xl font-black text-white italic">{nodeCount ?? 1} {t.devicesOnline || 'DEVICE ONLINE'}</div>
          </div>

          <div className="absolute bottom-8 right-8 flex gap-4">
            <div className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-celestial-saturn animate-pulse" />
               <span className="text-xs font-black text-white/40 uppercase tracking-widest">{t.shardClusterAlpha || 'Shard Cluster Alpha'}</span>
            </div>
            <div className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
               <span className="text-xs font-black text-white/40 uppercase tracking-widest">{t.meshBridgeV4 || 'Mesh Bridge v4'}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
