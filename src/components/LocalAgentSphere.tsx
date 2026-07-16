import React, { useState, useRef, useEffect } from 'react';

import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Sparkles, Volume2, Box, User as UserIcon, Pause, Wifi, WifiOff, Clock } from 'lucide-react';
import { Button } from './ui/button';

const DAYLIGHT_CORE_PALETTE = {
  ink: '#25313a',
  mineralBlue: '#2d5f88',
  warmCopper: '#b7792d',
  deepCopper: '#8f5a24',
  jadeInk: '#326f63',
};

function daylightParticleColor(color: string) {
  if (color === '#ffffff') return DAYLIGHT_CORE_PALETTE.mineralBlue;
  if (color === '#ff4d4d') return DAYLIGHT_CORE_PALETTE.warmCopper;
  if (color === '#ffcc00') return DAYLIGHT_CORE_PALETTE.deepCopper;
  if (color.startsWith('hsl')) return DAYLIGHT_CORE_PALETTE.jadeInk;
  return color;
}

function daylightVoidColor(x: number, y: number, z: number) {
  const phase = Math.sin((x + y + z) * 0.045);
  return phase > 0.34
    ? DAYLIGHT_CORE_PALETTE.mineralBlue
    : phase < -0.34
      ? DAYLIGHT_CORE_PALETTE.warmCopper
      : DAYLIGHT_CORE_PALETTE.ink;
}

