/** Provider inventory for cloud health and readiness diagnostics. */

import { getKey } from '../config/keys';
import { isGptSovitsRuntimeInstalled } from '../tts/gptsovits_runtime';
import { hasDoubaoSpeechCredentials } from '../config/doubao_speech';
import { relayConfigured } from '../relay/config';

// ── Provider Priority Lists ──

export const LLM_PRIORITY: Array<{ provider: string; label: string }> = [
  { provider: 'deepseek', label: 'DeepSeek' },
  { provider: 'qwen', label: 'Qwen' },
  { provider: 'openai', label: 'OpenAI' },
  { provider: 'gemini', label: 'Gemini' },
  { provider: 'anthropic', label: 'Anthropic' },
  { provider: 'glm', label: 'GLM / 智谱' },
];

export const STT_PRIORITY: Array<{ provider: string; label: string }> = [
  { provider: 'ark', label: 'Doubao-ASR' },
  { provider: 'qwen', label: 'Qwen-ASR' },
  { provider: 'whisper', label: 'Whisper' },
];

export const TTS_PRIORITY: Array<{ provider: string; label: string }> = [
  { provider: 'local-cosyvoice', label: 'Local CosyVoice' },
  { provider: 'ark', label: 'Doubao TTS' },
  { provider: 'cosyvoice', label: 'DashScope CosyVoice' },
  { provider: 'gptsovits', label: 'GPT-SoVITS' },
];

/**
 * Check which LLM providers have API keys configured.
 * Uses environment variables.
 */
export function getAvailableLLMProviders(): Record<string, boolean> {
  return {
    deepseek: !!(process.env.DEEPSEEK_API_KEY || getKey('DEEPSEEK_API_KEY')),
    qwen: !!(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY')),
    openai: !!(process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY')),
    gemini: !!(process.env.GEMINI_API_KEY || getKey('GEMINI_API_KEY')),
    anthropic: !!(process.env.ANTHROPIC_API_KEY || getKey('ANTHROPIC_API_KEY')),
    glm: !!(process.env.GLM_API_KEY || getKey('GLM_API_KEY')),
    // The official gateway is intentionally not in LLM_PRIORITY: exposing a
    // configured relay in health/readiness must not silently opt every user
    // into a billable external fallback.
    relay: relayConfigured(),
  };
}

/**
 * Check which STT providers have API keys configured.
 */
export function getAvailableSTTProviders(): Record<string, boolean> {
  return {
    ark: hasDoubaoSpeechCredentials(),
    qwen: !!(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY')),
    whisper: !!(process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY')),
    // Official STT is currently a documented batch adapter; it is still
    // reported here so the settings/health view reflects the selected route.
    relay: relayConfigured(),
  };
}

/**
 * Check which TTS providers have API keys configured.
 */
export function getAvailableTTSProviders(): Record<string, boolean> {
  return {
    'local-cosyvoice': !!(
      process.env.LOCAL_COSYVOICE_ENABLED === 'true'
      || process.env.LOCAL_COSYVOICE_API_URL
      || process.env.COSYVOICE_LOCAL_API_URL
    ),
    ark: hasDoubaoSpeechCredentials(),
    cosyvoice: !!(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY')),
    gptsovits: !!(
      process.env.GPTSOVITS_API_URL
      || process.env.GPTSOVITS_ENABLED === 'true'
      || getKey('GPTSOVITS_API_URL')
      || isGptSovitsRuntimeInstalled()
    ),
    relay: relayConfigured(),
  };
}
