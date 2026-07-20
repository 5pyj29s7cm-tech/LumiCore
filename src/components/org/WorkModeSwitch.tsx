import { useState } from 'react';
import { Building2, Loader2, User } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import type { DomainSwitchResult } from '../../contexts/AppContext';
import { uiMessage } from '../../i18n/uiMessages';

interface Props {
  domain: 'personal' | 'work';
  onSelectDomain: (domain: 'personal' | 'work') => Promise<DomainSwitchResult>;
  onOpenOrganization: () => void;
  onCloseOrganization?: () => void;
  organizationOpen?: boolean;
  connected: boolean;
}

export function WorkModeSwitch({
  domain,
  onSelectDomain,
  onOpenOrganization,
  onCloseOrganization,
  organizationOpen = false,
  connected,
}: Props) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [switching, setSwitching] = useState(false);
  const isWork = domain === 'work';

  const reportResult = (result: DomainSwitchResult, target: 'personal' | 'work') => {
    if (result?.success) {
      toast.success(result.message || (target === 'work'
        ? uiMessage('work-mode-switch.entered-organization.4ca4829204')
        : uiMessage('work-mode-switch.switched-to-personal.378022176b')));
    } else {
      toast.error(result?.message || uiMessage('work-mode-switch.mode-switch-failed.ff1179bd78'));
    }
  };

  const handlePersonal = async () => {
    if (switching) return;
    if (domain === 'personal') {
      onCloseOrganization?.();
      return;
    }
    setSwitching(true);
    try {
      const result = await onSelectDomain('personal');
      reportResult(result, 'personal');
      if (result?.success) onCloseOrganization?.();
    } catch (err: any) {
      toast.error(err.message || uiMessage('work-mode-switch.mode-switch-failed.ff1179bd78'));
    } finally {
      setSwitching(false);
    }
  };

  const handleOrganization = async () => {
    if (switching) return;
    if (!connected) {
      onOpenOrganization();
      return;
    }
    if (domain === 'work') {
      onOpenOrganization();
      return;
    }
    setSwitching(true);
    try {
      const result = await onSelectDomain('work');
      reportResult(result, 'work');
      if (result?.success) onOpenOrganization();
    } catch (err: any) {
      toast.error(err.message || uiMessage('work-mode-switch.mode-switch-failed.ff1179bd78'));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className={`lumi-work-mode-switch flex h-8 items-center rounded-full border border-white/10 bg-black/20 p-0.5 text-[11px] font-black uppercase tracking-widest ${switching ? 'opacity-75' : ''}`}>
      <button
        type="button"
        onClick={handlePersonal}
        disabled={switching}
        title={uiMessage('work-mode-switch.switch-to-personal.fbe06c3447')}
        className={`flex h-7 min-w-[78px] items-center justify-center gap-1.5 rounded-full px-3 transition-all ${
          !isWork && !organizationOpen
            ? 'bg-white/12 text-white shadow-[0_0_18px_rgba(255,255,255,0.08)]'
            : 'text-white/45 hover:bg-white/8 hover:text-white/75'
        } disabled:cursor-wait`}
      >
        <User size={13} />
        <span className="lumi-work-mode-label">{uiMessage('work-mode-switch.personal.d3eb901f5d')}</span>
      </button>
      <button
        type="button"
        onClick={handleOrganization}
        disabled={switching}
        title={connected ? uiMessage('work-mode-switch.open-organization.2fb9a9e9af') : uiMessage('work-mode-switch.create-organization.0cada00795')}
        className={`flex h-7 min-w-[82px] items-center justify-center gap-1.5 rounded-full px-3 transition-all ${
          isWork || organizationOpen
            ? 'border border-blue-400/25 bg-blue-500/18 text-blue-100 shadow-[0_0_18px_rgba(59,130,246,0.16)]'
            : 'text-white/45 hover:bg-white/8 hover:text-white/75'
        } disabled:cursor-wait`}
      >
        {switching ? <Loader2 size={13} className="animate-spin" /> : <Building2 size={13} />}
        <span className="lumi-work-mode-label">{uiMessage('work-mode-switch.organization.86b86ee61b')}</span>
      </button>
    </div>
  );
}
