import { cancelAppConfirm } from '../lib/appConfirm';
import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { toast } from 'sonner';
import * as authService from '../services/authService';
import * as notificationService from '../services/notificationService';
import { socketService } from '../services/socketService';
import { saveServerKeys } from '../services/settingsKeys';
import { apiFetch, apiJson } from '../services/apiClient';
import { getDomainReconciliation } from '../lib/domainSession';
import { setLegalCaseAccount } from '../lib/legalCaseStore';
import { mergeNotificationState, notificationClearStorageKey } from '../lib/notificationState';
import { translate } from '../i18n/runtime';
import { normalizeLumiOfficialModel } from '../../shared/model_provider_capabilities';
import type { NotificationItem as StoredNotificationItem } from '../types/models';
import {
  normalizeLumiClientMode,
  type LumiClientMode,
  normalizeDesktopExecutionPreference, type DesktopExecutionPreference,
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

interface AIConfig extends VisionConfig {
  selectionMode: 'pinned' | 'ordered_fallback' | 'auto';
  fallbackCandidates: Array<{ provider: string; model: string }>;
  allowCloudFallback: boolean;
  legacyMigration?: {
    migratedAt: string;
    entries: Array<{ provider: string; from: string; to: string }>;
  };
}

interface VisionConfig {
  ready: boolean;
  loadError: string;
  models: Record<string, string>;
  provider: string;
  model: string;
  apiKey: string;
}

type NotificationItem = Omit<StoredNotificationItem, 'userId'>;

interface ToolOverride {
  enabled: boolean;
  securityLevel?: string;
}

export type OperationMode = LumiClientMode;
export type AppearanceMode = 'system' | 'light' | 'dark';

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
  notificationsBusy: boolean;
  unreadCount: number;
  addNotification: (item: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => void;
  markAllNotificationsRead: () => Promise<boolean>;
  clearNotifications: () => Promise<boolean>;
  // Tools
  toolOverrides: Record<string, ToolOverride>;
  setToolOverride: (name: string, override: ToolOverride) => void;
  workbenchDrafts: Map<string, unknown>;
  // Org
  orgConnection: OrgConnection | null;
  workDomain: 'personal' | 'work';
  switchDomain: (domain: 'personal' | 'work', options?: { orgId?: string; orgName?: string; signal?: AbortSignal }) => Promise<DomainSwitchResult>;
  // Operation mode
  operationMode: OperationMode;
  setOperationMode: (mode: OperationMode) => void;
  desktopExecutionPreference: DesktopExecutionPreference;
  setDesktopExecutionPreference: (preference: DesktopExecutionPreference) => Promise<boolean>;
  // Appearance
  appearanceMode: AppearanceMode;
  resolvedAppearanceMode: 'light' | 'dark';
  setAppearanceMode: (mode: AppearanceMode) => void;
  // Core
  login: () => Promise<void>;
  logout: () => Promise<void>;
  updateBalance: (amount: number) => Promise<void>;
  refreshUser: () => Promise<void>;
  updateAIConfig: (config: Partial<AIConfig>, models?: Record<string, string>) => Promise<boolean>;
  updateVisionConfig: (config: Partial<VisionConfig>, models?: Record<string, string>) => Promise<boolean>;
  reloadModelPreferences: (role?: 'llm' | 'vision') => Promise<void>;
}

const DEFAULT_AI_CONFIG: AIConfig = { ready: false, loadError: '', provider: 'deepseek', model: 'deepseek-v4-flash', models: {}, apiKey: '', selectionMode: 'pinned', fallbackCandidates: [], allowCloudFallback: true };
const DEFAULT_VISION_CONFIG: VisionConfig = { ready: false, loadError: '', provider: 'openai', model: 'gpt-4o', models: {}, apiKey: '' };
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
    'lumi_ai_config', 'lumi_vision_config', 'lumi_llm_models', 'lumi_vision_models',
    'lumi_dashscope_key',
    'lumi_github_token',
    'lumi_notion_api_key',
    'lumi_figma_access_token',
    'lumi_e2b_api_key',
  ]) localStorage.removeItem(key);
} catch {
  // Browser storage can be unavailable in non-DOM runtimes.
}

