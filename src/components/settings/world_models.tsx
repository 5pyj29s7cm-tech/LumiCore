import { useEffect } from "react";
import { Globe, Zap, Loader2, Save } from "lucide-react";
import { Button } from "../ui/button";
import { useApp } from "@/contexts/AppContext";
import { useLumiOfficialCatalog } from "../../hooks/useLumiOfficialCatalog";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { useModelSettings, runModelConnectionTest, ModelSettingsStatus } from './model_operations';
import type { WorldPreference } from './model_preferences';
import { WORLD_MODEL_OPTIONS } from './model_preferences';
import { LUMI_OFFICIAL_PROVIDER_ID, officialModelOptions, lumiOfficialApiLabel, LumiOfficialCapabilityBadge } from './official_models';
import { SettingsSection, GenerationModelInput } from './components';
import { VisionRoleSettings } from './vision_voice_preferences';

export function WorldActionModelPage({ t }: { t: any }) {
  const { visionConfig, reloadModelPreferences } = useApp();
  const { value: preference, edit: setPreference, ready, error, reload, persist, operation } = useModelSettings<WorldPreference>('/api/preferences/world', { provider: 'inherit_vision', model: '', models: {} }, 'settings.failed-to-load-world-model.3111ba80e6');
  const { saving, testing, busy, message: testMessage, reset } = operation;
  const officialCatalog = useLumiOfficialCatalog();
  const inherited = preference.provider === 'inherit_vision';
  const activeProvider = inherited ? visionConfig.provider : preference.provider;
  const activeModel = inherited ? visionConfig.model : preference.model;
  useEffect(reset, [activeProvider, activeModel, reset]);

  const setProvider = (provider: string) => {
    setPreference(previous => ({
      ...previous,
      provider,
      model: provider === 'inherit_vision' ? '' : previous.models[provider] || WORLD_MODEL_OPTIONS[provider]?.[0] || '',
    }));
  };

  const setModel = (model: string) => {
    setPreference(previous => ({
      ...previous,
      model,
      models: { ...previous.models, [previous.provider]: model },
    }));
  };

  const save = () => operation.run('saving', async signal => {
    await persist(signal);
    return uiMessage('settings.world-model-saved.c98e892ead');
  }, 'settings.failed-to-save-world-model.5d460901d9');

  const test = () => activeProvider && activeModel && operation.run('testing', async signal => {
    const result = await runModelConnectionTest('vision', activeProvider, activeModel, signal);
    return formatUiMessage('settings.world-model-call-passed-value0-ms.386cfeaf91', { value0: result.latencyMs });
  }, 'settings.world-model-call-failed.814cb05bd8');

  if (!ready) return <ModelSettingsStatus error={error} retry={reload} />;

  if (inherited && visionConfig.ready === false) return <ModelSettingsStatus error={visionConfig.loadError} retry={() => void reloadModelPreferences('vision')} />;

  const modelOptions = inherited
    ? []
    : preference.provider === LUMI_OFFICIAL_PROVIDER_ID
      ? officialModelOptions(officialCatalog, 'world', WORLD_MODEL_OPTIONS.relay)
      : WORLD_MODEL_OPTIONS[preference.provider] || [];

  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.desktop-action-model.091115083c')} icon={<Globe size={18} className="text-cyan-300" />}>
        <p className="mb-5 max-w-2xl text-sm leading-relaxed text-white/45">
          {uiMessage('settings.world-model-description.a7cbc8eaf3')}
        </p>
        <div className="border-y border-white/10 py-5">
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.desktop-action-provider.c56456b63f')}</span>
            <select
              value={preference.provider}
              onChange={event => setProvider(event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/45"
            >
              <option value="inherit_vision">{uiMessage('settings.follow-vision-model.d174430ac2')}</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
              <option value="ark">Doubao / Ark</option>
              <option value="qwen">Qwen-VL / DashScope</option>
              <option value="ollama">Ollama Local</option>
              <option value="lmstudio">LM Studio Local</option>
              <option value={LUMI_OFFICIAL_PROVIDER_ID}>{lumiOfficialApiLabel(t)}</option>
            </select>
          </label>

          {!inherited && (
            <div className="mt-4">
              <GenerationModelInput
                id={`world-model-${preference.provider}`}
                label={uiMessage('settings.desktop-action-model.091115083c')}
                value={preference.model}
                options={modelOptions}
                onChange={setModel}
              />
            </div>
          )}

          <div className="mt-4 grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.effective-model.60bc31ba15')}</span>
            <span className="min-w-0 truncate rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-white/55">
              {activeProvider || '-'} / {activeModel || '-'}
            </span>
          </div>
          <LumiOfficialCapabilityBadge t={t} supported={true} capabilityKey="settings.capability-world-actions.d0e1f2a3b4" />
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button onClick={test} disabled={busy || !activeProvider || !activeModel} className="h-10 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-4 text-xs font-bold text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-40">
            {testing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Zap size={15} className="mr-2" />}
            {uiMessage('settings.test-effective-model.c9648a120e')}
          </Button>
          <Button onClick={save} disabled={busy} className="h-10 rounded-lg bg-cyan-300 px-4 text-xs font-bold text-black hover:bg-cyan-200 disabled:opacity-40">
            {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
            {uiMessage('settings.save-desktop-action-model.1fb3f1157c')}
          </Button>
        </div>
        {testMessage && <p className="mt-3 text-right text-xs text-white/55">{testMessage}</p>}
      </SettingsSection>
    </div>
  );
}

export function WorldModelsPage({ t }: { t: any }) {
  return (
    <div className="space-y-8">
      <VisionRoleSettings t={t} />
      <WorldActionModelPage t={t} />
    </div>
  );
}
