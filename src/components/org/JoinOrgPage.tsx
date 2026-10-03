import { useState } from 'react';
import { motion } from 'motion/react';
import { Building2, ArrowRight, CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { apiJson } from '../../services/apiClient';
import { useAsyncOperation } from '../../hooks/useAsyncOperation';
import { uiMessage } from '../../i18n/uiMessages';

export function JoinOrgPage() {
  const { user } = useApp();
  return user ? <JoinForm key={JSON.stringify([user.uid, user.role])} /> : null;
}
function JoinForm() {
  const t = useT(), { switchDomain } = useApp();
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'input' | 'preview' | 'done'>('input');
  const [orgInfo, setOrgInfo] = useState<{ code: string; org: { id: string; name: string }; role: string } | null>(null);
  const [joinedOrgId, setJoinedOrgId] = useState('');
  const { busy, error, run, cancel } = useAsyncOperation();
  const handleValidate = () => code.length >= 6 && run('validate', async signal => {
    const validatedCode = code.trim().toUpperCase();
    const data = await apiJson('/api/org/invitations/' + encodeURIComponent(validatedCode), { signal });
    if (data?.valid !== true || typeof data.org?.id !== 'string' || !data.org.id || typeof data.org.name !== 'string'
      || !['owner', 'admin', 'member', 'viewer'].includes(data.role)) throw new Error(uiMessage('join-org-page.invalid-invitation-code.bf31d88f81'));
    return () => { setOrgInfo({ org: { id: data.org.id, name: data.org.name }, role: data.role, code: validatedCode }); setJoinedOrgId(''); setStep('preview'); };
  });
  const handleJoin = () => orgInfo && run('join', async signal => {
    if (joinedOrgId !== orgInfo.org.id) {
      const data = await apiJson('/api/org/invitations/' + encodeURIComponent(orgInfo.code) + '/accept', { method: 'POST', signal });
      signal.throwIfAborted();
      if (data?.success !== true || data.orgId !== orgInfo.org.id) throw new Error(uiMessage('join-org-page.failed-to-join.ae4588143e'));
      setJoinedOrgId(data.orgId);
    }
    const result = await switchDomain('work', { orgId: orgInfo.org.id, orgName: orgInfo.org.name, signal });
    if (!result.success || result.connection?.orgId !== orgInfo.org.id) throw new Error(result.message || uiMessage('join-org-page.failed-to-join.ae4588143e'));
    return () => {
      setStep('done');
      window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org' } }));
    };
  });


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

        {error && <p role="alert" className="mb-4 text-red-400 text-sm text-center"><AlertCircle size={14} className="inline mr-1" />{error}</p>}

        {step === 'input' && (
          <div className="space-y-4">
            <input
              type="text"
              value={code}
              onChange={e => { cancel(); setCode(e.target.value.toUpperCase().slice(0, 8)); }}
              disabled={Boolean(busy)}
              placeholder="ABCD1234"
              maxLength={8}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-center text-2xl tracking-[0.3em] font-mono placeholder:text-white/45 focus:outline-none focus:border-blue-500/50"
            />
            <Button
              onClick={handleValidate}
              disabled={code.length < 6 || Boolean(busy)}
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
            <Button onClick={handleJoin} disabled={Boolean(busy)} className="w-full bg-green-600 hover:bg-green-500 text-white rounded-xl py-3">
              {uiMessage(joinedOrgId ? 'join-org-page.already-joined-return-to-the.14547e2e0f' : 'join-org-page.join.95aa690879')} {busy ? <Loader2 size={16} className="ml-2 animate-spin" /> : <CheckCircle size={16} className="ml-2" />}
            </Button>
            <button disabled={Boolean(busy)} onClick={() => { cancel(); setStep('input'); setOrgInfo(null); }} className="w-full text-center text-white/55 text-sm hover:text-white/50">
              {uiMessage('join-org-page.cancel.998b9c48fb')}
            </button>
          </motion.div>
        )}

        {step === 'done' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-8">
            <CheckCircle size={48} className="mx-auto text-green-400 mb-4" />
            <p className="text-white font-semibold">{uiMessage('join-org-page.successfully-joined.2b77f84b17')}</p>
            <p className="text-white/40 text-sm mt-1">{uiMessage('join-org-page.opening-the-organization-workspace.e4707300fc')}</p>
          </motion.div>
        )}

      </motion.div>
    </div>
  );
}