export function LocalAgentSphere({
  t,
  onMessage,
  sentiment = 'default',
  callState = 'idle',
  audioLevel = 0,
  isMuted = false,
  elapsedSeconds = 0,
  connectionQuality = 'good',
  highPerformance = false,
  isWallpaperMode = false,
  onStartCall,
  onEndCall,
  onInterrupt,
  onToggleMute,
  reaction,
  facePresent = false,
  gesturesDisabled = false,
  isLightMode = false,
}: {
  t: any;
  onMessage?: (text: string) => void;
  sentiment?: 'default' | 'excited' | 'focused' | 'zen';
  callState?: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'queued' | 'passive';
  audioLevel?: number;
  isMuted?: boolean;
  elapsedSeconds?: number;
  connectionQuality?: 'good' | 'fair' | 'poor';
  highPerformance?: boolean;
  isWallpaperMode?: boolean;
  onStartCall?: () => void;
  onEndCall?: () => void;
  onInterrupt?: () => void;
  onToggleMute?: () => void;
  reaction?: string | null;
  facePresent?: boolean;
  gesturesDisabled?: boolean;
  isLightMode?: boolean;
}) {
  const [interactionPulse, setInteractionPulse] = useState(0);
  const [reactionColor, setReactionColor] = useState('rgba(255,200,80,0.2)');

  useEffect(() => {
    if (reaction) {
      setInteractionPulse(p => p + 1);
      if (isLightMode) {
        setReactionColor(
          reaction === 'failed' ? 'rgba(143,90,36,0.22)' :
          reaction === 'jump' ? 'rgba(50,111,99,0.20)' :
          'rgba(183,121,45,0.18)'
        );
      } else {
        setReactionColor(
          reaction === 'failed' ? 'rgba(255,60,60,0.25)' :
          reaction === 'jump' ? 'rgba(80,255,120,0.2)' :
          'rgba(255,200,80,0.2)'
        );
      }
    }
  }, [isLightMode, reaction]);

  const [spatialMode, setSpatialMode] = useState<'geometric' | 'humanoid'>('geometric');
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: 0, y: 0, isDown: false });
  const rotationRef = useRef({ x: 0, y: 0 });
  const particleCount = highPerformance ? 2200 : 800;

  // Shared particle array (both canvases read from it)
  const particlesRef = useRef<any[]>([]);

  // Gesture refs (synced to latest props)
  const facePresentRef = useRef(false);
  const callStateRef = useRef(callState);
  const sentimentRef = useRef(sentiment);
  const audioLevelRef = useRef(audioLevel);
  const highPerfRef = useRef(highPerformance);
  const lightModeRef = useRef(isLightMode);
  useEffect(() => { lightModeRef.current = isLightMode; }, [isLightMode]);

  useEffect(() => { facePresentRef.current = facePresent; }, [facePresent]);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { sentimentRef.current = sentiment; }, [sentiment]);
  useEffect(() => { audioLevelRef.current = audioLevel; }, [audioLevel]);
  useEffect(() => {
    const onAudioLevel = (event: Event) => {
      const level = Number((event as CustomEvent<{ level?: number }>).detail?.level);
      if (Number.isFinite(level)) audioLevelRef.current = level;
    };
    window.addEventListener('lumi:voice-audio-level', onAudioLevel);
    return () => window.removeEventListener('lumi:voice-audio-level', onAudioLevel);
  }, []);
  useEffect(() => { highPerfRef.current = highPerformance; }, [highPerformance]);
  const disabledRef = useRef(gesturesDisabled);
  useEffect(() => { disabledRef.current = gesturesDisabled; }, [gesturesDisabled]);

  const handleSphereClick = () => setInteractionPulse(prev => prev + 1);

  // Particle class — shared between both canvases
  const sphereRadius = 180;

  class OrbParticle {
    x: number; y: number; z: number;
    baseX: number; baseY: number; baseZ: number;
    color: string; size: number; type: 'signal' | 'core' | 'void';

    constructor(mode: 'geometric' | 'humanoid') {
      if (mode === 'humanoid') {
        const rand = Math.random();
        if (rand < 0.2) {
          const u = Math.random(), v = Math.random();
          const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
          const r = Math.pow(Math.random(), 1/3) * 40;
          this.baseX = r * Math.sin(phi) * Math.cos(theta);
          this.baseY = r * Math.sin(phi) * Math.sin(theta) - 140;
          this.baseZ = r * Math.cos(phi);
        } else if (rand < 0.7) {
          this.baseX = (Math.random() - 0.5) * 80;
          this.baseY = (Math.random() - 0.5) * 120 - 40;
          this.baseZ = (Math.random() - 0.5) * 40;
        } else {
          this.baseX = (Math.random() - 0.5) * 140;
          this.baseY = (Math.random() - 0.5) * 180 + 40;
          this.baseZ = (Math.random() - 0.5) * 20;
        }
      } else {
        const u = Math.random(), v = Math.random();
        const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
        const r = Math.pow(Math.random(), 1/3) * sphereRadius;
        this.baseX = r * Math.sin(phi) * Math.cos(theta);
        this.baseY = r * Math.sin(phi) * Math.sin(theta);
        this.baseZ = r * Math.cos(phi);
      }
      this.x = this.baseX; this.y = this.baseY; this.z = this.baseZ;
      const rand = Math.random();
      if (rand < 0.4) {
        this.type = 'signal';
        this.color = '#ff4d4d';
      } else if (rand < 0.8) {
        this.type = 'core'; this.color = '#ffffff';
      } else {
        this.type = 'void'; this.color = '#000000';
      }
      this.size = Math.random() * 1.5 + 0.5;
    }

    update(time: number, rotX: number, rotY: number, currentCallState: string, currentAudioLevel: number, sphereScale: number) {
      if (this.type === 'signal') {
        if (sphereScale > 1.8) {
          const hue = (Math.sin(time * 0.0005 + this.baseX * 0.03) * 30 + 195);
          this.color = `hsl(${hue}, 90%, 65%)`;
        } else {
          this.color = currentCallState === 'listening' ? '#ffcc00' : currentCallState === 'speaking' ? '#ffffff' : '#ff4d4d';
        }
      }
      const audioWave = currentAudioLevel * 50;
      const wave = Math.sin(time * 0.002 + (this.baseX + this.baseY + this.baseZ) * 0.01) * (15 + audioWave);
      const radialUnit = Math.sqrt(this.baseX ** 2 + this.baseY ** 2 + this.baseZ ** 2) + 0.001;
      const effectiveR = radialUnit * sphereScale + wave;
      const rFactor = effectiveR / radialUnit;
      let tx = this.baseX * rFactor;
      let ty = this.baseY * rFactor;
      let tz = this.baseZ * rFactor;
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const y1 = ty * cosX - tz * sinX;
      const z1 = ty * sinX + tz * cosX;
      ty = y1; tz = z1;
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const x2 = tx * cosY + tz * sinY;
      const z2 = -tx * sinY + tz * cosY;
      tx = x2; tz = z2;
      this.x = tx; this.y = ty; this.z = tz;
    }

    drawLocal(ctx: CanvasRenderingContext2D, cx: number, cy: number, isDispersed: boolean) {
      const pz = Math.max(-300, Math.min(this.z, 590));
      const perspective = 600 / (600 - pz);
      const x = this.x * perspective + cx;
      const y = this.y * perspective + cy;
      const lm = lightModeRef.current;
      const size = this.size * perspective;
      const drawSize = lm ? size * 1.16 : size;
      if (this.color === '#000000') {
        if (lm) {
          const c = daylightVoidColor(this.baseX, this.baseY, this.baseZ);
          ctx.fillStyle = c;
          ctx.shadowColor = c;
          ctx.shadowBlur = 2.5;
          ctx.globalAlpha = Math.max(0.26, perspective - 0.30);
          ctx.beginPath(); ctx.arc(x, y, drawSize, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.2)';
          ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.arc(x, y, drawSize, 0, Math.PI * 2); ctx.stroke();
        }
      } else {
        let c = this.color;
        if (lm) {
          c = daylightParticleColor(c);
          ctx.shadowColor = c;
          ctx.shadowBlur = 2.5;
        }
        ctx.fillStyle = c;
        ctx.globalAlpha = Math.max(lm ? 0.30 : 0.1, perspective - (lm ? 0.30 : 0.4));
        ctx.beginPath(); ctx.arc(x, y, drawSize, 0, Math.PI * 2); ctx.fill();
        if (lm) ctx.shadowBlur = 0;
        if (isDispersed && this.type === 'signal') {
          ctx.globalAlpha = Math.max(0.03, (perspective - 0.4) * 0.3);
          ctx.beginPath(); ctx.arc(x, y, drawSize * 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    drawPortal(ctx: CanvasRenderingContext2D, screenCx: number, screenCy: number, scale: number) {
      const pz = Math.max(-300, Math.min(this.z, 590));
      const perspective = 600 / (600 - pz);
      const dx = this.x * perspective;
      const dy = this.y * perspective;
      const sx = screenCx + dx * scale;
      const sy = screenCy + dy * scale;
      const size = this.size * perspective * scale;
      if (size < 0.3) return;
      if (this.color === '#000000') {
        if (lightModeRef.current) {
          const c = daylightVoidColor(this.baseX, this.baseY, this.baseZ);
          ctx.fillStyle = c;
          ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.15)';
          ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.stroke();
        }
      } else {
        let c = this.color;
        if (lightModeRef.current) {
          c = daylightParticleColor(c);
        }
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // Initialize particles when spatialMode changes
  useEffect(() => {
    const ptcls: OrbParticle[] = [];
    for (let i = 0; i < particleCount; i++) ptcls.push(new OrbParticle(spatialMode));
    particlesRef.current = ptcls;
  }, [spatialMode, particleCount]);

  // === Unified rAF loop: updates particles once, renders to BOTH canvases ===
  useEffect(() => {
    const mainCanvas = mainCanvasRef.current;
    if (!mainCanvas) return;
    const mainCtx = mainCanvas.getContext('2d');
    if (!mainCtx) return;

    let animId: number;
    const sphereScaleRef = { current: 1 };

    const render = (time: number) => {
      try {
        // ---- Update & render main canvas ----
        mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
        const centerX = mainCanvas.width / 2;
        const centerY = mainCanvas.height / 2;

        const currentCallState = callStateRef.current;
        const isCallActive = currentCallState !== 'idle';

        // Sphere scale
        sphereScaleRef.current += (1 - sphereScaleRef.current) * 0.05;
        const sphereScale = sphereScaleRef.current;

        // Rotation: auto-rotate
        if (!mouseRef.current.isDown) {
          const speedFactor = currentCallState === 'thinking' ? 4 : sentimentRef.current === 'excited' ? 3 : sentimentRef.current === 'focused' ? 2 : sentimentRef.current === 'zen' ? 0.5 : 1;
          rotationRef.current.y += 0.005 * speedFactor;
          rotationRef.current.x += 0.002 * speedFactor;
        }

        const pts = particlesRef.current;
        if (pts.length === 0) { animId = requestAnimationFrame(render); return; }

        // Face present glow — warm breathing pulse around orb
        if (facePresentRef.current) {
          const pulse = 0.06 + Math.sin(time * 0.003) * 0.02;
          const glow = mainCtx.createRadialGradient(centerX, centerY, 100, centerX, centerY, 260);
          if (lightModeRef.current) {
            glow.addColorStop(0, `rgba(45,95,136,${(pulse * 0.58).toFixed(3)})`);
            glow.addColorStop(0.5, `rgba(183,121,45,${(pulse * 0.28).toFixed(3)})`);
            glow.addColorStop(1, 'rgba(45,95,136,0)');
          } else {
            glow.addColorStop(0, `rgba(255,200,100,${pulse.toFixed(3)})`);
            glow.addColorStop(0.5, `rgba(255,180,60,${(pulse * 0.5).toFixed(3)})`);
            glow.addColorStop(1, 'rgba(255,150,30,0)');
          }
          mainCtx.fillStyle = glow;
          mainCtx.fillRect(centerX - 260, centerY - 260, 520, 520);
        }

        // Update particles
        for (const p of pts) {
          p.update(time, rotationRef.current.x, rotationRef.current.y, currentCallState, audioLevelRef.current, sphereScale);
        }

        // Sort for proper z-ordering
        pts.sort((a, b) => a.z - b.z);

        // Draw particles on main canvas
        for (const p of pts) {
          p.drawLocal(mainCtx, centerX, centerY, false);
        }
        mainCtx.globalAlpha = 1;
      } catch (e) {
        // never let an exception kill the render loop
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, []);

  // Mouse/touch handlers
  const handleMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
    mouseRef.current.isDown = true;
    const pos = 'touches' in e ? e.touches[0] : e;
    mouseRef.current.x = pos.clientX;
    mouseRef.current.y = pos.clientY;
  };
  const handleMouseMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!mouseRef.current.isDown) return;
    const pos = 'touches' in e ? e.touches[0] : e;
    const dx = pos.clientX - mouseRef.current.x;
    const dy = pos.clientY - mouseRef.current.y;
    rotationRef.current.y += dx * 0.01;
    rotationRef.current.x -= dy * 0.01;
    mouseRef.current.x = pos.clientX;
    mouseRef.current.y = pos.clientY;
  };
  const handleMouseUp = () => { mouseRef.current.isDown = false; };

  return (
    <>
      <div className={`relative w-full flex flex-col items-center justify-center py-20 transition-all duration-1000 ${isWallpaperMode ? 'opacity-40 scale-[0.8] blur-[1px]' : 'opacity-100 scale-100'}`}>
        <div className="absolute inset-0 pointer-events-none" />

        <div
          ref={containerRef}
          className="relative w-80 h-80 md:w-[500px] md:h-[500px] flex items-center justify-center cursor-grab active:cursor-grabbing group"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleMouseDown}
          onTouchMove={handleMouseMove}
          onTouchEnd={handleMouseUp}
          onClick={handleSphereClick}
        >

          <canvas
            ref={mainCanvasRef}
            width={600}
            height={600}
            className="relative z-10 pointer-events-none"
            style={{ width: '100%', height: '100%' }}
          />

          <AnimatePresence>
            {[...Array(2)].map((_, i) => (
              <motion.div
                key={`${interactionPulse}-${i}`}
                className="absolute inset-0 rounded-full border pointer-events-none will-change-transform"
                style={{ borderColor: reactionColor }}
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1.5, opacity: 0 }}
                transition={{ duration: 1.5, delay: i * 0.3 }}
              />
            ))}
          </AnimatePresence>

        </div>

        {/* Controls */}
        <div className="mt-12 flex flex-col items-center gap-6 z-10">
          <div className="flex items-center gap-3">
            {callState !== 'idle' && onToggleMute && (
              <Button
                onClick={onToggleMute}
                className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300 ${
                  isMuted ? 'bg-amber-500 text-black' : 'bg-white/10 text-white/60 hover:bg-white/20'
                }`}
                title={isMuted ? (t.voiceUnmuted || 'Unmute') : (t.voiceMuted || 'Mute')}
              >
                {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
              </Button>
            )}

            <Button
              onClick={callState === 'idle' ? onStartCall : onEndCall}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500 ${
                callState !== 'idle'
                  ? 'bg-red-500 text-white shadow-[0_0_30px_rgba(239,68,68,0.5)] scale-110'
                  : 'bg-white/5 text-white/60 hover:bg-white/10'
              }`}
            >
              {callState !== 'idle' ? <Mic size={24} className="animate-pulse" /> : <MicOff size={24} />}
            </Button>

            {(callState === 'speaking' || callState === 'thinking') && onInterrupt && (
              <Button
                onClick={onInterrupt}
                className="w-10 h-10 rounded-full bg-white/10 text-white/60 hover:bg-white/20 flex items-center justify-center transition-all duration-300"
                title={t.voiceInterrupt || "Interrupt"}
              >
                <Pause size={18} />
              </Button>
            )}

            <div className="flex flex-col">
              <span className="text-xs font-bold uppercase tracking-widest text-white/40">
                {callState === 'listening' ? t.listening : callState === 'thinking' ? t.processing : callState === 'speaking' ? t.speaking : callState === 'idle' ? t.voiceInteract : callState === 'passive' ? (t.passive || 'Passive') : callState.toUpperCase()}
              </span>
              <span className="text-sm font-medium text-white/80">
                {callState === 'idle' ? (t.clickToStartSession || "Click to start voice session") : (t.sessionActiveClickToEnd || "Session active - Click to end")}
              </span>
              {callState !== 'idle' && (
                <div className="flex items-center gap-2 mt-1">
                  <Clock size={10} className="text-white/40" />
                  <span className="text-xs text-white/40 tabular-nums">
                    {String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')}
                  </span>
                  {connectionQuality === 'good' && <Wifi size={10} className="text-emerald-400" />}
                  {connectionQuality === 'fair' && <Wifi size={10} className="text-amber-400" />}
                  {connectionQuality === 'poor' && <WifiOff size={10} className="text-red-400" />}
                </div>
              )}
            </div>
          </div>

          <AnimatePresence>
            {callState !== 'idle' && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="flex gap-1"
              >
                {[...Array(5)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="w-1 bg-red-500 rounded-full"
                    style={{ height: 30 }}
                    animate={{
                      scaleY: callState === 'listening' ? [0.33, 1, 0.33] : [0.33, 0.5, 0.33],
                    }}
                    transition={{
                      duration: 0.5,
                      repeat: Infinity,
                      delay: i * 0.1,
                    }}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
