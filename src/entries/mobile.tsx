import { motion } from 'motion/react';
import { Rocket } from 'lucide-react';
import { Toaster } from 'sonner';
import '@fontsource-variable/geist';
import '../index.css';
import { ProactiveNotifications } from '../components/ProactiveNotifications';
import { LoginModal, LoginRequired } from '../core/components/Auth';
import { MobilePlatform } from '../platforms/mobile/MobilePlatform';
import { SkillHall } from '../components/SkillHall';
import { Profile } from '../components/Profile';
import { useAppShell } from './useAppShell';

export function MobileApp() {
  const shell = useAppShell();
  if (shell.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-black">
        <motion.div animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }} transition={{ duration: 2, repeat: Infinity }} className="flex flex-col items-center gap-4">
          <Rocket size={48} className="text-celestial-saturn" />
          <div className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-celestial-mars to-celestial-saturn">Lumi Mobile Preview</div>
        </motion.div>
      </div>
    );
  }

  const renderTabContent = (tab: string) => {
    switch (tab) {
      case 'generate':
        return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <SkillHall t={shell.t} lang={shell.lang} initialTab="generate" />;
      case 'skills':
        return <SkillHall t={shell.t} lang={shell.lang} />;
      case 'profile':
        return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Profile t={shell.t} />;
      default:
        return null;
    }
  };

  return (
    <>
      <ProactiveNotifications />
      <Toaster position="top-right" theme="dark" />
      <MobilePlatform
        t={shell.t}
        user={shell.user}
        lang={shell.lang}
        setLang={shell.setLang}
        onLogin={shell.handleLogin}
        renderTabContent={renderTabContent}
      />
      <LoginModal t={shell.t} isOpen={shell.isLoginModalOpen} onClose={() => shell.setIsLoginModalOpen(false)} onLoginSuccess={() => shell.refreshUser()} onGoogleLogin={shell.handleLogin} />
    </>
  );
}
