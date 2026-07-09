import React, { Suspense, lazy, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Shield,
  Globe,
  Cpu,
  Database,
  BrainCircuit,
  ChevronDown,
  Music,
  Headphones,
  MessagesSquare,
  Sparkle,
  Zap,
  Camera,
  Mic,
  CheckCircle,
  AlertCircle,
  Loader2,
  LogOut,
  Cloud,
  Volume2,
  Sun,
  Moon
} from 'lucide-react';
import { Button } from './ui/button';
import { toast } from 'sonner';

import { usePlatform } from '@/hooks/usePlatform';
import { BiometricsEnrollPanel } from './biometrics/BiometricsEnrollPanel';
import { useApp, type AppearanceMode, type OperationMode } from '@/contexts/AppContext';
import { VoiceProviderSwitch } from './VoiceProviderSwitch';
import { MCPSettings } from './MCPSettings';
import { getSavedKeyStatus, saveServerKeys } from '@/services/settingsKeys';
import { apiFetch } from '@/services/apiClient';
import {
  getSensorPermissionSnapshot,
  isSensorEnabled,
  requestSensorPermission,
  setSensorEnabled,
  SENSOR_ACCESS_CHANGED,
  SENSOR_PERMISSIONS_CHANGED,
  type SensorPermissionState,
} from '@/services/sensorPermissionService';

const VoiceForge = lazy(() => import('./VoiceForge').then(m => ({ default: m.VoiceForge })));

function buildSidebarGroups(t: any, isZh: boolean) {
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  return [
    {
      label: t.sidebarCore || ui('核心', 'Core'),
      items: [
        { id: 'general', label: t.sidebarGeneral || ui('通用', 'General'), icon: <Globe size={16} /> },
      ],
    },
    {
      label: t.sidebarAiNeural || ui('AI 与人格', 'AI & Neural'),
      items: [
        { id: 'neural', label: t.neuralEngine || ui('智能体框架', 'Neural Engine'), icon: <BrainCircuit size={16} /> },
        { id: 'llm-providers', label: t.llmProviders || ui('LLM 服务商', 'LLM Providers'), icon: <BrainCircuit size={16} /> },
        { id: 'vision-models', label: t.visionModelSettings || ui('视觉模型', 'Vision Model'), icon: <Camera size={16} /> },
        { id: 'voice-services', label: t.voiceServices || ui('语音服务', 'Voice Services'), icon: <Mic size={16} /> },
      ],
    },
    {
      label: t.sidebarSystem || ui('系统', 'System'),
      items: [
        { id: 'security', label: t.privacySecurity || ui('隐私与安全', 'Security'), icon: <Shield size={16} /> },
        { id: 'hardware', label: t.settingsHardware || ui('硬件权限', 'Hardware'), icon: <Camera size={16} /> },
        { id: 'mcp', label: t.settingsMCP || 'MCP', icon: <Cpu size={16} /> },
      ],
    },
  ];
}

