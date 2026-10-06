import { Zap, Loader2, Save, Search } from "lucide-react";
import { Button } from "../ui/button";
import { apiJson } from "@/services/apiClient";
import { useLumiOfficialCatalog } from "../../hooks/useLumiOfficialCatalog";
import { uiMessage } from "../../i18n/uiMessages";
import { lumiOfficialApiLabel, LUMI_OFFICIAL_PROVIDER_ID, officialModelOptions, LumiOfficialCapabilityBadge } from './official_models';
import { useModelSettings, ModelSettingsStatus } from './model_operations';
import type { RetrievalModelPreferences } from './model_preferences';
import { DEFAULT_RETRIEVAL_MODEL_PREFERENCES, EMBEDDING_MODELS, RERANK_MODELS, EMBEDDING_MODEL_PROVIDERS, RERANK_MODEL_PROVIDERS } from './model_preferences';
import { SettingsSection, GenerationModelInput } from './components';

export function retrievalProviderLabel(provider: string, t?: any): string {
  const labels: Record<string, string> = {
    '': uiMessage('settings.no-fallback.532319d005'),
    openai: 'OpenAI',
    qwen: 'Qwen / DashScope',
    siliconflow: 'SiliconFlow',
    ollama: 'Ollama Local',
    lmstudio: 'LM Studio Local',
    relay: lumiOfficialApiLabel(t),
  };
  return labels[provider] || provider;
}

