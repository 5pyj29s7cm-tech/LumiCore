import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Building2, ArrowRight, CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { apiFetch } from '../../services/apiClient';
import { uiMessage } from '../../i18n/uiMessages';

export function JoinOrgPage() {
  const t = useT();
  const { refreshUser, switchDomain } = useApp();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'input' | 'preview' | 'joining' | 'done' | 'error'>('input');
  const [orgInfo, setOrgInfo] = useState<any>(null);
  const [error, setError] = useState('');

  const handleValidate = async () => {
    if (code.length < 6) return;
    try {
      const res = await apiFetch(`/api/org/invitations/${code.toUpperCase()}`);
      const data = await res.json();
      if (data.valid) {
        setOrgInfo(data);
        setStep('preview');
      } else {
        setError(data.error || uiMessage('join-org-page.invalid-invitation-code.bf31d88f81'));
        setStep('error');
      }
    } catch {
      setError(uiMessage('join-org-page.unable-to-reach-the-organization.eae15e7512'));
      setStep('error');
    }
  };

  const handleJoin = async () => {
    setStep('joining');
    try {
      const res = await apiFetch(`/api/org/invitations/${code.toUpperCase()}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setStep('done');
        await refreshUser();
        await switchDomain('work');
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org' } }));
        }, 600);
      } else {
        setError(data.error || uiMessage('join-org-page.failed-to-join.ae4588143e'));
        setStep('error');
      }
    } catch {
      setError(uiMessage('join-org-page.connection-failed-please-try-again.5922631739'));
      setStep('error');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-celestial-deep to-black p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8"
      >
        <div className="text-center mb-8">
          <Building2 size={48} className="mx-auto text-blue-400 mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">{t.orgJoin}</h1>
          <p className="text-white/50 text-sm">{t.orgJoinDesc}</p>
        </div>

        {step === 'input' && (
          <div className="space-y-4">
            <input
              type="text"
              value={code}
              onChange={e => { setCode(e.target.value.toUpperCase().slice(0, 8)); setError(''); }}
              placeholder="ABCD1234"
              maxLength={8}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-center text-2xl tracking-[0.3em] font-mono placeholder:text-white/45 focus:outline-none focus:border-blue-500/50"
            />
            {error && (
              <p className="text-red-400 text-sm text-center flex items-center justify-center gap-1">
                <AlertCircle size={14} /> {error}
              </p>
            )}
            <Button
              onClick={handleValidate}
              disabled={code.length < 6}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-xl py-3"
            >
              {uiMessage('join-org-page.validate-code.bb3fb2ed0c')} <ArrowRight size={16} className="ml-2" />
            </Button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org' } }))}
              className="w-full text-center text-white/55 text-sm hover:text-white/50"
            >
              {uiMessage('join-org-page.already-joined-return-to-the.14547e2e0f')}
            </button>
          </div>
        )}

        {step === 'preview' && orgInfo && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 text-center">
              <Building2 size={32} className="mx-auto text-blue-400 mb-2" />
              <h2 className="text-xl font-semibold text-white">{orgInfo.org.name}</h2>
              <p className="text-white/40 text-sm">{uiMessage('join-org-page.role.b9e0249a04')}: {orgInfo.role}</p>
            </div>
            <Button onClick={handleJoin} className="w-full bg-green-600 hover:bg-green-500 text-white rounded-xl py-3">
              {uiMessage('join-org-page.join.95aa690879')} <CheckCircle size={16} className="ml-2" />
            </Button>
            <button onClick={() => setStep('input')} className="w-full text-center text-white/55 text-sm hover:text-white/50">
              {uiMessage('join-org-page.cancel.998b9c48fb')}
            </button>
          </motion.div>
        )}

        {step === 'joining' && (
          <div className="text-center py-8">
            <Loader2 size={40} className="mx-auto animate-spin text-blue-400 mb-4" />
            <p className="text-white/50">{uiMessage('join-org-page.joining-organization.11ce9009cd')}</p>
          </div>
        )}

        {step === 'done' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-8">
            <CheckCircle size={48} className="mx-auto text-green-400 mb-4" />
            <p className="text-white font-semibold">{uiMessage('join-org-page.successfully-joined.2b77f84b17')}</p>
            <p className="text-white/40 text-sm mt-1">{uiMessage('join-org-page.opening-the-organization-workspace.e4707300fc')}</p>
          </motion.div>
        )}

        {step === 'error' && (
          <div className="text-center space-y-4">
            <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
            <p className="text-red-400">{error}</p>
            <Button onClick={() => { setStep('input'); setError(''); }} className="bg-white/10 hover:bg-white/20 text-white rounded-xl">
              {uiMessage('join-org-page.try-again.8dcede9d49')}
            </Button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