function useAppSessionAndPreferences({ children }: { children: ReactNode }) {

  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiConfig, setAiConfig] = useState<AIConfig>(DEFAULT_AI_CONFIG);
  const modelPreferenceRequestRef = React.useRef(0);
  const authGenerationRef = React.useRef(0);
  const domainSwitchRequest = React.useRef<AbortController | null>(null);
  const aiConfigRef = React.useRef(aiConfig);
  useEffect(() => () => { authGenerationRef.current += 1; domainSwitchRequest.current?.abort(); notificationWriteRef.current?.abort(); setLegalCaseAccount(); }, []);
  const [visionConfig, setVisionConfig] = useState<VisionConfig>(DEFAULT_VISION_CONFIG);
  const visionConfigRef = React.useRef(visionConfig);
  const visionPreferenceRequestRef = React.useRef(0);
  const modelWriteTailsRef = React.useRef<Record<'llm' | 'vision', Promise<unknown>>>({ llm: Promise.resolve(), vision: Promise.resolve() });
  const modelReads = React.useRef<Partial<Record<'llm' | 'vision', AbortController>>>({});
  const modelAccountRef = React.useRef<string | undefined>(undefined);
  const setSessionUser = (next: UserProfile | null) => {
    setLegalCaseAccount(next?.uid);
    if (modelAccountRef.current !== next?.uid) {
      Object.values(modelReads.current).forEach(read => read.abort());
      authGenerationRef.current++;
      domainSwitchRequest.current?.abort(); domainSwitchRequest.current = null;
      modelAccountRef.current = next?.uid;
      aiConfigRef.current = DEFAULT_AI_CONFIG; setAiConfig(DEFAULT_AI_CONFIG);
      visionConfigRef.current = DEFAULT_VISION_CONFIG; setVisionConfig(DEFAULT_VISION_CONFIG);
      modelWriteTailsRef.current = { llm: Promise.resolve(), vision: Promise.resolve() };
      notificationWriteRef.current?.abort(); notificationWriteRef.current = null;
      notificationRevisionRef.current++; setNotifications([]); setNotificationsBusy(false);
    }
    setUser(next);
  };
  const setModelState = useCallback((role: 'llm' | 'vision', patch: Partial<AIConfig>) => {
    if (role === 'llm') { aiConfigRef.current = { ...aiConfigRef.current, ...patch }; setAiConfig(aiConfigRef.current); }
    else { visionConfigRef.current = { ...visionConfigRef.current, ...patch }; setVisionConfig(visionConfigRef.current); }
  }, []);
  const applyModelPreference = useCallback((role: 'llm' | 'vision', confirmed: Record<string, any>) => {
    if (typeof confirmed?.provider !== 'string' || !confirmed.provider.trim() || typeof confirmed.model !== 'string'
      || !confirmed.models || typeof confirmed.models !== 'object' || Array.isArray(confirmed.models)
      || Object.values(confirmed.models).some(model => typeof model !== 'string')
      || (role === 'llm' && ((confirmed.selectionMode !== undefined && !['auto', 'pinned', 'ordered_fallback'].includes(confirmed.selectionMode))
        || (confirmed.allowCloudFallback !== undefined && typeof confirmed.allowCloudFallback !== 'boolean')
        || (confirmed.legacyMigration !== undefined && (typeof confirmed.legacyMigration?.migratedAt !== 'string' || !Array.isArray(confirmed.legacyMigration.entries)
          || confirmed.legacyMigration.entries.some((entry: any) => ['provider', 'from', 'to'].some(key => typeof entry?.[key] !== 'string'))))
        || (confirmed.fallbackCandidates !== undefined && (!Array.isArray(confirmed.fallbackCandidates) || confirmed.fallbackCandidates.some((item: any) => typeof item?.provider !== 'string' || typeof item.model !== 'string')))))) throw new Error('Model preference confirmation missing or invalid');
    const current = role === 'llm' ? DEFAULT_AI_CONFIG : DEFAULT_VISION_CONFIG;
    const next = {
      ...current,
      ready: true, loadError: '',
      provider: confirmed.provider,
      model: confirmed.model || confirmed.models[confirmed.provider] || '',
      apiKey: '', models: confirmed.models || {},
      ...(role === 'llm' ? {
        selectionMode: confirmed.selectionMode || (confirmed.provider === 'auto' ? 'auto' : 'pinned'),
        fallbackCandidates: Array.isArray(confirmed.fallbackCandidates) ? confirmed.fallbackCandidates : [],
        allowCloudFallback: confirmed.allowCloudFallback !== false,
        ...(confirmed.legacyMigration ? { legacyMigration: confirmed.legacyMigration } : {}),
      } : {}),
    };
    setModelState(role, next);
  }, [setModelState]);

  const reloadModelPreferences = useCallback(async (selectedRole?: 'llm' | 'vision') => {
    if (!modelAccountRef.current) return;
    const owner = authGenerationRef.current;
    await Promise.all((selectedRole ? [selectedRole] : ['llm', 'vision'] as const).map(async role => {
      modelReads.current[role]?.abort();
      const request = new AbortController(); modelReads.current[role] = request;
      const revision = role === 'llm' ? modelPreferenceRequestRef : visionPreferenceRequestRef, started = revision.current;
      const isCurrent = () => !request.signal.aborted && owner === authGenerationRef.current && started === revision.current;
      setModelState(role, { ready: false, loadError: '' });
      try {
        await modelWriteTailsRef.current[role];
        if (!isCurrent()) return;
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
        const confirmed = await apiJson(`/api/preferences/${role}`, { signal });
        signal.throwIfAborted();
        if (isCurrent()) applyModelPreference(role, confirmed);
      } catch (error: any) {
        if (isCurrent()) setModelState(role, { ready: false, loadError: error?.message || 'Model preferences could not be loaded' });
      } finally { if (modelReads.current[role] === request) delete modelReads.current[role]; }
    }));
  }, [applyModelPreference, setModelState]);
  useEffect(() => {
    void reloadModelPreferences();
    const reload = (event: Event) => { if ((event as CustomEvent).detail?.source !== 'app-context') void reloadModelPreferences(); };
    window.addEventListener('lumi:model-configuration-changed', reload);
    return () => {
      Object.values(modelReads.current).forEach(read => read.abort());
      window.removeEventListener('lumi:model-configuration-changed', reload);
    };
  }, [reloadModelPreferences, user?.uid]);
  // Voice state
  const [selectedVoiceId, setSelectedVoiceIdState] = useState<string | undefined>(() => {
    return readStoredVoiceId(getVoiceStorageKeys());
  });
  const [favoriteVoices, setFavoriteVoices] = useState<string[]>(() => {
    return readStoredFavoriteVoices(getVoiceStorageKeys());
  });

  // Notifications state
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const notificationRevisionRef = React.useRef(0), notificationWriteRef = React.useRef<AbortController | null>(null);
  const unreadCount = notifications.filter(n => !n.read).length;

  // Tool overrides state
  const [toolOverrides, setToolOverrides] = useState<Record<string, ToolOverride>>(() => {
    try { return JSON.parse(localStorage.getItem('lumi_tool_overrides') || '{}'); } catch { return {}; }
  });
  const toolOverridesRef = React.useRef(toolOverrides);
  const toolWriteTailRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const toolRequestRef = React.useRef(0);

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

  const switchDomain = async (domain: 'personal' | 'work', options: { orgId?: string; orgName?: string; signal?: AbortSignal } = {}): Promise<DomainSwitchResult> => {
    const isWork = domain === 'work', owner = authGenerationRef.current;
    const failureMessage = translate(isWork ? 'domainWorkSwitchFailed' : 'domainPersonalSwitchFailed');
    const failure = (message = failureMessage): DomainSwitchResult => ({ success: false, domain, message, connection: orgConnection });
    if (domainSwitchRequest.current || options.signal?.aborted) return failure();
    const request = new AbortController(); domainSwitchRequest.current = request;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]);
    const current = () => !signal.aborted && owner === authGenerationRef.current && domainSwitchRequest.current === request;
    try {
      let orgId = isWork ? options.orgId || orgConnection?.orgId || null : null;
      let orgName = options.orgName ?? orgConnection?.orgName ?? '';
      if (isWork && !orgId) {
        const data = await apiJson('/api/auth/orgs', { signal });
        if (!Array.isArray(data?.orgs)) throw new Error(translate('organizationListLoadFailed'));
        orgId = typeof data.orgs[0]?.id === 'string' ? data.orgs[0].id : null;
        orgName = data.orgs[0]?.name || data.orgs[0]?.orgName || '';
      }
      if (isWork && !orgId) return failure(translate('organizationSwitchUnavailable'));
      if (!current()) return failure();
      const data = await apiJson('/api/auth/switch-org', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }), credentials: 'include',
      });
      if (!current()) return failure();
      if (data?.success !== true || data.orgId !== orgId || typeof data.token !== 'string' || !data.token
        || (isWork && !['owner', 'admin', 'member', 'viewer'].includes(data.orgRole))
        || (!isWork && data.orgRole !== null)) throw new Error(failureMessage);
      const connection = isWork ? { orgId: data.orgId, orgRole: data.orgRole, orgName, connected: true } : orgConnection;
      localStorage.setItem('lumi_auth_token', data.token);
      socketService.refreshAuth();
      if (isWork) {
        setOrgConnection(connection); localStorage.setItem('lumi_org_connection', JSON.stringify(connection));
      }
      setWorkDomain(domain); localStorage.setItem('lumi_work_domain', domain);
      window.dispatchEvent(new CustomEvent('lumi:domain-changed', {
        detail: isWork ? { domain, orgId: connection!.orgId, orgRole: connection!.orgRole, orgName: connection!.orgName } : { domain, orgId: null, orgRole: null },
      }));
      return { success: true, domain, message: translate(isWork ? 'domainWorkSwitched' : 'domainPersonalSwitched'), connection };
    } catch (error) {
      return failure(error instanceof Error ? error.message : failureMessage);
    } finally { if (domainSwitchRequest.current === request) domainSwitchRequest.current = null; }
  };

  const [operationMode, setOperationModeState] = useState<OperationMode>(() => {
    try {
      const stored = normalizeLumiClientMode(localStorage.getItem('lumi_operation_mode'));
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
    const normalizedMode = normalizeLumiClientMode(mode);
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
    if (!user?.uid) return;
    let cancelled = false;
    const requestVersion = operationModeRequestRef.current;
    apiFetch('/api/preferences/operation_mode')
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (cancelled || operationModeRequestRef.current !== requestVersion) return;
        const serverMode = normalizeLumiClientMode(data?.mode);
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

  const [desktopPreferenceState, setDesktopPreferenceState] = useState<{ userId: string; preference: DesktopExecutionPreference }>({ userId: '', preference: 'internal' });
  const desktopPreferenceRequestRef = React.useRef(0);
  const desktopPreferenceWriteTailRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const desktopExecutionPreference = desktopPreferenceState.userId === user?.uid ? desktopPreferenceState.preference : 'internal';
  const setDesktopExecutionPreference = (preference: DesktopExecutionPreference): Promise<boolean> => {
    const uid = user?.uid, generation = authGenerationRef.current;
    const operation = desktopPreferenceWriteTailRef.current.catch(() => undefined).then(async () => {
      if (!uid || generation !== authGenerationRef.current) return false;
      const request = ++desktopPreferenceRequestRef.current;
      try {
        const data = await apiJson('/api/preferences/desktop_execution', { method: 'PUT', credentials: 'include', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preference }) });
        if (generation !== authGenerationRef.current || data?.ok !== true || data.preference !== preference) return false;
        if (request === desktopPreferenceRequestRef.current) setDesktopPreferenceState({ userId: uid, preference });
        return true;
      } catch { return false; }
    });
    desktopPreferenceWriteTailRef.current = operation;
    return operation;
  };
  useEffect(() => {
    const uid = user?.uid, generation = authGenerationRef.current;
    if (!uid) return;
    let cancelled = false;
    const refresh = async () => {
      await desktopPreferenceWriteTailRef.current.catch(() => undefined);
      if (cancelled || generation !== authGenerationRef.current) return;
      const request = ++desktopPreferenceRequestRef.current;
      try {
        const data = await apiJson('/api/preferences/desktop_execution', { credentials: 'include' });
        if (!cancelled && generation === authGenerationRef.current && request === desktopPreferenceRequestRef.current) setDesktopPreferenceState({ userId: uid, preference: normalizeDesktopExecutionPreference(data?.preference) });
      } catch { /* An unavailable preference never authorizes desktop control. */ }
    };
    const changed = (payload: any) => {
      if (payload?.key === 'desktop_execution' && payload.userId === uid) void refresh();
    };
    const connection = socketService.getSocket() || socketService.connect();
    connection?.on('preferences:changed', changed);
    connection?.on('connect', refresh);
    window.addEventListener('focus', refresh);
    void refresh();
    return () => { cancelled = true; connection?.off('preferences:changed', changed); connection?.off('connect', refresh); window.removeEventListener('focus', refresh); };
  }, [user?.uid, workDomain, orgConnection?.orgId]);

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
  return {
    aiConfigRef, visionConfigRef, modelAccountRef, user, modelPreferenceRequestRef, visionPreferenceRequestRef,
    authGenerationRef, modelWriteTailsRef, applyModelPreference, toolRequestRef, setSessionUser, setOrgConnection,
    notificationRevisionRef, notificationWriteRef, setNotifications, toolOverridesRef, setToolOverrides, setLoading,
    orgConnection, switchDomain, setWorkDomain, workDomain, setUser, setSelectedVoiceIdState, voiceStorageKeys,
    setFavoriteVoices, notifications, setNotificationsBusy, toolWriteTailRef, loading, aiConfig, visionConfig,
    reloadModelPreferences, selectedVoiceId, favoriteVoices, notificationsBusy, unreadCount, toolOverrides,
    operationMode, setOperationMode, desktopExecutionPreference, setDesktopExecutionPreference, appearanceMode, resolvedAppearanceMode, setAppearanceMode, children
  } as const;
}

