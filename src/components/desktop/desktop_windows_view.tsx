import { LazyPanelFallback, OSWindow } from "./window_shell";
import { SensorPrimer } from "./sensor_primer";
import { KernelMonitorApp } from "./kernel_monitor";
import { ExecutionWorkQueue } from "./daily_plans";
import { Suspense } from 'react';
import { AnimatePresence } from 'motion/react';
import { Volume2, Brush } from 'lucide-react';
import { toast } from 'sonner';
import { DesktopPersonalizationSoundPanel } from "../DesktopPersonalizationSoundPanel";
import { uiMessage } from "../../i18n/uiMessages";
import { NotificationCenter, DesktopOnboarding, VoiceTrainingDialog, BusinessWorkbench, Settings, PersonalityEditor, ToolPanel, GitHubMCPBrowser, ReminderPanel, DeviceSyncCenter, TokenDashboard, SkillCenter, AvatarStudio, TerminalWindow } from "./surface_components";
import type { DesktopShellViewInput } from './DesktopShellView';

export function renderDesktopWindows({ isWallpaperMode, sensorPrimerSeen, finishSensorPrimer, t, showOnboarding, askComputerProfileQuestion, setShowOnboarding, isTrainingOpen, setIsTrainingOpen, openWindows, getWindowSize, getWindowMeta, focusedWindow, minimizedWindows, focusOsWindow, minimizeOsWindow, closeWindow, lang, workDomain, toggleWindow, openKnowledgeBase, setCreationRequestId, openCommandCenter, openMemoryAvatar, setLang, settingsSection, setSettingsSection, openProactiveChat, canUseExternalCapabilities, isTauri, user, personalizationSection, setPersonalizationSection, petPreferenceScopeKey, selectedPet, handleSelectPet, equippedAccessories, canCustomizeLumiAppearance, setEquippedAccessories, savePetPrefsToServer, setSelectedPet, renderTabContent }: Pick<DesktopShellViewInput, "isWallpaperMode" | "sensorPrimerSeen" | "finishSensorPrimer" | "t" | "showOnboarding" | "askComputerProfileQuestion" | "setShowOnboarding" | "isTrainingOpen" | "setIsTrainingOpen" | "openWindows" | "getWindowSize" | "getWindowMeta" | "focusedWindow" | "minimizedWindows" | "focusOsWindow" | "minimizeOsWindow" | "closeWindow" | "lang" | "workDomain" | "toggleWindow" | "openKnowledgeBase" | "setCreationRequestId" | "openCommandCenter" | "openMemoryAvatar" | "setLang" | "settingsSection" | "setSettingsSection" | "openProactiveChat" | "canUseExternalCapabilities" | "isTauri" | "user" | "personalizationSection" | "setPersonalizationSection" | "petPreferenceScopeKey" | "selectedPet" | "handleSelectPet" | "equippedAccessories" | "canCustomizeLumiAppearance" | "setEquippedAccessories" | "savePetPrefsToServer" | "setSelectedPet" | "renderTabContent">) {
  return (
<div className={`absolute inset-0 z-[20] pointer-events-none transition-opacity duration-500 ${isWallpaperMode ? 'opacity-0' : 'opacity-100'}`}>
        <SensorPrimer
          isOpen={!sensorPrimerSeen}
          onContinue={finishSensorPrimer}
          t={t}
        />
        {showOnboarding && sensorPrimerSeen && (
          <Suspense fallback={null}>
            <DesktopOnboarding
              isOpen
              onAsk={askComputerProfileQuestion}
              onFinish={() => {
                setShowOnboarding(false);
                localStorage.setItem('lumi_onboarding_seen', 'true');
              }}
              t={t}
            />
          </Suspense>
        )}
        {isTrainingOpen && (
          <Suspense fallback={null}>
            <VoiceTrainingDialog
              isOpen={isTrainingOpen}
              onClose={() => setIsTrainingOpen(false)}
              onSuccess={() => window.dispatchEvent(new CustomEvent('lumi:voice-updated'))}
            />
          </Suspense>
        )}
        <AnimatePresence>
          {openWindows.map((windowId, orderIdx) => {
            const size = getWindowSize(windowId);
            const meta = getWindowMeta(windowId);
            return (
              <OSWindow
                key={windowId}
                id={windowId}
                title={meta.label}
                icon={meta.icon}
                isActive={focusedWindow === windowId}
                isMinimized={minimizedWindows.includes(windowId)}
                zIndex={10 + orderIdx}
                onFocus={focusOsWindow}
                onMinimize={minimizeOsWindow}
                onMinimizeComplete={(id) => {
                  // Window stays in DOM, just mark animation complete
                }}
                onClose={() => closeWindow(windowId)}
                colorClass={meta.color}
                width={size.w}
                height={size.h}
                t={t}
              >
                <div className="os-window-body custom-scrollbar">
                  <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
                  {windowId === 'business' ? (
                    <BusinessWorkbench lang={lang} domain={workDomain} onOpenSettings={() => toggleWindow('settings')} onOpenKnowledge={openKnowledgeBase} onOpenSkills={() => toggleWindow('skills')}
                      onOpenCreation={() => { setCreationRequestId(crypto.randomUUID()); openCommandCenter('office'); }}
                      onOpenDigitalHuman={() => { void openMemoryAvatar(undefined, 'home'); }} />
                  ) : windowId === 'kernel' ? (
                    <KernelMonitorApp t={t} onAsk={askComputerProfileQuestion} />
                  ) : windowId === 'settings' ? (
                    <Settings t={t} lang={lang} setLang={setLang} activeSection={settingsSection} onSectionChange={setSettingsSection} />
                  ) : windowId === 'personality' ? (
                    <PersonalityEditor t={t} />
                  ) : windowId === 'tools' ? (
                    <ToolPanel />
                  ) : windowId === 'github-mcp' ? (
                    <GitHubMCPBrowser t={t} />
                  ) : windowId === 'notifications' ? (
                    <NotificationCenter
                      onChatMessage={(item) => {
                        closeWindow('notifications');
                        openProactiveChat(item);
                      }}
                    />
                  ) : windowId === 'reminders' ? (
                    <ReminderPanel t={t} />
                  ) : windowId === 'plans' ? (
                    <ExecutionWorkQueue t={t} />
                  ) : windowId === 'devices' ? (
                    <DeviceSyncCenter t={t} />
                  ) : windowId === 'tokens' ? (
                    <TokenDashboard />
                  ) : windowId === 'skills' ? (
                    <SkillCenter
                      t={t}
                      lang={lang}
                      canUseExternalCapabilities={canUseExternalCapabilities}
                      canReviewExternalCapabilities={Boolean(isTauri && user?.role === 'admin' && workDomain === 'personal')}
                    />
                  ) : windowId === 'personalization' ? (
                    <div className="flex h-full min-h-0 flex-col gap-3">
                      <div className="grid shrink-0 grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-black/20 p-1.5" role="tablist" aria-label={t.personalization || 'Personalization'}>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={personalizationSection === 'appearance'}
                          onClick={() => setPersonalizationSection('appearance')}
                          className={`flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${personalizationSection === 'appearance' ? 'bg-cyan-400/18 text-cyan-100' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/75'}`}
                        >
                          <Brush size={15} />
                          {t.avatarStudio || 'Avatar Studio'}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={personalizationSection === 'voice'}
                          onClick={() => setPersonalizationSection('voice')}
                          className={`flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${personalizationSection === 'voice' ? 'bg-indigo-400/18 text-indigo-100' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/75'}`}
                        >
                          <Volume2 size={15} />
                          {t.sound || 'Sound'}
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {personalizationSection === 'appearance' ? (
                          <AvatarStudio
                            key={petPreferenceScopeKey}
                            t={t}
                            lang={lang}
                            storageScope={petPreferenceScopeKey}
                            selectedPetId={selectedPet?.id}
                            onSelectPet={handleSelectPet}
                            equippedAccessories={equippedAccessories}
                            onChangeAccessories={(ids) => {
                              if (!canCustomizeLumiAppearance) {
                                toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
                                return;
                              }
                              setEquippedAccessories(ids);
                              savePetPrefsToServer(selectedPet, ids);
                            }}
                            onResetToSphere={() => {
                              if (!canCustomizeLumiAppearance) {
                                toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
                                return;
                              }
                              setSelectedPet(null);
                              savePetPrefsToServer(null, equippedAccessories);
                              toast.info(uiMessage('desktop-ui.switched-back-to-the-default.97edb4815a', (lang === 'zh') ? 'zh' : 'en'));
                            }}
                          />
                        ) : (
                          <DesktopPersonalizationSoundPanel
                            t={t}
                            onOpenAppearance={() => setPersonalizationSection('appearance')}
                            onOpenVoiceSettings={() => {
                              setSettingsSection('voice-model');
                              toggleWindow('settings');
                            }}
                          />
                        )}
                      </div>
                    </div>
                  ) : windowId === 'terminal' ? (
                    <TerminalWindow t={t} onClose={() => closeWindow('terminal')} isActive={focusedWindow === 'terminal'} />
                  ) : windowId === 'chat' || windowId === 'command-center' ? (
                    // Chat is now fullscreen overlay — this case should not be reached
                    null
                  ) : renderTabContent(windowId)}
                  </Suspense>
                </div>
              </OSWindow>
            );
          })}
        </AnimatePresence>
      </div>
  );
}
