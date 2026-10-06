import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Zap, Loader2, Save } from "lucide-react";
import { Button } from "../ui/button";
import { toast } from "sonner";
import { useApp } from "@/contexts/AppContext";
import { useLumiOfficialCatalog } from "../../hooks/useLumiOfficialCatalog";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import type { ProviderRuntimeStatus } from './connections';
import { useModelOperation, runModelConnectionTest, ModelSettingsStatus } from './model_operations';
import { SettingsSection, GenerationModelInput } from './components';
import { LUMI_OFFICIAL_PROVIDER_ID, lumiOfficialApiLabel, officialModelOptions, LumiOfficialCapabilityBadge } from './official_models';
import { REASONING_MODEL_OPTIONS } from './model_preferences';

export function ReasoningRoleSettings({ t, providerStatus }: { t: any; providerStatus: Record<string, ProviderRuntimeStatus> }) {
  const { aiConfig, updateAIConfig, reloadModelPreferences } = useApp();
  const [model, setModel] = useState(aiConfig.model);
  const savedFallbackText = (aiConfig.fallbackCandidates || []).map(candidate => `${candidate.provider}/${candidate.model}`).join('\n');
  const [fallbackText, setFallbackText] = useState(savedFallbackText);
  const confirmed = useRef({ provider: aiConfig.provider, model: aiConfig.model, fallbackText: savedFallbackText });
  const officialCatalog = useLumiOfficialCatalog();

  useEffect(() => {
    const previous = confirmed.current, switched = previous.provider !== aiConfig.provider;
    setModel(draft => switched || draft === previous.model ? aiConfig.model : draft);
    setFallbackText(draft => switched || draft === previous.fallbackText ? savedFallbackText : draft);
    confirmed.current = { provider: aiConfig.provider, model: aiConfig.model, fallbackText: savedFallbackText };
  }, [aiConfig.model, aiConfig.provider, savedFallbackText]);

  useEffect(() => {
    const migration = aiConfig.legacyMigration;
    if (!migration?.migratedAt || migration.entries.length === 0) return;
    const noticeKey = `lumi_model_migration_notice_${migration.migratedAt}`;
    if (localStorage.getItem(noticeKey) === 'shown') return;
    const detail = migration.entries.map(entry => `${entry.provider}: ${entry.from} → ${entry.to}`).join(', ');
    toast.info(`Legacy model aliases were migrated once: ${detail}`);
    localStorage.setItem(noticeKey, 'shown');
  }, [aiConfig.legacyMigration]);

  const selectionMode = aiConfig.provider === 'auto' ? 'auto' : aiConfig.selectionMode;
  const parseFallbackCandidates = () => fallbackText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separator = line.indexOf('/');
      return separator > 0
        ? { provider: line.slice(0, separator).trim(), model: line.slice(separator + 1).trim() }
        : { provider: '', model: '' };
    })
    .filter(candidate => candidate.provider && candidate.model);

  const route = {
    model: model.trim(), selectionMode,
    fallbackCandidates: selectionMode === 'ordered_fallback' || selectionMode === 'auto' ? parseFallbackCandidates() : [],
    allowCloudFallback: aiConfig.allowCloudFallback,
  };
  const operation = useModelOperation(JSON.stringify([aiConfig.provider, route]));
  const { testing, busy, message: testMessage } = operation;
  const saveReasoningRoute = () => operation.run('saving', async () => (await updateAIConfig(route)) ? '' : false);

  const configuredModel = aiConfig.models?.[aiConfig.provider] || providerStatus[aiConfig.provider]?.model || '';
  const extensionProviders = Object.entries(providerStatus).filter(([, status]) => status.extension === true);
  const selectedExtensionModels = (providerStatus[aiConfig.provider]?.models || [])
    .map(item => typeof item === 'string' ? item : String(item.id || ''))
    .filter(Boolean);
  const selectedExtensionUnavailable = aiConfig.provider.startsWith('ext_')
    && !providerStatus[aiConfig.provider];

  const test = () => aiConfig.provider && model.trim() && operation.run('testing', async signal => {
    if (selectionMode !== 'pinned') {
      if (!(await updateAIConfig(route))) throw new Error(uiMessage('settings.failed-to-save-model-role.f325b221b0'));
      signal.throwIfAborted();
    }
    const result = await runModelConnectionTest(selectionMode === 'pinned' ? 'llm' : 'llm/route', aiConfig.provider, model.trim(), signal);
    return formatUiMessage('settings.live-call-passed-value0-ms.9f3242a245', { value0: result.latencyMs });
  });

  if (aiConfig.ready === false) return <ModelSettingsStatus error={aiConfig.loadError} retry={() => void reloadModelPreferences('llm')} />;
  return (
    <SettingsSection title={uiMessage('settings.reasoning-model-role.70c69a008d')} icon={<BrainCircuit size={18} className="text-celestial-saturn" />}>
      <div className="space-y-4 border-y border-white/10 py-5">
        <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">{t.primaryReasoningBrain || uiMessage('settings.primary-reasoning-brain.5bdd279d51')}</span>
          <select
            value={aiConfig.provider}
            onChange={event => {
              operation.reset();
              const provider = event.target.value;
              updateAIConfig({
                provider,
                ...(providerStatus[provider]?.model ? { model: providerStatus[provider].model } : {}),
              });
            }}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
          >
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">Qwen / DashScope</option>
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="ark">Doubao / Ark</option>
            <option value="xiaomi">Xiaomi MiMo</option>
            <option value="kimi">Kimi / Moonshot</option>
            <option value="glm">GLM / Zhipu AI</option>
            <option value={LUMI_OFFICIAL_PROVIDER_ID}>{lumiOfficialApiLabel(t)}</option>
            <option value="auto">Automatic (Local First)</option>
            <option value="ollama">Ollama Local</option>
            <option value="lmstudio">LM Studio Local</option>
            {extensionProviders.map(([providerId, status]) => (
              <option key={providerId} value={providerId}>
                {providerId} (Signed{status.local ? ', Local' : ''})
              </option>
            ))}
            {selectedExtensionUnavailable && (
              <option value={aiConfig.provider}>{aiConfig.provider} (Unavailable signed Provider)</option>
            )}
          </select>
        </label>
        <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">Routing policy</span>
          <select
            value={selectionMode}
            onChange={event => {
              operation.reset();
              const next = event.target.value as 'pinned' | 'ordered_fallback' | 'auto';
              if (next === 'auto') updateAIConfig({ provider: 'auto', selectionMode: 'auto' });
              else updateAIConfig({
                provider: aiConfig.provider === 'auto' ? 'deepseek' : aiConfig.provider,
                selectionMode: next,
              });
            }}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
          >
            <option value="pinned">Primary model — configured backup on failure</option>
            <option value="ordered_fallback">Ordered fallback — user-defined order</option>
            <option value="auto">Automatic — local first with visible receipts</option>
          </select>
        </label>
        <GenerationModelInput
          id={`reasoning-role-${aiConfig.provider}`}
          label={uiMessage('settings.model.44c0cd4289')}
          value={model}
          options={[
            configuredModel,
            ...selectedExtensionModels,
            ...(aiConfig.provider === LUMI_OFFICIAL_PROVIDER_ID
              ? officialModelOptions(officialCatalog, 'reasoning', REASONING_MODEL_OPTIONS.relay)
              : REASONING_MODEL_OPTIONS[aiConfig.provider] || []),
          ].filter(Boolean)}
          onChange={value => { operation.reset(); setModel(value); }}
        />
        {(selectionMode === 'ordered_fallback' || selectionMode === 'auto') && (
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)]">
            <span className="pt-2 text-xs font-bold text-white/55">Fallback order</span>
            <div className="space-y-2">
              <textarea
                value={fallbackText}
                onChange={event => { operation.reset(); setFallbackText(event.target.value); }}
                placeholder={'ollama/qwen2.5:7b\nlmstudio/local-model\nopenai/gpt-4o-mini'}
                rows={3}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none focus:border-celestial-saturn/45"
              />
              <label className="flex items-center gap-2 text-xs text-white/60">
                <input
                  type="checkbox"
                  checked={aiConfig.allowCloudFallback}
                  onChange={event => { operation.reset(); updateAIConfig({ allowCloudFallback: event.target.checked }); }}
                />
                Allow explicitly configured cloud fallback
              </label>
            </div>
          </label>
        )}
        <p className="text-xs text-white/40">
          {selectionMode === 'pinned'
            ? 'Uses the selected provider/model first. If it fails, an available configured backup may take over; every attempt and the model actually used appear in routing receipts.'
            : 'Every attempt and the model actually used are written to the local routing receipt ledger.'}
        </p>
        <LumiOfficialCapabilityBadge t={t} supported={true} capabilityKey="settings.capability-reasoning.f2a3b4c5d6" />
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={test} disabled={busy || !model.trim()} className="h-10 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-4 text-xs font-bold text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-40">
          {testing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Zap size={15} className="mr-2" />}
          {uiMessage('settings.test.9408c1ff3a')}
        </Button>
        <Button onClick={saveReasoningRoute} disabled={busy || !model.trim()} className="h-10 rounded-lg bg-celestial-saturn px-4 text-xs font-bold text-black hover:bg-yellow-300 disabled:opacity-40">
          <Save size={15} className="mr-2" />
          {uiMessage('settings.save.ec8e6d5819')}
        </Button>
      </div>
      {testMessage && <p className="mt-3 text-right text-xs text-white/55">{testMessage}</p>}
    </SettingsSection>
  );
}
