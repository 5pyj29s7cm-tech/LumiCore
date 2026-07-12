import React, { useEffect, useState } from 'react';
import { GitBranch, Settings } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useT } from '../../lib/useT';
import { OrgBranchPanel } from '../OrgBranchPanel';
import { OrgSettings } from './OrgSettings';

type OrganizationSettingsTab = 'general' | 'branch';

export function OrganizationSettingsWorkspace({ initialTab = 'general' }: { initialTab?: OrganizationSettingsTab }) {
  const { orgConnection } = useApp();
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const canManage = ['owner', 'admin'].includes(String(orgConnection?.orgRole || '').toLowerCase());
  const [tab, setTab] = useState<OrganizationSettingsTab>(() => initialTab === 'general' && !canManage ? 'branch' : initialTab);

  useEffect(() => {
    setTab(initialTab === 'general' && !canManage ? 'branch' : initialTab);
  }, [canManage, initialTab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.08] bg-black/18 px-5 py-3">
        {canManage && (
          <button
            type="button"
            onClick={() => setTab('general')}
            className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition ${
              tab === 'general'
                ? 'border-blue-400/25 bg-blue-500/12 text-blue-100'
                : 'border-transparent text-white/45 hover:border-white/10 hover:bg-white/[0.05] hover:text-white/75'
            }`}
          >
            <Settings size={15} />
            {ui('组织配置', 'Organization')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setTab('branch')}
          className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition ${
            tab === 'branch'
              ? 'border-cyan-400/25 bg-cyan-500/12 text-cyan-100'
              : 'border-transparent text-white/45 hover:border-white/10 hover:bg-white/[0.05] hover:text-white/75'
          }`}
        >
          <GitBranch size={15} />
          {ui('分支连接', 'Branch Connection')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        {tab === 'general' && canManage ? <OrgSettings /> : <OrgBranchPanel />}
      </div>
    </div>
  );
}
