import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { toast } from 'sonner';
import * as authService from '../services/authService';
import * as agentService from '../services/agentService';
import * as notificationService from '../services/notificationService';
import { socketService } from '../services/socketService';
import { saveServerKeys } from '../services/settingsKeys';
import { apiFetch } from '../services/apiClient';

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

interface Agent {
  id: string;
  ownerUid: string;
  name: string;
  category: string;
  data: string;
  createdAt: string;
  status: 'active' | 'inactive';
}

interface AIConfig {
  provider: string;
  model: string;
  apiKey: string;
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

export type OperationMode = 'chat' | 'assistant' | 'autonomous' | 'meeting';
export type AppearanceMode = 'system' | 'light' | 'dark';

function normalizeOperationMode(mode: unknown): OperationMode {
  if (mode === 'chat' || mode === 'assistant' || mode === 'autonomous' || mode === 'meeting') return mode;
  if (mode === 'music') return 'assistant';
  if (mode === 'desktop_control' || mode === 'terminal') return 'assistant';
  return 'assistant';
}

function normalizeAppearanceMode(mode: unknown): AppearanceMode {
  if (mode === 'system' || mode === 'light' || mode === 'dark') return mode;
  return 'dark';
}

function getSystemAppearanceMode(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
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
  agents: Agent[];
  aiConfig: AIConfig;
  visionConfig: VisionConfig;
  // Voice
  selectedVoiceId: string | undefined;
  setSelectedVoiceId: (id: string, provider?: string) => void;
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
  createAgent: (name: string, category: string, data: any) => Promise<any>;
  updateAgent: (id: string, updates: Partial<Agent>) => Promise<any>;
  deleteAgent: (id: string) => Promise<void>;
  updateBalance: (amount: number) => Promise<void>;
  refreshUser: () => Promise<void>;
  updateAIConfig: (config: Partial<AIConfig>) => void;
  updateVisionConfig: (config: Partial<VisionConfig>) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiConfig, setAiConfig] = useState<AIConfig>(() => {
    const saved = localStorage.getItem('lumi_ai_config');
    return saved ? JSON.parse(saved) : { provider: 'deepseek', model: 'deepseek-chat', apiKey: '' };
  });
  const [visionConfig, setVisionConfig] = useState<VisionConfig>(() => {
    const saved = localStorage.getItem('lumi_vision_config');
    return saved ? JSON.parse(saved) : { provider: 'openai', model: 'gpt-4o', apiKey: '' };
  });

