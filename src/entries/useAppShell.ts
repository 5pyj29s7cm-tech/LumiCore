import { useState, useEffect } from 'react';
import { setLang, useLocale, useT } from '../lib/useT';
import { useApp } from '../contexts/AppContext';

export function useAppShell() {
  const { user, loading, logout, refreshUser } = useApp();
  const lang = useLocale();
  const t = useT();
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

  useEffect(() => {
    const handler = () => setIsLoginModalOpen(true);
    window.addEventListener('lumi:open-login', handler);
    return () => window.removeEventListener('lumi:open-login', handler);
  }, []);

  return {
    user, loading, lang, setLang, t,
    handleLogin: () => setIsLoginModalOpen(true),
    handleLogout: async () => { await logout(); },
    isLoginModalOpen, setIsLoginModalOpen, refreshUser,
  };
}
