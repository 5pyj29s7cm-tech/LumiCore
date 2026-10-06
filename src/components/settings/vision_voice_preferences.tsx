import { useState } from "react";
import { motion } from "motion/react";
import { ChevronDown, Camera } from "lucide-react";
import { useApp } from "@/contexts/AppContext";
import { uiMessage } from "../../i18n/uiMessages";
import { ModelSettingsStatus } from './model_operations';
import { SettingsSection, GenerationModelInput } from './components';
import { LUMI_OFFICIAL_PROVIDER_ID, lumiOfficialApiLabel, LumiOfficialCapabilityBadge } from './official_models';
import { WORLD_MODEL_OPTIONS } from './model_preferences';

export function VoicePreferenceToggle({ storageKey, label }: { storageKey: string; label: string }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(storageKey) === 'true');

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem(storageKey, String(next));
    window.dispatchEvent(new CustomEvent('lumi:setting-changed', {
      detail: { key: storageKey, value: next },
    }));
  };

  return (
    <button role="switch" aria-checked={enabled} aria-label={label}
      onClick={toggle}
      className={`w-11 h-6 rounded-full transition-all relative ${enabled ? 'bg-celestial-saturn' : 'bg-white/10 border border-white/20'}`}
    >
      <motion.div
        animate={{ x: enabled ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-md"
      />
    </button>
  );
}

export function VisionRoleSettings({ t }: { t: any }) {
  const { visionConfig, updateVisionConfig, reloadModelPreferences } = useApp();
  if (!visionConfig.ready) return <ModelSettingsStatus error={visionConfig.loadError} retry={() => void reloadModelPreferences('vision')} />;
  return (
    <SettingsSection title={uiMessage('settings.visual-perception-model.c74ca64c0f')} icon={<Camera size={18} className="text-cyan-300" />}>
      <div className="border-y border-white/10 py-5">
        <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">{t.primaryVisionModel || uiMessage('settings.screen-understanding-vision-control.a9be431876')}</span>
          <span className="relative">
            <select value={visionConfig.provider} onChange={(e) => updateVisionConfig({ provider: e.target.value })}
              className="w-full appearance-none rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/45">
              <option value="openai">OpenAI Vision</option>
              <option value="gemini">Google Gemini Vision</option>
              <option value="ark">Doubao Vision (Ark)</option>
              <option value="qwen">Qwen-VL (DashScope)</option>
              <option value="ollama">Ollama Local Vision</option>
              <option value="lmstudio">LM Studio Local Vision</option>
              <option value={LUMI_OFFICIAL_PROVIDER_ID}>{lumiOfficialApiLabel(t)} · Vision</option>
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/45" />
          </span>
        </label>
        <div className="mt-4">
          <GenerationModelInput
            id={`vision-role-${visionConfig.provider}`}
            label={uiMessage('settings.model.44c0cd4289')}
            value={visionConfig.model}
            options={WORLD_MODEL_OPTIONS[visionConfig.provider] || []}
            onChange={model => updateVisionConfig({ model })}
          />
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">{uiMessage('settings.effective-model.60bc31ba15')}</span>
          <span className="min-w-0 truncate rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-white/55">
            {visionConfig.provider} / {visionConfig.model}
          </span>
        </div>
        <LumiOfficialCapabilityBadge t={t} supported={true} capabilityKey="settings.capability-vision-world-actions.b8c9d0e1f2" />
      </div>
    </SettingsSection>
  );
}
