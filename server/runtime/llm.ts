import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey } from "../config/keys";
import { readDB } from "../../db_layer";

let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;
let gemini: GoogleGenerativeAI | null = null;
let deepseek: OpenAI | null = null;
let qwen: OpenAI | null = null;
let ark: OpenAI | null = null;
let ollama: OpenAI | null = null;
let ollamaDetected = false;
let lmstudio: OpenAI | null = null;
let lmstudioDetected = false;
let xiaomi: OpenAI | null = null;
let kimi: OpenAI | null = null;
let kimiKey: string | null = null;
let glm: OpenAI | null = null;
let relay: OpenAI | null = null;

/** Read Ollama base URL from settings (user-configured) or env var */
function getOllamaBaseUrl(): string {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === 'ollama_config');
    if (setting) {
      const config = JSON.parse(setting.value);
      if (config.baseUrl) return config.baseUrl.replace(/\/+$/, '');
    }
  } catch { /* DB not initialized yet — use env */ }
  return (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
}

/** Read LM Studio base URL from settings (user-configured) or env var */
function getLmStudioBaseUrl(): string {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === 'lmstudio_config');
    if (setting) {
      const config = JSON.parse(setting.value);
      if (config.baseUrl) return config.baseUrl.replace(/\/+$/, '');
    }
  } catch { /* DB not initialized yet — use env */ }
  return (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234').replace(/\/+$/, '');
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
}

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY');
  if (!openai && key) {
    openai = new OpenAI({ apiKey: key });
  }
  return openai;
}

function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY || getKey('ANTHROPIC_API_KEY');
  if (!anthropic && key) {
    anthropic = new Anthropic({ apiKey: key });
  }
  return anthropic;
}

function getGemini() {
  if (!gemini) {
    const key = process.env.GEMINI_API_KEY || getKey('GEMINI_API_KEY');
    if (!key) return null;
    gemini = new GoogleGenerativeAI(key);
  }
  return gemini;
}

function getDeepSeek() {
  const envKey = process.env.DEEPSEEK_API_KEY;
  const storedKey = getKey('DEEPSEEK_API_KEY');
  const key = envKey || storedKey;
  if (!deepseek && key) {
    deepseek = new OpenAI({
      apiKey: key,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    });
  }
  return deepseek;
}

function getQwen() {
  const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY
    || getKey('QWEN_API_KEY') || getKey('DASHSCOPE_API_KEY');
  if (!qwen && key) {
    qwen = new OpenAI({ apiKey: key, baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  }
  return qwen;
}

function getArk() {
  const key = process.env.ARK_API_KEY || getKey('ARK_API_KEY');
  if (!ark && key) {
    ark = new OpenAI({
      apiKey: key,
      baseURL: process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
    });
  }
  return ark;
}

function getOllama() {
  if (!ollama && ollamaDetected) {
    const url = getOllamaBaseUrl();
    ollama = new OpenAI({
      apiKey: 'ollama',
      baseURL: `${url}/v1`,
    });
  }
  return ollama;
}

function isOllamaAvailable() {
  return ollamaDetected;
}

async function detectOllama(): Promise<boolean> {
  try {
    const baseUrl = getOllamaBaseUrl();
    const resp = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      const models = data.models || [];
      const hasLLM = models.some((m: any) =>
        !m.name.includes('embed') && !m.name.includes('whisper')
      );
      ollamaDetected = hasLLM;
      console.log(`[LLM] Ollama detected — ${models.length} models (${hasLLM ? 'LLM available' : 'no LLM models found'})`);
      return hasLLM;
    }
  } catch {
    // Ollama not running — expected on most machines
  }
  ollamaDetected = false;
  return false;
}

function getLmStudio() {
  if (!lmstudio && lmstudioDetected) {
    const url = getLmStudioBaseUrl();
    lmstudio = new OpenAI({
      apiKey: 'lm-studio',
      baseURL: `${url}/v1`,
    });
  }
  return lmstudio;
}

function isLmStudioAvailable() {
  return lmstudioDetected;
}

function getXiaomi() {
  const key = process.env.XIAOMI_API_KEY || getKey('XIAOMI_API_KEY');
  if (!xiaomi && key) {
    xiaomi = new OpenAI({
      apiKey: key,
      baseURL: process.env.XIAOMI_BASE_URL || 'https://api.xiaomi.com/v1',
    });
  }
  return xiaomi;
}

function getKimi() {
  const key = process.env.KIMI_API_KEY || getKey('KIMI_API_KEY');
  if (key && (!kimi || kimiKey !== key)) {
    kimi = new OpenAI({
      apiKey: key,
      baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
    });
    kimiKey = key;
  }
  if (!key) {
    kimi = null;
    kimiKey = null;
  }
  return kimi;
}

function getGlm() {
  const key = process.env.GLM_API_KEY || getKey('GLM_API_KEY');
  if (!glm && key) {
    glm = new OpenAI({
      apiKey: key,
      baseURL: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    });
  }
  return glm;
}

function getRelay() {
  const key = process.env.RELAY_API_KEY || getKey('RELAY_API_KEY');
  const baseUrl = process.env.RELAY_BASE_URL || getKey('RELAY_BASE_URL') || 'https://api.example.com/v1';
  if (!relay && key) {
    relay = new OpenAI({
      apiKey: key,
      baseURL: baseUrl,
    });
  }
  return relay;
}

async function detectLmStudio(): Promise<boolean> {
  try {
    const baseUrl = getLmStudioBaseUrl();
    const resp = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      const models = data.data || [];
      const hasLLM = models.length > 0;
      lmstudioDetected = hasLLM;
      console.log(`[LLM] LM Studio detected — ${models.length} models`);
      return hasLLM;
    }
  } catch { /* LM Studio not running */ }
  lmstudioDetected = false;
  return false;
}

export function createLLMRuntime(): LLMClients {
  // Fire-and-forget: detect local Ollama and LM Studio in background
  detectOllama();
  detectLmStudio();
  return { getOpenAI, getAnthropic, getGemini, getDeepSeek, getQwen, getArk, getOllama, isOllamaAvailable, getLmStudio, isLmStudioAvailable, getXiaomi, getKimi, getGlm, getRelay };
}