export function Settings({
  t,
  lang,
  setLang,
  activeSection = 'general',
  onSectionChange,
}: {
  t: any;
  lang: 'en' | 'zh';
  setLang: (l: 'en' | 'zh') => void;
  activeSection?: string;
  onSectionChange?: (section: string) => void;
}) {
  const { platform, isElectron } = usePlatform();
  const { operationMode, appearanceMode, resolvedAppearanceMode, setAppearanceMode } = useApp();
  const [providerStatus, setProviderStatus] = useState<Record<string, { available: boolean; model: string }>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const visibleSection = activeSection === 'computer' || activeSection === 'messaging' ? 'general' : activeSection;
  const isZh = lang !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  useEffect(() => {
    let cancelled = false;
    const loadProviderStatus = async () => {
      try {
        const response = await apiFetch('/api/llm/providers');
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Provider status failed (${response.status})`);
        if (!cancelled) setProviderStatus(data.providers || {});
      } catch (err: any) {
        if (!cancelled) {
          toast.error(err?.message || t.failedToLoadProviderStatus || ui('服务商状态加载失败', 'Failed to load provider status'));
        }
      }
    };
    void loadProviderStatus();
    const onKeysChanged = () => { void loadProviderStatus(); };
    window.addEventListener('lumi:keys-changed', onKeysChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('lumi:keys-changed', onKeysChanged);
    };
  }, []);

  const handleSectionChange = (section: string) => {
    if (onSectionChange) onSectionChange(section);
  };

  const toggleGroup = (label: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

  const renderContent = (section: string) => {
    switch (section) {
      case 'general':
        return (
          <div className="space-y-8">
            <SettingsSection title={t.language || ui('语言', 'Language')} icon={<Globe size={18} className="text-blue-400" />}>
              <div className="p-8 bg-white/5 rounded-[2.5rem] border border-white/5 space-y-6">
                <div>
                  <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-4">{t.selectLanguage}</label>
                  <div className="grid grid-cols-2 gap-4">
                    <button onClick={() => setLang('en')}
                      className={`p-6 rounded-2xl border text-sm font-bold transition-all flex items-center justify-center gap-3 ${lang === 'en' ? 'bg-white text-black border-white shadow-[0_0_20px_rgba(255,255,255,0.2)]' : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/10'}`}>
                      {t.englishUS || ui('英文（美国）', 'English (US)')}
                    </button>
                    <button onClick={() => setLang('zh')}
                      className={`p-6 rounded-2xl border text-sm font-bold transition-all flex items-center justify-center gap-3 ${lang === 'zh' ? 'bg-white text-black border-white shadow-[0_0_20px_rgba(255,255,255,0.2)]' : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/10'}`}>
                      中文 (简体)
                    </button>
                  </div>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title={t.appearanceThemes || ui('外观与主题', 'Appearance & Themes')} icon={<Sparkle size={18} className="text-celestial-saturn" />}>
              <div className="p-8 bg-white/5 rounded-[2.5rem] border border-white/5 space-y-8">
                <div>
                  <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-4">{ui('全局明暗外观', 'Global Appearance')}</label>
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      { id: 'light', label: ui('白天', 'Day'), hint: ui('主界面更亮', 'Bright shell'), icon: <Sun size={16} /> },
                      { id: 'dark', label: ui('夜间', 'Night'), hint: ui('经典暗色', 'Classic dark'), icon: <Moon size={16} /> },
                      { id: 'system', label: ui('跟随系统', 'System'), hint: resolvedAppearanceMode === 'light' ? ui('当前白天', 'Now day') : ui('当前夜间', 'Now night'), icon: <Globe size={16} /> },
                    ] as Array<{ id: AppearanceMode; label: string; hint: string; icon: React.ReactNode }>).map(option => {
                      const active = appearanceMode === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setAppearanceMode(option.id)}
                          className={`min-h-[92px] rounded-2xl border px-4 py-3 text-left transition-all ${
                            active
                              ? 'border-celestial-saturn/40 bg-celestial-saturn/10 shadow-[0_0_22px_rgba(255,204,0,0.12)]'
                              : 'border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.06]'
                          }`}
                        >
                          <span className={`mb-3 flex h-9 w-9 items-center justify-center rounded-xl border ${
                            active ? 'border-celestial-saturn/35 bg-celestial-saturn/18 text-celestial-saturn' : 'border-white/10 bg-black/20 text-white/50'
                          }`}>
                            {option.icon}
                          </span>
                          <span className={`block text-xs font-black uppercase tracking-[0.14em] ${active ? 'text-white' : 'text-white/65'}`}>{option.label}</span>
                          <span className="mt-1 block text-[11px] font-bold text-white/35">{option.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-3 text-[12px] leading-relaxed text-white/40">
                    {ui('这是全局外壳主题。知识库、音乐沉浸层、会议覆盖层等需要暗场对比的页面会保留自己的深色工作台。', 'This controls the global shell. Knowledge base, immersive music, meeting overlays, and other contrast-heavy surfaces can keep their own dark workspace.')}
                  </p>
                </div>
              </div>
            </SettingsSection>
          </div>
        );
      case 'neural':
        return (
          <div className="space-y-8">
            <SettingsSection title={t.agentFramework || ui('智能体框架（Lumi 协议）', 'Agent Framework (Lumi Protocol)')} icon={<BrainCircuit size={18} className="text-celestial-saturn" />}>
              <div className="space-y-6">
                <AutonomousSettingsPanel t={t} operationMode={operationMode} />
              </div>
            </SettingsSection>
          </div>
        );
      case 'voice':
        return (
          <Suspense fallback={null}>
            <VoiceForge t={t} />
          </Suspense>
        );
      case 'llm-providers':
        return <LLMProvidersPage t={t} providerStatus={providerStatus} />;
      case 'vision-models':
        return <VisionModelPage t={t} />;
      case 'voice-services':
        return <VoiceServicesPage t={t} />;
      case 'security':
        return (
          <div className="space-y-8">
            <SettingsSection title={t.privacySecurity || ui('隐私与安全', 'Privacy & Security')} icon={<Shield size={18} className="text-celestial-mars" />}>
              <SettingsItem label={t.localEncryption || ui('本地加密', 'Local Encryption')} desc={t.localEncryptionDesc || ui('加密存储在本地磁盘上的所有智能体数据。', 'Encrypt all Agent data stored on your local disk.')} storageKey="lumi_sec_local_encryption" t={t} />
              <SettingsItem label={t.anonymousMode || ui('匿名模式', 'Anonymous Mode')} desc={t.anonymousModeDesc || ui('在协作网络中隐藏你的节点 ID。', 'Hide your node ID from the collaborative network.')} storageKey="lumi_sec_anonymous_mode" t={t} />
              <SettingsItem label={t.biometricLock || ui('生物识别锁', 'Biometric Lock')} desc={t.biometricLockDesc || ui('生成智能体时要求指纹或人脸验证。', 'Require fingerprint or face ID for Agent generation.')} storageKey="lumi_sec_biometric_lock" t={t} />
            </SettingsSection>
            {isElectron && (
              <SettingsSection title={t.desktopNodeRuntime || ui('桌面节点运行时', 'Desktop Node Runtime')} icon={<Database size={18} className="text-celestial-jupiter" />}>
                <div className="p-4 bg-celestial-jupiter/10 rounded-2xl border border-celestial-jupiter/20 space-y-2 mb-4">
                  <div className="flex justify-between items-center text-sm"><span className="text-white/60">{t.platform || ui('平台', 'Platform')}:</span><span className="font-mono text-celestial-jupiter uppercase">{platform}</span></div>
                  <div className="flex justify-between items-center text-sm"><span className="text-white/60">{t.nodeStatus || ui('节点状态', 'Node Status')}:</span><div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /><span className="font-bold text-green-500 underline decoration-green-500/20 underline-offset-4">{t.nodeActive || ui('运行中', 'ACTIVE')}</span></div></div>
                </div>
                <SettingsItem label={t.hardwareAcceleration || ui('硬件加速', 'Hardware Acceleration')} desc={t.hardwareAccelerationDesc || ui('使用 GPU 加速核心推理。', 'Use GPU for neural core inference.')} storageKey="lumi_sec_hw_accel" t={t} />
                <SettingsItem label={t.systemTrayMode || ui('系统托盘模式', 'System Tray Mode')} desc={t.systemTrayModeDesc || ui('让 Lumi 在后台保持运行。', 'Keep Lumi running in the background.')} storageKey="lumi_sec_system_tray" t={t} />
              </SettingsSection>
            )}

            <SettingsSection title="生物特征录入" icon={<Shield size={18} className="text-amber-400" />}>
              <div className="p-6 bg-white/5 rounded-[2.5rem] border border-white/5">
                <BiometricsEnrollPanel />
              </div>
            </SettingsSection>
          </div>
        );
      case 'hardware':
        return <HardwareSettings t={t} />;
      case 'mcp':
        return <MCPSettings t={t} />;
      default:
        return null;
    }
  };

  return (
    <div className="lumi-work-surface lumi-surface flex h-full overflow-hidden">
      {/* Sidebar — fixed height, scrollable */}
      <div className="w-44 flex-shrink-0 border-r border-white/[0.08] bg-white/[0.025] flex flex-col min-h-0 md:w-56">
        <div className="px-3 pt-4 pb-3 md:px-4 md:pt-5">
          <h2 className="text-xs font-black uppercase tracking-widest text-white/60">{t.settings || ui('设置', 'Settings')}</h2>
        </div>
        <div className="flex-1 px-1.5 pb-3 space-y-0.5 overflow-y-auto custom-scrollbar min-h-0 md:px-2">
          {buildSidebarGroups(t, isZh).map(group => {
            const isCollapsed = collapsedGroups.has(group.label);
            const hasActiveItem = group.items.some(item => item.id === visibleSection);
            return (
              <div key={group.label} className="mb-1">
                <button
                  onClick={() => toggleGroup(group.label)}
                  className="flex w-full items-center gap-1 px-2 py-1 text-xs font-black uppercase tracking-widest text-white/45 transition-colors hover:text-white/70"
                >
                  <ChevronDown size={9} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  {group.label}
                </button>
                {!isCollapsed && (
                  <div className="space-y-0.5">
                    {group.items.map(item => (
                      <SidebarItem
                        key={item.id}
                        active={visibleSection === item.id}
                        onClick={() => handleSectionChange(item.id)}
                        icon={item.icon}
                        label={item.label}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-2 pb-4 pt-2 border-t border-white/[0.08]">
          <button
            onClick={async () => {
              try {
                await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
                localStorage.removeItem('lumi_auth_token');
                window.location.reload();
              } catch {
                localStorage.removeItem('lumi_auth_token');
                window.location.reload();
              }
            }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold text-red-400/60 transition-all hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut size={14} />
            {t?.signOut || ui('退出登录', 'Sign Out')}
          </button>
        </div>
      </div>

      {/* Content — absolute positioned to prevent layout shift during transitions */}
      <div className="flex-1 min-w-0 relative overflow-hidden">
        <div className="absolute inset-0 overflow-y-auto custom-scrollbar p-3 md:p-6">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={visibleSection}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
            >
              {renderContent(visibleSection)}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function HardwareSettings({ t }: { t: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [micStatus, setMicStatus] = useState<SensorPermissionState>('unknown');
  const [camStatus, setCamStatus] = useState<SensorPermissionState>('unknown');
  const [micEnabled, setMicEnabled] = useState(() => isSensorEnabled('microphone'));
  const [camEnabled, setCamEnabled] = useState(() => isSensorEnabled('camera'));
  const [isRequesting, setIsRequesting] = useState(false);

  useEffect(() => {
    let disposed = false;

    const refresh = async () => {
      const snapshot = await getSensorPermissionSnapshot();
      if (disposed) return;
      setMicStatus(snapshot.microphone);
      setCamStatus(snapshot.camera);
    };

    const onSensorChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<Record<'microphone' | 'camera', SensorPermissionState>>>).detail;
      if (detail?.microphone) setMicStatus(detail.microphone);
      if (detail?.camera) setCamStatus(detail.camera);
      if (!detail?.microphone && !detail?.camera) void refresh();
    };

    const refreshAccess = () => {
      setMicEnabled(isSensorEnabled('microphone'));
      setCamEnabled(isSensorEnabled('camera'));
    };

    const onSensorAccessChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<Record<'microphone' | 'camera', boolean>>>).detail;
      if (typeof detail?.microphone === 'boolean') setMicEnabled(detail.microphone);
      if (typeof detail?.camera === 'boolean') setCamEnabled(detail.camera);
      if (typeof detail?.microphone !== 'boolean' && typeof detail?.camera !== 'boolean') refreshAccess();
    };

    const onStorageChange = (event: StorageEvent) => {
      if (event.key === 'lumi_mic_enabled' || event.key === 'lumi_camera_enabled') refreshAccess();
    };

    void refresh();
    refreshAccess();
    window.addEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
    window.addEventListener(SENSOR_ACCESS_CHANGED, onSensorAccessChange);
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('visibilitychange', refresh);
    window.addEventListener('visibilitychange', refreshAccess);
    return () => {
      disposed = true;
      window.removeEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
      window.removeEventListener(SENSOR_ACCESS_CHANGED, onSensorAccessChange);
      window.removeEventListener('storage', onStorageChange);
      window.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('visibilitychange', refreshAccess);
    };
  }, []);

  const requestPermissions = async (type: 'mic' | 'camera') => {
    setIsRequesting(true);
    try {
      const kind = type === 'mic' ? 'microphone' : 'camera';
      const result = await requestSensorPermission(kind);
      if (type === 'mic') setMicStatus(result.state);
      if (type === 'camera') setCamStatus(result.state);
      if (!result.ok) {
        throw new Error(result.error || ui('璇峰湪绯荤粺鏉冮檺涓墦寮€璁块棶', 'Please enable access in system permissions.'));
      }

      toast.success(type === 'mic' ? (t.micAccessSynced || ui('麦克风权限已同步。', 'Microphone access synchronized.')) : (t.camAccessSynced || ui('摄像头权限已同步。', 'Camera access synchronized.')));
      return true;
    } catch (err: any) {
      toast.error(`${t.sensorLinkFailed || ui('传感器连接失败', 'Sensor link failed')}: ${err.message}`);
      return false;
    } finally {
      setIsRequesting(false);
    }
  };

  const handleSensorToggle = async (type: 'mic' | 'camera', enabled: boolean) => {
    const kind = type === 'mic' ? 'microphone' : 'camera';
    setSensorEnabled(kind, enabled);
    if (type === 'mic') setMicEnabled(enabled);
    if (type === 'camera') setCamEnabled(enabled);

    if (!enabled) {
      toast.success(type === 'mic'
        ? (t.audioReceptorsDisabled || ui('音频输入已停用。', 'Audio input disabled.'))
        : (t.visualCortexDisabled || ui('视觉感知已停用。', 'Visual perception disabled.')));
      return;
    }

    const ok = await requestPermissions(type);
    if (!ok) {
      setSensorEnabled(kind, false);
      if (type === 'mic') setMicEnabled(false);
      if (type === 'camera') setCamEnabled(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <SettingsSection title={t.hardwareSensorNetwork || ui('硬件传感器网络', 'Hardware Sensor Network')} icon={<Camera size={18} className="text-celestial-saturn" />}>
        <p className="text-sm text-white/40 mb-8 max-w-xl">
          {t.hardwareSensorNetworkDesc || ui('LumiAI 需要访问物理传感器来进行现实上下文感知和生物识别验证。所有数据都会在你的本地节点处理。', 'LumiAI requires access to your physical sensors for real-world contextual awareness and biometric verification. All data is processed locally on your node.')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <HardwareCapCard
            icon={<Mic size={24} />}
            label={t.audioReceptors || ui('音频输入', 'Audio Receptors')}
            desc={t.audioReceptorsDesc || ui('启用语音识别和声音克隆相关能力。', 'Enable neural speech recognition and voice cloning.')}
            status={micStatus}
            enabled={micEnabled}
            onToggle={(enabled) => void handleSensorToggle('mic', enabled)}
            disabled={isRequesting}
            t={t}
          />
          <HardwareCapCard
            icon={<Camera size={24} />}
            label={t.visualCortex || ui('视觉感知', 'Visual Cortex')}
            desc={t.visualCortexDesc || ui('启用多模态视觉和手势控制。', 'Enable multimodal vision and gesture control.')}
            status={camStatus}
            enabled={camEnabled}
            onToggle={(enabled) => void handleSensorToggle('camera', enabled)}
            disabled={isRequesting}
            t={t}
          />
        </div>

        <div className="mt-12 p-6 glass-dark rounded-[2rem] border border-white/5 space-y-4">
           <div className="flex items-center gap-3">
              <Shield className="text-celestial-saturn" size={20} />
              <h4 className="text-sm font-bold uppercase tracking-tight text-white">{t.privacyAssurance || ui('隐私保证', 'Privacy Assurance')}</h4>
           </div>
           <p className="text-xs text-white/55 leading-relaxed italic">
             {t.privacyAssuranceText || ui('协议默认强制本地处理。没有你的明确确认，视觉和听觉数据流不会离开你的本地主权节点。', 'Our protocol strictly enforces local-only processing. Your visual and auditory data streams are never transmitted outside your sovereign mesh node without direct user-signed override.')}
           </p>
        </div>
      </SettingsSection>
    </div>
  );
}

function HardwareCapCard({ icon, label, desc, status, enabled, onToggle, disabled, t }: {
  icon: React.ReactNode,
  label: string,
  desc: string,
  status: SensorPermissionState,
  enabled: boolean,
  onToggle: (enabled: boolean) => void,
  disabled: boolean,
  t: any
}) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const isUnavailable = status === 'unavailable';
  const isLinked = enabled && status === 'granted';
  const isBlocked = status === 'denied';
  return (
    <div className="p-8 bg-white/5 rounded-[2.5rem] border border-white/5 flex flex-col justify-between gap-6 group hover:border-white/10 transition-all">
      <div className="space-y-4">
        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all ${
          isLinked ? 'bg-celestial-saturn text-black' : 'bg-white/5 text-white/40'
        }`}>
          {icon}
        </div>
        <div>
          <h4 className="text-lg font-bold text-white">{label}</h4>
          <p className="text-xs text-white/40 leading-relaxed mt-1">{desc}</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
           {isLinked ? (
             <div className="flex items-center gap-1.5 text-celestial-saturn text-xs font-black uppercase tracking-widest">
               <CheckCircle size={12} />
                {t.linked || ui('已连接', 'Linked')}
             </div>
           ) : isBlocked ? (
             <div className="flex items-center gap-1.5 text-red-500 text-xs font-black uppercase tracking-widest">
               <AlertCircle size={12} />
                {t.blocked || ui('已阻止', 'Blocked')}
             </div>
           ) : isUnavailable ? (
             <div className="flex items-center gap-1.5 text-white/35 text-xs font-black uppercase tracking-widest">
               <AlertCircle size={12} />
               {t.unavailable || ui('不可用', 'Unavailable')}
             </div>
           ) : !enabled ? (
              <div className="text-xs font-black uppercase tracking-widest text-white/45">{t.disabled || ui('已停用', 'Disabled')}</div>
           ) : (
              <div className="text-xs font-black uppercase tracking-widest text-white/45">{t.awaitingAccess || ui('等待授权', 'Awaiting Access')}</div>
           )}
        </div>

        <div className="flex items-center gap-2">
          {enabled && status !== 'granted' && !isUnavailable && (
            <Button
              onClick={() => onToggle(true)}
              disabled={disabled}
              className="bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-black uppercase tracking-widest px-4 h-9 rounded-xl"
            >
              {status === 'denied' ? (t.retryLink || ui('重新连接', 'Retry Link')) : (t.authorize || ui('授权', 'Authorize'))}
            </Button>
          )}
          <button
            type="button"
            onClick={() => onToggle(!enabled)}
            disabled={disabled || isUnavailable}
            aria-pressed={enabled}
            aria-label={enabled ? ui(`停用${label}`, `Disable ${label}`) : ui(`启用${label}`, `Enable ${label}`)}
            className={`relative h-9 w-16 rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              enabled
                ? 'border-celestial-saturn/40 bg-celestial-saturn/25 shadow-[0_0_18px_rgba(255,204,0,0.18)]'
                : 'border-white/10 bg-white/5 hover:bg-white/10'
            }`}
          >
            <span
              className={`absolute top-1 h-7 w-7 rounded-full transition-all ${
                enabled
                  ? 'left-8 bg-celestial-saturn'
                  : 'left-1 bg-white/35'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 ${active ? 'border border-white/10 bg-white/[0.075] text-white' : 'border border-transparent text-white/55 hover:bg-white/[0.045] hover:text-white/75'}`}
    >
      <div className={`flex-shrink-0 w-4 h-4 flex items-center justify-center ${active ? 'text-celestial-saturn' : 'text-current'}`}>{icon}</div>
      <span className="text-[12px] font-bold uppercase tracking-tight truncate">{label}</span>
      {active && <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-celestial-saturn" />}
    </button>
  );
}

function LLMProviderRow({ icon, label, providerId, models, placeholder, disabled = false, serverKey, t }: {
  icon: React.ReactNode; label: string; providerId: string; models: string[];
  placeholder: string; disabled?: boolean; serverKey: string; t?: any;
}) {
  const { aiConfig, updateAIConfig } = useApp();
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [keyValue, setKeyValue] = useState(() => {
    try { return localStorage.getItem(`lumi_${providerId}_key`) || ''; } catch { return ''; }
  });
  const [saved, setSaved] = useState(false);
  const [serverConfigured, setServerConfigured] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const savedModels = (() => {
    try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
  })();
  const [model, setModel] = useState(() => {
    return savedModels[providerId] || models[0];
  });

  useEffect(() => {
    getSavedKeyStatus()
      .then(data => setServerConfigured(!!data[serverKey]))
      .catch(() => {});
  }, [serverKey]);

  const handleRemoveKey = () => {
    saveServerKeys({ [serverKey]: '' }).then(() => {
      localStorage.removeItem(`lumi_${providerId}_key`);
      setServerConfigured(false);
      setKeyValue('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeyRemoved || ui('API Key 已移除', 'API key removed'));
    }).catch(err => toast.error(err.message || t?.failedToRemoveKey || ui('密钥移除失败', 'Failed to remove key')));
  };

  const handleSaveKey = () => {
    if (!keyValue.trim()) return;
    saveServerKeys({ [serverKey]: keyValue.trim() }).then(() => {
      localStorage.setItem(`lumi_${providerId}_key`, keyValue.trim());
      setServerConfigured(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || ui('API Key 已保存', 'API key saved'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || ui('密钥保存失败', 'Failed to save key')));
  };

  const syncToServer = (models: Record<string, string>) => {
    fetch('/api/preferences/llm', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: aiConfig.provider, models }),
      credentials: 'include',
    }).catch(() => {});
  };

  const handleModelChange = (m: string) => {
    setModel(m);
    const allModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
    })();
    allModels[providerId] = m;
    localStorage.setItem('lumi_llm_models', JSON.stringify(allModels));
    syncToServer(allModels);
    if (aiConfig.provider === providerId) {
      updateAIConfig({ model: m });
    }
  };

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg">{icon}</div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">{label}</label>
        {serverConfigured && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">{t?.configured || ui('已配置', 'CONFIGURED')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="flex gap-3">
        <div className="relative flex-1">
          <input
            disabled={disabled}
            type={showKey ? 'text' : 'password'}
            value={keyValue}
            onChange={e => setKeyValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSaveKey()}
            placeholder={serverConfigured && !keyValue ? (t?.keySavedOnServer || ui('密钥已保存在服务器', 'Key saved on server')) : placeholder}
            className="w-full bg-black/40 border border-white/10 rounded-xl p-4 pr-16 text-white font-mono text-sm outline-none focus:border-celestial-saturn/50 transition-colors disabled:opacity-50"
          />
          <div className="absolute right-2 top-2 flex gap-1">
            <button type="button" onClick={() => setShowKey(!showKey)}
              className="h-10 px-2 bg-white/5 hover:bg-white/10 text-xs font-bold uppercase border border-white/5 rounded-lg">
              {showKey ? (t?.hide || ui('隐藏', 'Hide')) : (t?.show || ui('显示', 'Show'))}
            </button>
          </div>
        </div>
        <Button
          onClick={handleSaveKey}
          disabled={disabled || !keyValue.trim()}
          className="h-[56px] px-4 bg-celestial-saturn text-black rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 disabled:cursor-not-allowed hover:bg-celestial-saturn/90 transition-all"
        >
          {t?.save || ui('保存', 'Save')}
        </Button>
        <Button
          onClick={handleRemoveKey}
          disabled={disabled || (!keyValue && !serverConfigured)}
          className="h-[56px] px-4 bg-red-500/10 border border-red-500/20 rounded-xl text-xs font-black uppercase tracking-widest text-red-400 hover:bg-red-500/20 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
        >
          {t?.remove || ui('移除', 'Remove')}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-[12px] font-black uppercase text-white/55 tracking-wider whitespace-nowrap">{t?.model || ui('模型', 'Model')}</label>
        <input
          type="text"
          value={model}
          onChange={e => handleModelChange(e.target.value)}
          list={`models-${providerId}`}
          placeholder={models[0]}
          className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono font-bold outline-none focus:border-celestial-saturn/50"
        />
        <datalist id={`models-${providerId}`}>
          {models.map(m => <option key={m} value={m} />)}
        </datalist>
        {aiConfig.provider === providerId && (
          <span className="text-xs px-2 py-0.5 bg-celestial-saturn/10 border border-celestial-saturn/20 text-celestial-saturn rounded-full font-bold whitespace-nowrap">{t?.activeBadge || ui('当前', 'ACTIVE')}</span>
        )}
      </div>
    </div>
  );
}

function VisionProviderRow({ icon, label, providerId, models, placeholder, disabled = false, serverKey, t }: {
  icon: React.ReactNode; label: string; providerId: string; models: string[];
  placeholder: string; disabled?: boolean; serverKey: string; t?: any;
}) {
  const { visionConfig, updateVisionConfig } = useApp();
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [keyValue, setKeyValue] = useState(() => {
    try { return localStorage.getItem(`lumi_vision_${providerId}_key`) || ''; } catch { return ''; }
  });
  const [saved, setSaved] = useState(false);
  const [serverConfigured, setServerConfigured] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const savedModels = (() => {
    try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
  })();
  const [model, setModel] = useState(() => savedModels[providerId] || models[0]);

  useEffect(() => {
    getSavedKeyStatus()
      .then(data => setServerConfigured(!!data[serverKey]))
      .catch(() => {});
  }, [serverKey]);

  const handleSaveKey = () => {
    if (!keyValue.trim()) return;
    saveServerKeys({ [serverKey]: keyValue.trim() }).then(() => {
      localStorage.setItem(`lumi_vision_${providerId}_key`, keyValue.trim());
      setServerConfigured(true);
      if (visionConfig.provider === providerId) {
        updateVisionConfig({ apiKey: keyValue.trim(), model });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || ui('API Key 已保存', 'API key saved'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || ui('密钥保存失败', 'Failed to save key')));
  };

  const handleRemoveKey = () => {
    saveServerKeys({ [serverKey]: '' }).then(() => {
      localStorage.removeItem(`lumi_vision_${providerId}_key`);
      setServerConfigured(false);
      setKeyValue('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeyRemoved || ui('API Key 已移除', 'API key removed'));
    }).catch(err => toast.error(err.message || t?.failedToRemoveKey || ui('密钥移除失败', 'Failed to remove key')));
  };

  const handleModelChange = (m: string) => {
    setModel(m);
    const allModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
    })();
    allModels[providerId] = m;
    localStorage.setItem('lumi_vision_models', JSON.stringify(allModels));
    if (visionConfig.provider === providerId) {
      updateVisionConfig({ model: m });
    } else {
      fetch('/api/preferences/vision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: visionConfig.provider, model: visionConfig.model, models: allModels }),
        credentials: 'include',
      }).catch(() => {});
    }
  };

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg">{icon}</div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">{label}</label>
        {serverConfigured && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">{t?.configured || ui('已配置', 'CONFIGURED')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="flex gap-3">
        <div className="relative flex-1">
          <input
            disabled={disabled}
            type={showKey ? 'text' : 'password'}
            value={keyValue}
            onChange={e => setKeyValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSaveKey()}
            placeholder={serverConfigured && !keyValue ? (t?.keySavedOnServer || ui('密钥已保存在服务器', 'Key saved on server')) : placeholder}
            className="w-full bg-black/40 border border-white/10 rounded-xl p-4 pr-16 text-white font-mono text-sm outline-none focus:border-cyan-300/50 transition-colors disabled:opacity-50"
          />
          <div className="absolute right-2 top-2 flex gap-1">
            <button type="button" onClick={() => setShowKey(!showKey)}
              className="h-10 px-2 bg-white/5 hover:bg-white/10 text-xs font-bold uppercase border border-white/5 rounded-lg">
              {showKey ? (t?.hide || ui('隐藏', 'Hide')) : (t?.show || ui('显示', 'Show'))}
            </button>
          </div>
        </div>
        <Button
          onClick={handleSaveKey}
          disabled={disabled || !keyValue.trim()}
          className="h-[56px] px-4 bg-cyan-300 text-black rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 disabled:cursor-not-allowed hover:bg-cyan-200 transition-all"
        >
          {t?.save || ui('保存', 'Save')}
        </Button>
        <Button
          onClick={handleRemoveKey}
          disabled={disabled || (!keyValue && !serverConfigured)}
          className="h-[56px] px-4 bg-red-500/10 border border-red-500/20 rounded-xl text-xs font-black uppercase tracking-widest text-red-400 hover:bg-red-500/20 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
        >
          {t?.remove || ui('移除', 'Remove')}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-[12px] font-black uppercase text-white/55 tracking-wider whitespace-nowrap">{t?.model || ui('模型', 'Model')}</label>
        <input
          type="text"
          value={model}
          onChange={e => handleModelChange(e.target.value)}
          list={`vision-models-${providerId}`}
          placeholder={models[0]}
          className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono font-bold outline-none focus:border-cyan-300/50"
        />
        <datalist id={`vision-models-${providerId}`}>
          {models.map(m => <option key={m} value={m} />)}
        </datalist>
        {visionConfig.provider === providerId && (
          <span className="text-xs px-2 py-0.5 bg-cyan-300/10 border border-cyan-300/20 text-cyan-200 rounded-full font-bold whitespace-nowrap">{t?.activeBadge || ui('当前', 'ACTIVE')}</span>
        )}
      </div>
    </div>
  );
}

function VisionLocalProviderRow({ icon, label, providerId, endpoint, storageKey, defaultUrl, defaultModel, suggestions, t }: {
  icon: React.ReactNode;
  label: string;
  providerId: 'ollama' | 'lmstudio';
  endpoint: string;
  storageKey: string;
  defaultUrl: string;
  defaultModel: string;
  suggestions: string[];
  t?: any;
}) {
  const { visionConfig, updateVisionConfig } = useApp();
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [baseUrl, setBaseUrl] = useState(() => {
    try { return localStorage.getItem(storageKey) || defaultUrl; } catch { return defaultUrl; }
  });
  const [detected, setDetected] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedModels = (() => {
    try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
  })();
  const [model, setModel] = useState(() => savedModels[providerId] || defaultModel);

  useEffect(() => {
    fetch(endpoint, { credentials: 'include' })
      .then(async r => {
        const cfg = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(cfg.error || 'Failed to load local vision config');
        return cfg;
      })
      .then(cfg => {
        setBaseUrl(cfg.baseUrl || defaultUrl);
        setDetected(!!cfg.detected);
        setModels(cfg.models || []);
      })
      .catch(() => {});
  }, [defaultUrl, endpoint]);

  const allModelOptions = Array.from(new Set([model, ...models, ...suggestions].filter(Boolean)));

  const persistModel = (nextModel: string) => {
    setModel(nextModel);
    const allModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
    })();
    allModels[providerId] = nextModel;
    localStorage.setItem('lumi_vision_models', JSON.stringify(allModels));
    if (visionConfig.provider === providerId) {
      updateVisionConfig({ model: nextModel });
    } else {
      fetch('/api/preferences/vision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: visionConfig.provider, model: visionConfig.model, models: allModels }),
        credentials: 'include',
      }).catch(() => {});
    }
  };

  const handleDetect = async () => {
    setChecking(true);
    try {
      const resp = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ baseUrl }),
      });
      const cfg = await resp.json();
      if (!resp.ok) throw new Error(cfg.error || 'Detect failed');
      setDetected(!!cfg.detected);
      setModels(cfg.models || []);
      localStorage.setItem(storageKey, baseUrl);
      const firstVisionModel = (cfg.models || []).find((m: string) => /vl|vision|minicpm|internvl|llava|glm.*v/i.test(m)) || model || defaultModel;
      if (firstVisionModel && firstVisionModel !== model) persistModel(firstVisionModel);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setDetected(false);
      setModels([]);
      toast.error(err.message || 'Detect failed');
    } finally {
      setChecking(false);
    }
  };

  const handleUse = () => {
    updateVisionConfig({ provider: providerId, model });
  };

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg">{icon}</div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">{label}</label>
        {detected && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">{ui('已连接', 'CONNECTED')}</span>}
        {visionConfig.provider === providerId && <span className="text-xs px-2 py-0.5 bg-cyan-300/10 border border-cyan-300/20 text-cyan-200 rounded-full font-bold">{t?.activeBadge || ui('当前', 'ACTIVE')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="flex gap-3">
        <input
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); setSaved(false); }}
          onKeyDown={e => e.key === 'Enter' && handleDetect()}
          placeholder={defaultUrl}
          className="flex-1 bg-black/40 border border-white/10 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-emerald-400/50 transition-colors"
        />
        <Button
          onClick={handleDetect}
          disabled={checking || !baseUrl.trim()}
          className="h-[56px] px-5 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 hover:bg-emerald-500 transition-all"
        >
          {checking ? <Loader2 size={16} className="animate-spin" /> : ui('检测', 'Detect')}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-[12px] font-black uppercase text-white/55 tracking-wider whitespace-nowrap">{t?.model || ui('模型', 'Model')}</label>
        <input
          type="text"
          value={model}
          onChange={e => persistModel(e.target.value)}
          list={`vision-local-models-${providerId}`}
          placeholder={defaultModel}
          className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono font-bold outline-none focus:border-emerald-400/50"
        />
        <datalist id={`vision-local-models-${providerId}`}>
          {allModelOptions.map(m => <option key={m} value={m} />)}
        </datalist>
        <Button
          onClick={handleUse}
          disabled={!model.trim()}
          className="h-9 px-3 bg-cyan-300 text-black rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 hover:bg-cyan-200 transition-all"
        >
          {ui('设为视觉', 'Use')}
        </Button>
      </div>
      <p className="text-[12px] text-white/45 leading-relaxed">
        {ui('本地视觉只在你的电脑上处理截图和图片。模型需要支持图像输入，否则视觉任务会失败并明确报错。', 'Local vision processes screenshots and images on your machine. The selected model must support image input, otherwise vision tasks will fail explicitly.')}
      </p>
      {detected && models.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {models.slice(0, 12).map(m => (
            <button key={m} onClick={() => persistModel(m)} className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/60 hover:text-white hover:bg-white/10 font-mono transition-colors">{m}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function VisionRelayProviderRow({ t }: { t?: any }) {
  const { visionConfig, updateVisionConfig } = useApp();
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem('lumi_relay_key') || ''; } catch { return ''; }
  });
  const [baseUrl, setBaseUrl] = useState(() => {
    try { return localStorage.getItem('lumi_relay_url') || 'http://localhost:8000/v1'; } catch { return 'http://localhost:8000/v1'; }
  });
  const savedModels = (() => {
    try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
  })();
  const [model, setModel] = useState(() => savedModels.relay || 'qwen2.5-vl-7b-instruct');
  const [serverConfigured, setServerConfigured] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSavedKeyStatus()
      .then(data => setServerConfigured(!!data.RELAY_API_KEY && !!data.RELAY_BASE_URL))
      .catch(() => {});
  }, []);

  const persistModel = (nextModel: string) => {
    setModel(nextModel);
    const allModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
    })();
    allModels.relay = nextModel;
    localStorage.setItem('lumi_vision_models', JSON.stringify(allModels));
    if (visionConfig.provider === 'relay') updateVisionConfig({ model: nextModel });
  };

  const handleSave = () => {
    if (!apiKey.trim() || !baseUrl.trim()) return;
    saveServerKeys({ RELAY_API_KEY: apiKey.trim(), RELAY_BASE_URL: baseUrl.trim() }).then(() => {
      localStorage.setItem('lumi_relay_key', apiKey.trim());
      localStorage.setItem('lumi_relay_url', baseUrl.trim());
      setServerConfigured(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || ui('API Key 已保存', 'API key saved'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || ui('保存失败', 'Failed to save')));
  };

  const handleUse = () => {
    updateVisionConfig({ provider: 'relay', model });
  };

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg"><Globe size={18} className="text-cyan-400" /></div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">OpenAI-Compatible Vision</label>
        {serverConfigured && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">{ui('已配置', 'CONFIGURED')}</span>}
        {visionConfig.provider === 'relay' && <span className="text-xs px-2 py-0.5 bg-cyan-300/10 border border-cyan-300/20 text-cyan-200 rounded-full font-bold">{t?.activeBadge || ui('当前', 'ACTIVE')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="grid grid-cols-1 gap-3">
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          placeholder="API Key"
          className="bg-black/40 border border-white/10 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-cyan-400/50 transition-colors"
        />
        <input
          type="text"
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          placeholder="http://localhost:8000/v1"
          className="bg-black/40 border border-white/10 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-cyan-400/50 transition-colors"
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-[12px] font-black uppercase text-white/55 tracking-wider whitespace-nowrap">{t?.model || ui('模型', 'Model')}</label>
        <input
          type="text"
          value={model}
          onChange={e => persistModel(e.target.value)}
          list="vision-relay-models"
          className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono font-bold outline-none focus:border-cyan-400/50"
        />
        <datalist id="vision-relay-models">
          {['qwen2.5-vl-7b-instruct', 'minicpm-v-4_5', 'internvl3_5-8b', 'glm-4.1v-9b-thinking'].map(m => <option key={m} value={m} />)}
        </datalist>
      </div>
      <div className="flex gap-3">
        <Button
          onClick={handleSave}
          disabled={!apiKey.trim() || !baseUrl.trim()}
          className="h-[44px] px-5 bg-cyan-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 hover:bg-cyan-500 transition-all"
        >
          {t?.save || ui('保存', 'Save')}
        </Button>
        <Button
          onClick={handleUse}
          disabled={!model.trim()}
          className="h-[44px] px-5 bg-cyan-300 text-black rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 hover:bg-cyan-200 transition-all"
        >
          {ui('设为视觉', 'Use as Vision')}
        </Button>
      </div>
      <p className="text-[12px] text-white/45 leading-relaxed">
        {ui('用于 vLLM、SGLang、Xinference 或其他兼容 OpenAI Chat Completions 的本地视觉服务。', 'Use this for vLLM, SGLang, Xinference, or any local OpenAI-compatible vision endpoint.')}
      </p>
    </div>
  );
}

function ProactiveVoiceToggle() {
  const storageKey = 'lumi_allow_proactive_voice';
  const [enabled, setEnabled] = useState(() => localStorage.getItem(storageKey) === 'true');

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem(storageKey, String(next));
    window.dispatchEvent(new CustomEvent('lumi:setting-changed', {
      detail: { key: storageKey, value: next },
    }));
  };

  return (
    <button
      onClick={toggle}
      className={`w-11 h-6 rounded-full transition-all relative ${enabled ? 'bg-celestial-saturn' : 'bg-white/10 border border-white/20'}`}
    >
      <motion.div
        animate={{ x: enabled ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-md"
      />
    </button>
  );
}

function WakeWordToggle() {
  const storageKey = 'lumi_wake_word_enabled';
  const [enabled, setEnabled] = useState(() => localStorage.getItem(storageKey) === 'true');

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem(storageKey, String(next));
    window.dispatchEvent(new CustomEvent('lumi:setting-changed', {
      detail: { key: storageKey, value: next },
    }));
  };

  return (
    <button
      onClick={toggle}
      className={`w-11 h-6 rounded-full transition-all relative ${enabled ? 'bg-celestial-saturn' : 'bg-white/10 border border-white/20'}`}
    >
      <motion.div
        animate={{ x: enabled ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-md"
      />
    </button>
  );
}

function AlwaysOnVoiceToggle() {
  const storageKey = 'lumi_always_on_voice';
  const [enabled, setEnabled] = useState(() => localStorage.getItem(storageKey) === 'true');

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem(storageKey, String(next));
  };

  return (
    <button
      onClick={toggle}
      className={`w-11 h-6 rounded-full transition-all relative ${enabled ? 'bg-celestial-saturn' : 'bg-white/10 border border-white/20'}`}
    >
      <motion.div
        animate={{ x: enabled ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-md"
      />
    </button>
  );
}

function VisionModelPage({ t }: { t: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const { visionConfig, updateVisionConfig } = useApp();
  return (
    <div className="space-y-8">
      <SettingsSection title={t.visionModelSettings || ui('视觉模型', 'Vision Model')} icon={<Camera size={18} className="text-cyan-300" />}>
        <div className="mb-6 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.04] p-4 space-y-2">
          <label className="text-xs font-black uppercase text-white/55 ml-1">{t.primaryVisionModel || ui('屏幕理解与视觉控制模型', 'Screen Understanding & Vision Control')}</label>
          <div className="relative">
            <select value={visionConfig.provider} onChange={(e) => updateVisionConfig({ provider: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm font-bold appearance-none cursor-pointer focus:border-cyan-300/50 outline-none">
              <option value="openai">OpenAI Vision</option>
              <option value="gemini">Google Gemini Vision</option>
              <option value="ark">Doubao / 豆包 Vision (Ark)</option>
              <option value="qwen">Qwen-VL (DashScope)</option>
              <option value="ollama">Ollama Local Vision</option>
              <option value="lmstudio">LM Studio Local Vision</option>
              <option value="relay">OpenAI-Compatible Vision</option>
            </select>
            <ChevronDown size={14} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/45" />
          </div>
          <p className="text-[12px] text-white/45 px-1">
            {ui('视觉模型只用于看屏幕、OCR、电脑控制等视觉任务；不会改变主推理大脑，也不会改变语音服务。', 'Vision is used only for screen reading, OCR, and desktop control. It does not change the main reasoning brain or voice services.')}
            <span className="ml-2 text-white/40 font-mono">{visionConfig.provider}/{visionConfig.model}</span>
          </p>
        </div>
        <div className="grid grid-cols-1 gap-6">
          <VisionProviderRow icon={<MessagesSquare size={18} className="text-green-400" />} label="OpenAI Vision" providerId="openai" models={['gpt-4o', 'gpt-4o-mini']} placeholder="sk-..." serverKey="OPENAI_API_KEY" t={t} />
          <VisionProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label="Google Gemini Vision" providerId="gemini" models={['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']} placeholder={ui('输入 Gemini API Key...', 'Enter Gemini API key...')} serverKey="GEMINI_API_KEY" t={t} />
          <VisionProviderRow icon={<Cloud size={18} className="text-cyan-400" />} label="Doubao / 豆包 Vision (Ark)" providerId="ark" models={['doubao-1-5-vision-pro-32k']} placeholder={ui('输入 Ark API Key...', 'Enter Ark API key...')} serverKey="ARK_API_KEY" t={t} />
          <VisionProviderRow icon={<Zap size={18} className="text-violet-400" />} label="Qwen-VL / DashScope" providerId="qwen" models={['qwen-vl-max']} placeholder="sk-..." serverKey="DASHSCOPE_API_KEY" t={t} />
          <VisionLocalProviderRow
            icon={<Cpu size={18} className="text-emerald-400" />}
            label="Ollama Local Vision"
            providerId="ollama"
            endpoint="/api/ollama/config"
            storageKey="lumi_ollama_url"
            defaultUrl="http://localhost:11434"
            defaultModel="qwen2.5vl:7b"
            suggestions={['qwen2.5vl:7b', 'minicpm-v:8b', 'llama3.2-vision:11b']}
            t={t}
          />
          <VisionLocalProviderRow
            icon={<Cpu size={18} className="text-amber-400" />}
            label="LM Studio Local Vision"
            providerId="lmstudio"
            endpoint="/api/lmstudio/config"
            storageKey="lumi_lmstudio_url"
            defaultUrl="http://localhost:1234"
            defaultModel="local-vision-model"
            suggestions={['qwen2.5-vl-7b-instruct', 'minicpm-v-4_5', 'internvl3_5-8b']}
            t={t}
          />
          <VisionRelayProviderRow t={t} />
        </div>
      </SettingsSection>
    </div>
  );
}

function LLMProvidersPage({ t, providerStatus }: { t: any; providerStatus: Record<string, { available: boolean; model: string }> }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const { aiConfig, updateAIConfig } = useApp();
  return (
    <div className="space-y-8">
      <SettingsSection title={t.llmProviders || ui('LLM 服务商', 'LLM Providers')} icon={<BrainCircuit size={18} className="text-celestial-saturn" />}>
        <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.04] p-4 space-y-2">
          <label className="text-xs font-black uppercase text-white/55 ml-1">{t.primaryReasoningBrain || ui('主推理大脑', 'Primary Reasoning Brain')}</label>
          <div className="relative">
            <select value={aiConfig.provider} onChange={(e) => updateAIConfig({ provider: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm font-bold appearance-none cursor-pointer focus:border-celestial-saturn/50 outline-none">
              <option value="deepseek">DeepSeek</option>
              <option value="qwen">Qwen (DashScope)</option>
              <option value="gemini">Google Gemini</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="ark">Doubao / 豆包 (Ark)</option>
              <option value="xiaomi">Xiaomi / 小米</option>
              <option value="kimi">Kimi / 月之暗面</option>
              <option value="glm">GLM / 智谱</option>
              <option value="relay">中转站 (API Relay)</option>
              <option value="ollama">Ollama (Local)</option>
              <option value="lmstudio">LM Studio (Local)</option>
            </select>
            <ChevronDown size={14} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/45" />
          </div>
          <p className="text-[12px] text-white/45 px-1">{t?.activeModel || ui('当前模型', 'Active model')}: <span className="text-white/40 font-mono">{aiConfig.model}</span> - {t?.changePerProvider || ui('可在下方服务商卡片中调整模型。', 'Adjust the model in the provider cards below.')}</p>
        </div>
        <p className="text-sm text-white/40 max-w-xl mb-6">
          {t.apiMatrixLLMDesc || ui('为每个 LLM 服务商配置 API Key 和偏好模型。', 'Configure API keys and preferred models for each LLM provider.')}
        </p>
        <div className="grid grid-cols-1 gap-6">
          <LLMProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label="DeepSeek" providerId="deepseek" models={['deepseek-chat', 'deepseek-reasoner']} placeholder="sk-..." serverKey="DEEPSEEK_API_KEY" t={t} />
          <LLMProviderRow icon={<Zap size={18} className="text-violet-400" />} label="Qwen / DashScope (Alibaba Cloud)" providerId="qwen" models={['qwen-plus', 'qwen-max', 'qwen-turbo']} placeholder="sk-..." serverKey="DASHSCOPE_API_KEY" t={t} />
          <LLMProviderRow icon={<Cloud size={18} className="text-cyan-400" />} label="Doubao / 豆包 (Ark)" providerId="ark" models={['doubao-1-5-pro-32k', 'doubao-1-5-lite-32k', 'doubao-1-5-vision-pro-32k']} placeholder={ui('输入 Ark API Key...', 'Enter Ark API key...')} serverKey="ARK_API_KEY" t={t} />
          <LLMProviderRow icon={<Cpu size={18} className="text-orange-400" />} label="Xiaomi / 小米" providerId="xiaomi" models={['xiaomi-chat']} placeholder={ui('输入小米 API Key...', 'Enter Xiaomi API key...')} serverKey="XIAOMI_API_KEY" t={t} />
          <LLMProviderRow icon={<Sparkle size={18} className="text-rose-400" />} label="Kimi / 月之暗面 (Moonshot)" providerId="kimi" models={['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']} placeholder="sk-..." serverKey="KIMI_API_KEY" t={t} />
          <LLMProviderRow icon={<Sparkle size={18} className="text-cyan-400" />} label="GLM / 智谱 (Zhipu AI)" providerId="glm" models={['glm-4-plus', 'glm-4-flash', 'glm-4-air']} placeholder={ui('输入 GLM API Key...', 'Enter GLM API key...')} serverKey="GLM_API_KEY" t={t} />
          <LLMProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label={`Google Gemini${providerStatus.gemini?.available ? ` (${providerStatus.gemini.model})` : ''}`} providerId="gemini" models={['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']} placeholder={providerStatus.gemini?.available ? (t.connectedViaEnv || ui('已通过环境变量连接', 'Connected via environment')) : (t.noKeyConfigured || ui('未配置密钥', 'No key configured'))} serverKey="GEMINI_API_KEY" t={t} />
          <LLMProviderRow icon={<MessagesSquare size={18} className="text-green-400" />} label="OpenAI" providerId="openai" models={['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo']} placeholder="sk-..." serverKey="OPENAI_API_KEY" t={t} />
          <LLMProviderRow icon={<Sparkle size={18} className="text-purple-400" />} label="Anthropic Claude" providerId="anthropic" models={['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5']} placeholder="sk-ant-..." serverKey="ANTHROPIC_API_KEY" t={t} />
          <OllamaProviderRow t={t} />
          <LmStudioProviderRow t={t} />
          <RelayProviderRow t={t} />
        </div>
      </SettingsSection>
    </div>
  );
}

function OllamaProviderRow({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [baseUrl, setBaseUrl] = useState(() => {
    try { return localStorage.getItem('lumi_ollama_url') || 'http://localhost:11434'; } catch { return 'http://localhost:11434'; }
  });
  const [detected, setDetected] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Load current config on mount
    fetch('/api/ollama/config', { credentials: 'include' })
      .then(async r => {
        const cfg = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(cfg.error || 'Failed to load Ollama config');
        return cfg;
      })
      .then(cfg => {
        setBaseUrl(cfg.baseUrl || 'http://localhost:11434');
        setDetected(!!cfg.detected);
        setModels(cfg.models || []);
      })
      .catch(() => {});
  }, []);

  const handleDetect = async () => {
    setChecking(true);
    try {
      const resp = await fetch('/api/ollama/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ baseUrl }),
      });
      const cfg = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(cfg.error || 'Ollama detection failed');
      setDetected(!!cfg.detected);
      setModels(cfg.models || []);
      localStorage.setItem('lumi_ollama_url', baseUrl);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { setDetected(false); setModels([]); }
    setChecking(false);
  };

  const llmModels = models.filter(m => !m.includes('embed') && !m.includes('whisper'));

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg"><Cpu size={18} className="text-emerald-400" /></div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">Ollama (Local AI)</label>
        {detected && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">CONNECTED</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="flex gap-3">
        <input
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); setSaved(false); }}
          onKeyDown={e => e.key === 'Enter' && handleDetect()}
          placeholder="http://localhost:11434"
          className="flex-1 bg-black/40 border border-white/10 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-emerald-400/50 transition-colors"
        />
        <Button
          onClick={handleDetect}
          disabled={checking || !baseUrl.trim()}
          className="h-[56px] px-5 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 hover:bg-emerald-500 transition-all"
        >
          {checking ? <Loader2 size={16} className="animate-spin" /> : 'Detect'}
        </Button>
      </div>
      {detected && llmModels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {llmModels.map(m => (
            <span key={m} className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/60 font-mono">{m}</span>
          ))}
        </div>
      )}
      {!detected && !checking && baseUrl && (
        <p className="text-xs text-white/40">{t?.noOllamaModelsFound || ui('此地址未发现本地模型。请确认 Ollama 正在运行。', 'No local models found at this address. Make sure Ollama is running.')}</p>
      )}
    </div>
  );
}

function LmStudioProviderRow({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [baseUrl, setBaseUrl] = useState(() => {
    try { return localStorage.getItem('lumi_lmstudio_url') || 'http://localhost:1234'; } catch { return 'http://localhost:1234'; }
  });
  const [detected, setDetected] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/lmstudio/config', { credentials: 'include' })
      .then(async r => {
        const cfg = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(cfg.error || 'Failed to load LM Studio config');
        return cfg;
      })
      .then(cfg => {
        setBaseUrl(cfg.baseUrl || 'http://localhost:1234');
        setDetected(!!cfg.detected);
        setModels(cfg.models || []);
      })
      .catch(() => {});
  }, []);

  const handleDetect = async () => {
    setChecking(true);
    try {
      const resp = await fetch('/api/lmstudio/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ baseUrl }),
      });
      const cfg = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(cfg.error || 'LM Studio detection failed');
      setDetected(!!cfg.detected);
      setModels(cfg.models || []);
      localStorage.setItem('lumi_lmstudio_url', baseUrl);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { setDetected(false); setModels([]); }
    setChecking(false);
  };

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg"><Cpu size={18} className="text-amber-400" /></div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">LM Studio (Local AI)</label>
        {detected && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">CONNECTED</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="flex gap-3">
        <input
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); setSaved(false); }}
          onKeyDown={e => e.key === 'Enter' && handleDetect()}
          placeholder="http://localhost:1234"
          className="flex-1 bg-black/40 border border-white/10 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-amber-400/50 transition-colors"
        />
        <Button
          onClick={handleDetect}
          disabled={checking || !baseUrl.trim()}
          className="h-[56px] px-5 bg-amber-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 hover:bg-amber-500 transition-all"
        >
          {checking ? <Loader2 size={16} className="animate-spin" /> : 'Detect'}
        </Button>
      </div>
      {detected && models.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {models.map(m => (
            <span key={m} className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/60 font-mono">{m}</span>
          ))}
        </div>
      )}
      {!detected && !checking && baseUrl && (
        <p className="text-xs text-white/40">{t?.noLmStudioModelsFound || ui('未发现模型。请确认 LM Studio 正在运行，并且已加载模型。', 'No models found. Make sure LM Studio is running and a model is loaded.')}</p>
      )}
    </div>
  );
}

function VoiceServicesPage({ t }: { t: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  return (
    <div className="space-y-8">
      <SettingsSection title={t.audioOutput || ui('音频与语音输出', 'Audio & Voice Output')} icon={<Music size={18} className="text-celestial-saturn" />}>
        <div className="space-y-4 mb-6">
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-white/80">{t.ttsEngine || ui('TTS 引擎', 'TTS Engine')}</span>
            </div>
            <p className="text-xs text-white/40">{t.ttsEngineDesc || ui('本地 TTS：Local CosyVoice / GPT-SoVITS；云端：DashScope CosyVoice / Doubao。', 'Local TTS: Local CosyVoice / GPT-SoVITS; cloud: DashScope CosyVoice / Doubao.')}</p>
          </div>
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-white/80">{t.sttEngine || ui('STT 引擎', 'STT Engine')}</span>
            </div>
            <p className="text-xs text-white/40">{t.sttEngineDesc || ui('本地 Whisper、OpenAI Whisper、豆包和 Qwen ASR 可用。', 'Local Whisper, OpenAI Whisper, Doubao, and Qwen ASR are available.')}</p>
          </div>
          <VoiceProviderSwitch t={t} />
        </div>
        <p className="text-sm text-white/40 max-w-xl mb-6">
          {t.voiceServicesDesc || ui('语音识别（ASR）和语音合成（TTS）。本地 TTS 不需要 API key；云端 TTS 需要对应服务密钥。', 'Speech recognition (ASR) and speech synthesis (TTS). Local TTS does not need an API key; cloud TTS uses the matching service key.')}
        </p>
        <div className="grid grid-cols-1 gap-6">
          <ApiKeyField icon={<Volume2 size={18} className="text-emerald-400" />} label={t.doubaoSpeechLabel || 'Doubao Speech (STT + TTS)'} placeholder="AppID:AccessToken" storageKey="lumi_doubao_speech" serverKey="DOUBAO_SPEECH_KEY" hint={t.doubaoSpeechHint || ui('格式：AppID:AccessToken。可在 console.volcengine.com/speech 的应用管理中获取。', 'Format: AppID:AccessToken. Get both from console.volcengine.com/speech → App Management')} t={t} />
          <ApiKeyField icon={<Zap size={18} className="text-violet-400" />} label={t.dashscopeLabel || 'DashScope (Cloud STT + TTS)'} placeholder="sk-..." storageKey="lumi_dashscope_key" serverKey="DASHSCOPE_API_KEY" hint={t.dashscopeHint || ui('用于 Qwen ASR 和 DashScope CosyVoice 云端 TTS。可在 dashscope.aliyun.com 获取密钥。', 'Powers Qwen ASR and DashScope CosyVoice cloud TTS. Get your key at dashscope.aliyun.com')} t={t} />
        </div>
        <div className="mt-6 p-4 bg-white/5 rounded-xl border border-white/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-white/80">{t.proactiveVoiceGreeting || '允许Lumi主动语音问候'}</p>
              <p className="text-xs text-white/55 mt-0.5">{t.proactiveVoiceGreetingDesc || '开启后，Lumi会在检测到异常或长时间不活动时主动开口说话'}</p>
            </div>
            <ProactiveVoiceToggle />
          </div>
          <div className="flex items-center justify-between mt-3">
            <div>
              <p className="text-xs font-bold text-white/80">{t.wakeWordLabel || '唤醒词检测 (Wake Word)'}</p>
              <p className="text-xs text-white/55 mt-0.5">{t.wakeWordDesc || '持续监听"Lumi"唤醒词。开启后麦克风持续上传音频做ASR识别，会产生费用。'}</p>
            </div>
            <WakeWordToggle />
          </div>
          <div className="flex items-center justify-between mt-3">
            <div>
              <p className="text-xs font-bold text-white/80">{t.alwaysOnVoiceLabel || '持续语音通道 (Always-On Voice)'}</p>
              <p className="text-xs text-white/55 mt-0.5">{t.alwaysOnVoiceDesc || '开启后麦克风不会自动断开，Lumi始终在听。'}</p>
            </div>
            <AlwaysOnVoiceToggle />
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function ApiKeyField({ icon, label, placeholder, disabled = false, storageKey, serverKey, hint, t }: { icon: React.ReactNode, label: string, placeholder: string, disabled?: boolean, storageKey: string, serverKey?: string, hint?: string, t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(storageKey) || ''; } catch { return ''; }
  });
  const [saved, setSaved] = useState(false);
  const [serverConfigured, setServerConfigured] = useState(false);

  useEffect(() => {
    if (!serverKey) return;
    getSavedKeyStatus()
      .then(data => setServerConfigured(!!data[serverKey]))
      .catch(() => {});
  }, [serverKey]);

  const handleRemove = () => {
    const removeLocal = () => {
      localStorage.removeItem(storageKey);
      setServerConfigured(false);
      setValue('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeyRemoved || ui('API Key 已移除', 'API key removed'));
    };
    if (serverKey) {
      saveServerKeys({ [serverKey]: '' })
        .then(removeLocal)
        .catch(err => toast.error(err.message || t?.failedToRemoveKey || ui('密钥移除失败', 'Failed to remove key')));
      return;
    }
    removeLocal();
  };

  const handleSave = () => {
    if (!value.trim()) return;
    const saveLocal = () => {
      localStorage.setItem(storageKey, value.trim());
      setServerConfigured(!!serverKey || serverConfigured);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || ui('API Key 已保存', 'API key saved'));
    };
    if (serverKey) {
      saveServerKeys({ [serverKey]: value.trim() })
        .then(saveLocal)
        .catch(err => toast.error(err.message || t?.failedToSaveKey || ui('密钥保存到服务器失败', 'Failed to save key to server')));
      return;
    }
    saveLocal();
  };

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg">{icon}</div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">{label}</label>
        {serverConfigured && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">{t?.configured || ui('已配置', 'CONFIGURED')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            disabled={disabled}
            type="password"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder={serverConfigured && !value ? (t?.keySavedOnServer || ui('密钥已保存在服务器（输入可替换）', 'Key saved on server (type to replace)')) : placeholder}
            className="w-full bg-black/40 border border-white/10 rounded-xl p-4 pr-16 text-white font-mono text-sm outline-none focus:border-celestial-saturn/50 transition-colors disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleRemove}
            disabled={disabled || (!value && !serverConfigured)}
            className="absolute right-2 top-2 h-10 px-3 bg-red-500/10 border border-red-500/20 rounded-lg text-[12px] font-bold uppercase tracking-tight text-red-400 hover:bg-red-500/20 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
          >
            {t?.remove || ui('移除', 'Remove')}
          </button>
        </div>
        <Button
          onClick={handleSave}
          disabled={disabled || !value.trim()}
          className="h-[56px] px-6 bg-celestial-saturn text-black rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 disabled:cursor-not-allowed hover:bg-celestial-saturn/90 transition-all"
        >
          {t?.save || ui('保存', 'Save')}
        </Button>
      </div>
      {hint && <p className="text-[12px] text-white/45 leading-relaxed">{hint}</p>}
    </div>
  );
}


function RelayProviderRow({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem('lumi_relay_key') || ''; } catch { return ''; }
  });
  const [baseUrl, setBaseUrl] = useState(() => {
    try { return localStorage.getItem('lumi_relay_url') || 'https://api.example.com/v1'; } catch { return 'https://api.example.com/v1'; }
  });
  const [serverKeyOk, setServerKeyOk] = useState(false);
  const [serverUrlOk, setServerUrlOk] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSavedKeyStatus()
      .then(data => {
        setServerKeyOk(!!data['RELAY_API_KEY']);
        setServerUrlOk(!!data['RELAY_BASE_URL']);
      })
      .catch(() => {});
  }, []);

  const handleSave = () => {
    if (!apiKey.trim() || !baseUrl.trim()) return;
    saveServerKeys({ RELAY_API_KEY: apiKey.trim(), RELAY_BASE_URL: baseUrl.trim() }).then(() => {
      localStorage.setItem('lumi_relay_key', apiKey.trim());
      localStorage.setItem('lumi_relay_url', baseUrl.trim());
      setServerKeyOk(true);
      setServerUrlOk(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || ui('API Key 已保存', 'API key saved'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || ui('保存失败', 'Failed to save')));
  };

  const handleRemove = () => {
    saveServerKeys({ RELAY_API_KEY: '', RELAY_BASE_URL: '' }).then(() => {
      localStorage.removeItem('lumi_relay_key');
      localStorage.removeItem('lumi_relay_url');
      setServerKeyOk(false);
      setServerUrlOk(false);
      setApiKey('');
      setBaseUrl('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeyRemoved || ui('API Key 已移除', 'API key removed'));
    }).catch(err => toast.error(err.message || t?.failedToRemoveKey || ui('移除失败', 'Failed to remove')));
  };

  return (
    <div className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 bg-white/5 rounded-lg"><Globe size={18} className="text-cyan-400" /></div>
        <label className="text-xs font-black uppercase tracking-widest text-white/50">中转站 (API Relay)</label>
        {(serverKeyOk || serverUrlOk) && <span className="text-xs px-2 py-0.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full font-bold">{ui('已配置', 'CONFIGURED')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400 ml-auto" />}
      </div>
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder="API Key"
            className="flex-1 bg-black/40 border border-white/10 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-cyan-400/50 transition-colors"
          />
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder="https://your-relay.example.com/v1"
            className="flex-1 bg-black/40 border border-white/10 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-cyan-400/50 transition-colors"
          />
        </div>
      </div>
      <div className="flex gap-3">
        <Button
          onClick={handleSave}
          disabled={!apiKey.trim() || !baseUrl.trim()}
          className="h-[48px] px-6 bg-cyan-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-30 disabled:cursor-not-allowed hover:bg-cyan-500 transition-all"
        >
          {t?.save || ui('保存', 'Save')}
        </Button>
        <Button
          onClick={handleRemove}
          disabled={!apiKey && !serverKeyOk && !serverUrlOk}
          className="h-[48px] px-4 bg-red-500/10 border border-red-500/20 rounded-xl text-xs font-black uppercase tracking-widest text-red-400 hover:bg-red-500/20 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
        >
          {t?.remove || ui('移除', 'Remove')}
        </Button>
      </div>
      <p className="text-[12px] text-white/45 leading-relaxed">{ui('兼容 OpenAI 的 API 中转服务。请输入代理/中转服务的 Base URL 和 API Key。', 'OpenAI-compatible API relay. Enter the base URL and API key of your proxy/relay service.')}</p>
    </div>
  );
}

type AutonomyGateConfig = {
  autonomyLevel: 'reactive' | 'semi' | 'full';
  alwaysOnline: boolean;
  autoProcessEnabled: boolean;
  messagingSendRequiresConfirmation: boolean;
  maxConsecutiveTasks: number;
  allowedHours: { start: number; end: number }[];
  requireIdle: boolean;
  minIdleSeconds: number;
  maxTokensPerHour: number;
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
};

type NativeRuntimeStatus = {
  platform: string;
  autostart_supported: boolean;
  autostart_enabled: boolean;
  autostart_entry: string;
  close_to_background: boolean;
  started_in_background: boolean;
  backend_node_running: boolean;
  backend_python_running: boolean;
  node_restarts: number;
  python_restarts: number;
  global_shortcut: string;
  notes: string[];
};

const DEFAULT_AUTONOMY_GATE: AutonomyGateConfig = {
  autonomyLevel: 'semi',
  alwaysOnline: true,
  autoProcessEnabled: true,
  messagingSendRequiresConfirmation: true,
  maxConsecutiveTasks: 3,
  allowedHours: [{ start: 8, end: 22 }],
  requireIdle: true,
  minIdleSeconds: 60,
  maxTokensPerHour: 10000,
};

function AutonomousSettingsPanel({ t, operationMode }: { t: any; operationMode: OperationMode }) {
  const [gateConfig, setGateConfig] = useState<AutonomyGateConfig>(DEFAULT_AUTONOMY_GATE);
  const [nativeRuntime, setNativeRuntime] = useState<NativeRuntimeStatus | null>(null);
  const [nativeRuntimeError, setNativeRuntimeError] = useState('');
  const [taskList, setTaskList] = useState<any[]>([]);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  useEffect(() => {
    fetch('/api/autonomy/gate_config')
      .then(r => r.json())
      .then(d => setGateConfig({ ...DEFAULT_AUTONOMY_GATE, ...(d || {}) }))
      .catch(() => {});
    fetch('/api/scheduler/tasks')
      .then(r => r.json())
      .then(d => setTaskList(d.tasks || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const loadNativeRuntime = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status = await invoke<NativeRuntimeStatus>('get_runtime_resilience_status');
        if (!cancelled) {
          setNativeRuntime(status);
          setNativeRuntimeError('');
        }
      } catch (err: any) {
        if (!cancelled) {
          setNativeRuntime(null);
          setNativeRuntimeError(err?.message || ui('原生常驻运行控制仅在桌面客户端可用。', 'Native runtime controls are only available in the desktop client.'));
        }
      }
    };
    void loadNativeRuntime();
    timer = window.setInterval(loadNativeRuntime, 30000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  const refreshNativeRuntime = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const status = await invoke<NativeRuntimeStatus>('get_runtime_resilience_status');
    setNativeRuntime(status);
    setNativeRuntimeError('');
    return status;
  };

  const updateNativeRuntime = async (kind: 'autostart' | 'closeToBackground', enabled: boolean) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (kind === 'autostart') {
        await invoke('set_autostart_enabled', { enabled });
      } else {
        localStorage.setItem('lumi_close_to_background', String(enabled));
        await invoke('set_close_to_background', { enabled });
      }
      await refreshNativeRuntime();
      toast.success(enabled ? ui('已开启', 'Enabled') : ui('已关闭', 'Disabled'));
    } catch (err: any) {
      toast.error(err?.message || ui('原生运行设置更新失败', 'Failed to update native runtime setting'));
    }
  };

  const invokeRuntimeAction = async (action: 'hide' | 'quit') => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke(action === 'hide' ? 'hide_to_background' : 'quit_app');
    } catch (err: any) {
      toast.error(err?.message || ui('运行时操作失败', 'Runtime action failed'));
    }
  };

  const toggleTask = async (taskId: string) => {
    try {
      const r = await fetch(`/api/scheduler/tasks/${taskId}/toggle`, { method: 'POST', credentials: 'include' });
      const data = await r.json();
      setTaskList(prev => prev.map(t => t.id === taskId ? { ...t, enabled: data.enabled } : t));
    } catch {}
  };

  const modeLabel =
    operationMode === 'autonomous' ? ui('自主', 'Autonomy') :
    operationMode === 'assistant' ? ui('助手', 'Assistant') :
    operationMode === 'chat' ? ui('聊天', 'Chat') :
    ui('会议', 'Meeting');
  const gateLevel = gateConfig.autonomyLevel || (gateConfig.autoProcessEnabled ? 'semi' : 'reactive');
  const ToggleRow = ({
    label,
    desc,
    checked,
    onClick,
    danger,
  }: {
    label: string;
    desc: string;
    checked: boolean;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-black/18 px-3 py-3">
      <div>
        <div className="text-xs font-bold text-white/72">{label}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-white/36">{desc}</div>
      </div>
      <button
        onClick={onClick}
        className={`h-5 w-10 shrink-0 rounded-full transition-all ${checked ? (danger ? 'bg-amber-400' : 'bg-cyan-500') : 'bg-white/10'}`}
      >
        <div className={`h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Desktop Mode Authority */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <div>
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{ui('桌面三档', 'Desktop Modes')}</div>
          <p className="text-xs text-white/40 mt-1">{ui('权限跟随桌面主界面的三档：聊天、助手、自主。会议是独立记录模式，不单独改变自主权限。', 'Permissions follow the three desktop modes: Chat, Assistant, and Autonomy. Meeting is a separate capture mode and does not create another autonomy level.')}</p>
        </div>
        <div className="rounded-xl bg-black/18 px-3 py-3 text-[11px] leading-relaxed text-white/42">
          {ui('当前桌面档位', 'Current desktop mode')}: <span className="font-bold text-white/72">{modeLabel}</span>
          <span className="mx-2 text-white/18">/</span>
          {ui('后端权限档', 'Backend autonomy')}: <span className="font-bold text-white/72">{gateLevel}</span>
        </div>
      </div>

      {/* Resident Runtime */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <div>
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{ui('原生常驻运行', 'Native Resident Runtime')}</div>
          <p className="text-xs text-white/40 mt-1">{ui('控制桌面客户端是否随系统启动，以及关闭窗口后是否继续留在后台。', 'Controls whether the desktop client starts with the system and stays alive after closing the window.')}</p>
        </div>
        <div className="rounded-xl border border-white/8 bg-black/18 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-white/72">{ui('原生常驻运行', 'Native resident runtime')}</div>
              <div className="mt-1 text-[11px] leading-relaxed text-white/36">
                {ui('控制已安装的桌面客户端是否随 Windows 启动，以及关闭窗口后是否继续保持后台运行。', 'Controls whether the installed desktop client starts with Windows and stays alive when the window is closed.')}
              </div>
            </div>
            <button
              onClick={() => refreshNativeRuntime().catch((err: any) => toast.error(err?.message || ui('运行时状态刷新失败', 'Runtime refresh failed')))}
              className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-white/45 hover:bg-white/[0.08] hover:text-white"
            >
              {ui('刷新', 'Refresh')}
            </button>
          </div>
          {nativeRuntime ? (
            <div className="space-y-2">
              <ToggleRow
                label={ui('开机登录后启动', 'Launch at login')}
                desc={nativeRuntime.autostart_supported ? ui('为当前 Windows 用户安装项以 --background 模式启动 Lumi。', 'Starts Lumi with --background for current Windows user installs.') : ui('当前平台暂不支持登录后启动。', 'Launch at login is not supported on this platform yet.')}
                checked={nativeRuntime.autostart_enabled}
                onClick={() => nativeRuntime.autostart_supported && updateNativeRuntime('autostart', !nativeRuntime.autostart_enabled)}
              />
              <ToggleRow
                label={ui('关闭按钮转入后台', 'Close button hides to background')}
                desc={ui('顶部关闭按钮和 Alt+F4 会隐藏 Lumi，而不是停止后端。需要完全退出时使用托盘退出。', 'The top close button and Alt+F4 hide Lumi instead of stopping the backend. Use tray Quit to fully exit.')}
                checked={nativeRuntime.close_to_background}
                onClick={() => updateNativeRuntime('closeToBackground', !nativeRuntime.close_to_background)}
              />
              <div className="grid grid-cols-2 gap-2 text-[11px] text-white/42">
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{ui('平台', 'Platform')}: {nativeRuntime.platform}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{ui('快捷键', 'Shortcut')}: {nativeRuntime.global_shortcut}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{ui('后端', 'Backend')}: {nativeRuntime.backend_node_running ? ui('运行中', 'Running') : ui('开发模式 / 未拉起', 'Dev / not spawned')}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{ui('重启次数', 'Restarts')}: {nativeRuntime.node_restarts}</div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => invokeRuntimeAction('hide')}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white/50 hover:bg-white/[0.08] hover:text-white"
                >
                  {ui('隐藏到后台', 'Hide Now')}
                </button>
                <button
                  onClick={() => invokeRuntimeAction('quit')}
                  className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-200/70 hover:bg-red-400/15 hover:text-red-100"
                >
                  {ui('退出 Lumi', 'Quit Lumi')}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/38">
              {nativeRuntimeError || ui('正在加载原生运行状态...', 'Native runtime status is loading...')}
            </div>
          )}
        </div>
      </div>

      {/* Scheduler Tasks */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <button onClick={() => setTasksExpanded(!tasksExpanded)} className="w-full flex items-center justify-between">
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{ui('后台任务', 'Background Tasks')}</div>
          <ChevronDown size={14} className={`text-white/40 transition-transform ${tasksExpanded ? 'rotate-180' : ''}`} />
        </button>

        {tasksExpanded && (
          <div className="max-h-60 overflow-y-auto custom-scrollbar space-y-1">
            {taskList.map((task: any) => (
              <div key={task.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.02]">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-white/60 truncate">{task.id}</div>
                  <div className="text-[11px] text-white/30">{task.cron} {task.lastRun ? ui(`· 上次：${new Date(task.lastRun).toLocaleTimeString()}`, `· Last: ${new Date(task.lastRun).toLocaleTimeString()}`) : ''}</div>
                </div>
                <button
                  onClick={() => toggleTask(task.id)}
                  className={`w-8 h-4 rounded-full transition-all ${task.enabled !== false ? 'bg-cyan-500/50' : 'bg-white/10'}`}
                >
                  <div className={`w-3 h-3 rounded-full bg-white transition-transform ${task.enabled !== false ? 'translate-x-[18px]' : 'translate-x-[1px]'}`} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {icon}
        <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">{title}</h3>
      </div>
      <div className="space-y-4">
        {children}
      </div>
    </div>
  );
}

function SettingsItem({ label, desc, active = false, storageKey, onChange, t }: { label: string; desc: string; active?: boolean; storageKey?: string; onChange?: (v: boolean) => void; t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [isActive, setIsActive] = useState(() => {
    if (storageKey) {
      try { return localStorage.getItem(storageKey) === 'true'; } catch { return active; }
    }
    return active;
  });

  const toggle = () => {
    const next = !isActive;
    setIsActive(next);
    if (storageKey) {
      localStorage.setItem(storageKey, String(next));
    }
    onChange?.(next);
    toast.info(`${label}: ${next ? (t?.enabled || ui('已开启', 'Enabled')) : (t?.disabled || ui('已关闭', 'Disabled'))}`);
  };

  return (
    <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
      <div className="space-y-1">
        <div className="font-bold text-sm text-white/90">{label}</div>
        <div className="text-xs text-white/40 uppercase tracking-widest">{desc}</div>
      </div>
      <div onClick={toggle} className={`w-10 h-5 rounded-full p-1 transition-colors cursor-pointer ${isActive ? 'bg-celestial-saturn' : 'bg-white/10'}`}>
        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${isActive ? 'translate-x-5' : 'translate-x-0'}`} />
      </div>
    </div>
  );
}
