import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey } from "../config/keys";
import { getLocalModelConfig, isTextGenerationModel, refreshLocalModelConfig } from "../llm/local_models";

let openai: OpenAI | null = null;
let openaiSignature = '';
let anthropic: Anthropic | null = null;
let anthropicSignature = '';
let gemini: GoogleGenerativeAI | null = null;
let geminiSignature = '';
let deepseek: OpenAI | null = null;
let deepseekSignature = '';
let qwen: OpenAI | null = null;
let qwenSignature = '';
let ark: OpenAI | null = null;
let arkSignature = '';
let ollama: OpenAI | null = null;
let ollamaSignature = '';
let ollamaDetected = false;
let lmstudio: OpenAI | null = null;
let lmstudioSignature = '';
let lmstudioDetected = false;
let xiaomi: OpenAI | null = null;
let xiaomiSignature = '';
let kimi: OpenAI | null = null;
let kimiSignature = '';
let glm: OpenAI | null = null;
let glmSignature = '';
let relay: OpenAI | null = null;
let relaySignature = '';

function clientSignature(...values: Array<string | undefined>): string {
  return values.map(value => value || '').join('\u0000');
}

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

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY');
  const baseURL = process.env.OPENAI_BASE_URL || getKey('OPENAI_BASE_URL');
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    openai = null;
    openaiSignature = '';
  } else if (!openai || openaiSignature !== signature) {
    openai = new OpenAI({ apiKey: key!, ...(baseURL ? { baseURL } : {}) });
    openaiSignature = signature;
  }
  return openai;
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

function getDeepSeek() {
  const key = process.env.DEEPSEEK_API_KEY || getKey('DEEPSEEK_API_KEY');
  const baseURL = process.env.DEEPSEEK_BASE_URL || getKey('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/v1';
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    deepseek = null;
    deepseekSignature = '';
  } else if (!deepseek || deepseekSignature !== signature) {
    deepseek = new OpenAI({
      apiKey: key!,
      baseURL,
    });
    deepseekSignature = signature;
  }
  return deepseek;
}

function getQwen() {
  const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY
    || getKey('QWEN_API_KEY') || getKey('DASHSCOPE_API_KEY');
  const baseURL = process.env.QWEN_BASE_URL || getKey('QWEN_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    qwen = null;
    qwenSignature = '';
  } else if (!qwen || qwenSignature !== signature) {
    qwen = new OpenAI({ apiKey: key!, baseURL });
    qwenSignature = signature;
  }
  return qwen;
}

function getArk() {
  const key = process.env.ARK_API_KEY || getKey('ARK_API_KEY');
  const baseURL = process.env.ARK_BASE_URL || getKey('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3';
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    ark = null;
    arkSignature = '';
  } else if (!ark || arkSignature !== signature) {
    ark = new OpenAI({
      apiKey: key!,
      baseURL,
    });
    arkSignature = signature;
  }
  return ark;
}

function getOllama() {
  const config = getLocalModelConfig('ollama');
  const available = config.detected && config.models.some(isTextGenerationModel);
  const signature = available ? config.baseUrl : '';
  ollamaDetected = available;
  if (!signature) {
    ollama = null;
    ollamaSignature = '';
  } else if (!ollama || ollamaSignature !== signature) {
    ollama = new OpenAI({
      apiKey: 'ollama',
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
  const signature = available ? config.baseUrl : '';
  lmstudioDetected = available;
  if (!signature) {
    lmstudio = null;
    lmstudioSignature = '';
  } else if (!lmstudio || lmstudioSignature !== signature) {
    lmstudio = new OpenAI({
      apiKey: 'lm-studio',
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

function getXiaomi() {
  const key = process.env.XIAOMI_API_KEY || getKey('XIAOMI_API_KEY');
  const baseURL = process.env.XIAOMI_BASE_URL || getKey('XIAOMI_BASE_URL') || 'https://api.xiaomimimo.com/v1';
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    xiaomi = null;
    xiaomiSignature = '';
  } else if (!xiaomi || xiaomiSignature !== signature) {
    xiaomi = new OpenAI({
      apiKey: key!,
      baseURL,
    });
    xiaomiSignature = signature;
  }
  return xiaomi;
}

function getKimi() {
  const key = process.env.KIMI_API_KEY || getKey('KIMI_API_KEY');
  const baseURL = process.env.KIMI_BASE_URL || getKey('KIMI_BASE_URL') || 'https://api.moonshot.cn/v1';
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    kimi = null;
    kimiSignature = '';
  } else if (!kimi || kimiSignature !== signature) {
    kimi = new OpenAI({
      apiKey: key!,
      baseURL,
    });
    kimiSignature = signature;
  }
  return kimi;
}

function getGlm() {
  const key = process.env.GLM_API_KEY || getKey('GLM_API_KEY');
  const baseURL = process.env.GLM_BASE_URL || getKey('GLM_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4';
  const signature = key ? clientSignature(key, baseURL) : '';
  if (!signature) {
    glm = null;
    glmSignature = '';
  } else if (!glm || glmSignature !== signature) {
    glm = new OpenAI({
      apiKey: key!,
      baseURL,
    });
    glmSignature = signature;
  }
  return glm;
}

function getRelay() {
  const key = process.env.RELAY_API_KEY || getKey('RELAY_API_KEY');
  const baseUrl = process.env.RELAY_BASE_URL || getKey('RELAY_BASE_URL') || 'https://api.example.com/v1';
  const signature = key ? clientSignature(key, baseUrl) : '';
  if (!signature) {
    relay = null;
    relaySignature = '';
  } else if (!relay || relaySignature !== signature) {
    relay = new OpenAI({
      apiKey: key!,
      baseURL: baseUrl,
    });
    relaySignature = signature;
  }
  return relay;
}

async function refreshLocalModels(): Promise<{ ollama: boolean; lmstudio: boolean }> {
  const [ollamaResult, lmstudioResult] = await Promise.all([
    refreshLocalModelConfig('ollama', undefined, { timeoutMs: 3000 }),
    refreshLocalModelConfig('lmstudio', undefined, { timeoutMs: 3000 }),
  ]);
  ollama = null;
  ollamaSignature = '';
  lmstudio = null;
  lmstudioSignature = '';
  getOllama();
  getLmStudio();
  if (ollamaResult.detected) console.log(`[LLM] Ollama detected — ${ollamaResult.models.length} models`);
  if (lmstudioResult.detected) console.log(`[LLM] LM Studio detected — ${lmstudioResult.models.length} models`);
  return { ollama: ollamaResult.detected, lmstudio: lmstudioResult.detected };
}

export function createLLMRuntime(): LLMClients {
  return { getOpenAI, getAnthropic, getGemini, getDeepSeek, getQwen, getArk, getOllama, isOllamaAvailable, getLmStudio, isLmStudioAvailable, getXiaomi, getKimi, getGlm, getRelay, refreshLocalModels };
}
