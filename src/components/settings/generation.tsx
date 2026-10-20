import { mediaGenerationCopy } from "../../i18n/locales/mediaGeneration";
import { Sparkle, Loader2, Save } from "lucide-react";
import { Button } from "../ui/button";
import { useLumiOfficialCatalog } from "../../hooks/useLumiOfficialCatalog";
import { uiMessage } from "../../i18n/uiMessages";
import { useModelSettings, ModelSettingsStatus } from './model_operations';
import type { GenerationPreferences } from './model_preferences';
import { DEFAULT_GENERATION_PREFERENCES, GENERATION_MODEL_OPTIONS, IMAGE_GENERATION_PROVIDERS, VIDEO_GENERATION_PROVIDERS } from './model_preferences';
import { officialModelOptions, LUMI_OFFICIAL_PROVIDER_ID, lumiOfficialApiLabel, LumiOfficialCapabilityBadge } from './official_models';
import { SettingsSection, GenerationModelInput } from './components';

export function GenerativeModelsPage({ t }: { t: any }) {
  const { value: preferences, edit: setPreferences, ready, error, reload, persist, operation } = useModelSettings<GenerationPreferences>('/api/preferences/generation', DEFAULT_GENERATION_PREFERENCES, 'settings.failed-to-load-generative-models.6f0ef4ec18');
  const { saving } = operation;
  const officialCatalog = useLumiOfficialCatalog();
  const relayImageModels = officialModelOptions(officialCatalog, 'image_generation', GENERATION_MODEL_OPTIONS.relayImage);
  const relayImageEditModels = officialModelOptions(officialCatalog, 'image_edit', GENERATION_MODEL_OPTIONS.relayImageEdit);
  const relayVideoModels = officialModelOptions(officialCatalog, 'video_generation', GENERATION_MODEL_OPTIONS.relayVideo);
  const relayImageToVideoModels = officialModelOptions(officialCatalog, 'image_to_video', GENERATION_MODEL_OPTIONS.relayImageToVideo);

  const setProvider = (role: 'image' | 'video' | 'imageToVideo', provider: string) => {
    const officialModels = role === 'image' ? relayImageModels : role === 'video' ? relayVideoModels : relayImageToVideoModels;
    const providers = role === 'image' ? IMAGE_GENERATION_PROVIDERS : VIDEO_GENERATION_PROVIDERS;
    setPreferences(previous => ({
      ...previous,
      [role]: {
        ...previous[role],
        provider,
        model: role === 'image' && provider === 'auto' ? '' : previous[role].models[provider]
          || (provider === LUMI_OFFICIAL_PROVIDER_ID ? officialModels[0] : providers[provider]?.models[0]) || '',
      },
    }));
  };

  const setRoleModel = (role: 'image' | 'imageEdit' | 'video' | 'imageToVideo', provider: string, model: string) => {
    setPreferences(previous => ({
      ...previous,
      [role]: {
        ...previous[role],
        model: previous[role].provider === provider ? model : previous[role].model,
        models: { ...previous[role].models, [provider]: model },
      },
    }));
  };

  const save = () => operation.run('saving', async signal => {
    const copy = mediaGenerationCopy(t?.langCode === 'en' ? 'en' : 'zh');
    for (const [field, models] of [['image', relayImageModels], ['imageEdit', relayImageEditModels], ['video', relayVideoModels], ['imageToVideo', relayImageToVideoModels]] as const) {
      const selection = preferences[field];
      if (selection.provider !== LUMI_OFFICIAL_PROVIDER_ID) continue;
      if (!officialCatalog) throw new Error(copy.modelCatalogUnavailable);
      if (!models.includes(selection.model)) throw new Error(copy.modelUnavailable);
    }
    await persist(signal);
    return uiMessage('settings.generative-models-saved.478e2f8603');
  }, 'settings.failed-to-save-generative-models.12ea083f89');

  if (!ready) return <ModelSettingsStatus error={error} retry={reload} />;

  const imageProvider = preferences.image.provider === LUMI_OFFICIAL_PROVIDER_ID
    ? { ...IMAGE_GENERATION_PROVIDERS.relay, models: relayImageModels }
    : IMAGE_GENERATION_PROVIDERS[preferences.image.provider];
  const imageEditProvider = { label: 'Lumi Official API', models: relayImageEditModels };
  const videoProvider = preferences.video.provider === LUMI_OFFICIAL_PROVIDER_ID
    ? { ...VIDEO_GENERATION_PROVIDERS.relay, models: relayVideoModels }
    : VIDEO_GENERATION_PROVIDERS[preferences.video.provider];
  const imageToVideoProvider = preferences.imageToVideo.provider === LUMI_OFFICIAL_PROVIDER_ID
    ? { ...VIDEO_GENERATION_PROVIDERS.relay, models: relayImageToVideoModels }
    : VIDEO_GENERATION_PROVIDERS[preferences.imageToVideo.provider];

  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.generative-models.3ef22638d1')} icon={<Sparkle size={18} className="text-celestial-saturn" />}>
        <div className="divide-y divide-white/10 border-y border-white/10">
          <section className="py-5">
            <div className="mb-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
              <div>
                <h3 className="text-sm font-semibold text-white">{uiMessage('settings.image-generation-model.fdd84f5c71')}</h3>
                <p className="mt-1 text-xs text-white/35">{uiMessage('settings.image-generation-model-description.65439bd21c')}</p>
              </div>
              <select
                value={preferences.image.provider}
                onChange={event => setProvider('image', event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
              >
                <option value="auto">{uiMessage('settings.automatic-provider.58089561bd')}</option>
                <option value="openai">OpenAI</option>
                <option value="qwen">Qwen / DashScope</option>
                <option value="siliconflow">SiliconFlow</option>
                <option value={LUMI_OFFICIAL_PROVIDER_ID}>
                  {lumiOfficialApiLabel(t)}
                </option>
              </select>
            </div>
            {imageProvider && (
              <GenerationModelInput
                id={`generation-${preferences.image.provider}-image-model`}
                label={imageProvider.label}
                value={preferences.image.models[preferences.image.provider] || preferences.image.model}
                options={imageProvider.models}
                onChange={model => setRoleModel('image', preferences.image.provider, model)}
              />
            )}
          </section>

          <section className="py-5">
            <div className="mb-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
              <div>
                <h3 className="text-sm font-semibold text-white">{uiMessage('settings.image-edit-model.4a3f9e82c1')}</h3>
                <p className="mt-1 text-xs text-white/35">{uiMessage('settings.image-edit-model-description.72bc0e11a4')}</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white/70">
                {lumiOfficialApiLabel(t)}
              </div>
            </div>
            <GenerationModelInput
              id="generation-relay-image-edit-model"
              label={imageEditProvider.label}
              value={preferences.imageEdit.models.relay || preferences.imageEdit.model}
              options={imageEditProvider.models}
              onChange={model => setRoleModel('imageEdit', 'relay', model)}
            />
          </section>

          <section className="py-5">
            <div className="mb-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
              <div>
                <h3 className="text-sm font-semibold text-white">{uiMessage('settings.video-generation-model.390997b87b')}</h3>
                <p className="mt-1 text-xs text-white/35">{uiMessage('settings.video-generation-model-description.20aed0c099')}</p>
              </div>
              <select
                value={preferences.video.provider}
                onChange={event => setProvider('video', event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
              >
                {Object.entries(VIDEO_GENERATION_PROVIDERS).map(([provider, definition]) => (
                  <option key={provider} value={provider}>{definition.label}</option>
                ))}
              </select>
            </div>
            {videoProvider && (
              <GenerationModelInput
                id={`generation-${preferences.video.provider}-video-model`}
                label={videoProvider.label}
                value={preferences.video.models[preferences.video.provider] || preferences.video.model}
                options={videoProvider.models}
                onChange={model => setRoleModel('video', preferences.video.provider, model)}
              />
            )}
          </section>

          <section className="py-5">
            <div className="mb-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
              <div>
                <h3 className="text-sm font-semibold text-white">{uiMessage('settings.image-to-video-model.0b7da532f4')}</h3>
                <p className="mt-1 text-xs text-white/35">{uiMessage('settings.image-to-video-model-description.c1e68f204d')}</p>
              </div>
              <select
                value={preferences.imageToVideo.provider}
                onChange={event => setProvider('imageToVideo', event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
              >
                <option value="minimax">MiniMax</option>
                <option value={LUMI_OFFICIAL_PROVIDER_ID}>{lumiOfficialApiLabel(t)}</option>
              </select>
            </div>
            {imageToVideoProvider && (
              <GenerationModelInput
                id={`generation-${preferences.imageToVideo.provider}-image-to-video-model`}
                label={imageToVideoProvider.label}
                value={preferences.imageToVideo.models[preferences.imageToVideo.provider] || preferences.imageToVideo.model}
                options={imageToVideoProvider.models}
                onChange={model => setRoleModel('imageToVideo', preferences.imageToVideo.provider, model)}
              />
            )}
          </section>
        </div>

        <LumiOfficialCapabilityBadge t={t} supported={true} capabilityKey="settings.capability-image-video-generation.c9d0e1f2a3" />

        <div className="mt-5 flex justify-end">
          <Button onClick={save} disabled={saving} className="h-10 rounded-lg bg-celestial-saturn px-4 text-xs font-bold text-black hover:bg-yellow-300 disabled:opacity-40">
            {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
            {uiMessage('settings.save-model-roles.2f4ed87292')}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
