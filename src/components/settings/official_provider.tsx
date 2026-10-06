import { useState } from "react";
import { Cpu, BrainCircuit, MessagesSquare, Sparkle, Zap, AlertTriangle, Loader2, Cloud, Volume2, ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { useApp } from "@/contexts/AppContext";
import { useLumiOfficialCatalog } from "../../hooks/useLumiOfficialCatalog";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { LUMI_OFFICIAL_DOCS_URL, LUMI_OFFICIAL_RECHARGE_URL } from "../../../shared/model_provider_capabilities";
import { useModelOperation, applyOfficialModelRoles, ModelSettingsStatus } from './model_operations';
import type { OfficialRoleApplyResponse } from './model_operations';
import { LUMI_OFFICIAL_APPLY_NOT_CONFIGURED_KEY, LUMI_OFFICIAL_APPLY_PARTIAL_KEY, LUMI_OFFICIAL_APPLY_SUCCESS_KEY, LUMI_OFFICIAL_APPLY_FAILED_KEY, LUMI_OFFICIAL_APPLY_LABEL_KEY, LUMI_OFFICIAL_APPLY_DESCRIPTION_KEY, lumiOfficialRoleReason, LumiOfficialCapabilityBadge } from './official_models';
import { SettingsSection } from './components';
import { RelayProviderRow, ApiKeyField } from './provider_access';
import type { ProviderRuntimeStatus } from './connections';
import { LLMProviderRow } from './provider_editor';

export function OfficialProviderSettings({ t }: { t: any }) {
  const locale = t?.langCode === 'en' ? 'en' : 'zh';
  const operation = useModelOperation();
  const applying = operation.saving;
  const [applyResult, setApplyResult] = useState<OfficialRoleApplyResponse | null>(null);
  const officialCatalog = useLumiOfficialCatalog();
  const catalogSummary = officialCatalog
    ? { modelCount: officialCatalog.models.length, roleCount: Object.keys(officialCatalog.byRole).length }
    : null;

  const applyOfficialApi = () => operation.run('saving', async signal => {
    setApplyResult(null);
    const result = await applyOfficialModelRoles(signal);
    signal.throwIfAborted(); setApplyResult(result);
    if (result.applied.length > 0) window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed', { detail: { source: 'official-settings' } }));
    if (result.code === 'OFFICIAL_API_NOT_CONFIGURED') throw new Error(uiMessage(LUMI_OFFICIAL_APPLY_NOT_CONFIGURED_KEY, locale));
    if (result.failed.length > 0) throw new Error(formatUiMessage(LUMI_OFFICIAL_APPLY_PARTIAL_KEY, { value0: result.applied.length, value1: result.failed.length }, locale));
    return result.applied.length > 0 ? formatUiMessage(LUMI_OFFICIAL_APPLY_SUCCESS_KEY, { value0: result.applied.length }, locale) : '';
  }, LUMI_OFFICIAL_APPLY_FAILED_KEY);

  const roleLabels: Record<string, string> = {
    reasoning: uiMessage('settings.reasoning.6a171d96b4', locale),
    vision: uiMessage('settings.vision-model.df2108ba57', locale),
    world: uiMessage('settings.world-model.67c5d91de2', locale),
    embedding: uiMessage('settings.embedding-role-label.f7a8b9c0d1', locale),
    image_generation: uiMessage('settings.image-generation-model.fdd84f5c71', locale),
    image_edit: uiMessage('settings.image-edit-model.4a3f9e82c1', locale),
    video_generation: uiMessage('settings.video-generation-model.390997b87b', locale),
    image_to_video: uiMessage('settings.image-to-video-model.0b7da532f4', locale),
    rerank: uiMessage('settings.rerank-role-label.a8b9c0d1e2', locale),
    speech_recognition: uiMessage('settings.speech-recognition-role-label.b9c0d1e2f3', locale),
    speech_synthesis: uiMessage('settings.speech-synthesis-role-label.c0d1e2f3a4', locale),
    request: uiMessage(LUMI_OFFICIAL_APPLY_LABEL_KEY, locale),
  };

  return (
    <SettingsSection title={uiMessage('settings.lumi-official-service.9a4e2d7c10')} icon={<Sparkle size={18} className="text-celestial-saturn" />}>
      <p className="mb-5 max-w-3xl text-sm leading-relaxed text-white/45">
        {uiMessage('settings.lumi-official-service-description.2c8f6a1e05')}
        {' '}
        <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
          <a
            href={LUMI_OFFICIAL_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-cyan-300/80 underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-200"
          >
            API docs <ExternalLink size={12} />
          </a>
          <a
            href={LUMI_OFFICIAL_RECHARGE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-amber-200/80 underline decoration-amber-200/30 underline-offset-2 hover:text-amber-100"
          >
            {uiMessage('settings.lumi-official-recharge-link.1c2d3e4f5a', locale)} <ExternalLink size={12} />
          </a>
        </span>
      </p>
      {catalogSummary && (
        <p className="mb-4 text-xs text-cyan-100/45" data-testid="official-model-catalog-summary">
          {formatUiMessage('settings.lumi-official-catalog-summary.2d3e4f5a6b', {
            value0: catalogSummary.modelCount,
            value1: catalogSummary.roleCount,
          }, locale)}
        </p>
      )}
      <div className="border-y border-white/10">
        <RelayProviderRow t={t} label={uiMessage('settings.lumi-official-relay.7d3b1f9c24')} />
      </div>
      <div className="mt-5 rounded-xl border border-celestial-saturn/15 bg-celestial-saturn/[0.04] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-2xl text-xs leading-relaxed text-white/55">
            {uiMessage(LUMI_OFFICIAL_APPLY_DESCRIPTION_KEY, locale)}
          </p>
          <Button
            type="button"
            onClick={() => { void applyOfficialApi(); }}
            disabled={applying}
            data-testid="apply-official-api"
            className="h-10 shrink-0 rounded-lg bg-celestial-saturn px-4 text-xs font-bold text-black hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {applying ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Zap size={15} className="mr-2" />}
            {uiMessage(LUMI_OFFICIAL_APPLY_LABEL_KEY, locale)}
          </Button>
        </div>
        {operation.state === 'error' && operation.message && <p role="alert" className="mt-3 text-xs text-red-300">{operation.message}</p>}
        {applyResult && (
          <div className="mt-3 grid gap-1.5 border-t border-white/10 pt-3 text-[11px] text-white/55" role="status" aria-live="polite">
            {Object.entries(applyResult.roles).map(([role, result]) => (
              <div key={role} className="flex flex-wrap items-center gap-2">
                <span className={result.status === 'applied' ? 'text-emerald-300' : result.status === 'failed' ? 'text-red-300' : 'text-amber-200'}>
                  {result.status === 'applied' ? '✓' : result.status === 'failed' ? '!' : '·'}
                </span>
                <span>{roleLabels[role] || role}</span>
                {result.model && <span className="font-mono text-white/40">{result.provider}/{result.model}</span>}
                {result.reason && <span className="text-white/35">{lumiOfficialRoleReason(result.reason, locale)}</span>}
              </div>
            ))}
            {applyResult.error && <p className="mt-1 text-red-300/80">{applyResult.error}</p>}
          </div>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <LumiOfficialCapabilityBadge t={t} supported={true} capabilityKey="settings.capability-official-supported-roles.a3b4c5d6e7" />
      </div>
    </SettingsSection>
  );
}

export function ServiceProviderSettings({ t, providerStatus }: { t: any; providerStatus: Record<string, ProviderRuntimeStatus> }) {
  const { aiConfig, reloadModelPreferences } = useApp();
  if (!aiConfig.ready) return <ModelSettingsStatus error={aiConfig.loadError} retry={() => void reloadModelPreferences('llm')} />;
  const failedProbes = Object.entries(providerStatus)
    // Relay belongs to the Lumi Official column; local runtimes belong to Local.
    // Keep the health banner scoped to the providers rendered in this column.
    .filter(([provider, status]) => (
      provider !== 'relay'
      && provider !== 'ollama'
      && provider !== 'lmstudio'
      && !(status.extension === true && status.local === true)
      && status.configured !== false
      && status.lastProbe?.ok === false
    ));
  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.service-model-providers.4f8a2c6d19')}>
        {failedProbes.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-2 border-y border-red-400/15 py-3 text-xs text-red-200/80">
            <AlertTriangle size={14} />
            <span>{uiMessage('settings.last-probe-unavailable.96559b4185')}</span>
            {failedProbes.map(([provider, status]) => (
              <span key={provider} className="font-mono">
                {provider} ({status.lastProbe?.errorCategory || uiMessage('settings.failed.4b20f2d3b4')})
              </span>
            ))}
          </div>
        )}
        <div className="border-y border-white/10">
          <LLMProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label="DeepSeek" providerId="deepseek" models={['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']} placeholder="sk-..." serverKey="DEEPSEEK_API_KEY" t={t} />
          <LLMProviderRow icon={<Zap size={18} className="text-violet-400" />} label="Qwen / DashScope (Alibaba Cloud)" providerId="qwen" models={['qwen-plus', 'qwen-max', 'qwen-turbo']} placeholder="sk-..." serverKey="DASHSCOPE_API_KEY" t={t} />
           <LLMProviderRow icon={<Cloud size={18} className="text-cyan-400" />} label="Doubao (Ark)" providerId="ark" models={['doubao-seed-2-0-lite-260215', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k', 'doubao-1-5-vision-pro-32k']} placeholder={uiMessage('settings.enter-ark-api-key.9f82bf67e1')} serverKey="ARK_API_KEY" t={t} />
           <LLMProviderRow icon={<Cpu size={18} className="text-orange-400" />} label="Xiaomi MiMo" providerId="xiaomi" models={['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro']} placeholder={uiMessage('settings.enter-mimo-api-key.58533112c9')} serverKey="XIAOMI_API_KEY" t={t} />
           <LLMProviderRow icon={<Sparkle size={18} className="text-rose-400" />} label="Kimi (Moonshot)" providerId="kimi" models={['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']} placeholder="sk-..." serverKey="KIMI_API_KEY" t={t} />
           <LLMProviderRow icon={<Sparkle size={18} className="text-cyan-400" />} label="GLM (Zhipu AI)" providerId="glm" models={['glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4-plus']} placeholder={uiMessage('settings.enter-glm-api-key.d9e86fca17')} serverKey="GLM_API_KEY" t={t} />
          <LLMProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label={`Google Gemini${providerStatus.gemini?.available ? ` (${providerStatus.gemini.model})` : ''}`} providerId="gemini" models={['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']} placeholder={providerStatus.gemini?.available ? (t.connectedViaEnv || uiMessage('settings.connected-via-environment.2dcffe5622')) : (t.noKeyConfigured || uiMessage('settings.no-key-configured.633defef78'))} serverKey="GEMINI_API_KEY" t={t} />
          <LLMProviderRow icon={<MessagesSquare size={18} className="text-green-400" />} label="OpenAI" providerId="openai" models={['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo']} placeholder="sk-..." serverKey="OPENAI_API_KEY" t={t} />
          <LLMProviderRow icon={<Sparkle size={18} className="text-purple-400" />} label="Anthropic Claude" providerId="anthropic" models={['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5']} placeholder="sk-ant-..." serverKey="ANTHROPIC_API_KEY" t={t} />
          <ApiKeyField icon={<Sparkle size={18} className="text-rose-300" />} label="MiniMax" placeholder="sk-..." storageKey="lumi_minimax_key" serverKey="MINIMAX_API_KEY" consoleUrl="https://platform.minimaxi.com" hint={uiMessage('settings.minimax-generation-provider-hint.2c939bd0f7')} t={t} />
          <ApiKeyField icon={<Sparkle size={18} className="text-emerald-300" />} label="SiliconFlow" placeholder="sk-..." storageKey="lumi_siliconflow_key" serverKey="SILICONFLOW_API_KEY" consoleUrl="https://cloud.siliconflow.cn" hint={uiMessage('settings.siliconflow-generation-provider-hint.73aa2ce8e7')} t={t} />
          <ApiKeyField icon={<Volume2 size={18} className="text-emerald-300" />} label={t.doubaoSpeechLabel || 'Doubao Speech'} placeholder="New-console API Key value" storageKey="lumi_doubao_speech" serverKey="DOUBAO_SPEECH_KEY" consoleUrl="https://console.volcengine.com/speech/new/setting/apikeys" testEndpoint="/api/voice/doubao/probe" hint={uiMessage('settings.doubao-speech-api-key-only.4ab619f21d')} t={t} />
        </div>
      </SettingsSection>
    </div>
  );
}
