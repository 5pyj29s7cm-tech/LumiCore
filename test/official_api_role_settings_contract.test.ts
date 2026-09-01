import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isImageEditProvider,
  isImageGenerationProvider,
  isImageToVideoProvider,
  isVideoGenerationProvider,
} from '../server/llm/generation_preferences';
import {
  isEmbeddingProvider,
  isRerankProvider,
} from '../server/llm/retrieval_model_preferences';
import { isVisionProvider } from '../server/llm/vision_preferences';
import { isWorldModelProvider } from '../server/llm/world_preferences';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../shared/model_provider_capabilities';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('Lumi official API role settings contract', () => {
  it('keeps the official relay selectable only for roles with a real adapter', () => {
    expect(isVisionProvider('relay')).toBe(true);
    expect(isWorldModelProvider('relay')).toBe(true);
    expect(isEmbeddingProvider('relay')).toBe(true);
    expect(isRerankProvider('relay')).toBe(true);
    expect(isImageGenerationProvider('relay')).toBe(true);
    expect(isImageEditProvider('relay')).toBe(true);
    expect(isVideoGenerationProvider('relay')).toBe(true);
    expect(isImageToVideoProvider('relay')).toBe(true);
  });

  it('exposes the same capability boundary in the settings UI', () => {
    const settings = source('src/components/Settings.tsx');
    const voice = source('src/components/VoiceProviderSwitch.tsx');

    expect(settings).toContain('const LUMI_OFFICIAL_PROVIDER_ID = SHARED_LUMI_OFFICIAL_PROVIDER_ID');
    expect(settings).toContain("value={LUMI_OFFICIAL_PROVIDER_ID}>{lumiOfficialApiLabel(t)} · Vision");
    expect(settings).not.toContain("value={LUMI_OFFICIAL_PROVIDER_ID} disabled");
    expect(settings).toContain("readStoredRelayBaseUrl() || LUMI_OFFICIAL_BASE_URL");
    expect(settings).not.toContain("|| 'https://api.example.com/v1'");
    expect(settings).not.toContain("localStorage.getItem('lumi_relay_key')");
    expect(settings).not.toContain("localStorage.setItem('lumi_relay_key'");
    expect(settings).toContain('LUMI_OFFICIAL_DEFAULT_MODELS.image_generation');
    expect(settings).toContain('LUMI_OFFICIAL_DEFAULT_MODELS.image_edit');
    expect(settings).toContain('LUMI_OFFICIAL_DEFAULT_MODELS.video_generation');
    expect(settings).toContain('LUMI_OFFICIAL_DEFAULT_MODELS.image_to_video');
    expect(settings).toContain('LUMI_OFFICIAL_DEFAULT_MODELS.embedding');
    expect(settings).toContain('LUMI_OFFICIAL_DEFAULT_MODELS.rerank');
    expect(voice).toContain("value: 'relay'");
    expect(voice).toContain('disabled: false');
    expect(voice).toContain('officialVoiceNote');
  });

  it('keeps the documented endpoint and model ids in one shared contract', async () => {
    const manifest = await import('../shared/model_provider_capabilities');
    expect(manifest.LUMI_OFFICIAL_BASE_URL).toBe('https://zhuan.huaczy.com/v1');
    expect(manifest.LUMI_OFFICIAL_DOCS_URL).toBe('https://zhuan.huaczy.com/console/help');
    expect(manifest.LUMI_OFFICIAL_RECHARGE_URL).toBe('https://zhuan.huaczy.com/console/recharge');
    expect(manifest.LUMI_OFFICIAL_DEFAULT_MODELS.reasoning).toBe('aliyun/qwen-plus');
    expect(manifest.LUMI_OFFICIAL_DEFAULT_MODELS.vision).toBe('huawei_maas/qwen2.5-vl-72b');
    expect(manifest.LUMI_OFFICIAL_DEFAULT_MODELS.world).toBe('aliyun/qwen3-vl-flash');
    expect(manifest.LUMI_OFFICIAL_DEFAULT_MODELS.video_generation).toBe('huawei_maas/Wan2.2-T2V-A14B');
    expect(LUMI_OFFICIAL_DEFAULT_MODELS.image_generation).toBe('huawei_maas/qwen-image');
    expect(LUMI_OFFICIAL_DEFAULT_MODELS.image_edit).toBe('huawei_maas/qwen-image-edit-2509');
    expect(LUMI_OFFICIAL_DEFAULT_MODELS.image_to_video).toBe('huawei_maas/Wan2.2-I2V-A14B');
    expect(LUMI_OFFICIAL_DEFAULT_MODELS.speech_recognition).toBe('aliyun/qwen-audio-3.0-asr-flash-streaming');
    expect(LUMI_OFFICIAL_DEFAULT_MODELS.speech_synthesis).toBe('aliyun/cosyvoice-v3-flash');
  });
});
