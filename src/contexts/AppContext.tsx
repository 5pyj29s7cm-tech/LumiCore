import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { toast } from 'sonner';
import * as authService from '../services/authService';
import * as notificationService from '../services/notificationService';
import { socketService } from '../services/socketService';
import { saveServerKeys } from '../services/settingsKeys';
import { apiFetch } from '../services/apiClient';
import { getDomainReconciliation } from '../lib/domainSession';
import { mergeNotificationState, notificationClearStorageKey } from '../lib/notificationState';
import { translate } from '../i18n/runtime';
import { LUMI_OFFICIAL_DEFAULT_MODELS, normalizeLumiOfficialModel } from '../../shared/model_provider_capabilities';
import {
  normalizeLumiClientMode,
  type LumiClientMode,
} from '../../shared/operation_modes';

interface UserProfile {
  uid: string;
  username: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
  balance: number;
  role: string;
  phone?: string;
  provider: 'custom' | 'google';
}

interface AIConfig {
  provider: string;
  model: string;
  apiKey: string;
  selectionMode: 'pinned' | 'ordered_fallback' | 'auto';
  fallbackCandidates: Array<{ provider: string; model: string }>;
  allowCloudFallback: boolean;
  legacyMigration?: {
    migratedAt: string;
    entries: Array<{ provider: string; from: string; to: string }>;
  };
}

interface VisionConfig {
  provider: string;
  model: string;
  apiKey: string;
}

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  action?: string;
  proactiveContext?: Record<string, any>;
  timestamp: number;
  read: boolean;
}

interface ToolOverride {
  enabled: boolean;
  securityLevel?: string;
}

export type OperationMode = LumiClientMode;
export type AppearanceMode = 'system' | 'light' | 'dark';

function normalizeOperationMode(mode: unknown): OperationMode {
  return normalizeLumiClientMode(mode);
}

function normalizeAppearanceMode(mode: unknown): AppearanceMode {
  if (mode === 'system' || mode === 'light' || mode === 'dark') return mode;
  return 'dark';
}