function useAppAccountActionsAndProvider(previousBindings: ReturnType<typeof useAppSessionAndPreferences>) {
  const { aiConfigRef, visionConfigRef, modelAccountRef, user, modelPreferenceRequestRef, visionPreferenceRequestRef, authGenerationRef, modelWriteTailsRef, applyModelPreference, toolRequestRef, setSessionUser, setOrgConnection, notificationRevisionRef, notificationWriteRef, setNotifications, toolOverridesRef, setToolOverrides, setLoading, orgConnection, switchDomain, setWorkDomain, workDomain, setUser, setSelectedVoiceIdState, voiceStorageKeys, setFavoriteVoices, notifications, setNotificationsBusy, toolWriteTailRef, loading, aiConfig, visionConfig, reloadModelPreferences, selectedVoiceId, favoriteVoices, notificationsBusy, unreadCount, toolOverrides, operationMode, setOperationMode, desktopExecutionPreference, setDesktopExecutionPreference, appearanceMode, resolvedAppearanceMode, setAppearanceMode, children } = previousBindings;


  const updateModelConfig = (role: 'llm' | 'vision', newConfig: Partial<AIConfig>, models: Record<string, string> = {}): Promise<boolean> => {
    const current = (role === 'llm' ? aiConfigRef : visionConfigRef).current;
    if (!modelAccountRef.current || modelAccountRef.current !== user?.uid || !current.ready) {
      toast.error(current.loadError || 'Model preferences have not loaded. Retry in model settings.');
      return Promise.resolve(false);
    }
    const revision = role === 'llm' ? modelPreferenceRequestRef : visionPreferenceRequestRef;
    ++revision.current;
    const owner = authGenerationRef.current;
    const operation = modelWriteTailsRef.current[role].then(async () => {
      if (owner !== authGenerationRef.current) return false;
      const signal = AbortSignal.timeout(15_000);
      const allModels = { ...(role === 'llm' ? aiConfigRef.current : visionConfigRef.current).models, ...models };
      const updated = { ...(role === 'llm' ? aiConfigRef.current : visionConfigRef.current), ...newConfig };
      if (newConfig.provider && !newConfig.model) updated.model = allModels[newConfig.provider] || '';
      else if (!newConfig.model && models[updated.provider]) updated.model = models[updated.provider];
      if (role === 'llm' && updated.provider === 'relay' && updated.model) updated.model = normalizeLumiOfficialModel('reasoning', updated.model);
      const keys: Record<string, string> = {
        qwen: 'DASHSCOPE_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY',
        gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', ark: 'ARK_API_KEY',
        xiaomi: 'XIAOMI_API_KEY', kimi: 'KIMI_API_KEY', glm: 'GLM_API_KEY', relay: 'RELAY_API_KEY',
      };
      if (updated.apiKey && keys[updated.provider] && (role === 'llm' || ['openai', 'gemini', 'ark', 'qwen', 'relay'].includes(updated.provider))) await saveServerKeys({ [keys[updated.provider]]: updated.apiKey }, signal);
      if (owner !== authGenerationRef.current) return false;
      if (updated.provider && updated.model) allModels[updated.provider] = updated.model;
      const confirmed = await apiJson(`/api/preferences/${role}`, {
        signal,
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: updated.provider, model: updated.model, models: allModels,
          ...(role === 'llm' ? { selectionMode: updated.selectionMode, fallbackCandidates: updated.fallbackCandidates, allowCloudFallback: updated.allowCloudFallback } : {}),
        }),
      });
      if (owner !== authGenerationRef.current) return false;
      applyModelPreference(role, confirmed);
      ++revision.current;
      window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed', { detail: { source: 'app-context' } }));
      toast.success(role === 'llm' ? 'Neural core configuration synchronized' : 'Vision model configuration synchronized');
      return true;
    }).catch(error => {
      if (owner === authGenerationRef.current) toast.error(error?.message || 'Model preference update failed');
      return false;
    });
    modelWriteTailsRef.current[role] = operation;
    return operation;
  };
  const updateAIConfig = (config: Partial<AIConfig>, models?: Record<string, string>) => updateModelConfig('llm', config, models);
  const updateVisionConfig = (config: Partial<VisionConfig>, models?: Record<string, string>) => updateModelConfig('vision', config, models);

  const refreshUser = async () => {
    let owner = authGenerationRef.current;
    const toolRevision = toolRequestRef.current;
    try {
      const customAuth = await authService.getMe();
      if (owner !== authGenerationRef.current) return;
      if (customAuth) {
        setSessionUser({ ...customAuth.user, provider: 'custom' } as any);
        owner = authGenerationRef.current;
        // Sync org connection from user data
        const u = customAuth.user as any;
        if (u?.orgId) {
          const conn: OrgConnection = { orgId: u.orgId, orgRole: u.orgRole || 'member', orgName: '', connected: true };
          setOrgConnection(conn);
          localStorage.setItem('lumi_org_connection', JSON.stringify(conn));
        }
        // Load persisted notifications from server
        try {
          const revision = ++notificationRevisionRef.current;
          const notifData = await notificationService.fetchNotifications();
          if (owner !== authGenerationRef.current) return;
          if (revision === notificationRevisionRef.current && !notificationWriteRef.current) {
            const clearKey = notificationClearStorageKey(String(customAuth.user.uid || ''));
            const clearedAt = Number(localStorage.getItem(clearKey) || 0);
            const proactiveGreetingEnabled = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
            setNotifications(prev => mergeNotificationState(
              prev,
              notifData.notifications as NotificationItem[],
              { clearedAt, allowGreeting: proactiveGreetingEnabled, limit: 50 },
            ));
          }
        } catch {}
        // Load tool overrides from server
        try {
          const toRes = await apiFetch('/api/settings/tool_overrides');
          if (toRes.ok) {
            const serverOverrides = await toRes.json();
            if (owner !== authGenerationRef.current) return;
            if (serverOverrides && toolRevision === toolRequestRef.current) {
              toolOverridesRef.current = serverOverrides;
              setToolOverrides(serverOverrides);
              localStorage.setItem('lumi_tool_overrides', JSON.stringify(serverOverrides));
            }
          }
        } catch {}
      } else {
        setSessionUser(null);
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

  const workbenchDrafts = React.useMemo(() => new Map<string, unknown>(), [user?.uid, user?.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole]);

  useEffect(() => { cancelAppConfirm(); }, [workbenchDrafts]);

  const logout = async () => {
    authGenerationRef.current += 1;
    modelPreferenceRequestRef.current += 1;
    visionPreferenceRequestRef.current += 1;
    const revocation = authService.logout();
    setSessionUser(null);
    toolOverridesRef.current = {};
    setToolOverrides({});
    socketService.disconnect();
    const result = await revocation;
    if (result.remoteRevoked) toast.info('Signed out');
    else toast.warning('Signed out locally. Server session revocation could not be confirmed.');
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

  const addNotification = useCallback((item: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => {
    const notification: NotificationItem = {
      ...item,
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      read: false,
    };
    setNotifications(prev => [notification, ...prev].slice(0, 50));
  }, []);

  const updateNotifications = async (clear: boolean) => {
    if (!user || notificationWriteRef.current) return false;
    const owner = authGenerationRef.current, controller = new AbortController();
    const targets = new Set(notifications.map(item => item.id));
    notificationWriteRef.current = controller; notificationRevisionRef.current++; setNotificationsBusy(true);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      const ids = await notificationService.updateNotifications(clear, signal);
      signal.throwIfAborted();
      if (owner !== authGenerationRef.current) return false;
      ids.forEach(id => targets.add(id));
      setNotifications(items => clear ? items.filter(item => !targets.has(item.id)) : items.map(item => targets.has(item.id) ? { ...item, read: true } : item));
      return true;
    } catch (error) {
      if (owner === authGenerationRef.current) toast.error(error instanceof Error ? error.message : 'Notification update failed');
      return false;
    } finally {
      if (notificationWriteRef.current === controller) { notificationWriteRef.current = null; notificationRevisionRef.current++; setNotificationsBusy(false); }
    }
  };
  const markAllNotificationsRead = () => updateNotifications(false);
  const clearNotifications = () => updateNotifications(true);

  const setToolOverride = (name: string, override: ToolOverride) => {
    ++toolRequestRef.current;
    const owner = authGenerationRef.current;
    const operation = toolWriteTailRef.current.then(async () => {
      if (owner !== authGenerationRef.current) return;
      const next = { ...toolOverridesRef.current, [name]: override };
      await apiJson('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'tool_overrides', value: next }),
      });
      if (owner !== authGenerationRef.current) return;
      toolOverridesRef.current = next;
      setToolOverrides(next);
      localStorage.setItem('lumi_tool_overrides', JSON.stringify(next));
    }).catch(error => {
      if (owner === authGenerationRef.current) toast.error(error?.message || 'Tool preference update failed');
    });
    toolWriteTailRef.current = operation;
  };

  return (
    <AppContext.Provider value={{
      user,
      loading,
      aiConfig,
      visionConfig,
      reloadModelPreferences,
      selectedVoiceId,
      setSelectedVoiceId,
      getSelectedVoiceIdForProvider,
      favoriteVoices,
      toggleFavoriteVoice,
      notifications,
      notificationsBusy,
      unreadCount,
      addNotification,
      markAllNotificationsRead,
      clearNotifications,
      toolOverrides,
      setToolOverride,
      workbenchDrafts,
      orgConnection,
      workDomain,
      switchDomain,
      operationMode,
      setOperationMode,
      desktopExecutionPreference, setDesktopExecutionPreference,
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

export function AppProvider(props: Parameters<typeof useAppSessionAndPreferences>[0]) {
  const state0 = useAppSessionAndPreferences(props);
  return useAppAccountActionsAndProvider(state0);
}


export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
