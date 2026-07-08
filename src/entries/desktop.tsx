// Desktop entry — fullscreen transparent Tauri WebView2 OS shell
import { lazy, Suspense, useEffect, useState } from 'react';
import { ProactiveNotifications } from '../components/ProactiveNotifications';
import { LoginModal } from '../core/components/Auth';
import { Toaster } from 'sonner';
import { motion } from 'motion/react';
import { Rocket } from 'lucide-react';
import { installApiBridge } from '../services/apiBridge';
import '@fontsource-variable/geist';
import '../index.css';
import { DesktopUI } from '../components/DesktopUI';
import { LoginRequired } from '../core/components/Auth';
import { useAppShell } from './useAppShell';
import { useApp } from '../contexts/AppContext';

installApiBridge();

const SETUP_DONE_KEY = 'lumi_setup_complete';
const AgentChatPage = lazy(() => import('../components/AgentChatPage').then(m => ({ default: m.AgentChatPage })));
const Docs = lazy(() => import('../components/Docs').then(m => ({ default: m.Docs })));
const FoundersSanctuary = lazy(() => import('../components/FoundersSanctuary').then(m => ({ default: m.FoundersSanctuary })));
const LumiEcosystem = lazy(() => import('../components/LumiEcosystem').then(m => ({ default: m.LumiEcosystem })));
const OrgPortal = lazy(() => import('../components/OrgPortal').then(m => ({ default: m.OrgPortal })));
const Profile = lazy(() => import('../components/Profile').then(m => ({ default: m.Profile })));
const Settings = lazy(() => import('../components/Settings').then(m => ({ default: m.Settings })));
const SetupWizard = lazy(() => import('../components/SetupWizard').then(m => ({ default: m.SetupWizard })));
const SkillHall = lazy(() => import('../components/SkillHall').then(m => ({ default: m.SkillHall })));

export function DesktopApp() {
  const shell = useAppShell();
  const { resolvedAppearanceMode } = useApp();
  const [activeTab, setActiveTab] = useState('home');
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [showSetup, setShowSetup] = useState(() => localStorage.getItem(SETUP_DONE_KEY) !== '1');

  useEffect(() => { document.body.classList.add('overflow-hidden'); return () => document.body.classList.remove('overflow-hidden'); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [activeTab]);

  if (shell.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-transparent">
        <motion.div animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }} transition={{ duration: 2, repeat: Infinity }} className="flex flex-col items-center gap-4">
          <Rocket size={48} className="text-celestial-saturn" />
          <div className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-celestial-mars to-celestial-saturn">Lumi OS Booting...</div>
        </motion.div>
      </div>
    );
  }

  const renderTabContent = (tab: string) => {
    switch (tab) {
      case 'home': return null;
      case 'ecosystem': return <Suspense fallback={null}><div className="space-y-24"><LumiEcosystem t={shell.t} onChatAgent={(a: any) => { setSelectedAgent(a); setActiveTab('agent-chat'); }} /><SkillHall t={shell.t} lang={shell.lang} /></div></Suspense>;
      case 'generate': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Suspense fallback={null}><SkillHall t={shell.t} lang={shell.lang} initialTab="generate" /></Suspense>;
      case 'agent-chat': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Suspense fallback={null}><AgentChatPage t={shell.t} user={shell.user} agent={selectedAgent} isOpen={true} onClose={() => setActiveTab('ecosystem')} /></Suspense>;
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
    <div className="h-screen w-full bg-transparent overflow-hidden">
      <ProactiveNotifications />
      <Toaster position="top-right" theme={resolvedAppearanceMode} />
      {showSetup ? (
        <div className="h-full w-full flex items-center justify-center bg-black/80 p-8">
          <Suspense fallback={null}>
            <SetupWizard onFinish={() => { setShowSetup(false); localStorage.setItem(SETUP_DONE_KEY, '1'); }} />
          </Suspense>
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
