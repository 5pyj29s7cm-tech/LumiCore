import { Cpu, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { useApp } from "@/contexts/AppContext";
import { useLocalModelConfig } from "../../hooks/useLocalModelConfig";
import { uiMessage } from "../../i18n/uiMessages";
import { ModelSettingsStatus, useProviderModel } from './model_operations';
import { SettingsSection, SettingsDisclosure } from './components';

export function LocalProviderSettings({ t }: { t: any }) {
  const { aiConfig, reloadModelPreferences } = useApp();
  if (!aiConfig.ready) return <ModelSettingsStatus error={aiConfig.loadError} retry={() => void reloadModelPreferences('llm')} />;
  return (
    <SettingsSection title={uiMessage('settings.local-model-providers.8e1c4b6a20')}>
      <div className="border-y border-white/10">
        <LocalLLMProviderRow providerId="ollama" label="Ollama (Local AI)" defaultUrl="http://127.0.0.1:11434" defaultModel="qwen2.5:7b" accent="emerald" t={t} />
        <LocalLLMProviderRow providerId="lmstudio" label="LM Studio (Local AI)" defaultUrl="http://127.0.0.1:1234" defaultModel="local-model" accent="amber" t={t} />
      </div>
    </SettingsSection>
  );
}

export function LocalLLMProviderRow({
  providerId,
  label,
  defaultUrl,
  defaultModel,
  accent,
  t,
}: {
  providerId: 'ollama' | 'lmstudio';
  label: string;
  defaultUrl: string;
  defaultModel: string;
  accent: 'emerald' | 'amber';
  t?: any;
}) {
  const { aiConfig, updateAIConfig } = useApp();
  const { url: baseUrl, setUrl: setBaseUrl, detected, models: generationModels, checking, saved, error: configError, detect } = useLocalModelConfig(providerId, defaultUrl);
  const { model, changeModel: persistModel, testModel, resetTest, testState, testMessage } = useProviderModel(providerId, defaultModel, JSON.stringify([baseUrl, detected, checking]));
  const error = configError || (generationModels.length > 0 && model.trim() && !generationModels.includes(model.trim())
    ? `Selected model "${model.trim()}" is not currently loaded. The selection was preserved; load that exact model or choose another one explicitly.` : '');

  const handleDetect = () => { resetTest(); void detect(); };

  const handleUse = () => {
    if (!model.trim()) return;
    updateAIConfig({ provider: providerId, model: model.trim() });
  };

  const handleTest = () => { if (detected) void testModel(); };

  const accentClasses = accent === 'emerald'
    ? { icon: 'text-emerald-400', button: 'bg-emerald-600 hover:bg-emerald-500', focus: 'focus:border-emerald-400/50' }
    : { icon: 'text-amber-400', button: 'bg-amber-600 hover:bg-amber-500', focus: 'focus:border-amber-400/50' };

  return (
    <SettingsDisclosure
      icon={<Cpu size={18} className={accentClasses.icon} />}
      label={label}
      defaultOpen={aiConfig.provider === providerId}
      badges={<>
        {detected && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{uiMessage('settings.detected.6d745414bb')}</span>}
        {aiConfig.provider === providerId && <span className="rounded-full border border-celestial-saturn/20 bg-celestial-saturn/10 px-2 py-0.5 text-[11px] font-semibold text-celestial-saturn">{t?.activeBadge || uiMessage('settings.active.0aac32bf1d')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); resetTest(); }}
          onKeyDown={e => e.key === 'Enter' && handleDetect()}
          placeholder={defaultUrl}
          className={`h-11 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors ${accentClasses.focus}`}
        />
        <Button
          onClick={handleDetect}
          disabled={checking || !baseUrl.trim()}
          className={`h-11 rounded-lg px-4 text-xs font-semibold text-white transition-all disabled:opacity-30 ${accentClasses.button}`}
        >
          {checking ? <Loader2 size={16} className="animate-spin" /> : uiMessage('settings.detect.333c762fe5')}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)_auto_auto] sm:items-center">
        <label className="text-xs font-semibold text-white/50">{t?.model || uiMessage('settings.model.44c0cd4289')}</label>
        <input
          type="text"
          value={model}
          onChange={event => persistModel(event.target.value)}
          list={`local-llm-models-${providerId}`}
          placeholder={defaultModel}
          className={`h-10 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white outline-none ${accentClasses.focus}`}
        />
        <datalist id={`local-llm-models-${providerId}`}>
          {[...new Set([model, ...generationModels].filter(Boolean))].map(modelName => <option key={modelName} value={modelName} />)}
        </datalist>
        <Button onClick={handleUse} disabled={!detected || !model.trim() || !generationModels.includes(model.trim())} className="h-10 rounded-lg bg-celestial-saturn px-3 text-xs font-semibold text-black hover:bg-celestial-saturn/90 disabled:opacity-30">
          {uiMessage('settings.use.1ec0c92474')}
        </Button>
        <Button onClick={handleTest} disabled={!detected || !model.trim() || testState === 'testing'} className="h-10 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-30">
          {testState === 'testing' ? <Loader2 size={15} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
        </Button>
      </div>
      {detected && generationModels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {generationModels.map(modelName => (
            <button key={modelName} onClick={() => persistModel(modelName)} className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/60 hover:bg-white/10 hover:text-white font-mono">
              {modelName}
            </button>
          ))}
        </div>
      )}
      {error && !checking && <p className="text-xs text-amber-300/80">{error}</p>}
      {testMessage && <p className={`text-xs ${testState === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{testMessage}</p>}
      </div>
    </SettingsDisclosure>
  );
}