  useEffect(() => {
    apiFetch('/api/preferences/vision')
      .then(r => r.ok ? r.json() : null)
      .then(pref => {
        if (!pref?.provider) return;
        setVisionConfig(prev => {
          const next = {
            ...prev,
            provider: pref.provider,
            model: pref.model || pref.models?.[pref.provider] || prev.model,
          };
          localStorage.setItem('lumi_vision_config', JSON.stringify(next));
          if (pref.models) localStorage.setItem('lumi_vision_models', JSON.stringify(pref.models));
          return next;
        });
      })
      .catch(() => {});
  }, []);
  // Voice state
  const [selectedVoiceId, setSelectedVoiceIdState] = useState<string | undefined>(() => {
    return localStorage.getItem('lumi_selected_voice_id') || undefined;
  });
  const [favoriteVoices, setFavoriteVoices] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('lumi_favorite_voices') || '[]'); } catch { return []; }
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
          return { success: true, domain: 'personal', message: '已切换到个人域', connection: orgConnection };
        }
        const data = await res.json().catch(() => ({}));
        return { success: false, domain: 'personal', message: data.error || '切换个人域失败', connection: orgConnection };
      } catch (err: any) {
        return { success: false, domain: 'personal', message: err.message || '切换个人域失败', connection: orgConnection };
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
        return { success: false, domain: 'work', message: err.message || '组织列表读取失败', connection: orgConnection };
      }
    }
    if (!orgId) {
      return { success: false, domain: 'work', message: '当前账号还没有可切换的组织', connection: orgConnection };
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
          return { success: true, domain: 'work', message: '已切换到工作域', connection: conn };
        }
      }
      return { success: false, domain: 'work', message: data.error || '切换工作域失败', connection: orgConnection };
    } catch (err: any) {
      return { success: false, domain: 'work', message: err.message || '切换工作域失败', connection: orgConnection };
    }
  };

  const [operationMode, setOperationModeState] = useState<OperationMode>(() => {
    try { return normalizeOperationMode(localStorage.getItem('lumi_operation_mode')); } catch { return 'assistant'; }
  });
  const [appearanceMode, setAppearanceModeState] = useState<AppearanceMode>(() => {
    try { return normalizeAppearanceMode(localStorage.getItem('lumi_appearance_mode')); } catch { return 'dark'; }
  });
  const [systemAppearanceMode, setSystemAppearanceMode] = useState<'light' | 'dark'>(() => getSystemAppearanceMode());
  const resolvedAppearanceMode = appearanceMode === 'system' ? systemAppearanceMode : appearanceMode;

  const setOperationMode = async (mode: OperationMode) => {
    const normalizedMode = normalizeOperationMode(mode);
    setOperationModeState(normalizedMode);
    localStorage.setItem('lumi_operation_mode', normalizedMode);
    try {
      await apiFetch('/api/preferences/operation_mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: normalizedMode }),
        credentials: 'include',
      });
    } catch {}
  };

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
    setAiConfig(prev => {
      // Auto-resolve model from per-provider preferences when provider changes
      let resolved = { ...newConfig };
      if (newConfig.provider && !newConfig.model) {
        const savedModels = (() => {
          try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
        })();
        const defaults: Record<string, string> = {
          qwen: 'qwen-plus', deepseek: 'deepseek-chat', openai: 'gpt-4o',
          gemini: 'gemini-2.0-flash', anthropic: 'claude-sonnet-4-6',
        };
        resolved.model = savedModels[newConfig.provider] || defaults[newConfig.provider] || '';
      }
      const updated = { ...prev, ...resolved };
      localStorage.setItem('lumi_ai_config', JSON.stringify(updated));

      // Also sync apiKey to server so LLM/STT/TTS providers can read it
      if (updated.apiKey && updated.provider) {
        const KEY_MAP: Record<string, string> = {
          qwen: 'DASHSCOPE_API_KEY',
          deepseek: 'DEEPSEEK_API_KEY',
          openai: 'OPENAI_API_KEY',
          gemini: 'GEMINI_API_KEY',
          anthropic: 'ANTHROPIC_API_KEY',
          ark: 'ARK_API_KEY',
          xiaomi: 'XIAOMI_API_KEY',
          kimi: 'KIMI_API_KEY',
          glm: 'GLM_API_KEY',
          relay: 'RELAY_API_KEY',
        };
        const serverKey = KEY_MAP[updated.provider];
        if (serverKey) {
          saveServerKeys({ [serverKey]: updated.apiKey })
            .catch(err => toast.error(err.message || 'API key save failed'));
        }
      }

      // Sync LLM prefs (provider + per-provider models) to server for personality evolution
      if (updated.provider || updated.model) {
        const allModels = (() => {
          try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
        })();
        if (updated.model && updated.provider) {
          allModels[updated.provider] = updated.model;
        }
        apiFetch('/api/preferences/llm', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: updated.provider || prev.provider, models: allModels }),
          credentials: 'include',
        }).catch(() => {});
      }
      return updated;
    });
    toast.success('Neural core configuration synchronized');
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
          relay: 'qwen2.5-vl-7b-instruct',
        };
        resolved.model = savedModels[newConfig.provider] || defaults[newConfig.provider] || '';
      }

      const updated = { ...prev, ...resolved };
      localStorage.setItem('lumi_vision_config', JSON.stringify(updated));

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

      return updated;
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
        try { setAgents(await agentService.listAgents()); } catch {}
        // Load persisted notifications from server
        try {
          const notifData = await notificationService.fetchNotifications();
          if (notifData.notifications?.length > 0) {
            setNotifications(prev => {
              const existingIds = new Set(prev.map(n => n.id));
              const proactiveGreetingEnabled = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
              const newNotifs = notifData.notifications.filter((n: any) =>
                !existingIds.has(n.id) &&
                (proactiveGreetingEnabled || n.type !== 'greeting')
              );
              return [...newNotifs, ...prev].slice(0, 50);
            });
          }
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
        setAgents([]);
      }
    } catch (error) {
      console.error('Error refreshing user:', error);
    }
  };

  useEffect(() => {
    const handleAgentsChanged = async (event: Event) => {
      const agent = (event as CustomEvent).detail?.agent;
      if (agent?.id) {
        setAgents(prev => {
          const exists = prev.some(a => a.id === agent.id);
          return exists ? prev.map(a => a.id === agent.id ? { ...a, ...agent } : a) : [...prev, agent];
        });
        return;
      }
      try { setAgents(await agentService.listAgents()); } catch {}
    };

    window.addEventListener('lumi:agents-changed', handleAgentsChanged);
    return () => window.removeEventListener('lumi:agents-changed', handleAgentsChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      setLoading(true);
      try {
        const me = await authService.getMe();
        // Re-bootstrap if session exists but lacks orgId (stale token from before org creation)
        const needsRebootstrap = !me || !(me.user as any)?.orgId;
        if (needsRebootstrap && !cancelled) {
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
          } else if (!cancelled) {
            console.warn('[Auth] Bootstrap failed after retries:', result.error);
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
      setAgents([]);
      toast.info('Returned to the mortal realm');
    } catch (error: any) {
      toast.error('Logout failed: ' + error.message);
    }
  };

  const createAgent = async (name: string, category: string, data: any): Promise<any> => {
    if (!user) {
      toast.error('You must be authenticated to synthesize agents');
      return null;
    }
    try {
      const newAgent = await agentService.createAgent({ name, category, data: JSON.stringify(data) });
      setAgents(prev => [...prev, newAgent]);
      addNotification({ type: 'success', title: 'Agent Synthesized', message: `${name} (${category}) has been created and is ready for use.` });
      toast.success(`${name} has been synthesized`);
      return newAgent;
    } catch (error: any) {
      console.error('Synthesis error:', error);
      toast.error('Synthesis failed: ' + error.message);
    }
  };

  const updateAgent = async (id: string, updates: Partial<Agent>) => {
    try {
      const updated = await agentService.updateAgent(id, updates);
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...updated } : a));
      toast.success(`Agent "${updated.name || id}" updated`);
      return updated;
    } catch (error: any) {
      console.error('Update error:', error);
      toast.error('Update failed: ' + error.message);
    }
  };

  const deleteAgent = async (id: string) => {
    try {
      await agentService.deleteAgent(id);
      const deleted = agents.find(a => a.id === id);
      setAgents(prev => prev.filter(a => a.id !== id));
      addNotification({ type: 'info', title: 'Agent Released', message: `"${deleted?.name || id}" has been dissolved.` });
      toast.success('Agent essence has been released');
    } catch (error: any) {
      console.error('Deletion error:', error);
      toast.error('Deletion failed: ' + error.message);
    }
  };

  const updateBalance = async (amount: number) => {
    setUser((prev) => prev ? { ...prev, balance: (prev.balance || 0) + amount } : prev);
  };

  const setSelectedVoiceId = (id: string, provider?: string) => {
    setSelectedVoiceIdState(id);
    localStorage.setItem('lumi_selected_voice_id', id);
    if (provider) {
      localStorage.setItem('lumi_selected_voice_provider', provider);
      // Auto-switch TTS provider to match the selected voice
      apiFetch('/api/voice/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts: provider }),
      }).catch(() => {});
    }
  };

  const toggleFavoriteVoice = (id: string) => {
    setFavoriteVoices(prev => {
      const next = prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id];
      localStorage.setItem('lumi_favorite_voices', JSON.stringify(next));
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
  };

  const clearNotifications = () => {
    setNotifications([]);
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
      agents,
      aiConfig,
      visionConfig,
      selectedVoiceId,
      setSelectedVoiceId,
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
      createAgent,
      updateAgent,
      deleteAgent,
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
