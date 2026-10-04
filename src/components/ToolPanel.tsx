import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Wrench, AlertTriangle, CheckCircle, Loader2, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { apiJson } from '@/services/apiClient';

interface ToolInfo {
  name: string;
  description: string;
  permission: string;
  securityLevel: 'safe' | 'confirm' | 'forbidden';
}

const SECURITY_COLORS: Record<string, { bg: string; border: string; text: string; icon: React.ReactNode }> = {
  safe: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', icon: <CheckCircle size={10} /> },
  confirm: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400', icon: <AlertTriangle size={10} /> },
  forbidden: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400', icon: <EyeOff size={10} /> },
};

export function ToolPanel({ t }: { t?: any }) {
  const { toolOverrides, setToolOverride } = useApp();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const failureMessage = t?.failedToLoadTools || 'Failed to load tools';

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    apiJson<unknown>('/api/tools', { signal: controller.signal })
      .then(data => {
        if (!Array.isArray(data) || !data.every(tool => tool && typeof tool.name === 'string'
          && ['safe', 'confirm', 'forbidden'].includes(tool.securityLevel))) {
          throw new Error('Invalid tools response');
        }
        if (!controller.signal.aborted) setTools(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) { setFailed(true); toast.error(failureMessage); }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [failureMessage]);

  const safeTools = tools.filter(t => t.securityLevel === 'safe');
  const confirmTools = tools.filter(t => t.securityLevel === 'confirm');
  const forbiddenTools = tools.filter(t => t.securityLevel === 'forbidden');

  const isEnabled = (name: string) => {
    const override = toolOverrides[name];
    if (override) return override.enabled;
    return true; // enabled by default
  };

  const toggleTool = (name: string) => {
    const next = !isEnabled(name);
    setToolOverride(name, { enabled: next });
  };

  const sections = [
    { label: 'autoExecute', items: safeTools, color: 'emerald' },
    { label: 'requireConfirmation', items: confirmTools, color: 'amber' },
    { label: 'forbidden', items: forbiddenTools, color: 'red' },
  ];

  return (
    <div className="lumi-surface h-full flex flex-col text-white overflow-hidden">
      <div className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/20 bg-amber-500/15">
          <Wrench size={20} className="text-amber-400" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-white/90">{t?.toolControlPanel || 'Tool Control Panel'}</h2>
          <p className="text-xs text-white/55">
            {loading ? (t?.loading || 'Loading...') : `${tools.length} ${t?.toolsRegistered || 'tools registered'}`}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-5 md:p-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-white/55">
            <Loader2 size={24} className="animate-spin mr-2" /> {t?.loadingTools || 'Loading tools...'}
          </div>
        ) : failed ? (
          <p role="alert" className="lumi-panel px-4 py-3 text-sm text-red-300">{failureMessage}</p>
        ) : (
          sections.map(section => {
            return (
              <div key={section.label} className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full bg-${section.color}-500`} />
                  <span className="text-xs font-black uppercase text-white/55 tracking-wider">
                    {t?.[section.label] || section.label} ({section.items.length})
                  </span>
                </div>
                {section.items.length === 0 ? (
                  <p className="lumi-panel px-4 py-3 text-xs italic text-white/40">{t?.noToolsInCategory || 'No tools in this category'}</p>
                ) : (
                <div className="space-y-1">
                  {section.items.map(tool => {
                    const sec = SECURITY_COLORS[tool.securityLevel] || SECURITY_COLORS.confirm;
                    return (
                      <div
                        key={tool.name}
                        className={`flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all ${
                          isEnabled(tool.name)
                            ? 'bg-white/[0.04] border-white/[0.08] hover:bg-white/[0.07]'
                            : 'bg-white/[0.02] border-white/[0.04] opacity-45'
                        }`}
                      >
                        <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${sec.bg} ${sec.border} border flex items-center justify-center`}>
                          {sec.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-white/80 font-mono">{tool.name}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-md font-black uppercase border ${sec.bg} ${sec.border} ${sec.text}`}>
                              {tool.securityLevel}
                            </span>
                            <span className="text-xs text-white/45 uppercase">{tool.permission}</span>
                          </div>
                          <p className="text-xs text-white/55 mt-0.5 truncate">{tool.description}</p>
                        </div>
                        <button
                          onClick={() => toggleTool(tool.name)}
                          className={`flex-shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${
                            isEnabled(tool.name) ? 'bg-emerald-500/60' : 'bg-white/10'
                          }`}
                        >
                          <motion.div
                            animate={{ x: isEnabled(tool.name) ? 16 : 0 }}
                            className={`w-4 h-4 rounded-full ${isEnabled(tool.name) ? 'bg-white' : 'bg-white/30'}`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
