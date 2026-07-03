import fs from 'fs';
import path from 'path';
import { getDataPath } from './data_path';
import { resetCircuit } from '../cloud/circuit_breaker';

const KEYS_FILE = getDataPath('keys.json');

export interface KeyStore {
  [key: string]: string | undefined;
  DEEPGRAM_API_KEY?: string;
  PICOVOICE_ACCESS_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  QWEN_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  E2B_API_KEY?: string;
  ARK_API_KEY?: string;
  DOUBAO_SPEECH_KEY?: string;
  NETEASE_APP_ID?: string;
  NETEASE_PRIVATE_KEY?: string;
  ALIYUN_AK_ID?: string;
  ALIYUN_AK_SECRET?: string;
  SILICONFLOW_API_KEY?: string;
  XIAOMI_API_KEY?: string;
  KIMI_API_KEY?: string;
  GLM_API_KEY?: string;
  RELAY_API_KEY?: string;
  RELAY_BASE_URL?: string;
  QICHACHA_API_KEY?: string;
  QICHACHA_APP_KEY?: string;
  QICHACHA_SECRET_KEY?: string;
  QICHACHA_BASE_URL?: string;
  TIANYANCHA_API_KEY?: string;
  TIANYANCHA_BASE_URL?: string;
  PKULAW_API_KEY?: string;
  PKULAW_TOKEN?: string;
  PKULAW_BASE_URL?: string;
  PKULAW_MCP_URL?: string;
  FARUI_API_KEY?: string;
  FARUI_BASE_URL?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  WECHAT_BOT_TOKEN?: string;
  WECHAT_BOT_ID?: string;
  WECHAT_BASE_URL?: string;
  GITHUB_TOKEN?: string;
  NOTION_API_KEY?: string;
  FIGMA_ACCESS_TOKEN?: string;
}

/** Which circuit-breaker provider(s) a given key name affects */
const KEY_TO_CIRCUIT: Partial<Record<keyof KeyStore, string[]>> = {
  DASHSCOPE_API_KEY: ['qwen'],
  QWEN_API_KEY: ['qwen'],
  DEEPGRAM_API_KEY: ['deepgram'],
  OPENAI_API_KEY: ['openai'],
  ANTHROPIC_API_KEY: ['anthropic'],
  GEMINI_API_KEY: ['gemini'],
  DEEPSEEK_API_KEY: ['deepseek'],
  KIMI_API_KEY: ['kimi'],
};

export function loadKeys(): KeyStore {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

const BUILTIN_KEY_NAMES = [
  'DEEPGRAM_API_KEY',
  'PICOVOICE_ACCESS_KEY',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'QWEN_API_KEY',
  'MINIMAX_API_KEY',
  'E2B_API_KEY',
  'ARK_API_KEY',
  'DOUBAO_SPEECH_KEY',
  'NETEASE_APP_ID',
  'NETEASE_PRIVATE_KEY',
  'ALIYUN_AK_ID',
  'ALIYUN_AK_SECRET',
  'SILICONFLOW_API_KEY',
  'XIAOMI_API_KEY',
  'KIMI_API_KEY',
  'GLM_API_KEY',
  'RELAY_API_KEY',
  'RELAY_BASE_URL',
  'QICHACHA_API_KEY',
  'QICHACHA_APP_KEY',
  'QICHACHA_SECRET_KEY',
  'QICHACHA_BASE_URL',
  'TIANYANCHA_API_KEY',
  'TIANYANCHA_BASE_URL',
  'PKULAW_API_KEY',
  'PKULAW_TOKEN',
  'PKULAW_BASE_URL',
  'PKULAW_MCP_URL',
  'FARUI_API_KEY',
  'FARUI_BASE_URL',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_VERIFICATION_TOKEN',
  'WECHAT_BOT_TOKEN',
  'WECHAT_BOT_ID',
  'WECHAT_BASE_URL',
  'GITHUB_TOKEN',
  'NOTION_API_KEY',
  'FIGMA_ACCESS_TOKEN',
] as const;

const BLOCKED_CUSTOM_KEY_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'NODE_OPTIONS',
  'NODE_ENV',
  'PORT',
  'HOST',
  'JWT_SECRET',
  'LUMI_DATA_DIR',
]);

const SAFE_CUSTOM_KEY_NAME = /^[A-Z][A-Z0-9_]{2,80}$/;
const SAFE_CUSTOM_SECRET_NAME = /(?:_API_KEY|_TOKEN|_SECRET|_APP_ID|_PRIVATE_KEY|_BASE_URL|_ACCESS_KEY|_AK_ID|_AK_SECRET|_BOT_ID|_CLIENT_ID|_CLIENT_SECRET|_WEBHOOK_URL)$/;

export function isPersistableKeyName(name: string): boolean {
  if ((BUILTIN_KEY_NAMES as readonly string[]).includes(name)) return true;
  if (!SAFE_CUSTOM_KEY_NAME.test(name)) return false;
  if (BLOCKED_CUSTOM_KEY_NAMES.has(name)) return false;
  return SAFE_CUSTOM_SECRET_NAME.test(name);
}

export function saveKeys(keys: Partial<KeyStore>): void {
  const dir = path.dirname(KEYS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadKeys();
  const merged = { ...existing, ...keys };
  for (const [k, v] of Object.entries(merged)) {
    if (!v || (typeof v === 'string' && v.trim().length === 0)) {
      delete (merged as Record<string, unknown>)[k];
    }
  }
  fs.writeFileSync(KEYS_FILE, JSON.stringify(merged, null, 2));

  for (const [key, value] of Object.entries(keys)) {
    if (value && typeof value === 'string' && value.trim().length > 0) {
      process.env[key] = value.trim();
    } else {
      delete process.env[key];
    }
  }

  // Reset circuit breakers for affected providers so updated keys take effect immediately
  try {
    for (const keyName of Object.keys(keys)) {
      const circuits = KEY_TO_CIRCUIT[keyName as keyof KeyStore];
      if (circuits) {
        for (const c of circuits) {
          resetCircuit(c);
        }
      }
    }
  } catch {}
}

export function getKey(name: keyof KeyStore): string | undefined {
  const keys = loadKeys();
  return keys[name];
}

export function getAllKeyNames(): string[] {
  const names = new Set<string>(BUILTIN_KEY_NAMES);
  const stored = loadKeys();
  for (const name of Object.keys(stored)) {
    if (isPersistableKeyName(name)) names.add(name);
  }
  return [...names];
}
