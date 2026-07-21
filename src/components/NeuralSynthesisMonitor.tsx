import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { Cpu, BrainCircuit, Clock, Zap, Thermometer, Activity } from 'lucide-react';
import { GlassCard } from './SharedUI';
import { systemService, LiveStats } from '../services/systemService';
import { useApp } from '../contexts/AppContext';

const SPARKLINE_POINTS = 60;
const SYSTEM_POLL_MS = 2000;
const TOKEN_POLL_MS = 10000;
const LATENCY_POLL_MS = 5000;

interface TokenData {
  grandTotal: number;
  recordCount: number;
  byProvider: Record<string, { totalTokens: number; calls: number }>;
}

interface LatencyStats {
  llm: { avgMs: number; lastMs: number; count: number };
  tts: { avgMs: number; lastMs: number; count: number };
  stt: { avgMs: number; lastMs: number; count: number };
}

// ── helpers ──

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function latencyColor(ms: number) {
  if (ms <= 0) return 'text-white/45';
  if (ms < 500) return 'text-green-400';
  if (ms < 2000) return 'text-amber-400';
  return 'text-red-400';
}

function healthStatus(score: number): { label: string; color: string } {
  if (score >= 90) return { label: 'Excellent', color: 'text-green-400' };
  if (score >= 70) return { label: 'Good', color: 'text-lime-400' };
  if (score >= 50) return { label: 'Fair', color: 'text-amber-400' };
  if (score >= 30) return { label: 'Poor', color: 'text-orange-400' };
  return { label: 'Critical', color: 'text-red-400' };
}

// ── SVG Sparkline ──