function getSystemAppearanceMode(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getVoiceStorageKeys(domain?: 'personal' | 'work', orgId?: string | null) {
  let resolvedDomain = domain;
  let resolvedOrgId = String(orgId || '').trim();
  if (!resolvedDomain) {
    try {
      resolvedDomain = localStorage.getItem('lumi_work_domain') === 'work' ? 'work' : 'personal';
      if (resolvedDomain === 'work' && !resolvedOrgId) {
        resolvedOrgId = String(JSON.parse(localStorage.getItem('lumi_org_connection') || 'null')?.orgId || '').trim();
      }
    } catch {
      resolvedDomain = 'personal';
    }
  }
  const scope = resolvedDomain === 'work' && resolvedOrgId
    ? `org_${resolvedOrgId}`
    : resolvedDomain === 'work' ? 'org_pending' : 'personal';
  return {
    scope,
    selected: `lumi_selected_voice_id_${scope}`,
    provider: `lumi_selected_voice_provider_${scope}`,
    favorites: `lumi_favorite_voices_${scope}`,
  };
}

function readStoredVoiceId(keys: ReturnType<typeof getVoiceStorageKeys>): string | undefined {
  const scoped = localStorage.getItem(keys.selected);
  if (scoped) return scoped;
  return keys.scope === 'personal' ? (localStorage.getItem('lumi_selected_voice_id') || undefined) : undefined;
}

function readStoredFavoriteVoices(keys: ReturnType<typeof getVoiceStorageKeys>): string[] {
  try {
    const scoped = localStorage.getItem(keys.favorites);
    const raw = scoped ?? (keys.scope === 'personal' ? localStorage.getItem('lumi_favorite_voices') : null) ?? '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface OrgConnection {
  orgId: string;
  orgRole: string;
  orgName: string;
  connected: boolean;
}

export interface DomainSwitchResult {
  success: boolean;
  domain: 'personal' | 'work';
  message?: string;
  connection?: OrgConnection | null;
}

interface AppContextType {
  user: UserProfile | null;
  loading: boolean;
  aiConfig: AIConfig;
  visionConfig: VisionConfig;
  // Voice
  selectedVoiceId: string | undefined;
  setSelectedVoiceId: (id: string, provider?: string) => void;
  getSelectedVoiceIdForProvider: (provider: string) => string | undefined;
  favoriteVoices: string[];
  toggleFavoriteVoice: (id: string) => void;
  // Notifications
  notifications: NotificationItem[];
  unreadCount: number;
  addNotification: (item: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  // Tools
  toolOverrides: Record<string, ToolOverride>;
  setToolOverride: (name: string, override: ToolOverride) => void;
  // Org
  orgConnection: OrgConnection | null;
  workDomain: 'personal' | 'work';
  switchDomain: (domain: 'personal' | 'work') => Promise<DomainSwitchResult>;
  // Operation mode
  operationMode: OperationMode;
  setOperationMode: (mode: OperationMode) => void;
  // Appearance
  appearanceMode: AppearanceMode;
  resolvedAppearanceMode: 'light' | 'dark';
  setAppearanceMode: (mode: AppearanceMode) => void;
  // Core
  login: () => Promise<void>;
  logout: () => Promise<void>;
  updateBalance: (amount: number) => Promise<void>;
  refreshUser: () => Promise<void>;
  updateAIConfig: (config: Partial<AIConfig>) => void;
  updateVisionConfig: (config: Partial<VisionConfig>) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

try {
  localStorage.removeItem('lumi_doubao_speech');
  // API credentials were stored by older settings panels.  They are now
  // write-only server credentials; remove any browser copies during startup,
  // even when the user has not opened Settings yet.
  localStorage.removeItem('lumi_relay_key');
  for (const provider of ['deepseek', 'qwen', 'openai', 'gemini', 'anthropic', 'ark', 'xiaomi', 'kimi', 'glm', 'minimax', 'siliconflow']) {
    localStorage.removeItem(`lumi_${provider}_key`);
    localStorage.removeItem(`lumi_vision_${provider}_key`);
  }
  for (const key of [
    'lumi_dashscope_key',
    'lumi_github_token',
    'lumi_notion_api_key',
    'lumi_figma_access_token',
    'lumi_e2b_api_key',
  ]) localStorage.removeItem(key);
} catch {
  // Browser storage can be unavailable in non-DOM runtimes.
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiConfig, setAiConfig] = useState<AIConfig>(() => {
    const saved = localStorage.getItem('lumi_ai_config');
    if (!saved) return {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKey: '',
      selectionMode: 'pinned',
      fallbackCandidates: [],
      allowCloudFallback: true,
    };
    try {
      const parsed = JSON.parse(saved);
      const sanitized = {
        ...parsed,
        apiKey: '',
        selectionMode: parsed.provider === 'auto'
          ? 'auto'
          : parsed.selectionMode === 'ordered_fallback' ? 'ordered_fallback' : 'pinned',
        fallbackCandidates: Array.isArray(parsed.fallbackCandidates) ? parsed.fallbackCandidates : [],
        allowCloudFallback: parsed.allowCloudFallback !== false,
      };
      // Rewrite legacy persisted state immediately; otherwise a failed or
      // unauthenticated preference request could leave the old secret on disk.
      localStorage.setItem('lumi_ai_config', JSON.stringify(sanitized));
      return sanitized;
    } catch {
      localStorage.removeItem('lumi_ai_config');
      return {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        apiKey: '',
        selectionMode: 'pinned',
        fallbackCandidates: [],
        allowCloudFallback: true,
      };
    }
  });
  const modelPreferenceRequestRef = React.useRef(0);
  const aiConfigRef = React.useRef(aiConfig);
  useEffect(() => {
    aiConfigRef.current = aiConfig;
  }, [aiConfig]);
  const [visionConfig, setVisionConfig] = useState<VisionConfig>(() => {
    const saved = localStorage.getItem('lumi_vision_config');
    const fallback: VisionConfig = { provider: 'openai', model: 'gpt-4o', apiKey: '' };
    if (!saved) return fallback;
    try {
      const parsed = JSON.parse(saved);
      const sanitized = {
        ...fallback,
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        apiKey: '',
      } as VisionConfig;
      // Remove credentials left by older builds as soon as the app starts.
      localStorage.setItem('lumi_vision_config', JSON.stringify(sanitized));
      return sanitized;
    } catch {
      localStorage.removeItem('lumi_vision_config');
      return fallback;
    }
  });

  useEffect(() => {
    let cancelled = false;
    const loadModelPreferences = async () => {
      const [reasoningResponse, visionResponse] = await Promise.all([
        apiFetch('/api/preferences/llm').catch(() => null),
        apiFetch('/api/preferences/vision').catch(() => null),
      ]);
      const [reasoning, vision] = await Promise.all([
        reasoningResponse?.ok ? reasoningResponse.json().catch(() => null) : null,
        visionResponse?.ok ? visionResponse.json().catch(() => null) : null,
      ]);
      if (cancelled) return;

      if (reasoning?.provider) {
        setAiConfig(previous => {
          const next = {
            ...previous,
            provider: reasoning.provider,
            model: reasoning.model || reasoning.models?.[reasoning.provider] || previous.model,
            selectionMode: reasoning.selectionMode || (reasoning.provider === 'auto' ? 'auto' : 'pinned'),
            fallbackCandidates: Array.isArray(reasoning.fallbackCandidates) ? reasoning.fallbackCandidates : [],
            allowCloudFallback: reasoning.allowCloudFallback !== false,
            ...(reasoning.legacyMigration ? { legacyMigration: reasoning.legacyMigration } : {}),
            apiKey: '',
          };
          localStorage.setItem('lumi_ai_config', JSON.stringify(next));
          if (reasoning.models) localStorage.setItem('lumi_llm_models', JSON.stringify(reasoning.models));
          return next;
        });
      }

      if (vision?.provider) {
        setVisionConfig(previous => {
          const next = {
            ...previous,
            provider: vision.provider,
            model: vision.model || vision.models?.[vision.provider] || previous.model,
            apiKey: '',
          };
          localStorage.setItem('lumi_vision_config', JSON.stringify(next));
          if (vision.models) localStorage.setItem('lumi_vision_models', JSON.stringify(vision.models));
          return next;
        });
      }
    };
    void loadModelPreferences();
    const handleModelConfigurationChanged = () => { void loadModelPreferences(); };
    window.addEventListener('lumi:model-configuration-changed', handleModelConfigurationChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('lumi:model-configuration-changed', handleModelConfigurationChanged);
    };
  }, []);
  // Voice state
  const [selectedVoiceId, setSelectedVoiceIdState] = useState<string | undefined>(() => {
    return readStoredVoiceId(getVoiceStorageKeys());
  });
  const [favoriteVoices, setFavoriteVoices] = useState<string[]>(() => {
    return readStoredFavoriteVoices(getVoiceStorageKeys());
  });

  // Notifications state
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const unreadCount = notifications.filter(n => !n.read).length;

  // Tool overrides state
  const [toolOverrides, setToolOverrides] = useState<Record<string, ToolOverride>>(() => {
    try { return JSON.parse(localStorage.getItem('lumi_tool_overrides') || '{}'); } catch { return {}; }
  });

  // Org state
  const [orgConnection, setOrgConnection] = useState<OrgConnection | null>(() => {
    try { return JSON.parse(localStorage.getItem('lumi_org_connection') || 'null'); } catch { return null; }
  });
  const [workDomain, setWorkDomain] = useState<'personal' | 'work'>(() => {
    try { return (localStorage.getItem('lumi_work_domain') as 'personal' | 'work') || 'personal'; } catch { return 'personal'; }
  });
  const voiceStorageKeys = getVoiceStorageKeys(workDomain, orgConnection?.orgId);

  useEffect(() => {
    setSelectedVoiceIdState(readStoredVoiceId(voiceStorageKeys));
    setFavoriteVoices(readStoredFavoriteVoices(voiceStorageKeys));
  }, [voiceStorageKeys.scope]);

  const switchDomain = async (domain: 'personal' | 'work'): Promise<DomainSwitchResult> => {
    if (domain === 'personal') {
      try {
        const res = await apiFetch('/api/auth/switch-org', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: null }),
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.token) {
            localStorage.setItem('lumi_auth_token', data.token);
            socketService.refreshAuth();
          }
          setWorkDomain('personal');
          localStorage.setItem('lumi_work_domain', 'personal');
          window.dispatchEvent(new CustomEvent('lumi:domain-changed', {
            detail: { domain: 'personal', orgId: null, orgRole: null },
          }));
          return { success: true, domain: 'personal', message: translate('domainPersonalSwitched'), connection: orgConnection };
        }
        const data = await res.json().catch(() => ({}));
        return { success: false, domain: 'personal', message: data.error || translate('domainPersonalSwitchFailed'), connection: orgConnection };
      } catch (err: any) {
        return { success: false, domain: 'personal', message: err.message || translate('domainPersonalSwitchFailed'), connection: orgConnection };
      }
    }
    // Switch to work: use known org or auto-discover
    let orgId = orgConnection?.orgId || null;
    let orgRole = orgConnection?.orgRole || 'member';
    let orgName = orgConnection?.orgName || '';
    if (!orgId) {
      try {
        const orgsRes = await apiFetch('/api/auth/orgs');
        if (orgsRes.ok) {
          const { orgs } = await orgsRes.json();
          if (orgs && orgs.length > 0) {
            orgId = orgs[0].id;
            orgRole = orgs[0].role || 'member';
            orgName = orgs[0].name || orgs[0].orgName || '';
          }
        }
      } catch (err: any) {
        return { success: false, domain: 'work', message: err.message || translate('organizationListLoadFailed'), connection: orgConnection };
      }
    }
    if (!orgId) {
      return { success: false, domain: 'work', message: translate('organizationSwitchUnavailable'), connection: orgConnection };
    }
    try {
      const res = await apiFetch('/api/auth/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, orgRole }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.orgId) {
          const conn = { orgId: data.orgId, orgRole: data.orgRole, orgName, connected: true };
          if (data.token) {
            localStorage.setItem('lumi_auth_token', data.token);
            socketService.refreshAuth();
          }
          setOrgConnection(conn);
          setWorkDomain('work');
          localStorage.setItem('lumi_work_domain', 'work');
          localStorage.setItem('lumi_org_connection', JSON.stringify(conn));
          window.dispatchEvent(new CustomEvent('lumi:domain-changed', {
            detail: { domain: 'work', orgId: conn.orgId, orgRole: conn.orgRole, orgName: conn.orgName },
          }));
          return { success: true, domain: 'work', message: translate('domainWorkSwitched'), connection: conn };
        }
      }
      return { success: false, domain: 'work', message: data.error || translate('domainWorkSwitchFailed'), connection: orgConnection };
    } catch (err: any) {
      return { success: false, domain: 'work', message: err.message || translate('domainWorkSwitchFailed'), connection: orgConnection };
    }
  };

  const [operationMode, setOperationModeState] = useState<OperationMode>(() => {
    try {
      const stored = normalizeOperationMode(localStorage.getItem('lumi_operation_mode'));
      return stored === 'meeting' ? 'assistant' : stored;
    } catch { return 'assistant'; }
  });
  const operationModeRef = React.useRef(operationMode);
  const operationModeRequestRef = React.useRef(0);
  const [appearanceMode, setAppearanceModeState] = useState<AppearanceMode>(() => {
    try { return normalizeAppearanceMode(localStorage.getItem('lumi_appearance_mode')); } catch { return 'dark'; }
  });
  const [systemAppearanceMode, setSystemAppearanceMode] = useState<'light' | 'dark'>(() => getSystemAppearanceMode());
  const resolvedAppearanceMode = appearanceMode === 'system' ? systemAppearanceMode : appearanceMode;

  const setOperationMode = async (mode: OperationMode) => {
    const normalizedMode = normalizeOperationMode(mode);
    const previousMode = operationModeRef.current;
    const requestId = ++operationModeRequestRef.current;
    operationModeRef.current = normalizedMode;
    setOperationModeState(normalizedMode);
    // Meeting is a live capture state. Persist assistant locally so a crash or
    // restart never reopens the microphone without a fresh user action.
    localStorage.setItem('lumi_operation_mode', normalizedMode === 'meeting' ? 'assistant' : normalizedMode);
    try {
      const response = await apiFetch('/api/preferences/operation_mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: normalizedMode }),
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      if (operationModeRequestRef.current !== requestId) return;
      operationModeRef.current = previousMode;
      setOperationModeState(previousMode);
      localStorage.setItem('lumi_operation_mode', previousMode === 'meeting' ? 'assistant' : previousMode);
      toast.error('Operation mode could not be synchronized');
    }
  };

  useEffect(() => {
    operationModeRef.current = operationMode;
  }, [operationMode]);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    const requestVersion = operationModeRequestRef.current;
    apiFetch('/api/preferences/operation_mode')
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (cancelled || operationModeRequestRef.current !== requestVersion) return;
        const serverMode = normalizeOperationMode(data?.mode);
        const restoredMode = serverMode === 'meeting' ? 'assistant' : serverMode;
        operationModeRef.current = restoredMode;
        setOperationModeState(restoredMode);
        localStorage.setItem('lumi_operation_mode', restoredMode);
        if (serverMode === 'meeting') {
          await apiFetch('/api/preferences/operation_mode', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'assistant' }),
            credentials: 'include',
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.uid]);

  const setAppearanceMode = (mode: AppearanceMode) => {
    const normalizedMode = normalizeAppearanceMode(mode);
    setAppearanceModeState(normalizedMode);
    localStorage.setItem('lumi_appearance_mode', normalizedMode);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const syncSystemAppearance = () => setSystemAppearanceMode(media.matches ? 'light' : 'dark');
    syncSystemAppearance();
    media.addEventListener?.('change', syncSystemAppearance);
    return () => media.removeEventListener?.('change', syncSystemAppearance);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-mode', resolvedAppearanceMode);
    document.documentElement.style.colorScheme = resolvedAppearanceMode;
  }, [resolvedAppearanceMode]);

  const updateAIConfig = (newConfig: Partial<AIConfig>) => {
    const requestRevision = ++modelPreferenceRequestRef.current;
    const previous = aiConfigRef.current;
    const resolved = { ...newConfig };
    if (newConfig.provider && !newConfig.model) {
      const savedModels = (() => {
        try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
      })();
      const defaults: Record<string, string> = {
        qwen: 'qwen-plus', deepseek: 'deepseek-v4-flash', openai: 'gpt-4o',
        gemini: 'gemini-2.0-flash', anthropic: 'claude-sonnet-4-6',
        ark: 'doubao-seed-2-0-lite-260215', xiaomi: 'mimo-v2.5-pro',
        kimi: 'moonshot-v1-8k', glm: 'glm-5.1', relay: LUMI_OFFICIAL_DEFAULT_MODELS.reasoning,
        ollama: 'qwen2.5:7b', lmstudio: 'local-model', auto: 'qwen2.5:7b',
      };
      resolved.model = newConfig.provider === 'relay'
        ? normalizeLumiOfficialModel('reasoning', savedModels[newConfig.provider] || defaults[newConfig.provider])
        : savedModels[newConfig.provider] || defaults[newConfig.provider] || '';
    }
    const updated = { ...previous, ...resolved };
    // API keys are write-only server credentials. Never mirror a typed key in
    // localStorage (or keep it in the long-lived context state) even for the
    // short window before the save request resolves.
    const persisted = { ...updated, apiKey: '' };
    aiConfigRef.current = persisted;
    setAiConfig(persisted);
    localStorage.setItem('lumi_ai_config', JSON.stringify(persisted));

    if (updated.apiKey && updated.provider) {
      const KEY_MAP: Record<string, string> = {
        qwen: 'DASHSCOPE_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY',
        gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', ark: 'ARK_API_KEY',
        xiaomi: 'XIAOMI_API_KEY', kimi: 'KIMI_API_KEY', glm: 'GLM_API_KEY', relay: 'RELAY_API_KEY',
      };
      const serverKey = KEY_MAP[updated.provider];
      if (serverKey) {
        saveServerKeys({ [serverKey]: updated.apiKey })
          .catch(err => toast.error(err.message || 'API key save failed'));
      }
    }

    if (!updated.provider && !updated.model) return;
    const allModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
    })();
    if (updated.model && updated.provider) allModels[updated.provider] = updated.model;
    void apiFetch('/api/preferences/llm', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: updated.provider || previous.provider,
        model: updated.model,
        models: allModels,
        selectionMode: updated.selectionMode,
        fallbackCandidates: updated.fallbackCandidates,
        allowCloudFallback: updated.allowCloudFallback,
      }),
      credentials: 'include',
    }).then(async response => {
      const confirmed = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(confirmed.error || 'Model preference update failed');
      if (modelPreferenceRequestRef.current !== requestRevision) return;
      const synchronized = {
        ...updated,
        provider: confirmed.provider || updated.provider,
        model: confirmed.model || updated.model,
        selectionMode: confirmed.selectionMode || updated.selectionMode,
        fallbackCandidates: Array.isArray(confirmed.fallbackCandidates)
          ? confirmed.fallbackCandidates
          : updated.fallbackCandidates,
        allowCloudFallback: confirmed.allowCloudFallback !== false,
        ...(confirmed.legacyMigration ? { legacyMigration: confirmed.legacyMigration } : {}),
        apiKey: '',
      };
      aiConfigRef.current = synchronized;
      setAiConfig(synchronized);
      localStorage.setItem('lumi_ai_config', JSON.stringify(synchronized));
      if (confirmed.models) localStorage.setItem('lumi_llm_models', JSON.stringify(confirmed.models));
      window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed'));
      toast.success('Neural core configuration synchronized');
    }).catch(error => {
      if (modelPreferenceRequestRef.current !== requestRevision) return;
      const safePrevious = { ...previous, apiKey: '' };
      aiConfigRef.current = safePrevious;
      setAiConfig(safePrevious);
      localStorage.setItem('lumi_ai_config', JSON.stringify(safePrevious));
      toast.error(error?.message || 'Model preference update failed');
    });
  };

  const updateVisionConfig = (newConfig: Partial<VisionConfig>) => {
    setVisionConfig(prev => {
      let resolved = { ...newConfig };
      if (newConfig.provider && !newConfig.model) {
        const savedModels = (() => {
          try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
        })();
        const defaults: Record<string, string> = {
          openai: 'gpt-4o',
          gemini: 'gemini-2.0-flash',
          ark: 'doubao-1-5-vision-pro-32k',
          qwen: 'qwen-vl-max',
          ollama: 'qwen2.5vl:7b',
          lmstudio: 'local-vision-model',
          relay: LUMI_OFFICIAL_DEFAULT_MODELS.vision,
        };
        resolved.model = savedModels[newConfig.provider] || defaults[newConfig.provider] || '';
      }

      const updated = { ...prev, ...resolved };
      const persisted = { ...updated, apiKey: '' };
      localStorage.setItem('lumi_vision_config', JSON.stringify(persisted));

      if (updated.apiKey && updated.provider) {
        const KEY_MAP: Record<string, string> = {
          openai: 'OPENAI_API_KEY',
          gemini: 'GEMINI_API_KEY',
          ark: 'ARK_API_KEY',
          qwen: 'DASHSCOPE_API_KEY',
          relay: 'RELAY_API_KEY',
        };
        const serverKey = KEY_MAP[updated.provider];
        if (serverKey) {
          saveServerKeys({ [serverKey]: updated.apiKey })
            .catch(err => toast.error(err.message || 'Vision API key save failed'));
        }
      }

      const allModels = (() => {
        try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
      })();
      if (updated.provider && updated.model) {
        allModels[updated.provider] = updated.model;
        localStorage.setItem('lumi_vision_models', JSON.stringify(allModels));
      }
      apiFetch('/api/preferences/vision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: updated.provider, model: updated.model, models: allModels }),
        credentials: 'include',
      }).catch(() => {});

      return persisted;
    });
    toast.success('Vision model configuration synchronized');
  };

  const refreshUser = async () => {
    try {
      const customAuth = await authService.getMe();
      if (customAuth) {
        setUser({ ...customAuth.user, provider: 'custom' } as any);
        // Sync org connection from user data
        const u = customAuth.user as any;
        if (u?.orgId) {
          const conn: OrgConnection = { orgId: u.orgId, orgRole: u.orgRole || 'member', orgName: '', connected: true };
          setOrgConnection(conn);
          localStorage.setItem('lumi_org_connection', JSON.stringify(conn));
        }
        // Load persisted notifications from server
        try {
          const notifData = await notificationService.fetchNotifications();
          const clearKey = notificationClearStorageKey(String(customAuth.user.uid || ''));
          const clearedAt = Number(localStorage.getItem(clearKey) || 0);
          const proactiveGreetingEnabled = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
          setNotifications(prev => mergeNotificationState(
            prev,
            Array.isArray(notifData.notifications) ? notifData.notifications as NotificationItem[] : [],
            { clearedAt, allowGreeting: proactiveGreetingEnabled, limit: 50 },
          ));
        } catch {}
        // Load tool overrides from server
        try {
          const toRes = await apiFetch('/api/settings/tool_overrides');
          if (toRes.ok) {
            const serverOverrides = await toRes.json();
            if (serverOverrides && Object.keys(serverOverrides).length > 0) {
              setToolOverrides(serverOverrides);
              localStorage.setItem('lumi_tool_overrides', JSON.stringify(serverOverrides));
            }
          }
        } catch {}
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error('Error refreshing user:', error);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      setLoading(true);
      try {
        // Refresh the process-bound desktop session capability on every native
        // client load, even when a still-valid JWT survived a backend restart.
        if (authService.isNativeDesktopRuntime()) {
          let nativeSession = await authService.bootstrap();
          for (let retry = 0; !nativeSession.success && retry < 8 && !cancelled; retry++) {
            await new Promise(resolve => setTimeout(resolve, 500 + retry * 500));
            nativeSession = await authService.bootstrap();
          }
          if (nativeSession.success) socketService.refreshAuth();
        }
        let me = await authService.getMe();
        if (!me && !cancelled) {
          // Clear stale token so apiBridge sends fresh one after bootstrap
          try { localStorage.removeItem('lumi_auth_token'); } catch {}
          let result = await authService.bootstrap();
          for (let retry = 0; !result.success && retry < 8 && !cancelled; retry++) {
            const delay = 500 + retry * 500; // 0.5s, 1s, 1.5s, ..., 4s
            console.log(`[Auth] Bootstrap retry ${retry + 1}/8 in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            result = await authService.bootstrap();
          }
          if (result.success && !cancelled) {
            console.log('[Auth] Auto-logged in via bootstrap as', result.user?.username);
            socketService.refreshAuth();
            me = await authService.getMe();
          } else if (!cancelled) {
            console.warn('[Auth] Bootstrap failed after retries:', result.error);
          }
        }
        if (me && !cancelled) {
          const desiredDomain = (() => {
            try { return localStorage.getItem('lumi_work_domain') === 'work' ? 'work' : 'personal'; }
            catch { return 'personal'; }
          })();
          const activeOrgId = String((me.user as any)?.orgId || '');
          const preferredOrgId = String(orgConnection?.orgId || '');
          const reconciliation = getDomainReconciliation(desiredDomain, activeOrgId, preferredOrgId);
          let domainResult: DomainSwitchResult | null = null;
          if (reconciliation === 'switch_personal') domainResult = await switchDomain('personal');
          if (reconciliation === 'switch_work') domainResult = await switchDomain('work');
          if (domainResult && !domainResult.success) {
            const fallback = await switchDomain('personal');
            if (!fallback.success) {
              try { localStorage.removeItem('lumi_auth_token'); } catch {}
              const bootstrapped = await authService.bootstrap();
              if (bootstrapped.success) socketService.refreshAuth();
            }
            setWorkDomain('personal');
            localStorage.setItem('lumi_work_domain', 'personal');
          }
        }
        if (!cancelled) await refreshUser();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => { cancelled = true; };
  }, []);

  const login = async () => {
    window.dispatchEvent(new CustomEvent('lumi:open-login'));
  };

  const logout = async () => {
    try {
      await authService.logout();
      setUser(null);
      toast.info('Returned to the mortal realm');
    } catch (error: any) {
      toast.error('Logout failed: ' + error.message);
    }
  };

  const updateBalance = async (amount: number) => {
    setUser((prev) => prev ? { ...prev, balance: (prev.balance || 0) + amount } : prev);
  };

  const setSelectedVoiceId = useCallback((id: string, provider?: string) => {
    setSelectedVoiceIdState(id);
    localStorage.setItem(voiceStorageKeys.selected, id);
    if (provider) {
      localStorage.setItem(voiceStorageKeys.provider, provider);
      localStorage.setItem(`${voiceStorageKeys.selected}_provider_${provider}`, id);
    }
  }, [voiceStorageKeys.provider, voiceStorageKeys.selected]);

  const getSelectedVoiceIdForProvider = useCallback((provider: string) => {
    if (!provider) return undefined;
    return localStorage.getItem(`${voiceStorageKeys.selected}_provider_${provider}`) || undefined;
  }, [voiceStorageKeys.selected]);

  const toggleFavoriteVoice = (id: string) => {
    setFavoriteVoices(prev => {
      const next = prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id];
      localStorage.setItem(voiceStorageKeys.favorites, JSON.stringify(next));
      return next;
    });
  };

  const addNotification = (item: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => {
    const notification: NotificationItem = {
      ...item,
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      read: false,
    };
    setNotifications(prev => [notification, ...prev].slice(0, 50));
  };

  const markAllNotificationsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    void notificationService.markAllNotificationsRead().catch(err => {
      console.warn('Failed to persist notification read state:', err);
    });
  };

  const clearNotifications = () => {
    const clearedAt = Date.now();
    if (user?.uid) {
      localStorage.setItem(notificationClearStorageKey(user.uid), String(clearedAt));
    }
    setNotifications([]);
    void notificationService.clearAllNotifications().catch(err => {
      console.warn('Failed to clear persisted notifications:', err);
      toast.error('Notifications were hidden locally, but server cleanup will retry later.');
    });
  };

  const setToolOverride = (name: string, override: ToolOverride) => {
    setToolOverrides(prev => {
      const next = { ...prev, [name]: override };
      localStorage.setItem('lumi_tool_overrides', JSON.stringify(next));
      // Sync to server for tool registry awareness
      apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: 'tool_overrides', value: next }),
      }).catch(() => {});
      return next;
    });
  };

  return (
    <AppContext.Provider value={{
      user,
      loading,
      aiConfig,
      visionConfig,
      selectedVoiceId,
      setSelectedVoiceId,
      getSelectedVoiceIdForProvider,
      favoriteVoices,
      toggleFavoriteVoice,
      notifications,
      unreadCount,
      addNotification,
      markAllNotificationsRead,
      clearNotifications,
      toolOverrides,
      setToolOverride,
      orgConnection,
      workDomain,
      switchDomain,
      operationMode,
      setOperationMode,
      appearanceMode,
      resolvedAppearanceMode,
      setAppearanceMode,
      login,
      logout,
      updateBalance,
      refreshUser,
      updateAIConfig,
      updateVisionConfig,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
