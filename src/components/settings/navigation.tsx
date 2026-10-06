import React, { Suspense, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Shield, Globe, Database, BrainCircuit, Sparkle, Camera, Mic, LogOut, Sun, Moon, ExternalLink, Wrench, Search } from "lucide-react";
import { toast } from "sonner";
import { usePlatform } from "@/hooks/usePlatform";
import { BiometricsEnrollPanel } from "../biometrics/BiometricsEnrollPanel";
import { PrivacyModeSettings } from "../PrivacyModeSettings";
import { useApp, type AppearanceMode } from "@/contexts/AppContext";
import { apiJson } from "@/services/apiClient";
import { uiMessage } from "../../i18n/uiMessages";
import type { ProviderRuntimeStatus } from './connections';
import { SettingsSection, SettingsItem, SidebarItem } from './components';
import { AutonomousSettingsPanel } from './autonomy';
import { VoiceForge, VoiceServicesPage } from './voice_services';
import { AIProvidersPage } from './provider_navigation';
import { ReasoningRoleSettings } from './reasoning';
import { ExternalConnectionsPage, ToolRuntimeConnections } from './connections';
import { WorldModelsPage } from './world_models';
import { GenerativeModelsPage } from './generation';
import { RetrievalModelSettings } from './retrieval';
import { HardwareSettings } from './hardware';

export function buildSidebarGroups(t: any) {
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

export function SettingsView({
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
  const { user, logout, appearanceMode, resolvedAppearanceMode, setAppearanceMode, workDomain, switchDomain } = useApp();
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

  useEffect(() => {
    if (!user?.uid) return;
    let request: AbortController | undefined;
    const loadProviderStatus = async () => {
      request?.abort();
      const owner = new AbortController(); request = owner;
      const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
      try {
        const data = await apiJson('/api/llm/providers', { signal });
        signal.throwIfAborted();
        if (!data?.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) throw new Error('Invalid provider status');
        setProviderStatus(data.providers);
      } catch (err: any) {
        if (!owner.signal.aborted) {
          setProviderStatus({});
          toast.error(err?.message || t.failedToLoadProviderStatus || uiMessage('settings.failed-to-load-provider-status.6411dc3232'));
        }
      }
    };
    void loadProviderStatus();
    window.addEventListener('lumi:keys-changed', loadProviderStatus);
    return () => {
      request?.abort();
      window.removeEventListener('lumi:keys-changed', loadProviderStatus);
    };
  }, [user?.uid, t.failedToLoadProviderStatus]);

  useEffect(() => {
    const handleModelConfigurationChanged = (event: Event) => {
      if ((event as CustomEvent).detail?.source !== 'official-settings') setModelConfigurationRevision(previous => previous + 1);
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
                <AutonomousSettingsPanel t={t} />
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
        return <RetrievalModelSettings t={t} />;
      case 'voice-model':
      case 'voice-services':
        return <VoiceServicesPage t={t} />;
      case 'security':
        return (
          <div className="space-y-8">
            <SettingsSection title={t.privacySecurity || uiMessage('settings.privacy-security.901389923c')} icon={<Shield size={18} className="text-celestial-mars" />}>
              <PrivacyModeSettings locale={lang} workspace={workDomain} sessionId={user?.uid || 'signed-out'} />
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
          <a
            href="https://lumiai.asia/"
            target="_blank"
            rel="noopener noreferrer"
            className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <Globe size={14} className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block">{uiMessage('settings.lumi-website.29f47c3d10', lang)}</span>
              <span className="mt-0.5 block text-[10px] text-white/35">lumiai.asia</span>
            </span>
            <ExternalLink size={13} className="shrink-0" />
          </a>
          <button
            onClick={logout}
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
