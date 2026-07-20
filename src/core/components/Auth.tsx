import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Rocket, Sparkles, X, LogIn, UserPlus } from 'lucide-react';
import * as authService from '../../services/authService';

export function LoginRequired({ t, onLogin }: { t: any; onLogin: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-8"
    >
      <div className="w-24 h-24 rounded-3xl bg-celestial-saturn/10 flex items-center justify-center text-celestial-saturn">
        <Sparkles size={48} />
      </div>
      <div className="space-y-2">
        <h2 className="text-3xl font-bold tracking-tighter">{t.loginRequired || 'Authentication Required'}</h2>
        <p className="text-white/40 max-w-md mx-auto">
          {t.loginRequiredDesc || 'Please connect your account to access this module and synchronize your local intelligence.'}
        </p>
      </div>
      <button
        onClick={onLogin}
        className="px-8 py-4 bg-celestial-saturn text-black font-bold rounded-full hover:scale-105 transition-transform flex items-center gap-2"
      >
        <Rocket size={20} />
        {t.connect}
      </button>
    </motion.div>
  );
}

export function LoginModal({ t, isOpen, onClose, onLoginSuccess, onGoogleLogin }: { t: any; isOpen: boolean; onClose: () => void; onLoginSuccess: () => void; onGoogleLogin: () => void }) {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    // Validate username pattern
    const usernameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!usernameRegex.test(username)) {
      setError(t.authValidationUsername || 'Username can only contain letters, numbers, underscores, and hyphens');
      setLoading(false);
      return;
    }
    
    try {
      let result;
      if (isRegister) {
        const phoneRegex = /^\+?[0-9]{5,15}$/;
        if (!phoneRegex.test(phone)) {
          setError(t.invalidPhone || 'Invalid phone number format');
          setLoading(false);
          return;
        }
        result = await authService.register(username, password, phone);
      } else {
        result = await authService.login(username, password);
      }

      if (result.success) {
        onLoginSuccess();
        onClose();
      } else {
        setError(result.error || (isRegister ? (t.registerFailed || 'Registration failed') : (t.loginFailed || 'Login failed')));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-[2rem] border border-white/10 bg-[#111] shadow-2xl"
      >
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-celestial-mars via-celestial-saturn to-celestial-mars" />
        
        <div className="p-8">
          <div className="flex justify-between items-center mb-8">
            <div>
              <h2 className="text-2xl font-black tracking-tighter text-white">
                {isRegister ? t.register || 'Create Node' : t.loginTitle || 'Sync Node'}
              </h2>
              <p className="text-white/40 text-xs font-bold uppercase tracking-widest mt-1">
                {t.authSubtitle || 'Lumi Network Authentication'}
              </p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full text-white/40 hover:text-white transition-colors">
              <X size={20} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-xs font-black uppercase tracking-widest text-white/30 ml-1">{t.username || 'Identifier'}</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/35 focus:outline-none focus:border-celestial-saturn/50 transition-colors"
                placeholder={t.authPlaceholderUsername || 'User_ID_0X1F'}
              />
            </div>

            {isRegister && (
              <div className="space-y-1.5">
                <label className="text-xs font-black uppercase tracking-widest text-white/30 ml-1">{t.phone || 'Communication Line'}</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/35 focus:outline-none focus:border-celestial-saturn/50 transition-colors"
                  placeholder="+86..."
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-black uppercase tracking-widest text-white/30 ml-1">{t.password || 'Access Key'}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/35 focus:outline-none focus:border-celestial-saturn/50 transition-colors"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-xs font-bold flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                {error}
              </div>
            )}

            <div className="flex flex-col gap-4 pt-4">
              <button
                type="submit"
                disabled={loading}
                className={`w-full py-4 rounded-xl font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-lg ${
                  loading ? 'bg-white/10 text-white/20 cursor-not-allowed' : 'bg-white text-black hover:scale-[1.02] active:scale-[0.98]'
                }`}
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                ) : (
                  <>
                    {isRegister ? <UserPlus size={18} /> : <LogIn size={18} />}
                    {isRegister ? t.registerBtn || 'Register Node' : t.loginBtn || 'Initialize Link'}
                  </>
                )}
              </button>

              <div className="flex items-center gap-4 my-2">
                 <div className="h-px flex-1 bg-white/5" />
                 <span className="text-[12px] font-black text-white/20 uppercase tracking-widest">{t.authOrDivider || 'or'}</span>
                 <div className="h-px flex-1 bg-white/5" />
              </div>

              <button
                type="button"
                onClick={onGoogleLogin}
                className="w-full py-4 bg-white/5 border border-white/10 rounded-xl font-black uppercase tracking-widest text-white/80 hover:bg-white/10 transition-all flex items-center justify-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                {t.googleLogin || 'Nexus Google Sign-in'}
              </button>

              <button
                type="button"
                onClick={() => setIsRegister(!isRegister)}
                className="text-xs font-black text-celestial-saturn uppercase tracking-widest hover:underline transition-all mt-2"
              >
                {isRegister ? t.hasAccount || 'Return to Login' : t.noAccount || 'Expand Neural Network'}
              </button>
            </div>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
