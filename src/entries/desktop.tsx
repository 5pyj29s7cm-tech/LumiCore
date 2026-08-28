// Desktop entry — fullscreen transparent Tauri WebView2 OS shell
import { lazy, Suspense, useEffect, useState } from 'react';
import { ProactiveNotifications } from '../components/ProactiveNotifications';
import { LoginModal } from '../core/components/Auth';
import { Toaster } from 'sonner';
import { motion } from 'motion/react';
import { installApiBridge } from '../services/apiBridge';
import '@fontsource-variable/geist';
import '../index.css';
import { DesktopUI } from '../components/DesktopUI';
import { LoginRequired } from '../core/components/Auth';
import { useAppShell } from './useAppShell';
import { useApp } from '../contexts/AppContext';
import { StartupSequence } from '../components/StartupSequence';
import { initializeSharedSocketRuntime } from '../hooks/useSocket';

installApiBridge();
initializeSharedSocketRuntime();

const SETUP_DONE_KEY = 'lumi_setup_complete';
const Docs = lazy(() => import('../components/Docs').then(m => ({ default: m.Docs })));
const FoundersSanctuary = lazy(() => import('../components/FoundersSanctuary').then(m => ({ default: m.FoundersSanctuary })));
const OrgPortal = lazy(() => import('../components/OrgPortal').then(m => ({ default: m.OrgPortal })));
const Profile = lazy(() => import('../components/Profile').then(m => ({ default: m.Profile })));
const Settings = lazy(() => import('../components/Settings').then(m => ({ default: m.Settings })));
const SetupWizard = lazy(() => import('../components/SetupWizard').then(m => ({ default: m.SetupWizard })));
const SkillHall = lazy(() => import('../components/SkillHall').then(m => ({ default: m.SkillHall })));

export function DesktopApp() {
  const shell = useAppShell();
  const { resolvedAppearanceMode } = useApp();
  const [activeTab, setActiveTab] = useState('home');
  const [showSetup, setShowSetup] = useState(() => localStorage.getItem(SETUP_DONE_KEY) !== '1');
  const [startupVisible, setStartupVisible] = useState(true);

  useEffect(() => { document.body.classList.add('overflow-hidden'); return () => document.body.classList.remove('overflow-hidden'); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [activeTab]);
  useEffect(() => {
    if (shell.loading) return;
    const timer = window.setTimeout(() => setStartupVisible(false), 320);
    return () => window.clearTimeout(timer);
  }, [shell.loading]);

  if (shell.loading || startupVisible) return <StartupSequence ready={!shell.loading} />;

  const renderTabContent = (tab: string) => {
    switch (tab) {
      case 'home': return null;
      case 'ecosystem': return <Suspense fallback={null}><SkillHall t={shell.t} lang={shell.lang} /></Suspense>;
      case 'generate': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Suspense fallback={null}><SkillHall t={shell.t} lang={shell.lang} initialTab="generate" /></Suspense>;
      case 'docs': return <Suspense fallback={null}><Docs t={shell.t} /></Suspense>;
      case 'founders': return <Suspense fallback={null}><FoundersSanctuary t={shell.t} user={shell.user} onBack={() => setActiveTab('home')} /></Suspense>;
      case 'profile': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Suspense fallback={null}><Profile t={shell.t} /></Suspense>;
      case 'org': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Suspense fallback={null}><OrgPortal /></Suspense>;
      case 'settings': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Suspense fallback={null}><Settings t={shell.t} lang={shell.lang} setLang={shell.setLang} /></Suspense>;
      case 'voice': case 'memory': case 'mcp': case 'personality': case 'sync':
        return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Suspense fallback={null}><Settings t={shell.t} lang={shell.lang} setLang={shell.setLang} activeSection={tab} /></Suspense>;
      default: return null;
    }
  };

  return (
    <div className="lumi-desktop-root h-screen w-full bg-transparent overflow-hidden">
      <ProactiveNotifications />
      <Toaster position="top-right" theme={resolvedAppearanceMode} />
      {showSetup ? (
        <div className="h-full w-full overflow-y-auto bg-black/80 p-4 sm:p-8">
          <div className="flex min-h-full w-full items-center justify-center py-2">
            <Suspense fallback={null}>
              <SetupWizard onFinish={() => { setShowSetup(false); localStorage.setItem(SETUP_DONE_KEY, '1'); }} />
            </Suspense>
          </div>
        </div>
      ) : (
        <>
          <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.5 }} className="h-full w-full">
            <DesktopUI t={shell.t} user={shell.user} lang={shell.lang} setLang={shell.setLang} activeTab={activeTab} setActiveTab={setActiveTab}
              onLogin={shell.handleLogin} renderTabContent={renderTabContent} />
          </motion.div>
          <LoginModal t={shell.t} isOpen={shell.isLoginModalOpen} onClose={() => shell.setIsLoginModalOpen(false)} onLoginSuccess={() => shell.refreshUser()} onGoogleLogin={shell.handleLogin} />
        </>
      )}
    </div>
  );
}
