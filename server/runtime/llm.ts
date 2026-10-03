import OpenAI from "openai";
import { localPrivacyFetch } from '../config/privacy';
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey } from "../config/keys";
import { getLocalModelConfig, isTextGenerationModel, refreshLocalModelConfig } from "../llm/local_models";
import { relayApiKey, relayConfigured, relayOpenAIBaseUrl } from "../relay/config";
import { normalizeOfficialOpenAIErrorResponse } from '../llm/official_api';

let anthropic: Anthropic | null = null;
let anthropicSignature = '';
let gemini: GoogleGenerativeAI | null = null;
let geminiSignature = '';
let ollama: OpenAI | null = null;
let ollamaSignature = '';
let ollamaDetected = false;
let lmstudio: OpenAI | null = null;
let lmstudioSignature = '';
let lmstudioDetected = false;
let relay: OpenAI | null = null;
let relaySignature = '';

function clientSignature(...values: Array<string | undefined>): string {
  return values.map(value => value || '').join('\u0000');
}

// Standard OpenAI-compatible providers share cache invalidation, not routing.
function cloudClient(provider: string, defaultBaseURL?: string, alternateKey?: string): () => OpenAI | null {
  let client: OpenAI | null = null;
  let signature = '';
  return () => {
    const keyName = provider + '_API_KEY', baseName = provider + '_BASE_URL';
    const key = process.env[keyName] || (alternateKey ? process.env[alternateKey] : undefined)
      || getKey(keyName) || (alternateKey ? getKey(alternateKey) : undefined);
    const baseURL = process.env[baseName] || getKey(baseName) || defaultBaseURL;
    const nextSignature = key ? clientSignature(key, baseURL) : '';
    if (!nextSignature) {
      client = null;
      signature = '';
    } else if (!client || signature !== nextSignature) {
      client = new OpenAI({ apiKey: key!, ...(baseURL ? { baseURL } : {}) });
      signature = nextSignature;
    }
    return client;
  };
}

const getOpenAI = cloudClient('OPENAI');
const getDeepSeek = cloudClient('DEEPSEEK', 'https://api.deepseek.com/v1');
const getQwen = cloudClient('QWEN', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY');
const getArk = cloudClient('ARK', 'https://ark.cn-beijing.volces.com/api/v3');
const getXiaomi = cloudClient('XIAOMI', 'https://api.xiaomimimo.com/v1');
const getKimi = cloudClient('KIMI', 'https://api.moonshot.cn/v1');
const getGlm = cloudClient('GLM', 'https://open.bigmodel.cn/api/paas/v4');

export interface LLMClients {
  getOpenAI: () => OpenAI | null;
  getAnthropic: () => Anthropic | null;
  getGemini: () => GoogleGenerativeAI | null;
  getDeepSeek: () => OpenAI | null;
  getQwen: () => OpenAI | null;
  getArk: () => OpenAI | null;
  getOllama: () => OpenAI | null;
  isOllamaAvailable: () => boolean;
  getLmStudio: () => OpenAI | null;
  isLmStudioAvailable: () => boolean;
  getXiaomi: () => OpenAI | null;
  getKimi: () => OpenAI | null;
  getGlm: () => OpenAI | null;
  getRelay: () => OpenAI | null;
  refreshLocalModels: () => Promise<{ ollama: boolean; lmstudio: boolean }>;
}

function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY || getKey('ANTHROPIC_API_KEY');
  const baseURL = process.env.ANTHROPIC_BASE_URL || getKey('ANTHROPIC_BASE_URL');
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    anthropic = null;
    anthropicSignature = '';
  } else if (!anthropic || anthropicSignature !== signature) {
    anthropic = new Anthropic({ apiKey: key!, ...(baseURL ? { baseURL } : {}) });
    anthropicSignature = signature;
  }
  return anthropic;
}

function getGemini() {
  const key = process.env.GEMINI_API_KEY || getKey('GEMINI_API_KEY');
  const signature = key || '';
  if (!signature) {
    gemini = null;
    geminiSignature = '';
  } else if (!gemini || geminiSignature !== signature) {
    gemini = new GoogleGenerativeAI(key);
    geminiSignature = signature;
  }
  return gemini;
}

function getOllama() {
  const config = getLocalModelConfig('ollama');
  const available = config.detected && config.models.some(isTextGenerationModel);
  const signature = config.baseUrl;
  ollamaDetected = available;
  if (!ollama || ollamaSignature !== signature) {
    ollama = new OpenAI({
      apiKey: 'ollama',
      fetch: localPrivacyFetch,
      baseURL: `${config.baseUrl}/v1`,
    });
    ollamaSignature = signature;
  }
  return ollama;
}

function isOllamaAvailable() {
  getOllama();
  return ollamaDetected;
}

function getLmStudio() {
  const config = getLocalModelConfig('lmstudio');
  const available = config.detected && config.models.some(isTextGenerationModel);
  const signature = config.baseUrl;
  lmstudioDetected = available;
  if (!lmstudio || lmstudioSignature !== signature) {
    lmstudio = new OpenAI({
      apiKey: 'lm-studio',
      fetch: localPrivacyFetch,
      baseURL: `${config.baseUrl}/v1`,
    });
    lmstudioSignature = signature;
  }
  return lmstudio;
}

function isLmStudioAvailable() {
  getLmStudio();
  return lmstudioDetected;
}

function getRelay() {
  const key = relayApiKey();
  // A relay is not usable with a key alone.  Do not construct a client for
  // the old example endpoint: role pages would report the provider as
  // selected, then the first real request would be sent to a placeholder
  // host.  The settings page and all role probes use the same two-part
  // readiness contract (key + base URL).
  const baseUrl = relayConfigured() ? relayOpenAIBaseUrl() : '';
  const signature = key && baseUrl ? clientSignature(key, baseUrl) : '';
  if (!signature) {
    relay = null;
    relaySignature = '';
  } else if (!relay || relaySignature !== signature) {
    relay = new OpenAI({
      apiKey: key!,
      baseURL: baseUrl,
      // Retry/failover is owned by the common provider layer and its deadline.
      // An SDK retry inside that attempt must not silently multiply requests.
      maxRetries: 0,
      fetch: async (input, init) => normalizeOfficialOpenAIErrorResponse(await fetch(input, init), key),
    });
    relaySignature = signature;
  }
  return relay;
}

async function refreshLocalModels(): Promise<{ ollama: boolean; lmstudio: boolean }> {
  await Promise.allSettled([
    refreshLocalModelConfig('ollama', undefined, { timeoutMs: 3000 }),
    refreshLocalModelConfig('lmstudio', undefined, { timeoutMs: 3000 }),
  ]);
  ollama = null;
  ollamaSignature = '';
  lmstudio = null;
  lmstudioSignature = '';
  getOllama();
  getLmStudio();
  const ollamaResult = getLocalModelConfig('ollama'), lmstudioResult = getLocalModelConfig('lmstudio');
  if (ollamaResult.detected) console.log(`[LLM] Ollama detected — ${ollamaResult.models.length} models`);
  if (lmstudioResult.detected) console.log(`[LLM] LM Studio detected — ${lmstudioResult.models.length} models`);
  return { ollama: ollamaResult.detected, lmstudio: lmstudioResult.detected };
}

export function createLLMRuntime(): LLMClients {
  return { getOpenAI, getAnthropic, getGemini, getDeepSeek, getQwen, getArk, getOllama, isOllamaAvailable, getLmStudio, isLmStudioAvailable, getXiaomi, getKimi, getGlm, getRelay, refreshLocalModels };
}
