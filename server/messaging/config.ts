/**
 * Messaging config store — initialized from .env, mutable at runtime, persisted to disk.
 * This allows the Feishu settings UI to update config without restarting the server.
 */
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';

const CONFIG_FILE = getDataPath('messaging.json');

export interface MessagingConfig {
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken?: string;
    transport: 'long_connection' | 'webhook';
    enabled: boolean;
  };
  wecom: {
    mode: 'aibot_long_connection' | 'app_webhook';
    botId: string;
    botSecret: string;
    corpId: string;
    agentId: string;
    appSecret: string;
    token: string;
    encodingAESKey: string;
    enabled: boolean;
  };
  wechat: {
    botToken: string;
    botId: string;
    baseUrl: string;
    enabled: boolean;
  };
}

function feishuReady(config: MessagingConfig['feishu']): boolean {
  if (!config.appId || !config.appSecret) return false;
  return config.transport === 'long_connection' || Boolean(config.verificationToken);
}

function wecomReady(config: MessagingConfig['wecom']): boolean {
  if (config.mode === 'aibot_long_connection') return Boolean(config.botId && config.botSecret);
  return Boolean(config.corpId && config.agentId && config.appSecret && config.token && config.encodingAESKey);
}

function loadFromEnv(): MessagingConfig {
  const feishuTransport = process.env.FEISHU_TRANSPORT === 'webhook'
    || (!process.env.FEISHU_TRANSPORT && process.env.FEISHU_VERIFICATION_TOKEN)
    ? 'webhook'
    : 'long_connection';
  const hasLegacyWeComEnv = Boolean(process.env.WECOM_CORP_ID || process.env.WECOM_AGENT_ID || process.env.WECOM_APP_SECRET);
  const wecomMode = process.env.WECOM_MODE === 'app_webhook'
    || (!process.env.WECOM_MODE && hasLegacyWeComEnv)
    ? 'app_webhook'
    : 'aibot_long_connection';
  return {
    feishu: {
      appId: process.env.FEISHU_APP_ID || '',
      appSecret: process.env.FEISHU_APP_SECRET || '',
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || undefined,
      transport: feishuTransport,
      enabled: !!(
        process.env.FEISHU_APP_ID
        && process.env.FEISHU_APP_SECRET
        && (feishuTransport !== 'webhook' || process.env.FEISHU_VERIFICATION_TOKEN)
      ),
    },
    wecom: {
      mode: wecomMode,
      botId: process.env.WECOM_BOT_ID || '',
      botSecret: process.env.WECOM_BOT_SECRET || '',
      corpId: process.env.WECOM_CORP_ID || '',
      agentId: process.env.WECOM_AGENT_ID || '',
      appSecret: process.env.WECOM_APP_SECRET || '',
      token: process.env.WECOM_TOKEN || '',
      encodingAESKey: process.env.WECOM_ENCODING_AES_KEY || '',
      enabled: wecomMode === 'aibot_long_connection'
        ? !!(process.env.WECOM_BOT_ID && process.env.WECOM_BOT_SECRET)
        : !!(
          process.env.WECOM_CORP_ID
          && process.env.WECOM_AGENT_ID
          && process.env.WECOM_APP_SECRET
          && process.env.WECOM_TOKEN
          && process.env.WECOM_ENCODING_AES_KEY
        ),
    },
    wechat: {
      botToken: process.env.WECHAT_BOT_TOKEN || '',
      botId: process.env.WECHAT_BOT_ID || '',
      baseUrl: process.env.WECHAT_BASE_URL || 'https://ilinkai.weixin.qq.com',
      enabled: !!(process.env.WECHAT_BOT_TOKEN && process.env.WECHAT_BOT_ID),
    },
  };
}

function loadFromFile(): MessagingConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveToFile(config: MessagingConfig): void {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function definedValues<T extends Record<string, any>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function normalizeMessagingConfig(raw: Partial<MessagingConfig> | null, fallback: MessagingConfig): MessagingConfig {
  const feishu = { ...fallback.feishu, ...definedValues((raw?.feishu || {}) as MessagingConfig['feishu']) };
  const legacyFeishuWebhook = Boolean(
    raw?.feishu
    && !Object.prototype.hasOwnProperty.call(raw.feishu, 'transport')
    && raw.feishu.verificationToken,
  );
  feishu.transport = feishu.transport === 'webhook' || legacyFeishuWebhook ? 'webhook' : 'long_connection';
  feishu.enabled = feishuReady(feishu);

  const wecom = { ...fallback.wecom, ...definedValues((raw?.wecom || {}) as MessagingConfig['wecom']) };
  const legacyWeComWebhook = Boolean(
    raw?.wecom
    && !Object.prototype.hasOwnProperty.call(raw.wecom, 'mode')
    && (raw.wecom.corpId || raw.wecom.agentId || raw.wecom.appSecret),
  );
  wecom.mode = wecom.mode === 'app_webhook' || legacyWeComWebhook ? 'app_webhook' : 'aibot_long_connection';
  wecom.enabled = wecomReady(wecom);

  const wechat = { ...fallback.wechat, ...definedValues((raw?.wechat || {}) as MessagingConfig['wechat']) };
  wechat.enabled = Boolean(wechat.botToken && wechat.botId);
  return { feishu, wecom, wechat };
}

// Init: file overrides env (so user changes persist across restarts)
const fileConfig = loadFromFile();
let _config: MessagingConfig = normalizeMessagingConfig(fileConfig, loadFromEnv());
let _configured = _config.feishu.enabled || _config.wecom.enabled || _config.wechat.enabled;

export function getMessagingConfig(): MessagingConfig {
  return _config;
}

export function isMessagingConfigured(): boolean {
  return _configured;
}

export function updateMessagingConfig(
  partial: Partial<MessagingConfig['feishu']> & { wecom?: Partial<MessagingConfig['wecom']>; wechat?: Partial<MessagingConfig['wechat']> },
): MessagingConfig {
  if (partial.wechat) {
    _config = { ..._config, wechat: { ..._config.wechat, ...definedValues(partial.wechat) } };
    _config.wechat.enabled = !!(_config.wechat.botToken && _config.wechat.botId);
  } else if (partial.wecom) {
    _config = { ..._config, wecom: { ..._config.wecom, ...definedValues(partial.wecom) } };
    _config.wecom.mode = _config.wecom.mode === 'aibot_long_connection' ? 'aibot_long_connection' : 'app_webhook';
    _config.wecom.enabled = wecomReady(_config.wecom);
  } else {
    _config = { ..._config, feishu: { ..._config.feishu, ...definedValues(partial as Partial<MessagingConfig['feishu']>) } };
    _config.feishu.transport = _config.feishu.transport === 'webhook' ? 'webhook' : 'long_connection';
    _config.feishu.enabled = feishuReady(_config.feishu);
  }
  _configured = _config.feishu.enabled || _config.wecom.enabled || _config.wechat.enabled;
  saveToFile(_config);
  return _config;
}