export function RetrievalModelSettings({ t }: { t?: any }) {
  const { value: preferences, edit: setPreferences, ready, error, reload, persist, operation } = useModelSettings<RetrievalModelPreferences>('/api/preferences/retrieval-model', DEFAULT_RETRIEVAL_MODEL_PREFERENCES, 'settings.failed-to-load-model-roles.2db04d5ff2');
  const { saving, testing, busy, message: testMessage } = operation;
  const officialCatalog = useLumiOfficialCatalog();
  const embeddingOptions = (provider: string) => provider === LUMI_OFFICIAL_PROVIDER_ID
    ? officialModelOptions(officialCatalog, 'embedding', EMBEDDING_MODELS.relay)
    : EMBEDDING_MODELS[provider] || [];
  const rerankOptions = (provider: string) => provider === LUMI_OFFICIAL_PROVIDER_ID
    ? officialModelOptions(officialCatalog, 'rerank', RERANK_MODELS.relay)
    : RERANK_MODELS[provider] || [];

  const setRole = <K extends keyof RetrievalModelPreferences>(role: K, patch: Partial<RetrievalModelPreferences[K]>) => {
    setPreferences(previous => ({ ...previous, [role]: { ...previous[role], ...patch } }));
  };

  const setProvider = (provider: string) => {
    const model = EMBEDDING_MODELS[provider]?.[0] || '';
    setRole('embedding', { provider, model });
  };

  const setFallbackProvider = (fallbackProvider: string) => {
    const fallbackModel = fallbackProvider ? EMBEDDING_MODELS[fallbackProvider]?.[0] || '' : '';
    setRole('embedding', { fallbackProvider, fallbackModel });
  };

  const setRerankProvider = (provider: string) => {
    setRole('rerank', { provider, model: RERANK_MODELS[provider]?.[0] || '' });
  };

  const save = () => operation.run('saving', async signal => {
    await persist(signal);
    return uiMessage('settings.model-role-saved.48ed509208');
  }, 'settings.failed-to-save-model-role.f325b221b0');

  const test = () => operation.run('testing', async signal => {
    await persist(signal);
    const body = await apiJson<any>('/api/retrieval-model/test', { method: 'POST', signal });
    if (body?.ok !== true || !body.embedding) throw new Error(body?.error || uiMessage('settings.model-role-test-failed.6f17ba0837'));
    const embeddingLatency = Number(body.embedding.latencyMs) || 0;
    const rerankStatus = body.rerank?.enabled
      ? `Rerank ${Number(body.rerank.latencyMs) || 0} ms`
      : `Rerank ${uiMessage('settings.disabled.2caae825fe')}`;
    return `Embedding ${embeddingLatency} ms · ${rerankStatus}`;
  }, 'settings.model-role-test-failed.6f17ba0837');

  if (!ready) return <ModelSettingsStatus error={error} retry={reload} />;

  return (
    <SettingsSection title={uiMessage('settings.retrieval-model-role.7d25a85198')} icon={<Search size={18} className="text-emerald-300" />}>
      <p className="max-w-3xl text-sm leading-relaxed text-white/45">
        {uiMessage('settings.knowledge-retrieval-description.56e971d4a2')}
      </p>
      <div className="divide-y divide-white/10 border-y border-white/10">
        <section className="space-y-4 py-5">
          <div>
            <h3 className="text-sm font-semibold text-white">Embedding</h3>
            <p className="mt-1 text-xs leading-relaxed text-white/40">{uiMessage('settings.embedding-role-description.73576dd2ab')}</p>
          </div>
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.primary-model.78ee8a421a')}</span>
            <select value={preferences.embedding.provider} onChange={event => setProvider(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none">
              {EMBEDDING_MODEL_PROVIDERS.map(provider => <option key={provider} value={provider}>{retrievalProviderLabel(provider, t)}</option>)}
            </select>
          </label>
          <GenerationModelInput
            id={`embedding-${preferences.embedding.provider}-model`}
            label={uiMessage('settings.model.44c0cd4289')}
            value={preferences.embedding.model}
            options={embeddingOptions(preferences.embedding.provider)}
            onChange={model => setRole('embedding', { model })}
          />
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.fallback-model.562ec1697f')}</span>
            <select value={preferences.embedding.fallbackProvider} onChange={event => setFallbackProvider(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none">
              <option value="">{retrievalProviderLabel('', t)}</option>
              {EMBEDDING_MODEL_PROVIDERS.filter(provider => provider !== preferences.embedding.provider).map(provider => <option key={provider} value={provider}>{retrievalProviderLabel(provider, t)}</option>)}
            </select>
          </label>
          {preferences.embedding.fallbackProvider && (
            <GenerationModelInput
              id={`embedding-${preferences.embedding.fallbackProvider}-fallback-model`}
              label={uiMessage('settings.fallback-model-id.31f402c7ca')}
              value={preferences.embedding.fallbackModel}
              options={embeddingOptions(preferences.embedding.fallbackProvider)}
              onChange={fallbackModel => setRole('embedding', { fallbackModel })}
            />
          )}
        </section>

        <section className="space-y-4 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Rerank</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/40">{uiMessage('settings.rerank-role-description.8eac1d6897')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.rerank.enabled}
              aria-label={uiMessage('settings.enable-rerank.17ba5b1376')}
              onClick={() => setRole('rerank', { enabled: !preferences.rerank.enabled })}
              className={`h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${preferences.rerank.enabled ? 'bg-emerald-500' : 'bg-white/15'}`}
            >
              <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${preferences.rerank.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
          {preferences.rerank.enabled && (
            <>
              <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
                <span className="text-xs font-bold text-white/55">{uiMessage('settings.primary-model.78ee8a421a')}</span>
                <select value={preferences.rerank.provider} onChange={event => setRerankProvider(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none">
                  {RERANK_MODEL_PROVIDERS.map(provider => <option key={provider} value={provider}>{retrievalProviderLabel(provider, t)}</option>)}
                </select>
              </label>
              <GenerationModelInput
                id={`rerank-${preferences.rerank.provider}-model`}
                label={uiMessage('settings.model.44c0cd4289')}
                value={preferences.rerank.model}
                options={rerankOptions(preferences.rerank.provider)}
                onChange={model => setRole('rerank', { model })}
              />
              <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
                <span className="text-xs font-bold text-white/55">{uiMessage('settings.rerank-top-n.5fa98399c8')}</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={preferences.rerank.topN}
                  onChange={event => setRole('rerank', { topN: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })}
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-sm text-white outline-none"
                />
              </label>
            </>
          )}
        </section>
      </div>
      <LumiOfficialCapabilityBadge t={t} supported={true} capabilityKey="settings.capability-embedding.e1f2a3b4c5" />
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={test} disabled={busy || !preferences.embedding.model.trim() || (preferences.rerank.enabled && !preferences.rerank.model.trim())} className="h-10 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-4 text-xs font-bold text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-40">
          {testing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Zap size={15} className="mr-2" />}
          {uiMessage('settings.test.9408c1ff3a')}
        </Button>
        <Button onClick={save} disabled={busy || !preferences.embedding.model.trim() || (preferences.rerank.enabled && !preferences.rerank.model.trim())} className="h-10 rounded-lg bg-celestial-saturn px-4 text-xs font-bold text-black hover:bg-yellow-300 disabled:opacity-40">
          {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
          {uiMessage('settings.save.ec8e6d5819')}
        </Button>
      </div>
      {testMessage && <p className="mt-3 text-right text-xs text-white/55">{testMessage}</p>}
    </SettingsSection>
  );
}
