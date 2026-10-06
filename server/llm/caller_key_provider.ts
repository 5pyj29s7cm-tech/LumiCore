import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ProviderGetters } from './provider_getters';

type CallerProvider = 'gemini' | 'anthropic' | 'deepseek' | 'qwen' | 'openai';
const DEFAULT_MODELS: Record<CallerProvider, string> = {
  gemini: 'gemini-2.0-flash', anthropic: 'claude-sonnet-4-6',
  deepseek: 'deepseek-v4-flash', qwen: 'qwen-plus', openai: 'gpt-4o',
};

/** One request-local client; these getters never reference Lumi's shared credentials. */
export function createCallerKeyProvider(provider: string, model: string | undefined, apiKey: string) {
  const selected: CallerProvider = ['gemini', 'anthropic', 'deepseek', 'qwen'].includes(provider)
    ? provider as CallerProvider : 'openai';
  const getters: Partial<ProviderGetters> = {};
  if (selected === 'gemini') {
    const client = new GoogleGenerativeAI(apiKey);
    getters.getGemini = () => client;
  } else if (selected === 'anthropic') {
    const client = new Anthropic({ apiKey });
    getters.getAnthropic = () => client;
  } else {
    const client = new OpenAI({ apiKey, baseURL: selected === 'deepseek'
      ? 'https://api.deepseek.com/v1' : selected === 'qwen'
      ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : undefined });
    if (selected === 'deepseek') getters.getDeepSeek = () => client;
    else if (selected === 'qwen') getters.getQwen = () => client;
    else getters.getOpenAI = () => client;
  }
  return { provider: selected, model: model || DEFAULT_MODELS[selected], getters };
}
