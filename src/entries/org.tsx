// Org web entry — standalone admin workbench
// Served when LUMI_ROLE=org; no landing page, no ecosystem, no desktop UI
import { StrictMode, lazy, Suspense, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../contexts/AppContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { LoadingFallback } from '../components/LoadingFallback';
import { LoginModal } from '../core/components/Auth';
import { useApp } from '../contexts/AppContext';
import { useT } from '../lib/useT';
import { Toaster } from 'sonner';
import { motion } from 'motion/react';
import { Building2, LogIn } from 'lucide-react';
import '@fontsource-variable/geist';
import '../index.css';

const OrgPortal = lazy(() => import('../components/OrgPortal').then(m => ({ default: m.OrgPortal })));

function OrgShell() {
  const { user, loading, refreshUser } = useApp();
  const t = useT();
  const [showLogin, setShowLogin] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(true);

  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => setIsRefreshing(false), 200);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  if (loading || isRefreshing) {
    return <LoadingFallback />;
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-celestial-deep flex flex-col items-center justify-center gap-8">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-4"
        >
          <Building2 size={48} className="text-celestial-saturn" />
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-celestial-mars to-celestial-saturn">
            {t.orgWorkbench || 'Org Workbench'}
          </h1>
          <p className="text-white/40 text-sm max-w-md text-center">
            {t.orgLoginPrompt || 'Log in to access your organization dashboard, knowledge base, and admin tools.'}
          </p>
        </motion.div>
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          onClick={() => setShowLogin(true)}
          className="px-8 py-3 rounded-2xl bg-gradient-to-r from-celestial-mars to-celestial-saturn text-black font-bold flex items-center gap-2 hover:scale-105 transition-transform"
        >
          <LogIn size={18} />
          {t.signIn || 'Sign In'}
        </motion.button>
        <LoginModal t={t} isOpen={showLogin} onClose={() => setShowLogin(false)} onLoginSuccess={() => refreshUser()} onGoogleLogin={() => {}} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-celestial-deep overflow-hidden">
      <Toaster position="top-right" theme="dark" />
      <Suspense fallback={<LoadingFallback />}>
        <OrgPortal orgOnly />
      </Suspense>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <OrgShell />
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
);
