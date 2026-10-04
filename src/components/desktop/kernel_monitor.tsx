import { lazy, useState, useEffect, Suspense } from "react";
import { useApp } from "@/contexts/AppContext";
import { type SystemStats, systemService } from "@/services/systemService";
import { Cpu, Monitor } from "lucide-react";
import { uiMessage } from "../../i18n/uiMessages";
import { motion } from "motion/react";
import { LazyPanelFallback } from "./window_shell";
const SystemExplorer = lazy(() => import("../SystemExplorer").then(m => ({ default: m.SystemExplorer })));


export function KernelMonitorApp(props: Parameters<typeof KernelMonitorView>[0]) {
  const { user } = useApp();
  return user ? <KernelMonitorView key={JSON.stringify([user.uid, user.role])} {...props} /> : null;
}


function KernelMonitorView({ t, onAsk }: { t: any; onAsk?: (prompt: string) => void }) {
  const [{ stats, data, error }, setSnapshot] = useState<{ stats: SystemStats | null; data: number[]; error: string }>({ stats: null, data: [], error: '' });
  useEffect(() => {
    const owner = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await systemService.getSystemStats(AbortSignal.any([owner.signal, AbortSignal.timeout(10_000)]));
        if (!owner.signal.aborted) setSnapshot(current => ({ stats: next, data: [...(current.stats?.computerScope === next.computerScope && current.stats.hostname === next.hostname ? current.data : []), next.cpu].slice(-30), error: '' }));
      } catch (error: any) {
        if (!owner.signal.aborted) setSnapshot({ stats: null, data: [], error: error?.message || String(error) });
      } finally { if (!owner.signal.aborted) timer = setTimeout(refresh, 2000); }
    };
    void refresh();
    return () => { owner.abort(); clearTimeout(timer); };
  }, []);

  const chipLabel = stats?.cpuModel || (stats ? `${stats.platform.toUpperCase()}_${stats.arch.toUpperCase()}_NODE` : '');
  const uptimeFmt = stats ? `${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m` : '';
  const loadStatus = stats ? stats.cpu > 80 ? 'WARN' : stats.cpu > 50 ? 'LOAD' : 'IDLE' : '';

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-8 space-y-6 font-sans">
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {!stats && !error && <p role="status">{t.loading || 'Loading'}</p>}
      {stats && <>
      <div className="flex justify-between items-center bg-black/40 p-5 rounded-[2rem] border border-white/5 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-celestial-saturn/10 flex items-center justify-center text-celestial-saturn border border-celestial-saturn/20 shadow-[0_0_20px_rgba(255,200,80,0.1)]">
            <Cpu size={24} />
          </div>
          <div>
            <div className="text-xs font-black text-white/40 uppercase tracking-widest leading-none mb-1">{stats.hostname} · {stats.computerScope === 'lumi_server_host' ? uiMessage('system-explorer.lumi-server-host.88940fdc68') : (t.localIntelNode || 'Local Node')}</div>
            <div className="max-w-[min(50vw,38rem)] truncate text-lg font-black text-white tracking-tight" title={chipLabel}>{chipLabel}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs font-black text-celestial-saturn uppercase tracking-widest leading-none mb-1">{loadStatus} / {stats.physicalCpus || '?'} cores / {stats.logicalCpus} threads / {uptimeFmt}</div>
          <div className="text-xs font-mono text-white/40">{stats.release || ''} / CPU {stats.cpu}%</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          { label: t.neuralThroughput || 'CPU Load', value: `${stats.cpu}%`, bar: stats.cpu, color: 'bg-celestial-saturn' },
          { label: t.synapticLoad || 'Memory', value: `${stats.ram.used} / ${stats.ram.total} GB`, bar: stats.ram.percent, color: 'bg-emerald-500' },
          { label: 'GPU', value: stats.gpu?.name || (t.notDetected || 'Not detected'), bar: stats.gpu?.util || 0, color: 'bg-blue-500' }
        ].map((stat, i) => (
          <div key={i} className="p-5 bg-white/5 rounded-[2rem] border border-white/5 space-y-3 hover:bg-white/10 transition-colors cursor-default">
            <div className="text-[12px] font-black text-white/45 uppercase tracking-[0.2em]">{stat.label}</div>
            <div className="min-h-10 break-words text-base font-black text-white" title={String(stat.value)}>{stat.value}</div>
            <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${stat.bar}%` }} className={`h-full ${stat.color}`} />
            </div>
          </div>
        ))}
      </div>

      <div className="h-48 bg-black/40 rounded-[2.5rem] border border-white/5 p-6 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="w-full h-full" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '20px 20px' }} />
        </div>
        <div className="relative h-full flex items-end gap-1">
          {data.map((val, i) => (
            <motion.div
              key={i}
              initial={{ height: 0 }}
              animate={{ height: `${val}%` }}
              className="flex-1 bg-gradient-to-t from-celestial-saturn/40 to-celestial-saturn rounded-t-sm"
              style={{ minWidth: '4px' }}
            />
          ))}
        </div>
      </div>

      </>}
      <div className="rounded-[2rem] border border-white/5 bg-black/20 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Monitor size={16} className="text-cyan-300" />
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-white/70">{t.computerAdaptation || 'Computer Adaptation'}</h3>
            <p className="mt-1 text-xs text-white/35">{t.kernelExploreMergedDesc || 'Runtime monitor and computer exploration are merged into this single kernel view.'}</p>
          </div>
        </div>
        <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
          <SystemExplorer t={t} onAsk={onAsk} />
        </Suspense>
      </div>

    </div>
  );
}
