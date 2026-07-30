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
  AlertTriangle,
  Loader2,
  LogOut,
  Cloud,
  Volume2,
  Sun,
  Moon,
  Save,
  ExternalLink,
  Wrench,
  FileText,
  Search,
  Trash2
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
  BACKGROUND_FACE_PRESENCE_CHANGED,
  BACKGROUND_FACE_PRESENCE_ENABLED_KEY,
  getSensorPermissionSnapshot,
  isBackgroundFacePresenceEnabled,
  isSensorEnabled,
  requestSensorPermission,
  setBackgroundFacePresenceEnabled,
  setSensorEnabled,
  SENSOR_ACCESS_CHANGED,
  SENSOR_PERMISSIONS_CHANGED,
  type SensorPermissionState,
} from '@/services/sensorPermissionService';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import {
  CHINA_LEGAL_DATA_SOURCES,
  chinaLegalCopy,
  type ChinaLegalDataSourceDefinition,
  type ChinaLegalDataSourceField,
} from '../i18n/regions/cn/legal';

const VoiceForge = lazy(() => import('./VoiceForge').then(m => ({ default: m.VoiceForge })));

function buildSidebarGroups(t: any) {
  return [
    {
      label: t.sidebarCore || uiMessage('settings.core.38f8d0ecb8'),
      items: [
        { id: 'general', label: t.sidebarGeneral || uiMessage('settings.general.40e00570d2'), icon: <Globe size={16} /> },
        { id: 'neural', label: t.neuralEngine || uiMessage('settings.neural-engine.dd539ca320'), icon: <BrainCircuit size={16} /> },
      ],
    },
    {
      label: uiMessage('settings.ai-and-models.5bf41de4e3'),
      items: [
        { id: 'ai-providers', label: uiMessage('settings.ai-providers.38c3f21901'), icon: <BrainCircuit size={16} /> },
        { id: 'reasoning-model', label: uiMessage('settings.reasoning.6a171d96b4'), icon: <BrainCircuit size={16} /> },
        { id: 'world-model', label: uiMessage('settings.world-model.67c5d91de2'), icon: <Globe size={16} /> },
        { id: 'generation-model', label: uiMessage('settings.generation.702ee6d1d7'), icon: <Sparkle size={16} /> },
        { id: 'retrieval-model', label: uiMessage('settings.retrieval.a3cd857a16'), icon: <Search size={16} /> },
        { id: 'voice-model', label: uiMessage('settings.voice-and-sound.e1a9a13b38'), icon: <Mic size={16} /> },
      ],
    },
    {
      label: uiMessage('settings.resources.36c2abf7a1'),
      items: [
        { id: 'external-connections', label: uiMessage('settings.external-connections.a83a9fc1d2'), icon: <Database size={16} /> },
        { id: 'tools', label: uiMessage('settings.tools.145e2645a6'), icon: <Wrench size={16} /> },
      ],
    },
    {
      label: t.sidebarSystem || uiMessage('settings.system.bd68977ed1'),
      items: [
        { id: 'security', label: t.privacySecurity || uiMessage('settings.security.7c0dadaf08'), icon: <Shield size={16} /> },
        { id: 'hardware', label: t.settingsHardware || uiMessage('settings.hardware.8177f0148a'), icon: <Camera size={16} /> },
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
  const { operationMode, appearanceMode, resolvedAppearanceMode, setAppearanceMode, workDomain, switchDomain } = useApp();
  const [providerStatus, setProviderStatus] = useState<Record<string, ProviderRuntimeStatus>>({});
  const [modelConfigurationRevision, setModelConfigurationRevision] = useState(0);
  const visibleSection = activeSection === 'computer' || activeSection === 'messaging'
    ? 'general'
    : activeSection === 'data-sources' || activeSection === 'applications'
      ? 'external-connections'
      : activeSection === 'connections-tools' || activeSection === 'app-tools' || activeSection === 'mcp'
        ? 'tools'
        : activeSection;
  const externalConnectionsTab = activeSection === 'applications' ? 'applications' : 'data-sources';
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
          toast.error(err?.message || t.failedToLoadProviderStatus || uiMessage('settings.failed-to-load-provider-status.6411dc3232'));
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

  useEffect(() => {
    const handleModelConfigurationChanged = () => {
      setModelConfigurationRevision(previous => previous + 1);
    };
    window.addEventListener('lumi:model-configuration-changed', handleModelConfigurationChanged);
    return () => window.removeEventListener('lumi:model-configuration-changed', handleModelConfigurationChanged);
  }, []);

  const handleSectionChange = (section: string) => {
    if (onSectionChange) onSectionChange(section);
  };

  const renderContent = (section: string) => {
    switch (section) {
      case 'general':
        return (
          <div className="space-y-8">
            <SettingsSection title={t.language || uiMessage('settings.language.1200fa47a6')} icon={<Globe size={18} className="text-blue-400" />}>
              <div className="p-8 bg-white/5 rounded-[2.5rem] border border-white/5 space-y-6">
                <div>
                  <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-4">{t.selectLanguage}</label>
                  <div className="grid grid-cols-2 gap-4">
                    <button onClick={() => setLang('en')}
                      className={`p-6 rounded-2xl border text-sm font-bold transition-all flex items-center justify-center gap-3 ${lang === 'en' ? 'bg-white text-black border-white shadow-[0_0_20px_rgba(255,255,255,0.2)]' : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/10'}`}>
                      {t.englishUS || uiMessage('settings.english-us.265bc3cad7')}
                    </button>
                    <button onClick={() => setLang('zh')}
                      className={`p-6 rounded-2xl border text-sm font-bold transition-all flex items-center justify-center gap-3 ${lang === 'zh' ? 'bg-white text-black border-white shadow-[0_0_20px_rgba(255,255,255,0.2)]' : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/10'}`}>
                       {t.chinese}
                    </button>
                  </div>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title={t.appearanceThemes || uiMessage('settings.appearance-themes.c5b9eacfd0')} icon={<Sparkle size={18} className="text-celestial-saturn" />}>
              <div className="p-8 bg-white/5 rounded-[2.5rem] border border-white/5 space-y-8">
                <div>
                  <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-4">{uiMessage('settings.global-appearance.360529c0a2')}</label>
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      { id: 'light', label: uiMessage('settings.day.2a9362ad0e'), hint: uiMessage('settings.bright-shell.8a26ab726b'), icon: <Sun size={16} /> },
                      { id: 'dark', label: uiMessage('settings.night.da11ed8a8e'), hint: uiMessage('settings.classic-dark.3c4a1d5444'), icon: <Moon size={16} /> },
                      { id: 'system', label: uiMessage('settings.system.b9dd0f7e7a'), hint: resolvedAppearanceMode === 'light' ? uiMessage('settings.now-day.a98d215d70') : uiMessage('settings.now-night.99973ce72a'), icon: <Globe size={16} /> },
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
                    {uiMessage('settings.this-controls-the-global-shell.fd3236415f')}
                  </p>
                </div>
              </div>
            </SettingsSection>
          </div>
        );
      case 'neural':
        return (
          <div className="space-y-8">
            <SettingsSection title={t.agentFramework || uiMessage('settings.agent-framework-lumi-protocol.2d0970720d')} icon={<BrainCircuit size={18} className="text-celestial-saturn" />}>
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
      case 'ai-providers':
      case 'llm-providers':
        return <AIProvidersPage t={t} providerStatus={providerStatus} />;
      case 'reasoning-model':
      case 'model-routing':
        return <ReasoningRoleSettings t={t} providerStatus={providerStatus} />;
      case 'external-connections':
        return <ExternalConnectionsPage t={t} initialTab={externalConnectionsTab} />;
      case 'tools':
      case 'app-tools':
      case 'connections-tools':
      case 'mcp':
        return <ToolRuntimeConnections t={t} />;
      case 'vision-models':
      case 'world-model':
        return <WorldModelsPage t={t} />;
      case 'generation-model':
      case 'generation-models':
        return <GenerativeModelsPage t={t} />;
      case 'retrieval-model':
        return <RetrievalModelSettings />;
      case 'voice-model':
      case 'voice-services':
        return <VoiceServicesPage t={t} />;
      case 'security':
        return (
          <div className="space-y-8">
            <SettingsSection title={t.privacySecurity || uiMessage('settings.privacy-security.901389923c')} icon={<Shield size={18} className="text-celestial-mars" />}>
              <SettingsItem label={t.localEncryption || uiMessage('settings.local-encryption.48aca1952b')} desc={t.localEncryptionDesc || uiMessage('settings.encrypt-all-agent-data-stored.d88a575c31')} storageKey="lumi_sec_local_encryption" t={t} />
              <SettingsItem label={t.anonymousMode || uiMessage('settings.anonymous-mode.2caa1cc9a5')} desc={t.anonymousModeDesc || uiMessage('settings.hide-your-node-id-from.1679578b38')} storageKey="lumi_sec_anonymous_mode" t={t} />
              <SettingsItem label={t.biometricLock || uiMessage('settings.biometric-lock.6e177df8a6')} desc={t.biometricLockDesc || uiMessage('settings.require-fingerprint-or-face-id.a9f1459524')} storageKey="lumi_sec_biometric_lock" t={t} />
            </SettingsSection>
            {isElectron && (
              <SettingsSection title={t.desktopNodeRuntime || uiMessage('settings.desktop-node-runtime.839c1b5918')} icon={<Database size={18} className="text-celestial-jupiter" />}>
                <div className="p-4 bg-celestial-jupiter/10 rounded-2xl border border-celestial-jupiter/20 space-y-2 mb-4">
                  <div className="flex justify-between items-center text-sm"><span className="text-white/60">{t.platform || uiMessage('settings.platform.3ffff3f363')}:</span><span className="font-mono text-celestial-jupiter uppercase">{platform}</span></div>
                  <div className="flex justify-between items-center text-sm"><span className="text-white/60">{t.nodeStatus || uiMessage('settings.node-status.d26319b9df')}:</span><div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /><span className="font-bold text-green-500 underline decoration-green-500/20 underline-offset-4">{t.nodeActive || uiMessage('settings.active.6f9fc6b162')}</span></div></div>
                </div>
                <SettingsItem label={t.hardwareAcceleration || uiMessage('settings.hardware-acceleration.508a40b8c7')} desc={t.hardwareAccelerationDesc || uiMessage('settings.use-gpu-for-neural-core.de372afa5c')} storageKey="lumi_sec_hw_accel" t={t} />
                <SettingsItem label={t.systemTrayMode || uiMessage('settings.system-tray-mode.43259974b8')} desc={t.systemTrayModeDesc || uiMessage('settings.keep-lumi-running-in-the.30e5d2cd98')} storageKey="lumi_sec_system_tray" t={t} />
              </SettingsSection>
            )}

            <SettingsSection title={t.biometricEnrollment} icon={<Shield size={18} className="text-amber-400" />}>
              <div className="p-6 bg-white/5 rounded-[2.5rem] border border-white/5">
                {workDomain === 'personal' ? (
                  <BiometricsEnrollPanel />
                ) : (
                  <div className="space-y-3 text-sm text-white/65">
                    <p>{uiMessage('settings.voiceprints-and-face-data-belong.f078b91611')}</p>
                    <button
                      type="button"
                      onClick={() => { void switchDomain('personal'); }}
                      className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-200 transition-colors hover:bg-amber-400/15"
                    >
                      {uiMessage('settings.switch-to-personal-workspace.b53fff066e')}
                    </button>
                  </div>
                )}
              </div>
            </SettingsSection>
          </div>
        );
      case 'hardware':
        return <HardwareSettings t={t} />;
      default:
        return null;
    }
  };

  return (
    <div className="lumi-work-surface lumi-surface flex h-full overflow-hidden">
      {/* Sidebar — fixed height, scrollable */}
      <div className="w-44 flex-shrink-0 border-r border-white/[0.08] bg-white/[0.025] flex flex-col min-h-0 md:w-56">
        <div className="px-3 pt-4 pb-3 md:px-4 md:pt-5">
          <h2 className="text-xs font-black uppercase tracking-widest text-white/60">{t.settings || uiMessage('settings.settings.8d4d0d8541')}</h2>
        </div>
        <div className="flex-1 px-1.5 pb-3 space-y-0.5 overflow-y-auto custom-scrollbar min-h-0 md:px-2">
          {buildSidebarGroups(t).map(group => (
              <div key={group.label} className="mb-3">
                <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold text-white/35">
                  {group.label}
                </div>
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
              </div>
          ))}
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
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium text-red-400/60 transition-all hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut size={14} />
            {t?.signOut || uiMessage('settings.sign-out.db1b9e9fea')}
          </button>
        </div>
      </div>

      {/* Content — absolute positioned to prevent layout shift during transitions */}
      <div className="flex-1 min-w-0 relative overflow-hidden">
        <div className="absolute inset-0 overflow-y-auto custom-scrollbar p-3 md:p-6">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={`${visibleSection}:${modelConfigurationRevision}`}
              className="mx-auto w-full max-w-6xl"
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
  const [backgroundFacePresenceEnabled, setBackgroundFacePresenceState] = useState(() => (
    isBackgroundFacePresenceEnabled()
  ));
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
      setBackgroundFacePresenceState(isBackgroundFacePresenceEnabled());
    };

    const onSensorAccessChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<Record<'microphone' | 'camera', boolean>>>).detail;
      if (typeof detail?.microphone === 'boolean') setMicEnabled(detail.microphone);
      if (typeof detail?.camera === 'boolean') setCamEnabled(detail.camera);
      if (typeof detail?.microphone !== 'boolean' && typeof detail?.camera !== 'boolean') refreshAccess();
    };

    const onStorageChange = (event: StorageEvent) => {
      if (
        event.key === 'lumi_mic_enabled' ||
        event.key === 'lumi_camera_enabled' ||
        event.key === BACKGROUND_FACE_PRESENCE_ENABLED_KEY
      ) {
        refreshAccess();
      }
    };

    void refresh();
    refreshAccess();
    window.addEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
    window.addEventListener(SENSOR_ACCESS_CHANGED, onSensorAccessChange);
    window.addEventListener(BACKGROUND_FACE_PRESENCE_CHANGED, refreshAccess);
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('visibilitychange', refresh);
    window.addEventListener('visibilitychange', refreshAccess);
    return () => {
      disposed = true;
      window.removeEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
      window.removeEventListener(SENSOR_ACCESS_CHANGED, onSensorAccessChange);
      window.removeEventListener(BACKGROUND_FACE_PRESENCE_CHANGED, refreshAccess);
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
        throw new Error(result.error || uiMessage('settings.please-enable-access-in-system.3fa8966e6c'));
      }

      toast.success(type === 'mic' ? (t.micAccessSynced || uiMessage('settings.microphone-access-synchronized.cf6ea6edc8')) : (t.camAccessSynced || uiMessage('settings.camera-access-synchronized.8effc04251')));
      return true;
    } catch (err: any) {
      toast.error(`${t.sensorLinkFailed || uiMessage('settings.sensor-link-failed.ccc93e4061')}: ${err.message}`);
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
        ? (t.audioReceptorsDisabled || uiMessage('settings.audio-input-disabled.7a401ffe0b'))
        : (t.visualCortexDisabled || uiMessage('settings.visual-perception-disabled.d15e5b5cc6')));
      return;
    }

    const ok = await requestPermissions(type);
    if (!ok) {
      setSensorEnabled(kind, false);
      if (type === 'mic') setMicEnabled(false);
      if (type === 'camera') setCamEnabled(false);
    }
  };

  const handleBackgroundFacePresenceToggle = async (enabled: boolean) => {
    if (enabled && !camEnabled) {
      toast.error(uiMessage('settings.enable-camera-access-before-turning.fbd6cf6197'));
      return;
    }
    if (enabled && camStatus !== 'granted') {
      const cameraReady = await requestPermissions('camera');
      if (!cameraReady) return;
    }
    setBackgroundFacePresenceEnabled(enabled);
    setBackgroundFacePresenceState(enabled);
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <SettingsSection title={t.hardwareSensorNetwork || uiMessage('settings.hardware-sensor-network.5ac24401d0')} icon={<Camera size={18} className="text-celestial-saturn" />}>
        <p className="text-sm text-white/40 mb-8 max-w-xl">
          {t.hardwareSensorNetworkDesc || uiMessage('settings.lumiai-requires-access-to-your.2c2519e903')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <HardwareCapCard
            icon={<Mic size={24} />}
            label={t.audioReceptors || uiMessage('settings.audio-receptors.2d53651196')}
            desc={t.audioReceptorsDesc || uiMessage('settings.enable-neural-speech-recognition-and.37c49ca0c6')}
            status={micStatus}
            enabled={micEnabled}
            onToggle={(enabled) => void handleSensorToggle('mic', enabled)}
            disabled={isRequesting}
            t={t}
          />
          <HardwareCapCard
            icon={<Camera size={24} />}
            label={t.visualCortex || uiMessage('settings.visual-cortex.215cdec3f7')}
            desc={t.visualCortexDesc || uiMessage('settings.enable-multimodal-vision-and-gesture.2861691bfc')}
            status={camStatus}
            enabled={camEnabled}
            onToggle={(enabled) => void handleSensorToggle('camera', enabled)}
            disabled={isRequesting}
            t={t}
          />
        </div>

        <div className="mt-6 flex items-center justify-between gap-6 rounded-2xl border border-white/5 bg-white/[0.035] p-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
              backgroundFacePresenceEnabled && camEnabled
                ? 'bg-celestial-saturn/20 text-celestial-saturn'
                : 'bg-white/5 text-white/35'
            }`}>
              <Camera size={17} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-white/90">
                {uiMessage('settings.background-face-presence.c07ac0f5cb')}
              </div>
              <div className="mt-1 max-w-2xl text-xs leading-relaxed text-white/45">
                {uiMessage('settings.when-enabled-lumi-may-use.25f7da1264')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleBackgroundFacePresenceToggle(!backgroundFacePresenceEnabled)}
            disabled={isRequesting || (camStatus === 'unavailable' && !backgroundFacePresenceEnabled)}
            aria-pressed={backgroundFacePresenceEnabled}
            aria-label={uiMessage('settings.background-face-presence.c07ac0f5cb')}
            className={`relative h-7 w-12 shrink-0 rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              backgroundFacePresenceEnabled
                ? 'border-celestial-saturn/40 bg-celestial-saturn/25'
                : 'border-white/10 bg-white/5'
            }`}
          >
            <span className={`absolute top-1 h-5 w-5 rounded-full transition-all ${
              backgroundFacePresenceEnabled
                ? 'left-6 bg-celestial-saturn'
                : 'left-1 bg-white/35'
            }`} />
          </button>
        </div>

        <div className="mt-12 p-6 glass-dark rounded-[2rem] border border-white/5 space-y-4">
           <div className="flex items-center gap-3">
              <Shield className="text-celestial-saturn" size={20} />
              <h4 className="text-sm font-bold uppercase tracking-tight text-white">{t.privacyAssurance || uiMessage('settings.privacy-assurance.2ce5c06cdb')}</h4>
           </div>
           <p className="text-xs text-white/55 leading-relaxed italic">
             {t.privacyAssuranceText || uiMessage('settings.our-protocol-strictly-enforces-local.872b7c5677')}
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
                {t.linked || uiMessage('settings.linked.6892680d46')}
             </div>
           ) : isBlocked ? (
             <div className="flex items-center gap-1.5 text-red-500 text-xs font-black uppercase tracking-widest">
               <AlertCircle size={12} />
                {t.blocked || uiMessage('settings.blocked.f5f31a9aa5')}
             </div>
           ) : isUnavailable ? (
             <div className="flex items-center gap-1.5 text-white/35 text-xs font-black uppercase tracking-widest">
               <AlertCircle size={12} />
               {t.unavailable || uiMessage('settings.unavailable.a19c84a34b')}
             </div>
           ) : !enabled ? (
              <div className="text-xs font-black uppercase tracking-widest text-white/45">{t.disabled || uiMessage('settings.disabled.2caae825fe')}</div>
           ) : (
              <div className="text-xs font-black uppercase tracking-widest text-white/45">{t.awaitingAccess || uiMessage('settings.awaiting-access.75952ad010')}</div>
           )}
        </div>

        <div className="flex items-center gap-2">
          {enabled && status !== 'granted' && !isUnavailable && (
            <Button
              onClick={() => onToggle(true)}
              disabled={disabled}
              className="bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-black uppercase tracking-widest px-4 h-9 rounded-xl"
            >
              {status === 'denied' ? (t.retryLink || uiMessage('settings.retry-link.394f83238c')) : (t.authorize || uiMessage('settings.authorize.9ed688f227'))}
            </Button>
          )}
          <button
            type="button"
            onClick={() => onToggle(!enabled)}
            disabled={disabled || isUnavailable}
            aria-pressed={enabled}
            aria-label={enabled ? formatUiMessage('settings.disable-value0.aaf58c1a29', { value0: label }) : formatUiMessage('settings.enable-value0.71e0c154da', { value0: label })}
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
      className={`relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${active ? 'border border-white/10 bg-white/[0.075] text-white' : 'border border-transparent text-white/55 hover:bg-white/[0.045] hover:text-white/75'}`}
    >
      <div className={`flex-shrink-0 w-4 h-4 flex items-center justify-center ${active ? 'text-celestial-saturn' : 'text-current'}`}>{icon}</div>
      <span className="truncate text-[13px] font-medium">{label}</span>
      {active && <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-celestial-saturn" />}
    </button>
  );
}

type ProviderTestState = 'idle' | 'testing' | 'ok' | 'error';

function SettingsDisclosure({
  icon,
  label,
  badges,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  badges?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="group border-b border-white/10 last:border-b-0">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 py-3 text-left marker:content-none">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/8 bg-white/[0.035] text-white/70">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white/80">{label}</span>
        {badges}
        <ChevronDown size={15} className="shrink-0 text-white/30 transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-5 sm:pl-11">
        {children}
      </div>
    </details>
  );
}

async function runLLMConnectionTest(provider: string, model: string): Promise<{ latencyMs: number; model: string }> {
  const response = await apiFetch('/api/llm/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ provider, model }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(data.error || `Connection test failed (${response.status})`);
  }
  return { latencyMs: Number(data.latencyMs) || 0, model: data.model || model };
}

async function runConfiguredReasoningRouteTest(): Promise<{ latencyMs: number; model: string }> {
  const response = await apiFetch('/api/llm/route/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(data.error || `Route test failed (${response.status})`);
  }
  return { latencyMs: Number(data.latencyMs) || 0, model: data.model || '' };
}

async function runVisionConnectionTest(provider: string, model: string): Promise<{ latencyMs: number; model: string }> {
  const response = await apiFetch('/api/vision/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ provider, model }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(data.error || `Vision test failed (${response.status})`);
  }
  return { latencyMs: Number(data.latencyMs) || 0, model: data.model || model };
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
  const [keyDirty, setKeyDirty] = useState(false);
  const [testState, setTestState] = useState<ProviderTestState>('idle');
  const [testMessage, setTestMessage] = useState('');

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
      setKeyDirty(false);
      setTestState('idle');
      setTestMessage('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeyRemoved || uiMessage('settings.api-key-removed.bae3220b94'));
    }).catch(err => toast.error(err.message || t?.failedToRemoveKey || uiMessage('settings.failed-to-remove-key.065616ae8b')));
  };

  const handleSaveKey = () => {
    if (!keyValue.trim()) return;
    saveServerKeys({ [serverKey]: keyValue.trim() }).then(() => {
      localStorage.setItem(`lumi_${providerId}_key`, keyValue.trim());
      setServerConfigured(true);
      setKeyDirty(false);
      setTestState('idle');
      setTestMessage('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || uiMessage('settings.api-key-saved.a1dc4d42fb'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || uiMessage('settings.failed-to-save-key.58568a4911')));
  };

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
    setTestState('idle');
    setTestMessage('');
    const allModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
    })();
    allModels[providerId] = nextModel;
    localStorage.setItem('lumi_llm_models', JSON.stringify(allModels));
    apiFetch('/api/preferences/llm', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ provider: aiConfig.provider, models: allModels }),
    }).catch(() => {});
    if (aiConfig.provider === providerId) updateAIConfig({ model: nextModel });
  };

  const handleTest = async () => {
    if (!serverConfigured || keyDirty || !model.trim()) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const result = await runLLMConnectionTest(providerId, model.trim());
      setTestState('ok');
      setTestMessage(formatUiMessage('settings.live-call-passed-value0-ms.9f3242a245', { value0: result.latencyMs }));
    } catch (error: any) {
      setTestState('error');
      setTestMessage(error?.message || uiMessage('settings.live-call-failed.cd19d46055'));
    }
  };

  return (
    <SettingsDisclosure
      icon={icon}
      label={label}
      defaultOpen={aiConfig.provider === providerId}
      badges={<>
        {serverConfigured && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{t?.configured || uiMessage('settings.configured.d7f5ed6e15')}</span>}
        {aiConfig.provider === providerId && <span className="rounded-full border border-celestial-saturn/20 bg-celestial-saturn/10 px-2 py-0.5 text-[11px] font-semibold text-celestial-saturn">{t?.activeBadge || uiMessage('settings.active.0aac32bf1d')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <div className="relative flex-1">
          <input
            disabled={disabled}
            type={showKey ? 'text' : 'password'}
            value={keyValue}
            onChange={e => { setKeyValue(e.target.value); setKeyDirty(true); setTestState('idle'); setTestMessage(''); }}
            onKeyDown={e => e.key === 'Enter' && handleSaveKey()}
            placeholder={serverConfigured && !keyValue ? (t?.keySavedOnServer || uiMessage('settings.key-saved-on-server.1ca0422100')) : placeholder}
            className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 pr-14 font-mono text-sm text-white outline-none transition-colors focus:border-celestial-saturn/50 disabled:opacity-50"
          />
          <div className="absolute right-1.5 top-1.5 flex gap-1">
            <button type="button" onClick={() => setShowKey(!showKey)}
              className="h-8 rounded-md border border-white/5 bg-white/5 px-2 text-[11px] font-semibold text-white/60 hover:bg-white/10">
              {showKey ? (t?.hide || uiMessage('settings.hide.d2e660d104')) : (t?.show || uiMessage('settings.show.520bd3e959'))}
            </button>
          </div>
        </div>
        <Button
          onClick={handleSaveKey}
          disabled={disabled || !keyValue.trim()}
          className="h-11 rounded-lg bg-celestial-saturn px-4 text-xs font-semibold text-black transition-all hover:bg-celestial-saturn/90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t?.save || uiMessage('settings.save.ec8e6d5819')}
        </Button>
        <Button
          onClick={handleRemoveKey}
          disabled={disabled || (!keyValue && !serverConfigured)}
          className="h-11 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {t?.remove || uiMessage('settings.remove.78190c6054')}
        </Button>
        <Button
          onClick={handleTest}
          disabled={disabled || !serverConfigured || keyDirty || !model.trim() || testState === 'testing'}
          className="h-11 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 text-xs font-semibold text-emerald-300 transition-all hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {testState === 'testing' ? <Loader2 size={16} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
        </Button>
      </div>
      <label className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
        <span className="text-xs font-semibold text-white/50">{uiMessage('settings.model.44c0cd4289')}</span>
        <span>
          <input
            value={model}
            onChange={event => handleModelChange(event.target.value)}
            list={`provider-models-${providerId}`}
            className="h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white outline-none focus:border-celestial-saturn/50"
          />
          <datalist id={`provider-models-${providerId}`}>
            {models.map(option => <option key={option} value={option} />)}
          </datalist>
        </span>
      </label>
      {testMessage && (
        <p className={`text-xs ${testState === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {testMessage}
        </p>
      )}
      </div>
    </SettingsDisclosure>
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
  const [keyDirty, setKeyDirty] = useState(false);
  const [testState, setTestState] = useState<ProviderTestState>('idle');
  const [testMessage, setTestMessage] = useState('');
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
      setKeyDirty(false);
      setTestState('idle');
      setTestMessage('');
      if (visionConfig.provider === providerId) {
        updateVisionConfig({ apiKey: keyValue.trim(), model });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || uiMessage('settings.api-key-saved.a1dc4d42fb'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || uiMessage('settings.failed-to-save-key.58568a4911')));
  };

  const handleRemoveKey = () => {
    saveServerKeys({ [serverKey]: '' }).then(() => {
      localStorage.removeItem(`lumi_vision_${providerId}_key`);
      setServerConfigured(false);
      setKeyValue('');
      setKeyDirty(false);
      setTestState('idle');
      setTestMessage('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeyRemoved || uiMessage('settings.api-key-removed.bae3220b94'));
    }).catch(err => toast.error(err.message || t?.failedToRemoveKey || uiMessage('settings.failed-to-remove-key.065616ae8b')));
  };

  const handleModelChange = (m: string) => {
    setModel(m);
    setTestState('idle');
    setTestMessage('');
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

  const handleTest = async () => {
    if (!serverConfigured || keyDirty || !model.trim()) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const result = await runVisionConnectionTest(providerId, model.trim());
      setTestState('ok');
      setTestMessage(formatUiMessage('settings.vision-call-passed-value0-ms.c80d92a068', { value0: result.latencyMs }));
    } catch (error: any) {
      setTestState('error');
      setTestMessage(error?.message || uiMessage('settings.vision-call-failed.adf12eb156'));
    }
  };

  return (
    <SettingsDisclosure
      icon={icon}
      label={label}
      defaultOpen={visionConfig.provider === providerId}
      badges={<>
        {serverConfigured && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{t?.configured || uiMessage('settings.configured.d7f5ed6e15')}</span>}
        {visionConfig.provider === providerId && <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200">{t?.activeBadge || uiMessage('settings.active.0aac32bf1d')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <div className="relative flex-1">
          <input
            disabled={disabled}
            type={showKey ? 'text' : 'password'}
            value={keyValue}
            onChange={e => { setKeyValue(e.target.value); setKeyDirty(true); setTestState('idle'); setTestMessage(''); }}
            onKeyDown={e => e.key === 'Enter' && handleSaveKey()}
            placeholder={serverConfigured && !keyValue ? (t?.keySavedOnServer || uiMessage('settings.key-saved-on-server.1ca0422100')) : placeholder}
            className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 pr-14 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-300/50 disabled:opacity-50"
          />
          <div className="absolute right-1.5 top-1.5 flex gap-1">
            <button type="button" onClick={() => setShowKey(!showKey)}
              className="h-8 rounded-md border border-white/5 bg-white/5 px-2 text-[11px] font-semibold text-white/60 hover:bg-white/10">
              {showKey ? (t?.hide || uiMessage('settings.hide.d2e660d104')) : (t?.show || uiMessage('settings.show.520bd3e959'))}
            </button>
          </div>
        </div>
        <Button
          onClick={handleSaveKey}
          disabled={disabled || !keyValue.trim()}
          className="h-11 rounded-lg bg-cyan-300 px-4 text-xs font-semibold text-black transition-all hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t?.save || uiMessage('settings.save.ec8e6d5819')}
        </Button>
        <Button
          onClick={handleRemoveKey}
          disabled={disabled || (!keyValue && !serverConfigured)}
          className="h-11 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {t?.remove || uiMessage('settings.remove.78190c6054')}
        </Button>
        <Button
          onClick={handleTest}
          disabled={disabled || !serverConfigured || keyDirty || !model.trim() || testState === 'testing'}
          className="h-11 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 text-xs font-semibold text-emerald-300 transition-all hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {testState === 'testing' ? <Loader2 size={16} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
        <label className="text-xs font-semibold text-white/50">{t?.model || uiMessage('settings.model.44c0cd4289')}</label>
        <input
          type="text"
          value={model}
          onChange={e => handleModelChange(e.target.value)}
          list={`vision-models-${providerId}`}
          placeholder={models[0]}
          className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white outline-none focus:border-cyan-300/50"
        />
        <datalist id={`vision-models-${providerId}`}>
          {models.map(m => <option key={m} value={m} />)}
        </datalist>
      </div>
      {testMessage && <p className={`text-xs ${testState === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{testMessage}</p>}
      </div>
    </SettingsDisclosure>
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
  const [error, setError] = useState('');
  const [testState, setTestState] = useState<ProviderTestState>('idle');
  const [testMessage, setTestMessage] = useState('');
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
        setError(cfg.lastError || '');
      })
      .catch(() => {});
  }, [defaultUrl, endpoint]);

  const allModelOptions = Array.from(new Set([model, ...models, ...suggestions].filter(Boolean)));

  const persistModel = (nextModel: string) => {
    setModel(nextModel);
    setTestState('idle');
    setTestMessage('');
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
    setError('');
    setTestState('idle');
    setTestMessage('');
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
      setBaseUrl(cfg.baseUrl || baseUrl);
      setError(cfg.lastError || '');
      localStorage.setItem(storageKey, cfg.baseUrl || baseUrl);
      const firstVisionModel = (cfg.models || []).find((m: string) => /vl|vision|minicpm|internvl|llava|glm.*v/i.test(m)) || model || defaultModel;
      if (firstVisionModel && firstVisionModel !== model) persistModel(firstVisionModel);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setDetected(false);
      setModels([]);
      setError(err.message || 'Detect failed');
    } finally {
      setChecking(false);
    }
  };

  const handleUse = () => {
    updateVisionConfig({ provider: providerId, model });
  };

  const handleTest = async () => {
    if (!detected || !model.trim()) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const result = await runVisionConnectionTest(providerId, model.trim());
      setTestState('ok');
      setTestMessage(formatUiMessage('settings.vision-call-passed-value0-ms.c80d92a068', { value0: result.latencyMs }));
    } catch (caught: any) {
      setTestState('error');
      setTestMessage(caught?.message || uiMessage('settings.vision-call-failed.adf12eb156'));
    }
  };

  return (
    <SettingsDisclosure
      icon={icon}
      label={label}
      defaultOpen={visionConfig.provider === providerId}
      badges={<>
        {detected && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{uiMessage('settings.connected.4f18b17c87')}</span>}
        {visionConfig.provider === providerId && <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200">{t?.activeBadge || uiMessage('settings.active.0aac32bf1d')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); setSaved(false); setDetected(false); setTestState('idle'); setTestMessage(''); }}
          onKeyDown={e => e.key === 'Enter' && handleDetect()}
          placeholder={defaultUrl}
          className="h-11 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-emerald-400/50"
        />
        <Button
          onClick={handleDetect}
          disabled={checking || !baseUrl.trim()}
          className="h-11 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white transition-all hover:bg-emerald-500 disabled:opacity-30"
        >
          {checking ? <Loader2 size={16} className="animate-spin" /> : uiMessage('settings.detect.333c762fe5')}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)_auto_auto] sm:items-center">
        <label className="text-xs font-semibold text-white/50">{t?.model || uiMessage('settings.model.44c0cd4289')}</label>
        <input
          type="text"
          value={model}
          onChange={e => persistModel(e.target.value)}
          list={`vision-local-models-${providerId}`}
          placeholder={defaultModel}
          className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white outline-none focus:border-emerald-400/50"
        />
        <datalist id={`vision-local-models-${providerId}`}>
          {allModelOptions.map(m => <option key={m} value={m} />)}
        </datalist>
        <Button
          onClick={handleUse}
          disabled={!model.trim()}
          className="h-10 rounded-lg bg-cyan-300 px-3 text-xs font-semibold text-black transition-all hover:bg-cyan-200 disabled:opacity-30"
        >
          {uiMessage('settings.use.998b2bc522')}
        </Button>
        <Button
          onClick={handleTest}
          disabled={!detected || !model.trim() || testState === 'testing'}
          className="h-10 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-300 transition-all hover:bg-emerald-500/20 disabled:opacity-30"
        >
          {testState === 'testing' ? <Loader2 size={15} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
        </Button>
      </div>
      <p className="text-[12px] text-white/45 leading-relaxed">
        {uiMessage('settings.local-vision-processes-screenshots-and.94552138f2')}
      </p>
      {detected && models.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {models.slice(0, 12).map(m => (
            <button key={m} onClick={() => persistModel(m)} className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/60 hover:text-white hover:bg-white/10 font-mono transition-colors">{m}</button>
          ))}
        </div>
      )}
      {error && !checking && <p className="text-xs text-amber-300/80">{error}</p>}
      {testMessage && <p className={`text-xs ${testState === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{testMessage}</p>}
      </div>
    </SettingsDisclosure>
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
    try { return localStorage.getItem('lumi_relay_url') || 'http://127.0.0.1:8000/v1'; } catch { return 'http://127.0.0.1:8000/v1'; }
  });
  const savedModels = (() => {
    try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
  })();
  const [model, setModel] = useState(() => savedModels.relay || 'qwen2.5-vl-7b-instruct');
  const [serverConfigured, setServerConfigured] = useState(false);
  const [saved, setSaved] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [testState, setTestState] = useState<ProviderTestState>('idle');
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    getSavedKeyStatus()
      .then(data => setServerConfigured(!!data.RELAY_API_KEY && !!data.RELAY_BASE_URL))
      .catch(() => {});
  }, []);

  const persistModel = (nextModel: string) => {
    setModel(nextModel);
    setTestState('idle');
    setTestMessage('');
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
      setConnectionDirty(false);
      setTestState('idle');
      setTestMessage('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t?.apiKeySaved || uiMessage('settings.api-key-saved.a1dc4d42fb'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || uiMessage('settings.failed-to-save.465b88f9c0')));
  };

  const handleRemove = () => {
    saveServerKeys({ RELAY_API_KEY: '', RELAY_BASE_URL: '' }).then(() => {
      localStorage.removeItem('lumi_relay_key');
      localStorage.removeItem('lumi_relay_url');
      setApiKey('');
      setBaseUrl('');
      setServerConfigured(false);
      setConnectionDirty(false);
      setTestState('idle');
      setTestMessage('');
      toast.success(t?.apiKeyRemoved || uiMessage('settings.api-key-removed.bae3220b94'));
    }).catch(err => toast.error(err.message || uiMessage('settings.failed-to-remove.5c5d9c7827')));
  };

  const handleUse = () => {
    updateVisionConfig({ provider: 'relay', model });
  };

  const handleTest = async () => {
    if (!serverConfigured || connectionDirty || !model.trim()) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const result = await runVisionConnectionTest('relay', model.trim());
      setTestState('ok');
      setTestMessage(formatUiMessage('settings.vision-call-passed-value0-ms.c80d92a068', { value0: result.latencyMs }));
    } catch (caught: any) {
      setTestState('error');
      setTestMessage(caught?.message || uiMessage('settings.vision-call-failed.adf12eb156'));
    }
  };

  return (
    <SettingsDisclosure
      icon={<Globe size={18} className="text-cyan-400" />}
      label="OpenAI-Compatible Vision"
      defaultOpen={visionConfig.provider === 'relay'}
      badges={<>
        {serverConfigured && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{uiMessage('settings.configured.d7f5ed6e15')}</span>}
        {visionConfig.provider === 'relay' && <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200">{t?.activeBadge || uiMessage('settings.active.0aac32bf1d')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3">
        <input
          type="password"
          value={apiKey}
          onChange={e => { setApiKey(e.target.value); setConnectionDirty(true); setTestState('idle'); setTestMessage(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          placeholder="API Key"
          className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-400/50"
        />
        <input
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); setConnectionDirty(true); setTestState('idle'); setTestMessage(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          placeholder="http://127.0.0.1:8000/v1"
          className="h-11 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-400/50"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
        <label className="text-xs font-semibold text-white/50">{t?.model || uiMessage('settings.model.44c0cd4289')}</label>
        <input
          type="text"
          value={model}
          onChange={e => persistModel(e.target.value)}
          list="vision-relay-models"
          className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white outline-none focus:border-cyan-400/50"
        />
        <datalist id="vision-relay-models">
          {['qwen2.5-vl-7b-instruct', 'minicpm-v-4_5', 'internvl3_5-8b', 'glm-4.1v-9b-thinking'].map(m => <option key={m} value={m} />)}
        </datalist>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={handleSave}
          disabled={!apiKey.trim() || !baseUrl.trim()}
          className="h-10 rounded-lg bg-cyan-600 px-4 text-xs font-semibold text-white transition-all hover:bg-cyan-500 disabled:opacity-30"
        >
          {t?.save || uiMessage('settings.save.ec8e6d5819')}
        </Button>
        <Button
          onClick={handleUse}
          disabled={!model.trim()}
          className="h-10 rounded-lg bg-cyan-300 px-4 text-xs font-semibold text-black transition-all hover:bg-cyan-200 disabled:opacity-30"
        >
          {uiMessage('settings.use-as-vision.adf03f9489')}
        </Button>
        <Button
          onClick={handleTest}
          disabled={!serverConfigured || connectionDirty || !model.trim() || testState === 'testing'}
          className="h-10 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 text-xs font-semibold text-emerald-300 transition-all hover:bg-emerald-500/20 disabled:opacity-30"
        >
          {testState === 'testing' ? <Loader2 size={15} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
        </Button>
        <Button
          onClick={handleRemove}
          disabled={!serverConfigured && !apiKey}
          className="h-10 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-xs font-semibold text-red-300 transition-all hover:bg-red-500/20 disabled:opacity-30"
        >
          {t?.remove || uiMessage('settings.remove.78190c6054')}
        </Button>
      </div>
      <p className="text-[12px] text-white/45 leading-relaxed">
        {uiMessage('settings.use-this-for-vllm-sglang.6ba52812bd')}
      </p>
      {testMessage && <p className={`text-xs ${testState === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{testMessage}</p>}
      </div>
    </SettingsDisclosure>
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

function VisionRoleSettings({ t }: { t: any }) {
  const { visionConfig, updateVisionConfig } = useApp();
  const setVisionModel = (model: string) => {
    const savedModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_vision_models') || '{}'); } catch { return {}; }
    })();
    savedModels[visionConfig.provider] = model;
    localStorage.setItem('lumi_vision_models', JSON.stringify(savedModels));
    updateVisionConfig({ model });
  };
  return (
    <SettingsSection title={uiMessage('settings.visual-perception-model.c74ca64c0f')} icon={<Camera size={18} className="text-cyan-300" />}>
      <div className="border-y border-white/10 py-5">
        <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">{t.primaryVisionModel || uiMessage('settings.screen-understanding-vision-control.a9be431876')}</span>
          <span className="relative">
            <select value={visionConfig.provider} onChange={(e) => updateVisionConfig({ provider: e.target.value })}
              className="w-full appearance-none rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/45">
              <option value="openai">OpenAI Vision</option>
              <option value="gemini">Google Gemini Vision</option>
              <option value="ark">Doubao Vision (Ark)</option>
              <option value="qwen">Qwen-VL (DashScope)</option>
              <option value="ollama">Ollama Local Vision</option>
              <option value="lmstudio">LM Studio Local Vision</option>
              <option value="relay">OpenAI-Compatible Vision</option>
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/45" />
          </span>
        </label>
        <div className="mt-4">
          <GenerationModelInput
            id={`vision-role-${visionConfig.provider}`}
            label={uiMessage('settings.model.44c0cd4289')}
            value={visionConfig.model}
            options={WORLD_MODEL_OPTIONS[visionConfig.provider] || []}
            onChange={setVisionModel}
          />
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">{uiMessage('settings.effective-model.60bc31ba15')}</span>
          <span className="min-w-0 truncate rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-white/55">
            {visionConfig.provider} / {visionConfig.model}
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}

function VisionProviderSettings({ t }: { t: any }) {
  return (
    <SettingsSection title={uiMessage('settings.vision-capable-providers.40ab375ce2')} icon={<Camera size={18} className="text-cyan-300" />}>
      <p className="mb-5 max-w-3xl text-sm leading-relaxed text-white/45">
        {uiMessage('settings.vision-provider-description.77b9f301aa')}
      </p>
      <div className="border-y border-white/10">
        <VisionProviderRow icon={<MessagesSquare size={18} className="text-green-400" />} label="OpenAI Vision" providerId="openai" models={['gpt-4o', 'gpt-4o-mini']} placeholder="sk-..." serverKey="OPENAI_API_KEY" t={t} />
        <VisionProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label="Google Gemini Vision" providerId="gemini" models={['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']} placeholder={uiMessage('settings.enter-gemini-api-key.4295b94e77')} serverKey="GEMINI_API_KEY" t={t} />
        <VisionProviderRow icon={<Cloud size={18} className="text-cyan-400" />} label="Doubao Vision (Ark)" providerId="ark" models={['doubao-1-5-vision-pro-32k']} placeholder={uiMessage('settings.enter-ark-api-key.9f82bf67e1')} serverKey="ARK_API_KEY" t={t} />
        <VisionProviderRow icon={<Zap size={18} className="text-violet-400" />} label="Qwen-VL / DashScope" providerId="qwen" models={['qwen-vl-max']} placeholder="sk-..." serverKey="DASHSCOPE_API_KEY" t={t} />
        <VisionLocalProviderRow
          icon={<Cpu size={18} className="text-emerald-400" />}
          label="Ollama Local Vision"
          providerId="ollama"
          endpoint="/api/ollama/config"
          storageKey="lumi_ollama_url"
          defaultUrl="http://127.0.0.1:11434"
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
          defaultUrl="http://127.0.0.1:1234"
          defaultModel="local-vision-model"
          suggestions={['qwen2.5-vl-7b-instruct', 'minicpm-v-4_5', 'internvl3_5-8b']}
          t={t}
        />
        <VisionRelayProviderRow t={t} />
      </div>
    </SettingsSection>
  );
}

type GenerationPreference = {
  provider: string;
  model: string;
  models: Record<string, string>;
};

type GenerationPreferences = {
  image: GenerationPreference;
  video: GenerationPreference;
};

const DEFAULT_GENERATION_PREFERENCES: GenerationPreferences = {
  image: {
    provider: 'auto',
    model: '',
    models: { openai: 'gpt-image-1', qwen: 'wan2.2-t2i-plus', siliconflow: 'Kwai-Kolors/Kolors' },
  },
  video: {
    provider: 'qwen',
    model: 'wanx2.1-t2v-turbo',
    models: {
      qwen: 'wanx2.1-t2v-turbo',
      minimax: 'MiniMax-Hailuo-2.3',
      siliconflow: 'Wan-AI/Wan2.2-T2V-A14B',
      openai: 'sora-2',
    },
  },
};

const GENERATION_MODEL_OPTIONS: Record<string, string[]> = {
  openai: ['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'],
  qwenImage: ['wan2.2-t2i-plus'],
  siliconflowImage: ['Kwai-Kolors/Kolors', 'stabilityai/stable-diffusion-3-5-large'],
  qwenVideo: ['wanx2.1-t2v-turbo', 'wanx2.1-t2v-plus'],
  minimaxVideo: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'],
  siliconflowVideo: ['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.1-T2V-14B-720P', 'Wan-AI/Wan2.1-T2V-14B-720P-Turbo'],
  openaiVideo: ['sora-2', 'sora-2-pro'],
};

const IMAGE_GENERATION_PROVIDERS: Record<string, { label: string; models: string[] }> = {
  openai: { label: 'OpenAI', models: GENERATION_MODEL_OPTIONS.openai },
  qwen: { label: 'Qwen / DashScope', models: GENERATION_MODEL_OPTIONS.qwenImage },
  siliconflow: { label: 'SiliconFlow', models: GENERATION_MODEL_OPTIONS.siliconflowImage },
};

const VIDEO_GENERATION_PROVIDERS: Record<string, { label: string; models: string[] }> = {
  qwen: { label: 'Qwen / DashScope', models: GENERATION_MODEL_OPTIONS.qwenVideo },
  minimax: { label: 'MiniMax', models: GENERATION_MODEL_OPTIONS.minimaxVideo },
  siliconflow: { label: 'SiliconFlow', models: GENERATION_MODEL_OPTIONS.siliconflowVideo },
  openai: { label: 'OpenAI', models: GENERATION_MODEL_OPTIONS.openaiVideo },
};

function GenerationModelInput({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const modelOptions = Array.from(new Set([value, ...options].map(option => option.trim()).filter(Boolean)));
  return (
    <label className="grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
      <span className="text-xs font-bold text-white/55">{label}</span>
      <span className="relative">
        <select
          id={id}
          value={value}
          onChange={event => onChange(event.target.value)}
          disabled={modelOptions.length === 0}
          className="w-full appearance-none rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 pr-9 font-mono text-xs text-white outline-none focus:border-celestial-saturn/45 disabled:opacity-45"
        >
          {modelOptions.length === 0 && <option value="">{uiMessage('settings.no-models-configured.0c98ec7051')}</option>}
          {modelOptions.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
        <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/35" />
      </span>
    </label>
  );
}

function GenerativeModelsPage({ t }: { t: any }) {
  const [preferences, setPreferences] = useState<GenerationPreferences>(DEFAULT_GENERATION_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/preferences/generation')
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        return body;
      })
      .then(body => {
        if (!cancelled) setPreferences(body as GenerationPreferences);
      })
      .catch(error => toast.error(error?.message || uiMessage('settings.failed-to-load-generative-models.6f0ef4ec18')))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const setImageProvider = (provider: string) => {
    setPreferences(previous => ({
      ...previous,
      image: {
        ...previous.image,
        provider,
        model: provider === 'auto'
          ? ''
          : previous.image.models[provider] || IMAGE_GENERATION_PROVIDERS[provider]?.models[0] || '',
      },
    }));
  };

  const setVideoProvider = (provider: string) => {
    setPreferences(previous => ({
      ...previous,
      video: {
        ...previous.video,
        provider,
        model: previous.video.models[provider] || VIDEO_GENERATION_PROVIDERS[provider]?.models[0] || '',
      },
    }));
  };

  const setRoleModel = (role: 'image' | 'video', provider: string, model: string) => {
    setPreferences(previous => ({
      ...previous,
      [role]: {
        ...previous[role],
        model: previous[role].provider === provider ? model : previous[role].model,
        models: { ...previous[role].models, [provider]: model },
      },
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await apiFetch('/api/preferences/generation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(preferences),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setPreferences(body as GenerationPreferences);
      toast.success(uiMessage('settings.generative-models-saved.478e2f8603'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('settings.failed-to-save-generative-models.12ea083f89'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="animate-spin text-white/45" /></div>;

  const imageProvider = IMAGE_GENERATION_PROVIDERS[preferences.image.provider];
  const videoProvider = VIDEO_GENERATION_PROVIDERS[preferences.video.provider];

  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.generative-models.3ef22638d1')} icon={<Sparkle size={18} className="text-celestial-saturn" />}>
        <div className="divide-y divide-white/10 border-y border-white/10">
          <section className="py-5">
            <div className="mb-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
              <div>
                <h3 className="text-sm font-semibold text-white">{uiMessage('settings.image-generation-model.fdd84f5c71')}</h3>
                <p className="mt-1 text-xs text-white/35">{uiMessage('settings.image-generation-model-description.65439bd21c')}</p>
              </div>
              <select
                value={preferences.image.provider}
                onChange={event => setImageProvider(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
              >
                <option value="auto">{uiMessage('settings.automatic-provider.58089561bd')}</option>
                <option value="openai">OpenAI</option>
                <option value="qwen">Qwen / DashScope</option>
                <option value="siliconflow">SiliconFlow</option>
              </select>
            </div>
            {imageProvider && (
              <GenerationModelInput
                id={`generation-${preferences.image.provider}-image-model`}
                label={imageProvider.label}
                value={preferences.image.models[preferences.image.provider] || preferences.image.model}
                options={imageProvider.models}
                onChange={model => setRoleModel('image', preferences.image.provider, model)}
              />
            )}
          </section>

          <section className="py-5">
            <div className="mb-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
              <div>
                <h3 className="text-sm font-semibold text-white">{uiMessage('settings.video-generation-model.390997b87b')}</h3>
                <p className="mt-1 text-xs text-white/35">{uiMessage('settings.video-generation-model-description.20aed0c099')}</p>
              </div>
              <select
                value={preferences.video.provider}
                onChange={event => setVideoProvider(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
              >
                {Object.entries(VIDEO_GENERATION_PROVIDERS).map(([provider, definition]) => (
                  <option key={provider} value={provider}>{definition.label}</option>
                ))}
              </select>
            </div>
            {videoProvider && (
              <GenerationModelInput
                id={`generation-${preferences.video.provider}-video-model`}
                label={videoProvider.label}
                value={preferences.video.models[preferences.video.provider] || preferences.video.model}
                options={videoProvider.models}
                onChange={model => setRoleModel('video', preferences.video.provider, model)}
              />
            )}
          </section>
        </div>

        <div className="mt-5 flex justify-end">
          <Button onClick={save} disabled={saving} className="h-10 rounded-lg bg-celestial-saturn px-4 text-xs font-bold text-black hover:bg-yellow-300 disabled:opacity-40">
            {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
            {uiMessage('settings.save-model-roles.2f4ed87292')}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}

function GenerationProviderSettings({ t }: { t: any }) {
  return (
    <SettingsSection title={uiMessage('settings.generation-model-providers.b4f1c95162')} icon={<Cloud size={18} className="text-cyan-300" />}>
      <p className="mb-4 max-w-2xl text-sm leading-relaxed text-white/45">
        {uiMessage('settings.generation-model-providers-description.a548399017')}
      </p>
      <div className="border-y border-white/10">
        <ApiKeyField
          compact
          icon={<Sparkle size={18} className="text-rose-300" />}
          label="MiniMax"
          placeholder="sk-..."
          storageKey="lumi_minimax_key"
          serverKey="MINIMAX_API_KEY"
          consoleUrl="https://platform.minimaxi.com"
          hint={uiMessage('settings.minimax-generation-provider-hint.2c939bd0f7')}
          t={t}
        />
        <ApiKeyField
          compact
          icon={<Sparkle size={18} className="text-emerald-300" />}
          label="SiliconFlow"
          placeholder="sk-..."
          storageKey="lumi_siliconflow_key"
          serverKey="SILICONFLOW_API_KEY"
          consoleUrl="https://cloud.siliconflow.cn"
          hint={uiMessage('settings.siliconflow-generation-provider-hint.73aa2ce8e7')}
          t={t}
        />
      </div>
    </SettingsSection>
  );
}

type WorldPreference = {
  provider: string;
  model: string;
  models: Record<string, string>;
  resolved?: {
    provider: string;
    model: string;
    inheritedFromVision: boolean;
  };
};

const WORLD_MODEL_OPTIONS: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro'],
  ark: ['doubao-1-5-vision-pro-32k'],
  qwen: ['qwen-vl-max'],
  ollama: ['qwen2.5vl:7b', 'minicpm-v:8b', 'llama3.2-vision:11b'],
  lmstudio: ['qwen2.5-vl-7b-instruct', 'minicpm-v-4_5', 'internvl3_5-8b'],
  relay: ['qwen2.5-vl-7b-instruct', 'glm-4.1v-9b-thinking'],
};

function WorldActionModelPage({ t }: { t: any }) {
  const [preference, setPreference] = useState<WorldPreference>({ provider: 'inherit_vision', model: '', models: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/preferences/world')
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        return body;
      })
      .then(body => { if (!cancelled) setPreference(body as WorldPreference); })
      .catch(error => toast.error(error?.message || uiMessage('settings.failed-to-load-world-model.3111ba80e6')))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const setProvider = (provider: string) => {
    setTestMessage('');
    setPreference(previous => ({
      ...previous,
      provider,
      model: provider === 'inherit_vision' ? '' : previous.models[provider] || WORLD_MODEL_OPTIONS[provider]?.[0] || '',
    }));
  };

  const setModel = (model: string) => {
    setTestMessage('');
    setPreference(previous => ({
      ...previous,
      model,
      models: { ...previous.models, [previous.provider]: model },
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await apiFetch('/api/preferences/world', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(preference),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setPreference(body as WorldPreference);
      toast.success(uiMessage('settings.world-model-saved.c98e892ead'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('settings.failed-to-save-world-model.5d460901d9'));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const provider = preference.provider === 'inherit_vision' ? preference.resolved?.provider : preference.provider;
    const model = preference.provider === 'inherit_vision' ? preference.resolved?.model : preference.model;
    if (!provider || !model) return;
    setTesting(true);
    setTestMessage('');
    try {
      const result = await runVisionConnectionTest(provider, model);
      setTestMessage(formatUiMessage('settings.world-model-call-passed-value0-ms.386cfeaf91', { value0: result.latencyMs }));
    } catch (error: any) {
      setTestMessage(error?.message || uiMessage('settings.world-model-call-failed.814cb05bd8'));
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="animate-spin text-white/45" /></div>;

  const inherited = preference.provider === 'inherit_vision';
  const modelOptions = inherited ? [] : WORLD_MODEL_OPTIONS[preference.provider] || [];
  const activeProvider = inherited ? preference.resolved?.provider : preference.provider;
  const activeModel = inherited ? preference.resolved?.model : preference.model;

  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.desktop-action-model.091115083c')} icon={<Globe size={18} className="text-cyan-300" />}>
        <p className="mb-5 max-w-2xl text-sm leading-relaxed text-white/45">
          {uiMessage('settings.world-model-description.a7cbc8eaf3')}
        </p>
        <div className="border-y border-white/10 py-5">
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.desktop-action-provider.c56456b63f')}</span>
            <select
              value={preference.provider}
              onChange={event => setProvider(event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/45"
            >
              <option value="inherit_vision">{uiMessage('settings.follow-vision-model.d174430ac2')}</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
              <option value="ark">Doubao / Ark</option>
              <option value="qwen">Qwen-VL / DashScope</option>
              <option value="ollama">Ollama Local</option>
              <option value="lmstudio">LM Studio Local</option>
              <option value="relay">OpenAI-Compatible</option>
            </select>
          </label>

          {!inherited && (
            <div className="mt-4">
              <GenerationModelInput
                id={`world-model-${preference.provider}`}
                label={uiMessage('settings.desktop-action-model.091115083c')}
                value={preference.model}
                options={modelOptions}
                onChange={setModel}
              />
            </div>
          )}

          <div className="mt-4 grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.effective-model.60bc31ba15')}</span>
            <span className="min-w-0 truncate rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-white/55">
              {activeProvider || '-'} / {activeModel || '-'}
            </span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button onClick={test} disabled={testing || !activeProvider || !activeModel} className="h-10 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-4 text-xs font-bold text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-40">
            {testing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Zap size={15} className="mr-2" />}
            {uiMessage('settings.test-effective-model.c9648a120e')}
          </Button>
          <Button onClick={save} disabled={saving} className="h-10 rounded-lg bg-cyan-300 px-4 text-xs font-bold text-black hover:bg-cyan-200 disabled:opacity-40">
            {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
            {uiMessage('settings.save-desktop-action-model.1fb3f1157c')}
          </Button>
        </div>
        {testMessage && <p className="mt-3 text-right text-xs text-white/55">{testMessage}</p>}
      </SettingsSection>
    </div>
  );
}

function WorldModelsPage({ t }: { t: any }) {
  return (
    <div className="space-y-8">
      <VisionRoleSettings t={t} />
      <WorldActionModelPage t={t} />
    </div>
  );
}

type EmbeddingModelSelection = {
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
};

type RerankModelSelection = {
  enabled: boolean;
  provider: string;
  model: string;
  topN: number;
};

type RetrievalModelPreferences = {
  embedding: EmbeddingModelSelection;
  rerank: RerankModelSelection;
};

const DEFAULT_RETRIEVAL_MODEL_PREFERENCES: RetrievalModelPreferences = {
  embedding: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    fallbackProvider: 'ollama',
    fallbackModel: 'nomic-embed-text',
  },
  rerank: {
    enabled: false,
    provider: 'siliconflow',
    model: 'Qwen/Qwen3-Reranker-8B',
    topN: 5,
  },
};

const EMBEDDING_MODEL_PROVIDERS = ['openai', 'qwen', 'siliconflow', 'ollama', 'lmstudio', 'relay'];
const RERANK_MODEL_PROVIDERS = ['siliconflow'];

const EMBEDDING_MODELS: Record<string, string[]> = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
  qwen: ['text-embedding-v4', 'text-embedding-v3'],
  siliconflow: ['Qwen/Qwen3-Embedding-8B', 'Qwen/Qwen3-Embedding-4B', 'Qwen/Qwen3-Embedding-0.6B'],
  ollama: ['nomic-embed-text', 'mxbai-embed-large'],
  lmstudio: ['text-embedding-nomic-embed-text-v1.5'],
  relay: ['text-embedding-3-small'],
};

const RERANK_MODELS: Record<string, string[]> = {
  siliconflow: ['Qwen/Qwen3-Reranker-8B', 'Qwen/Qwen3-Reranker-4B', 'Qwen/Qwen3-Reranker-0.6B'],
};

function retrievalProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    '': uiMessage('settings.no-fallback.532319d005'),
    openai: 'OpenAI',
    qwen: 'Qwen / DashScope',
    siliconflow: 'SiliconFlow',
    ollama: 'Ollama Local',
    lmstudio: 'LM Studio Local',
    relay: 'OpenAI-Compatible',
  };
  return labels[provider] || provider;
}

function RetrievalModelSettings() {
  const [preferences, setPreferences] = useState<RetrievalModelPreferences>(DEFAULT_RETRIEVAL_MODEL_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/preferences/retrieval-model')
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        return body;
      })
      .then(body => { if (!cancelled) setPreferences(body as RetrievalModelPreferences); })
      .catch(error => toast.error(error?.message || uiMessage('settings.failed-to-load-model-roles.2db04d5ff2')))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const setEmbedding = (patch: Partial<EmbeddingModelSelection>) => {
    setTestMessage('');
    setPreferences(previous => ({
      ...previous,
      embedding: { ...previous.embedding, ...patch },
    }));
  };

  const setRerank = (patch: Partial<RerankModelSelection>) => {
    setTestMessage('');
    setPreferences(previous => ({
      ...previous,
      rerank: { ...previous.rerank, ...patch },
    }));
  };

  const setProvider = (provider: string) => {
    const model = EMBEDDING_MODELS[provider]?.[0] || '';
    setEmbedding({ provider, model });
  };

  const setFallbackProvider = (fallbackProvider: string) => {
    const fallbackModel = fallbackProvider ? EMBEDDING_MODELS[fallbackProvider]?.[0] || '' : '';
    setEmbedding({ fallbackProvider, fallbackModel });
  };

  const setRerankProvider = (provider: string) => {
    setRerank({ provider, model: RERANK_MODELS[provider]?.[0] || '' });
  };

  const save = async (showToast = true): Promise<boolean> => {
    setSaving(true);
    try {
      const response = await apiFetch('/api/preferences/retrieval-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(preferences),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setPreferences(body as RetrievalModelPreferences);
      if (showToast) toast.success(uiMessage('settings.model-role-saved.48ed509208'));
      return true;
    } catch (error: any) {
      toast.error(error?.message || uiMessage('settings.failed-to-save-model-role.f325b221b0'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!(await save(false))) return;
    setTesting(true);
    setTestMessage('');
    try {
      const response = await apiFetch('/api/retrieval-model/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      const embeddingLatency = Number(body.embedding?.latencyMs) || 0;
      const rerankStatus = body.rerank?.enabled
        ? `Rerank ${Number(body.rerank?.latencyMs) || 0} ms`
        : `Rerank ${uiMessage('settings.disabled.2caae825fe')}`;
      setTestMessage(`Embedding ${embeddingLatency} ms · ${rerankStatus}`);
    } catch (error: any) {
      setTestMessage(error?.message || uiMessage('settings.model-role-test-failed.6f17ba0837'));
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="animate-spin text-white/45" /></div>;

  return (
    <SettingsSection title={uiMessage('settings.retrieval-model-role.7d25a85198')} icon={<Search size={18} className="text-emerald-300" />}>
      <p className="max-w-3xl text-sm leading-relaxed text-white/45">
        {uiMessage('settings.knowledge-retrieval-description.56e971d4a2')}
      </p>
      <div className="divide-y divide-white/10 border-y border-white/10">
        <section className="space-y-4 py-5">
          <div>
            <h3 className="text-sm font-semibold text-white">Embedding</h3>
            <p className="mt-1 text-xs leading-relaxed text-white/40">{uiMessage('settings.embedding-role-description.73576dd2ab')}</p>
          </div>
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.primary-model.78ee8a421a')}</span>
            <select value={preferences.embedding.provider} onChange={event => setProvider(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none">
              {EMBEDDING_MODEL_PROVIDERS.map(provider => <option key={provider} value={provider}>{retrievalProviderLabel(provider)}</option>)}
            </select>
          </label>
          <GenerationModelInput
            id={`embedding-${preferences.embedding.provider}-model`}
            label={uiMessage('settings.model.44c0cd4289')}
            value={preferences.embedding.model}
            options={EMBEDDING_MODELS[preferences.embedding.provider] || []}
            onChange={model => setEmbedding({ model })}
          />
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
            <span className="text-xs font-bold text-white/55">{uiMessage('settings.fallback-model.562ec1697f')}</span>
            <select value={preferences.embedding.fallbackProvider} onChange={event => setFallbackProvider(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none">
              <option value="">{retrievalProviderLabel('')}</option>
              {EMBEDDING_MODEL_PROVIDERS.filter(provider => provider !== preferences.embedding.provider).map(provider => <option key={provider} value={provider}>{retrievalProviderLabel(provider)}</option>)}
            </select>
          </label>
          {preferences.embedding.fallbackProvider && (
            <GenerationModelInput
              id={`embedding-${preferences.embedding.fallbackProvider}-fallback-model`}
              label={uiMessage('settings.fallback-model-id.31f402c7ca')}
              value={preferences.embedding.fallbackModel}
              options={EMBEDDING_MODELS[preferences.embedding.fallbackProvider] || []}
              onChange={fallbackModel => setEmbedding({ fallbackModel })}
            />
          )}
        </section>

        <section className="space-y-4 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Rerank</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/40">{uiMessage('settings.rerank-role-description.8eac1d6897')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.rerank.enabled}
              aria-label={uiMessage('settings.enable-rerank.17ba5b1376')}
              onClick={() => setRerank({ enabled: !preferences.rerank.enabled })}
              className={`h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${preferences.rerank.enabled ? 'bg-emerald-500' : 'bg-white/15'}`}
            >
              <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${preferences.rerank.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
          {preferences.rerank.enabled && (
            <>
              <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
                <span className="text-xs font-bold text-white/55">{uiMessage('settings.primary-model.78ee8a421a')}</span>
                <select value={preferences.rerank.provider} onChange={event => setRerankProvider(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none">
                  {RERANK_MODEL_PROVIDERS.map(provider => <option key={provider} value={provider}>{retrievalProviderLabel(provider)}</option>)}
                </select>
              </label>
              <GenerationModelInput
                id={`rerank-${preferences.rerank.provider}-model`}
                label={uiMessage('settings.model.44c0cd4289')}
                value={preferences.rerank.model}
                options={RERANK_MODELS[preferences.rerank.provider] || []}
                onChange={model => setRerank({ model })}
              />
              <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
                <span className="text-xs font-bold text-white/55">{uiMessage('settings.rerank-top-n.5fa98399c8')}</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={preferences.rerank.topN}
                  onChange={event => setRerank({ topN: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })}
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-sm text-white outline-none"
                />
              </label>
            </>
          )}
        </section>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={test} disabled={saving || testing || !preferences.embedding.model.trim() || (preferences.rerank.enabled && !preferences.rerank.model.trim())} className="h-10 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-4 text-xs font-bold text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-40">
          {testing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Zap size={15} className="mr-2" />}
          {uiMessage('settings.test.9408c1ff3a')}
        </Button>
        <Button onClick={() => { void save(); }} disabled={saving || !preferences.embedding.model.trim() || (preferences.rerank.enabled && !preferences.rerank.model.trim())} className="h-10 rounded-lg bg-celestial-saturn px-4 text-xs font-bold text-black hover:bg-yellow-300 disabled:opacity-40">
          {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
          {uiMessage('settings.save.ec8e6d5819')}
        </Button>
      </div>
      {testMessage && <p className="mt-3 text-right text-xs text-white/55">{testMessage}</p>}
    </SettingsSection>
  );
}

function dataSourceFieldLabel(field: ChinaLegalDataSourceField): string {
  if (field.keyName.endsWith('_APP_KEY')) return uiMessage('settings.app-key.48d8312e26');
  if (field.keyName.endsWith('_SECRET_KEY')) return uiMessage('settings.secret-key.e44bdd0d82');
  if (field.keyName.endsWith('_API_KEY')) return uiMessage('settings.api-key.8f242c55e5');
  if (field.keyName.endsWith('_TOKEN')) return uiMessage('settings.access-token.9e3cac6ad8');
  if (field.keyName.endsWith('_MCP_URL')) return uiMessage('settings.mcp-url.6ddedb1520');
  if (field.label === 'API Base URL') return uiMessage('settings.api-base-url.f17b3d297b');
  return uiMessage('settings.base-url.f44ed563c9');
}

function isDataSourceConfigured(source: ChinaLegalDataSourceDefinition, status: Record<string, boolean>): boolean {
  if (source.id === 'qichacha') return Boolean(status.QICHACHA_APP_KEY && status.QICHACHA_SECRET_KEY);
  if (source.id === 'tianyancha') return Boolean(status.TIANYANCHA_API_KEY);
  if (source.id === 'pkulaw') {
    return Boolean((status.PKULAW_API_KEY || status.PKULAW_TOKEN) && (status.PKULAW_BASE_URL || status.PKULAW_MCP_URL));
  }
  if (source.id === 'farui') return Boolean(status.FARUI_API_KEY && status.FARUI_BASE_URL);
  return source.fields.some(field => status[field.keyName]);
}

function DataSourceConnections({ t }: { t: any }) {
  const isZh = t?.langCode !== 'en';
  const copy = chinaLegalCopy(isZh ? 'zh' : 'en');
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busySource, setBusySource] = useState('');

  const refreshStatus = async () => {
    const next = await getSavedKeyStatus();
    setStatus(next);
  };

  useEffect(() => {
    void refreshStatus().catch(() => {});
  }, []);

  const clearDrafts = (source: ChinaLegalDataSourceDefinition) => {
    setDrafts(previous => {
      const next = { ...previous };
      for (const field of source.fields) delete next[field.keyName];
      return next;
    });
  };

  const saveSource = async (source: ChinaLegalDataSourceDefinition) => {
    const keys = Object.fromEntries(
      source.fields
        .map(field => [field.keyName, (drafts[field.keyName] || '').trim()] as const)
        .filter(([, value]) => value.length > 0),
    );
    if (Object.keys(keys).length === 0) return;
    setBusySource(source.id);
    try {
      await saveServerKeys(keys);
      clearDrafts(source);
      await refreshStatus();
      toast.success(uiMessage('legal-data-sources-settings.legal-data-source-key-saved.aa9bdea122'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('legal-data-sources-settings.save-failed.5b5ea27d01'));
    } finally {
      setBusySource('');
    }
  };

  const removeSource = async (source: ChinaLegalDataSourceDefinition) => {
    setBusySource(source.id);
    try {
      await saveServerKeys(Object.fromEntries(source.fields.map(field => [field.keyName, ''])));
      clearDrafts(source);
      await refreshStatus();
      toast.success(uiMessage('legal-data-sources-settings.legal-data-source-key-removed.a6062630fb'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('legal-data-sources-settings.remove-failed.415d663686'));
    } finally {
      setBusySource('');
    }
  };

  return (
    <SettingsSection title={uiMessage('settings.data-sources.9f7efbc2df')} icon={<Database size={18} className="text-cyan-300" />}>
      <p className="mb-4 text-sm leading-relaxed text-white/45">
        {uiMessage('settings.data-sources-description.68775d0d92')}
      </p>
      <div className="border-y border-white/10">
        {CHINA_LEGAL_DATA_SOURCES.map(source => {
          const providerCopy = copy.dataSources[source.id];
          const configured = isDataSourceConfigured(source, status);
          const busy = busySource === source.id;
          const hasDraft = source.fields.some(field => Boolean((drafts[field.keyName] || '').trim()));
          const hasStoredField = source.fields.some(field => status[field.keyName]);
          return (
            <SettingsDisclosure
              key={source.id}
              icon={<Database size={18} className="text-cyan-300" />}
              label={providerCopy.label}
              badges={(
                <span className={`rounded-md border px-2 py-1 text-[11px] font-medium ${configured ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200' : 'border-white/10 bg-white/5 text-white/45'}`}>
                  {configured
                    ? uiMessage('legal-data-sources-settings.configured.b0740e7ebe')
                    : uiMessage('legal-data-sources-settings.not-configured.8b6c7ecc15')}
                </span>
              )}
            >
              <div className="space-y-4">
                <p className="text-xs leading-5 text-white/45">{providerCopy.boundary}</p>
                <div className="grid gap-3 lg:grid-cols-2">
                  {source.fields.map(field => {
                    const fieldConfigured = Boolean(status[field.keyName]);
                    const value = drafts[field.keyName] || '';
                    return (
                      <label key={field.keyName} htmlFor={`data-source-${field.keyName}`} className="grid min-w-0 gap-2">
                        <span className="flex items-center justify-between gap-2 text-xs font-medium text-white/60">
                          <span>
                            {dataSourceFieldLabel(field)}
                            {field.required && <span className="ml-1 text-cyan-200">*</span>}
                          </span>
                          {fieldConfigured && <CheckCircle size={13} className="shrink-0 text-emerald-300" />}
                        </span>
                        <input
                          id={`data-source-${field.keyName}`}
                          type={field.kind === 'secret' ? 'password' : 'text'}
                          value={value}
                          onChange={event => setDrafts(previous => ({ ...previous, [field.keyName]: event.target.value }))}
                          onKeyDown={event => {
                            if (event.key === 'Enter') void saveSource(source);
                          }}
                          placeholder={fieldConfigured && !value
                            ? uiMessage('legal-data-sources-settings.saved-type-to-replace.bbdf5a8d1e')
                            : field.placeholder}
                          className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/25 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-300/35"
                        />
                      </label>
                    );
                  })}
                </div>
                <div className="flex flex-wrap justify-end gap-2 border-t border-white/8 pt-4">
                  <Button
                    onClick={() => { void removeSource(source); }}
                    disabled={busy || (!hasStoredField && !hasDraft)}
                    className="h-9 rounded-lg border border-red-400/20 bg-red-500/10 px-3 text-xs font-semibold text-red-200 hover:bg-red-500/15 disabled:opacity-30"
                  >
                    {busy ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Trash2 size={14} className="mr-2" />}
                    {uiMessage('settings.remove-provider.47319e8331')}
                  </Button>
                  <Button
                    onClick={() => { void saveSource(source); }}
                    disabled={busy || !hasDraft}
                    className="h-9 rounded-lg bg-celestial-saturn px-4 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-30"
                  >
                    {busy ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Save size={14} className="mr-2" />}
                    {uiMessage('settings.save-provider.2882e9668b')}
                  </Button>
                </div>
              </div>
            </SettingsDisclosure>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function ApplicationConnections({ t }: { t: any }) {
  return (
    <SettingsSection title={uiMessage('settings.application-service-connections.4c05e32d49')} icon={<FileText size={18} className="text-sky-300" />}>
      <div className="border-y border-white/10">
        <ApiKeyField compact icon={<Wrench size={18} className="text-white/70" />} label="GitHub" placeholder="Personal access token" storageKey="lumi_github_token" serverKey="GITHUB_TOKEN" t={t} />
        <ApiKeyField compact icon={<FileText size={18} className="text-white/70" />} label="Notion" placeholder="Integration token" storageKey="lumi_notion_api_key" serverKey="NOTION_API_KEY" t={t} />
        <ApiKeyField compact icon={<Sparkle size={18} className="text-pink-300" />} label="Figma" placeholder="Access token" storageKey="lumi_figma_access_token" serverKey="FIGMA_ACCESS_TOKEN" t={t} />
      </div>
    </SettingsSection>
  );
}

function ExternalConnectionsPage({
  t,
  initialTab = 'data-sources',
}: {
  t: any;
  initialTab?: 'data-sources' | 'applications';
}) {
  const [tab, setTab] = useState<'data-sources' | 'applications'>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  return (
    <div className="space-y-6">
      <div className="border-b border-white/10 pb-4">
        <h2 className="text-lg font-semibold text-white">
          {uiMessage('settings.external-connections.a83a9fc1d2')}
        </h2>
        <div className="mt-4 flex gap-5" role="tablist" aria-label={uiMessage('settings.external-connections.a83a9fc1d2')}>
          {([
            { id: 'data-sources', label: uiMessage('settings.data-sources.9f7efbc2df'), icon: <Database size={15} /> },
            { id: 'applications', label: uiMessage('settings.applications.36d70e9597'), icon: <FileText size={15} /> },
          ] as const).map(item => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={`flex items-center gap-2 border-b-2 pb-2 text-sm font-semibold transition-colors ${
                  active
                    ? 'border-celestial-saturn text-white'
                    : 'border-transparent text-white/45 hover:text-white/75'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'data-sources'
        ? <DataSourceConnections t={t} />
        : <ApplicationConnections t={t} />}
    </div>
  );
}

function ToolRuntimeConnections({ t }: { t: any }) {
  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.tool-runtime-connections.3942c3052f')} icon={<Cpu size={18} className="text-violet-300" />}>
        <div className="border-y border-white/10">
          <ApiKeyField compact icon={<Cpu size={18} className="text-violet-300" />} label="E2B Code Sandbox" placeholder="API Key" storageKey="lumi_e2b_api_key" serverKey="E2B_API_KEY" t={t} />
        </div>
      </SettingsSection>
      <MCPSettings t={t} />
    </div>
  );
}

interface ProviderRuntimeStatus {
  available: boolean;
  configured?: boolean;
  model: string;
  extension?: boolean;
  local?: boolean;
  version?: string;
  models?: Array<string | { id?: string; capabilities?: Record<string, boolean> }>;
  compatibility?: { status?: string; checkedAt?: string; latencyMs?: number };
  manifestDigest?: string;
  signerFingerprint?: string;
  lastProbe?: {
    ok: boolean;
    testedAt: string;
    latencyMs?: number;
    errorCategory?: string;
  } | null;
}

function AIProvidersPage({ t, providerStatus }: { t: any; providerStatus: Record<string, ProviderRuntimeStatus> }) {
  const [scope, setScope] = useState<'cloud' | 'local'>('cloud');
  const extensionProviders = Object.entries(providerStatus).filter(([, status]) => (
    status.extension === true && (scope === 'local' ? status.local === true : status.local !== true)
  ));
  return (
    <div className="space-y-6">
      <div className="border-b border-white/10 pb-4">
        <h2 className="text-lg font-semibold text-white">{uiMessage('settings.ai-providers.38c3f21901')}</h2>
        <div className="mt-4 flex gap-5">
          {([
            { id: 'cloud', label: uiMessage('settings.cloud-providers.134b71a80d') },
            { id: 'local', label: uiMessage('settings.local-compatible.4fda3a8732') },
          ] as const).map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setScope(item.id)}
              className={`relative pb-2 text-sm font-medium transition-colors ${scope === item.id ? 'text-white' : 'text-white/45 hover:text-white/70'}`}
            >
              {item.label}
              {scope === item.id && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-celestial-saturn" />}
            </button>
          ))}
        </div>
      </div>
      {scope === 'cloud' ? <CloudProviderSettings t={t} providerStatus={providerStatus} /> : <LocalProviderSettings t={t} />}
      {extensionProviders.length > 0 && (
        <SettingsSection title="Signed extension Providers" icon={<Shield size={18} className="text-emerald-300" />}>
          <div className="divide-y divide-white/10 border-y border-white/10">
            {extensionProviders.map(([providerId, status]) => (
              <div key={providerId} className="grid gap-2 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
                    <span>{providerId}</span>
                    <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-200">signed</span>
                    {status.version && <span className="font-mono text-[10px] text-white/35">v{status.version}</span>}
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    {status.model || 'No default model'} · {status.compatibility?.status || 'compatibility unknown'} · credentials {status.configured ? 'ready' : 'missing'}
                  </p>
                </div>
                <span className={`text-xs font-medium ${status.available ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {status.available ? 'available' : 'unavailable'}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-white/35">
            Installation, permission review, rollback, and disable operations use Lumi's confirmed extension registry and persistent receipts. Credentials are referenced from the local credential store and are never embedded in manifests.
          </p>
        </SettingsSection>
      )}
    </div>
  );
}

const REASONING_MODEL_OPTIONS: Record<string, string[]> = {
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
  ark: ['doubao-seed-2-0-lite-260215', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k'],
  xiaomi: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro'],
  kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  glm: ['glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4-plus'],
  relay: [],
  ollama: [],
  lmstudio: [],
  auto: [],
};

function ReasoningRoleSettings({ t, providerStatus }: { t: any; providerStatus: Record<string, ProviderRuntimeStatus> }) {
  const { aiConfig, updateAIConfig } = useApp();
  const [model, setModel] = useState(aiConfig.model);
  const [fallbackText, setFallbackText] = useState(() => (
    (aiConfig.fallbackCandidates || []).map(candidate => `${candidate.provider}/${candidate.model}`).join('\n')
  ));
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    setModel(aiConfig.model);
    setFallbackText((aiConfig.fallbackCandidates || []).map(candidate => `${candidate.provider}/${candidate.model}`).join('\n'));
    setTestMessage('');
  }, [aiConfig.model, aiConfig.provider, aiConfig.fallbackCandidates]);

  useEffect(() => {
    const migration = aiConfig.legacyMigration;
    if (!migration?.migratedAt || migration.entries.length === 0) return;
    const noticeKey = `lumi_model_migration_notice_${migration.migratedAt}`;
    if (localStorage.getItem(noticeKey) === 'shown') return;
    const detail = migration.entries.map(entry => `${entry.provider}: ${entry.from} → ${entry.to}`).join(', ');
    toast.info(`Legacy model aliases were migrated once: ${detail}`);
    localStorage.setItem(noticeKey, 'shown');
  }, [aiConfig.legacyMigration]);

  const selectionMode = aiConfig.provider === 'auto' ? 'auto' : aiConfig.selectionMode;
  const parseFallbackCandidates = () => fallbackText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separator = line.indexOf('/');
      return separator > 0
        ? { provider: line.slice(0, separator).trim(), model: line.slice(separator + 1).trim() }
        : { provider: '', model: '' };
    })
    .filter(candidate => candidate.provider && candidate.model);

  const saveReasoningRoute = () => {
    updateAIConfig({
      model: model.trim(),
      selectionMode,
      fallbackCandidates: selectionMode === 'ordered_fallback' || selectionMode === 'auto'
        ? parseFallbackCandidates()
        : [],
      allowCloudFallback: aiConfig.allowCloudFallback,
    });
  };

  const configuredModel = (() => {
    try {
      const models = JSON.parse(localStorage.getItem('lumi_llm_models') || '{}');
      return String(models[aiConfig.provider] || providerStatus[aiConfig.provider]?.model || '');
    } catch {
      return '';
    }
  })();
  const extensionProviders = Object.entries(providerStatus).filter(([, status]) => status.extension === true);
  const selectedExtensionModels = (providerStatus[aiConfig.provider]?.models || [])
    .map(item => typeof item === 'string' ? item : String(item.id || ''))
    .filter(Boolean);
  const selectedExtensionUnavailable = aiConfig.provider.startsWith('ext_')
    && !providerStatus[aiConfig.provider];

  const test = async () => {
    if (!aiConfig.provider || !model.trim()) return;
    setTesting(true);
    setTestMessage('');
    try {
      const result = selectionMode === 'pinned'
        ? await runLLMConnectionTest(aiConfig.provider, model.trim())
        : await runConfiguredReasoningRouteTest();
      setTestMessage(formatUiMessage('settings.live-call-passed-value0-ms.9f3242a245', { value0: result.latencyMs }));
    } catch (error: any) {
      setTestMessage(error?.message || uiMessage('settings.live-call-failed.cd19d46055'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsSection title={uiMessage('settings.reasoning-model-role.70c69a008d')} icon={<BrainCircuit size={18} className="text-celestial-saturn" />}>
      <div className="space-y-4 border-y border-white/10 py-5">
        <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">{t.primaryReasoningBrain || uiMessage('settings.primary-reasoning-brain.5bdd279d51')}</span>
          <select
            value={aiConfig.provider}
            onChange={event => {
              const provider = event.target.value;
              updateAIConfig({
                provider,
                ...(providerStatus[provider]?.model ? { model: providerStatus[provider].model } : {}),
              });
            }}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
          >
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">Qwen / DashScope</option>
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="ark">Doubao / Ark</option>
            <option value="xiaomi">Xiaomi MiMo</option>
            <option value="kimi">Kimi / Moonshot</option>
            <option value="glm">GLM / Zhipu AI</option>
            <option value="relay">{t.apiRelayLabel || 'OpenAI-Compatible'}</option>
            <option value="auto">Automatic (Local First)</option>
            <option value="ollama">Ollama Local</option>
            <option value="lmstudio">LM Studio Local</option>
            {extensionProviders.map(([providerId, status]) => (
              <option key={providerId} value={providerId}>
                {providerId} (Signed{status.local ? ', Local' : ''})
              </option>
            ))}
            {selectedExtensionUnavailable && (
              <option value={aiConfig.provider}>{aiConfig.provider} (Unavailable signed Provider)</option>
            )}
          </select>
        </label>
        <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
          <span className="text-xs font-bold text-white/55">Routing policy</span>
          <select
            value={selectionMode}
            onChange={event => {
              const next = event.target.value as 'pinned' | 'ordered_fallback' | 'auto';
              if (next === 'auto') updateAIConfig({ provider: 'auto', selectionMode: 'auto' });
              else updateAIConfig({
                provider: aiConfig.provider === 'auto' ? 'deepseek' : aiConfig.provider,
                selectionMode: next,
              });
            }}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-celestial-saturn/45"
          >
            <option value="pinned">Pinned — never substitute</option>
            <option value="ordered_fallback">Ordered fallback — user-defined order</option>
            <option value="auto">Automatic — local first with visible receipts</option>
          </select>
        </label>
        <GenerationModelInput
          id={`reasoning-role-${aiConfig.provider}`}
          label={uiMessage('settings.model.44c0cd4289')}
          value={model}
          options={[configuredModel, ...selectedExtensionModels, ...(REASONING_MODEL_OPTIONS[aiConfig.provider] || [])].filter(Boolean)}
          onChange={value => { setModel(value); setTestMessage(''); }}
        />
        {(selectionMode === 'ordered_fallback' || selectionMode === 'auto') && (
          <label className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)]">
            <span className="pt-2 text-xs font-bold text-white/55">Fallback order</span>
            <div className="space-y-2">
              <textarea
                value={fallbackText}
                onChange={event => setFallbackText(event.target.value)}
                placeholder={'ollama/qwen2.5:7b\nlmstudio/local-model\nopenai/gpt-4o-mini'}
                rows={3}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none focus:border-celestial-saturn/45"
              />
              <label className="flex items-center gap-2 text-xs text-white/60">
                <input
                  type="checkbox"
                  checked={aiConfig.allowCloudFallback}
                  onChange={event => updateAIConfig({ allowCloudFallback: event.target.checked })}
                />
                Allow explicitly configured cloud fallback
              </label>
            </div>
          </label>
        )}
        <p className="text-xs text-white/40">
          {selectionMode === 'pinned'
            ? 'Pinned mode fails explicitly if this exact provider/model is unavailable.'
            : 'Every attempt and the model actually used are written to the local routing receipt ledger.'}
        </p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={test} disabled={testing || !model.trim()} className="h-10 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-4 text-xs font-bold text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-40">
          {testing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Zap size={15} className="mr-2" />}
          {uiMessage('settings.test.9408c1ff3a')}
        </Button>
        <Button onClick={saveReasoningRoute} disabled={!model.trim()} className="h-10 rounded-lg bg-celestial-saturn px-4 text-xs font-bold text-black hover:bg-yellow-300 disabled:opacity-40">
          <Save size={15} className="mr-2" />
          {uiMessage('settings.save.ec8e6d5819')}
        </Button>
      </div>
      {testMessage && <p className="mt-3 text-right text-xs text-white/55">{testMessage}</p>}
    </SettingsSection>
  );
}

function CloudProviderSettings({ t, providerStatus }: { t: any; providerStatus: Record<string, ProviderRuntimeStatus> }) {
  const failedProbes = Object.entries(providerStatus)
    .filter(([, status]) => status.configured !== false && status.lastProbe?.ok === false);
  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.cloud-model-providers.55a86c3fed')}>
        {failedProbes.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-2 border-y border-red-400/15 py-3 text-xs text-red-200/80">
            <AlertTriangle size={14} />
            <span>{uiMessage('settings.last-probe-unavailable.96559b4185')}</span>
            {failedProbes.map(([provider, status]) => (
              <span key={provider} className="font-mono">
                {provider} ({status.lastProbe?.errorCategory || uiMessage('settings.failed.4b20f2d3b4')})
              </span>
            ))}
          </div>
        )}
        <div className="border-y border-white/10">
          <LLMProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label="DeepSeek" providerId="deepseek" models={['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']} placeholder="sk-..." serverKey="DEEPSEEK_API_KEY" t={t} />
          <LLMProviderRow icon={<Zap size={18} className="text-violet-400" />} label="Qwen / DashScope (Alibaba Cloud)" providerId="qwen" models={['qwen-plus', 'qwen-max', 'qwen-turbo']} placeholder="sk-..." serverKey="DASHSCOPE_API_KEY" t={t} />
           <LLMProviderRow icon={<Cloud size={18} className="text-cyan-400" />} label="Doubao (Ark)" providerId="ark" models={['doubao-seed-2-0-lite-260215', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k', 'doubao-1-5-vision-pro-32k']} placeholder={uiMessage('settings.enter-ark-api-key.9f82bf67e1')} serverKey="ARK_API_KEY" t={t} />
           <LLMProviderRow icon={<Cpu size={18} className="text-orange-400" />} label="Xiaomi MiMo" providerId="xiaomi" models={['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro']} placeholder={uiMessage('settings.enter-mimo-api-key.58533112c9')} serverKey="XIAOMI_API_KEY" t={t} />
           <LLMProviderRow icon={<Sparkle size={18} className="text-rose-400" />} label="Kimi (Moonshot)" providerId="kimi" models={['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']} placeholder="sk-..." serverKey="KIMI_API_KEY" t={t} />
           <LLMProviderRow icon={<Sparkle size={18} className="text-cyan-400" />} label="GLM (Zhipu AI)" providerId="glm" models={['glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4-plus']} placeholder={uiMessage('settings.enter-glm-api-key.d9e86fca17')} serverKey="GLM_API_KEY" t={t} />
          <LLMProviderRow icon={<BrainCircuit size={18} className="text-blue-400" />} label={`Google Gemini${providerStatus.gemini?.available ? ` (${providerStatus.gemini.model})` : ''}`} providerId="gemini" models={['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']} placeholder={providerStatus.gemini?.available ? (t.connectedViaEnv || uiMessage('settings.connected-via-environment.2dcffe5622')) : (t.noKeyConfigured || uiMessage('settings.no-key-configured.633defef78'))} serverKey="GEMINI_API_KEY" t={t} />
          <LLMProviderRow icon={<MessagesSquare size={18} className="text-green-400" />} label="OpenAI" providerId="openai" models={['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo']} placeholder="sk-..." serverKey="OPENAI_API_KEY" t={t} />
          <LLMProviderRow icon={<Sparkle size={18} className="text-purple-400" />} label="Anthropic Claude" providerId="anthropic" models={['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5']} placeholder="sk-ant-..." serverKey="ANTHROPIC_API_KEY" t={t} />
          <ApiKeyField compact icon={<Sparkle size={18} className="text-rose-300" />} label="MiniMax" placeholder="sk-..." storageKey="lumi_minimax_key" serverKey="MINIMAX_API_KEY" consoleUrl="https://platform.minimaxi.com" hint={uiMessage('settings.minimax-generation-provider-hint.2c939bd0f7')} t={t} />
          <ApiKeyField compact icon={<Sparkle size={18} className="text-emerald-300" />} label="SiliconFlow" placeholder="sk-..." storageKey="lumi_siliconflow_key" serverKey="SILICONFLOW_API_KEY" consoleUrl="https://cloud.siliconflow.cn" hint={uiMessage('settings.siliconflow-generation-provider-hint.73aa2ce8e7')} t={t} />
          <ApiKeyField compact icon={<Volume2 size={18} className="text-emerald-300" />} label={t.doubaoSpeechLabel || 'Doubao Speech'} placeholder="AppID:AccessToken" storageKey="lumi_doubao_speech" serverKey="DOUBAO_SPEECH_KEY" hint={t.doubaoSpeechHint || uiMessage('settings.format-appid-accesstoken-get-both.c1d78f1a86')} t={t} />
        </div>
      </SettingsSection>
    </div>
  );
}

function LocalProviderSettings({ t }: { t: any }) {
  return (
    <SettingsSection title={uiMessage('settings.local-compatible-providers.f6a71d6a1e')}>
      <div className="border-y border-white/10">
        <OllamaProviderRow t={t} />
        <LmStudioProviderRow t={t} />
        <RelayProviderRow t={t} />
      </div>
    </SettingsSection>
  );
}

function LocalLLMProviderRow({
  providerId,
  label,
  endpoint,
  storageKey,
  defaultUrl,
  defaultModel,
  accent,
  t,
}: {
  providerId: 'ollama' | 'lmstudio';
  label: string;
  endpoint: string;
  storageKey: string;
  defaultUrl: string;
  defaultModel: string;
  accent: 'emerald' | 'amber';
  t?: any;
}) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const { aiConfig, updateAIConfig } = useApp();
  const [baseUrl, setBaseUrl] = useState(() => {
    try { return localStorage.getItem(storageKey) || defaultUrl; } catch { return defaultUrl; }
  });
  const [detected, setDetected] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testState, setTestState] = useState<ProviderTestState>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [model, setModel] = useState(() => {
    try {
      const savedModels = JSON.parse(localStorage.getItem('lumi_llm_models') || '{}');
      return savedModels[providerId] || defaultModel;
    } catch {
      return defaultModel;
    }
  });
  const generationModels = models.filter(modelName => !/(?:embed|embedding|whisper|rerank|re-rank|bge[-_]|nomic[-_]?embed)/i.test(modelName));

  const persistModel = (nextModel: string) => {
    setModel(nextModel);
    const allModels = (() => {
      try { return JSON.parse(localStorage.getItem('lumi_llm_models') || '{}'); } catch { return {}; }
    })();
    allModels[providerId] = nextModel;
    localStorage.setItem('lumi_llm_models', JSON.stringify(allModels));
    if (aiConfig.provider === providerId) updateAIConfig({ model: nextModel });
    else {
      apiFetch('/api/preferences/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider: aiConfig.provider, models: allModels }),
      }).catch(() => {});
    }
    setTestState('idle');
    setTestMessage('');
  };

  useEffect(() => {
    apiFetch(endpoint, { credentials: 'include' })
      .then(async r => {
        const cfg = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(cfg.error || 'Failed to load local model config');
        return cfg;
      })
      .then(cfg => {
        setBaseUrl(cfg.baseUrl || defaultUrl);
        setDetected(!!cfg.detected);
        setModels(cfg.models || []);
        setError(cfg.lastError || '');
      })
      .catch(() => {});
  }, [defaultUrl, endpoint]);

  useEffect(() => {
    if (generationModels.length > 0 && model.trim() && !generationModels.includes(model.trim())) {
      setError(`Selected model "${model.trim()}" is not currently loaded. The selection was preserved; load that exact model or choose another one explicitly.`);
    }
  }, [generationModels.join('\u0000')]);

  const handleDetect = async () => {
    setChecking(true);
    setError('');
    setTestState('idle');
    setTestMessage('');
    try {
      const resp = await apiFetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ baseUrl }),
      });
      const cfg = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(cfg.error || 'Local model detection failed');
      setDetected(!!cfg.detected);
      setModels(cfg.models || []);
      setBaseUrl(cfg.baseUrl || baseUrl);
      setError(cfg.lastError || '');
      localStorage.setItem(storageKey, cfg.baseUrl || baseUrl);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (caught: any) {
      setDetected(false);
      setModels([]);
      setError(caught?.message || uiMessage('settings.local-model-detection-failed.639dea570a'));
    } finally {
      setChecking(false);
    }
  };

  const handleUse = () => {
    if (!model.trim()) return;
    updateAIConfig({ provider: providerId, model: model.trim() });
  };

  const handleTest = async () => {
    if (!detected || !model.trim()) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const result = await runLLMConnectionTest(providerId, model.trim());
      setTestState('ok');
      setTestMessage(formatUiMessage('settings.live-call-passed-value0-ms.9f3242a245', { value0: result.latencyMs }));
    } catch (caught: any) {
      setTestState('error');
      setTestMessage(caught?.message || uiMessage('settings.live-call-failed.cd19d46055'));
    }
  };

  const accentClasses = accent === 'emerald'
    ? { icon: 'text-emerald-400', button: 'bg-emerald-600 hover:bg-emerald-500', focus: 'focus:border-emerald-400/50' }
    : { icon: 'text-amber-400', button: 'bg-amber-600 hover:bg-amber-500', focus: 'focus:border-amber-400/50' };

  return (
    <SettingsDisclosure
      icon={<Cpu size={18} className={accentClasses.icon} />}
      label={label}
      defaultOpen={aiConfig.provider === providerId}
      badges={<>
        {detected && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{uiMessage('settings.detected.6d745414bb')}</span>}
        {aiConfig.provider === providerId && <span className="rounded-full border border-celestial-saturn/20 bg-celestial-saturn/10 px-2 py-0.5 text-[11px] font-semibold text-celestial-saturn">{t?.activeBadge || uiMessage('settings.active.0aac32bf1d')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); setSaved(false); setDetected(false); setTestState('idle'); setTestMessage(''); }}
          onKeyDown={e => e.key === 'Enter' && handleDetect()}
          placeholder={defaultUrl}
          className={`h-11 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors ${accentClasses.focus}`}
        />
        <Button
          onClick={handleDetect}
          disabled={checking || !baseUrl.trim()}
          className={`h-11 rounded-lg px-4 text-xs font-semibold text-white transition-all disabled:opacity-30 ${accentClasses.button}`}
        >
          {checking ? <Loader2 size={16} className="animate-spin" /> : uiMessage('settings.detect.333c762fe5')}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)_auto_auto] sm:items-center">
        <label className="text-xs font-semibold text-white/50">{t?.model || uiMessage('settings.model.44c0cd4289')}</label>
        <input
          type="text"
          value={model}
          onChange={event => persistModel(event.target.value)}
          list={`local-llm-models-${providerId}`}
          placeholder={defaultModel}
          className={`h-10 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white outline-none ${accentClasses.focus}`}
        />
        <datalist id={`local-llm-models-${providerId}`}>
          {[...new Set([model, ...generationModels].filter(Boolean))].map(modelName => <option key={modelName} value={modelName} />)}
        </datalist>
        <Button onClick={handleUse} disabled={!detected || !model.trim() || !generationModels.includes(model.trim())} className="h-10 rounded-lg bg-celestial-saturn px-3 text-xs font-semibold text-black hover:bg-celestial-saturn/90 disabled:opacity-30">
          {uiMessage('settings.use.1ec0c92474')}
        </Button>
        <Button onClick={handleTest} disabled={!detected || !model.trim() || testState === 'testing'} className="h-10 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-30">
          {testState === 'testing' ? <Loader2 size={15} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
        </Button>
      </div>
      {detected && generationModels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {generationModels.map(modelName => (
            <button key={modelName} onClick={() => persistModel(modelName)} className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/60 hover:bg-white/10 hover:text-white font-mono">
              {modelName}
            </button>
          ))}
        </div>
      )}
      {error && !checking && <p className="text-xs text-amber-300/80">{error}</p>}
      {testMessage && <p className={`text-xs ${testState === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{testMessage}</p>}
      </div>
    </SettingsDisclosure>
  );
}

function OllamaProviderRow({ t }: { t?: any }) {
  return <LocalLLMProviderRow providerId="ollama" label="Ollama (Local AI)" endpoint="/api/ollama/config" storageKey="lumi_ollama_url" defaultUrl="http://127.0.0.1:11434" defaultModel="qwen2.5:7b" accent="emerald" t={t} />;
}

function LmStudioProviderRow({ t }: { t?: any }) {
  return <LocalLLMProviderRow providerId="lmstudio" label="LM Studio (Local AI)" endpoint="/api/lmstudio/config" storageKey="lumi_lmstudio_url" defaultUrl="http://127.0.0.1:1234" defaultModel="local-model" accent="amber" t={t} />;
}

function VoiceServicesPage({ t }: { t: any }) {
  return (
    <div className="space-y-8">
      <SettingsSection title={t.audioOutput || uiMessage('settings.audio-voice-output.e1f3dc4c32')} icon={<Music size={18} className="text-celestial-saturn" />}>
        <div className="space-y-4 mb-6">
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-white/80">{t.ttsEngine || uiMessage('settings.tts-engine.a69f1a5e70')}</span>
            </div>
            <p className="text-xs text-white/40">{t.ttsEngineDesc || uiMessage('settings.local-tts-local-cosyvoice-gpt.ec3eae7527')}</p>
          </div>
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-white/80">{t.sttEngine || uiMessage('settings.stt-engine.3e8df8d9d4')}</span>
            </div>
            <p className="text-xs text-white/40">{t.sttEngineDesc || uiMessage('settings.local-whisper-openai-whisper-doubao.ff3da59708')}</p>
          </div>
          <VoiceProviderSwitch t={t} />
        </div>
        <p className="text-sm text-white/40 max-w-xl mb-6">
          {t.voiceServicesDesc || uiMessage('settings.speech-recognition-asr-and-speech.4d604985a1')}
        </p>
        <div className="mt-6 p-4 bg-white/5 rounded-xl border border-white/10">
          <div className="flex items-center justify-between">
            <div>
               <p className="text-xs font-bold text-white/80">{t.proactiveVoiceGreeting}</p>
               <p className="text-xs text-white/55 mt-0.5">{t.proactiveVoiceGreetingDesc}</p>
            </div>
            <ProactiveVoiceToggle />
          </div>
          <div className="flex items-center justify-between mt-3">
            <div>
               <p className="text-xs font-bold text-white/80">{t.wakeWordLabel}</p>
               <p className="text-xs text-white/55 mt-0.5">{t.wakeWordDesc}</p>
            </div>
            <WakeWordToggle />
          </div>
          <div className="flex items-center justify-between mt-3">
            <div>
               <p className="text-xs font-bold text-white/80">{t.alwaysOnVoiceLabel}</p>
               <p className="text-xs text-white/55 mt-0.5">{t.alwaysOnVoiceDesc}</p>
            </div>
            <AlwaysOnVoiceToggle />
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function SpeechProviderSettings({ t }: { t: any }) {
  return (
    <SettingsSection title={uiMessage('settings.speech-model-providers.99e68f2051')} icon={<Mic size={18} className="text-emerald-300" />}>
      <p className="mb-5 max-w-3xl text-sm leading-relaxed text-white/45">
        {uiMessage('settings.speech-provider-description.ea8bf84041')}
      </p>
      <div className="border-y border-white/10">
        <ApiKeyField icon={<Volume2 size={18} className="text-emerald-400" />} label={t.doubaoSpeechLabel || 'Doubao Speech (STT + TTS)'} placeholder="AppID:AccessToken" storageKey="lumi_doubao_speech" serverKey="DOUBAO_SPEECH_KEY" hint={t.doubaoSpeechHint || uiMessage('settings.format-appid-accesstoken-get-both.c1d78f1a86')} t={t} />
        <ApiKeyField icon={<Zap size={18} className="text-violet-400" />} label={t.dashscopeLabel || 'DashScope (Cloud STT + TTS)'} placeholder="sk-..." storageKey="lumi_dashscope_key" serverKey="DASHSCOPE_API_KEY" hint={t.dashscopeHint || uiMessage('settings.powers-qwen-asr-and-dashscope.519f4cb3da')} t={t} />
      </div>
    </SettingsSection>
  );
}

function ApiKeyField({ icon, label, placeholder, disabled = false, storageKey, serverKey, hint, consoleUrl, compact = false, secret = true, t }: { icon: React.ReactNode, label: string, placeholder: string, disabled?: boolean, storageKey: string, serverKey?: string, hint?: string, consoleUrl?: string, compact?: boolean, secret?: boolean, t?: any }) {
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
      toast.success(t?.apiKeyRemoved || uiMessage('settings.api-key-removed.bae3220b94'));
    };
    if (serverKey) {
      saveServerKeys({ [serverKey]: '' })
        .then(removeLocal)
        .catch(err => toast.error(err.message || t?.failedToRemoveKey || uiMessage('settings.failed-to-remove-key.065616ae8b')));
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
      toast.success(t?.apiKeySaved || uiMessage('settings.api-key-saved.a1dc4d42fb'));
    };
    if (serverKey) {
      saveServerKeys({ [serverKey]: value.trim() })
        .then(saveLocal)
        .catch(err => toast.error(err.message || t?.failedToSaveKey || uiMessage('settings.failed-to-save-key-to.be32a67a8a')));
      return;
    }
    saveLocal();
  };

  return (
    <SettingsDisclosure
      icon={icon}
      label={label}
      badges={<>
        {serverConfigured && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{t?.configured || uiMessage('settings.configured.d7f5ed6e15')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
      {consoleUrl && (
        <a href={consoleUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300/70 hover:text-cyan-200">
          {uiMessage('settings.provider-console.f2138df9a1')} <ExternalLink size={12} />
        </a>
      )}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="relative flex-1">
          <input
            disabled={disabled}
            type={secret ? 'password' : 'text'}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder={serverConfigured && !value ? (t?.keySavedOnServer || uiMessage('settings.key-saved-on-server-type.3b51321a15')) : placeholder}
            className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 pr-20 font-mono text-sm text-white outline-none transition-colors focus:border-celestial-saturn/50 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleRemove}
            disabled={disabled || (!value && !serverConfigured)}
            className="absolute right-1.5 top-1.5 h-8 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 text-[11px] font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-20"
          >
            {t?.remove || uiMessage('settings.remove.78190c6054')}
          </button>
        </div>
        <Button
          onClick={handleSave}
          disabled={disabled || !value.trim()}
          className="h-11 rounded-lg bg-celestial-saturn px-5 text-xs font-semibold text-black transition-all hover:bg-celestial-saturn/90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t?.save || uiMessage('settings.save.ec8e6d5819')}
        </Button>
      </div>
      {hint && <p className="text-[12px] text-white/45 leading-relaxed">{hint}</p>}
      </div>
    </SettingsDisclosure>
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
      toast.success(t?.apiKeySaved || uiMessage('settings.api-key-saved.a1dc4d42fb'));
    }).catch(err => toast.error(err.message || t?.failedToSaveKey || uiMessage('settings.failed-to-save.465b88f9c0')));
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
      toast.success(t?.apiKeyRemoved || uiMessage('settings.api-key-removed.bae3220b94'));
    }).catch(err => toast.error(err.message || t?.failedToRemoveKey || uiMessage('settings.failed-to-remove.5c5d9c7827')));
  };

  return (
    <SettingsDisclosure
      icon={<Globe size={18} className="text-cyan-400" />}
      label={t?.apiRelayLabel || 'API Relay'}
      badges={<>
        {(serverKeyOk || serverUrlOk) && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{uiMessage('settings.configured.d7f5ed6e15')}</span>}
        {saved && <CheckCircle size={14} className="text-green-400" />}
      </>}
    >
      <div className="space-y-3">
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          placeholder="API Key"
          className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-400/50"
        />
        <input
          type="text"
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          placeholder="https://your-relay.example.com/v1"
          className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-400/50"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          onClick={handleSave}
          disabled={!apiKey.trim() || !baseUrl.trim()}
          className="h-10 rounded-lg bg-cyan-600 px-4 text-xs font-semibold text-white transition-all hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t?.save || uiMessage('settings.save.ec8e6d5819')}
        </Button>
        <Button
          onClick={handleRemove}
          disabled={!apiKey && !serverKeyOk && !serverUrlOk}
          className="h-10 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {t?.remove || uiMessage('settings.remove.78190c6054')}
        </Button>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-white/45">{uiMessage('settings.openai-compatible-api-relay-enter.b0d5520635')}</p>
    </SettingsDisclosure>
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
  messagingSendRequiresConfirmation: false,
  maxConsecutiveTasks: 6,
  allowedHours: [{ start: 0, end: 24 }],
  requireIdle: false,
  minIdleSeconds: 0,
  maxTokensPerHour: 30000,
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
          setNativeRuntimeError(err?.message || uiMessage('settings.native-runtime-controls-are-only.242e691b46'));
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
      toast.success(enabled ? uiMessage('settings.enabled.4508d98328') : uiMessage('settings.disabled.68b069bc6a'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('settings.failed-to-update-native-runtime.6cdad0027d'));
    }
  };

  const invokeRuntimeAction = async (action: 'hide' | 'quit') => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke(action === 'hide' ? 'hide_to_background' : 'quit_app');
    } catch (err: any) {
      toast.error(err?.message || uiMessage('settings.runtime-action-failed.2d63d1e37a'));
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
    operationMode === 'autonomous' ? uiMessage('settings.autonomy.6aea974e38') :
    operationMode === 'assistant' ? uiMessage('settings.assistant.90c4ae600c') :
    operationMode === 'chat' ? uiMessage('settings.chat.1594b2f45c') :
    uiMessage('settings.meeting.e16a90b510');
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
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{uiMessage('settings.desktop-modes.569d70b466')}</div>
          <p className="text-xs text-white/40 mt-1">{uiMessage('settings.permissions-follow-the-three-desktop.5c6e6a2ca1')}</p>
        </div>
        <div className="rounded-xl bg-black/18 px-3 py-3 text-[11px] leading-relaxed text-white/42">
          {uiMessage('settings.current-desktop-mode.0535fb2a2e')}: <span className="font-bold text-white/72">{modeLabel}</span>
          <span className="mx-2 text-white/18">/</span>
          {uiMessage('settings.backend-autonomy.cf04ab2476')}: <span className="font-bold text-white/72">{gateLevel}</span>
        </div>
      </div>

      {/* Resident Runtime */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <div>
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{uiMessage('settings.native-resident-runtime.a56bca847b')}</div>
          <p className="text-xs text-white/40 mt-1">{uiMessage('settings.controls-whether-the-desktop-client.0b21f43460')}</p>
        </div>
        <div className="rounded-xl border border-white/8 bg-black/18 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-white/72">{uiMessage('settings.native-resident-runtime.f3f4af60e9')}</div>
              <div className="mt-1 text-[11px] leading-relaxed text-white/36">
                {uiMessage('settings.controls-whether-the-installed-desktop.aa6963a96d')}
              </div>
            </div>
            <button
              onClick={() => refreshNativeRuntime().catch((err: any) => toast.error(err?.message || uiMessage('settings.runtime-refresh-failed.c51da4aaaa')))}
              className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-white/45 hover:bg-white/[0.08] hover:text-white"
            >
              {uiMessage('settings.refresh.cba212b169')}
            </button>
          </div>
          {nativeRuntime ? (
            <div className="space-y-2">
              <ToggleRow
                label={uiMessage('settings.launch-at-login.2485b7c036')}
                desc={nativeRuntime.autostart_supported ? uiMessage('settings.starts-lumi-with-background-for.a33dc15a9d') : uiMessage('settings.launch-at-login-is-not.1796e70780')}
                checked={nativeRuntime.autostart_enabled}
                onClick={() => nativeRuntime.autostart_supported && updateNativeRuntime('autostart', !nativeRuntime.autostart_enabled)}
              />
              <ToggleRow
                label={uiMessage('settings.close-button-hides-to-background.788eb15250')}
                desc={uiMessage('settings.the-top-close-button-and.2777d97f38')}
                checked={nativeRuntime.close_to_background}
                onClick={() => updateNativeRuntime('closeToBackground', !nativeRuntime.close_to_background)}
              />
              <div className="grid grid-cols-2 gap-2 text-[11px] text-white/42">
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.platform.3ffff3f363')}: {nativeRuntime.platform}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.shortcut.51a35f7d60')}: {nativeRuntime.global_shortcut}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.backend.9c17db77f8')}: {nativeRuntime.backend_node_running ? uiMessage('settings.running.4ac4390de9') : uiMessage('settings.dev-not-spawned.42b82413a9')}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.restarts.04fb20829b')}: {nativeRuntime.node_restarts}</div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => invokeRuntimeAction('hide')}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white/50 hover:bg-white/[0.08] hover:text-white"
                >
                  {uiMessage('settings.hide-now.f08e6a7f7b')}
                </button>
                <button
                  onClick={() => invokeRuntimeAction('quit')}
                  className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-200/70 hover:bg-red-400/15 hover:text-red-100"
                >
                  {uiMessage('settings.quit-lumi.df32c5974e')}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/38">
              {nativeRuntimeError || uiMessage('settings.native-runtime-status-is-loading.4a6aed02cd')}
            </div>
          )}
        </div>
      </div>

      {/* Scheduler Tasks */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <button onClick={() => setTasksExpanded(!tasksExpanded)} className="w-full flex items-center justify-between">
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{uiMessage('settings.background-tasks.015be0a9ad')}</div>
          <ChevronDown size={14} className={`text-white/40 transition-transform ${tasksExpanded ? 'rotate-180' : ''}`} />
        </button>

        {tasksExpanded && (
          <div className="max-h-60 overflow-y-auto custom-scrollbar space-y-1">
            {taskList.map((task: any) => (
              <div key={task.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.02]">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-white/60 truncate">{task.id}</div>
                  <div className="text-[11px] text-white/30">{task.cron} {task.lastRun ? formatUiMessage('settings.last-value0.ad05dbfaea', { value0: new Date(task.lastRun).toLocaleTimeString() }) : ''}</div>
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

function SettingsSection({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-5">
      <div className="flex items-center gap-2.5">
        {icon || null}
        <h3 className="text-base font-semibold text-white/90">{title}</h3>
      </div>
      <div className="space-y-4">
        {children}
      </div>
    </section>
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
    toast.info(`${label}: ${next ? (t?.enabled || uiMessage('settings.enabled.4508d98328')) : (t?.disabled || uiMessage('settings.disabled.68b069bc6a'))}`);
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
