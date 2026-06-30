/**
 * Privacy Mode — local-only processing enforcement.
 *
 * LUMI_PRIVACY=strict  →  all cloud calls blocked, local providers only
 * LUMI_PRIVACY=standard (default) → normal operation
 */

import { loadKeys } from './keys';

export type PrivacyMode = 'strict' | 'standard';

const PRIVACY_ENV = 'LUMI_PRIVACY';

export function getPrivacyMode(): PrivacyMode {
  const val = process.env[PRIVACY_ENV];
  if (val === 'strict') return 'strict';
  return 'standard';
}

export function isStrictPrivacy(): boolean {
  return getPrivacyMode() === 'strict';
}

export function isProviderLocalOnly(provider: string): boolean {
  return provider === 'ollama' || provider === 'lmstudio';
}

export function requireLocalProvider(provider: string): void {
  if (isStrictPrivacy() && !isProviderLocalOnly(provider)) {
    throw new Error(
      `[Privacy] Strict mode active (LUMI_PRIVACY=strict). ` +
      `Cloud provider "${provider}" is blocked. Use ollama or lmstudio.`
    );
  }
}

export function requireNotStrict(operation: string): void {
  if (isStrictPrivacy()) {
    throw new Error(
      `[Privacy] Strict mode: "${operation}" is blocked — it sends data to cloud services.`
    );
  }
}

export function listActiveCloudProviders(): string[] {
  try {
    const keys = loadKeys();
    const providers: string[] = [];
    if (keys.OPENAI_API_KEY) providers.push('openai');
    if (keys.ANTHROPIC_API_KEY) providers.push('anthropic');
    if (keys.DASHSCOPE_API_KEY || keys.QWEN_API_KEY) providers.push('qwen');
    if (keys.DEEPSEEK_API_KEY) providers.push('deepseek');
    if (keys.GEMINI_API_KEY) providers.push('gemini');
    if (keys.ALIYUN_AK_ID) providers.push('aliyun');
    return providers;
  } catch {
    return [];
  }
}