function Sparkline({ data, width, height, color, label, value }: {
  data: number[]; width: number; height: number; color: string; label: string; value: string;
}) {
  if (data.length < 2) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-[12px] font-bold text-white/55 w-8 shrink-0">{label}</span>
        <div className="flex-1 h-[36px] bg-white/[0.03] rounded-lg animate-pulse" />
        <span className="text-xs font-mono text-white/45 w-14 text-right">{value}</span>
      </div>
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const h = height - 4;

  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / range) * h + 2).toFixed(1)}`).join(' ');
  const areaPts = `${pts} ${((data.length - 1) * stepX).toFixed(1)},${height} 0,${height}`;

  return (
    <div className="flex items-center gap-3">
      <span className="text-[12px] font-bold text-white/55 w-8 shrink-0">{label}</span>
      <svg width={width} height={height} className="shrink-0 overflow-visible">
        <polygon points={areaPts} fill={color} opacity={0.12} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-xs font-mono text-white/60 w-14 text-right">{value}</span>
    </div>
  );
}

// ── Main Component ──

export function NeuralSynthesisMonitor({ t, onOpenTokens }: { t?: any; onOpenTokens?: () => void }) {
  const { aiConfig } = useApp();
  const [liveStats, setLiveStats] = useState<LiveStats | null>(null);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [latency, setLatency] = useState<LatencyStats | null>(null);
  const prevTokenTotal = useRef<number>(0);
  const [tokenSpeed, setTokenSpeed] = useState<number>(0);

  // Ring buffers for sparklines
  const cpuHistory = useRef<number[]>([]);
  const memHistory = useRef<number[]>([]);
  const gpuHistory = useRef<number[]>([]);

  const pushSample = (buf: number[], v: number) => {
    buf.push(v);
    if (buf.length > SPARKLINE_POINTS) buf.shift();
  };

  // ── System stats polling ──

  useEffect(() => {
    const poll = async () => {
      const stats = await systemService.getLiveStats();
      setLiveStats(stats);
      pushSample(cpuHistory.current, stats.cpu_percent);
      pushSample(memHistory.current, stats.memory_percent);
      if (stats.gpu_utilization != null) {
        pushSample(gpuHistory.current, stats.gpu_utilization);
      }
    };
    poll();
    const id = setInterval(poll, SYSTEM_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // ── Token usage polling ──

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch('/api/llm/usage?days=1', { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        setTokenData(d);
        if (prevTokenTotal.current > 0 && d.grandTotal > prevTokenTotal.current) {
          setTokenSpeed((d.grandTotal - prevTokenTotal.current) / (TOKEN_POLL_MS / 1000));
        }
        prevTokenTotal.current = d.grandTotal;
      } catch {}
    };
    poll();
    const id = setInterval(poll, TOKEN_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // ── Latency polling ──

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch('/api/monitor/latency');
        if (!r.ok) return;
        setLatency(await r.json());
      } catch {}
    };
    poll();
    const id = setInterval(poll, LATENCY_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // ── Health score ──

  const healthScore = liveStats
    ? (() => {
        const cpu = liveStats.cpu_percent;
        const mem = liveStats.memory_percent;
        const maxTemp = liveStats.temperatures.length > 0
          ? Math.max(...liveStats.temperatures.map(t => t.celsius))
          : 0;
        let penalty: number;
        if (maxTemp > 0) {
          penalty = cpu * 0.4 + mem * 0.35 + Math.max(0, maxTemp - 50) * 1.0 * 0.25;
        } else {
          penalty = cpu * 0.5 + mem * 0.5;
        }
        return Math.max(0, Math.min(100, Math.round(100 - penalty)));
      })()
    : null;

  const health = healthScore != null ? healthStatus(healthScore) : null;

  // ── Format helpers ──

  const cpuFmt = liveStats ? `${Math.round(liveStats.cpu_percent)}%` : '--';
  const memFmt = liveStats
    ? `${Math.round(liveStats.memory_percent)}% (${liveStats.memory_used_gb.toFixed(1)}/${liveStats.memory_total_gb.toFixed(1)}G)`
    : '--';
  const gpuShort = liveStats?.gpu_vendor
    ? liveStats.gpu_vendor.replace(/NVIDIA GeForce /, '').replace(/AMD Radeon /, '').replace(/Intel /, '')
    : null;
  const gpuFmt = liveStats?.gpu_utilization != null ? `${Math.round(liveStats.gpu_utilization)}%` : (gpuShort || '--');
  const gpuLabel = 'GPU';

  const modelLabel = aiConfig ? `${aiConfig.provider}/${aiConfig.model}` : '--';
  const tokenSpeedFmt = tokenSpeed > 0 ? `${Math.round(tokenSpeed)} tok/s` : '--';
  const todayTokens = tokenData ? fmtTokens(tokenData.grandTotal) : '--';
  const callCount = tokenData ? tokenData.recordCount.toLocaleString() : '--';

  return (
    <GlassCard className="p-5 rounded-[2.5rem] space-y-5 border-white/5 bg-black/30 backdrop-blur-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-black uppercase tracking-widest text-white/55 flex items-center gap-2">
          <Activity size={12} /> {t?.neuralSynthesis || 'Neural Synthesis'}
        </h4>
        <div className="flex items-center gap-2">
          {health && (
            <span className={`text-[12px] font-bold ${health.color}`}>
              {healthScore}/{health.label}
            </span>
          )}
          <motion.div
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_10px_#22c55e]"
          />
        </div>
      </div>

      {/* Section 1: System Resources */}
      <div className="space-y-2">
        <h5 className="text-xs font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <Cpu size={10} /> System Resources
        </h5>
        <div className="space-y-1.5">
          <Sparkline data={cpuHistory.current} width={200} height={36} color="#22d3ee" label="CPU" value={cpuFmt} />
          <Sparkline data={memHistory.current} width={200} height={36} color="#f59e0b" label="MEM" value={memFmt} />
          <Sparkline data={gpuHistory.current} width={200} height={36} color="#a78bfa" label={gpuLabel} value={gpuFmt} />
        </div>
      </div>

      {/* Section 2: AI Inference */}
      <div className="space-y-2 cursor-pointer" onClick={onOpenTokens}>
        <h5 className="text-xs font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <BrainCircuit size={10} /> AI Inference
        </h5>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-white/45 font-medium mb-0.5">Model</div>
            <div className="text-xs font-mono text-white/60 truncate flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block shrink-0" />
              {modelLabel}
            </div>
          </div>
          <div>
            <div className="text-xs text-white/45 font-medium mb-0.5">Speed</div>
            <div className="text-xs font-mono text-white/50">{tokenSpeedFmt}</div>
          </div>
          <div>
            <div className="text-xs text-white/45 font-medium mb-0.5">Today</div>
            <div className="text-xs font-mono text-white/50">{todayTokens}</div>
          </div>
          <div>
            <div className="text-xs text-white/45 font-medium mb-0.5">Calls</div>
            <div className="text-xs font-mono text-white/50">{callCount}</div>
          </div>
        </div>
      </div>

      {/* Section 3: Latency */}
      <div className="space-y-2">
        <h5 className="text-xs font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <Clock size={10} /> Latency
        </h5>
        <div className="flex gap-3 text-[12px]">
          {(['llm', 'tts', 'stt'] as const).map(k => {
            const d = latency?.[k];
            return (
              <div key={k} className="flex-1">
                <div className="text-white/45 font-bold uppercase mb-0.5">{k.toUpperCase()}</div>
                <div className={`font-mono ${latencyColor(d?.lastMs ?? 0)}`}>
                  {d && d.lastMs > 0 ? `${d.lastMs}ms` : '--'}
                </div>
                <div className="text-xs text-white/40">
                  avg {d && d.avgMs > 0 ? `${d.avgMs}ms` : '--'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 4: Sensors + Health */}
      {liveStats && (
        <div className="space-y-2">
          <h5 className="text-xs font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
            <Thermometer size={10} /> Sensors
          </h5>
          <div className="flex items-center gap-2 flex-wrap">
            {liveStats.temperatures.length > 0 ? (
              liveStats.temperatures.slice(0, 4).map((t, i) => (
                <span key={i} className="text-[12px] font-mono px-2 py-0.5 rounded-full bg-white/5 text-white/50">
                  {t.label.slice(0, 12)} {Math.round(t.celsius)}°C
                </span>
              ))
            ) : (
              <span className="text-[12px] text-white/45">{t?.noSensorData || 'No sensor data'}</span>
            )}
            {liveStats.fan_speed_rpm != null && (
              <span className="text-[12px] font-mono px-2 py-0.5 rounded-full bg-white/5 text-white/50">
                Fan {liveStats.fan_speed_rpm}rpm
              </span>
            )}
            {health && (
              <span className={`text-[12px] font-bold ml-auto ${health.color}`}>
                {healthScore}/100
              </span>
            )}
          </div>
        </div>
      )}
    </GlassCard>
  );
}
