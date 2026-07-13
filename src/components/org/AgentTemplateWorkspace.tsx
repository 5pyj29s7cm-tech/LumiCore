import React, { useEffect, useState } from 'react';
import { ClipboardCheck, Package } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useT } from '../../lib/useT';
import { TemplateMarketplace } from './TemplateMarketplace';
import { TemplateReviewQueue } from './TemplateReviewQueue';
import { uiMessage } from '../../i18n/uiMessages';

type TemplateWorkspaceTab = 'marketplace' | 'review';

export function AgentTemplateWorkspace({ initialTab = 'marketplace' }: { initialTab?: TemplateWorkspaceTab }) {
  const { orgConnection } = useApp();
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const canReview = ['owner', 'admin'].includes(String(orgConnection?.orgRole || '').toLowerCase());
  const [tab, setTab] = useState<TemplateWorkspaceTab>(() => initialTab === 'review' && canReview ? 'review' : 'marketplace');

  useEffect(() => {
    setTab(initialTab === 'review' && canReview ? 'review' : 'marketplace');
  }, [canReview, initialTab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.08] bg-black/18 px-5 py-3">
        <button
          type="button"
          onClick={() => setTab('marketplace')}
          className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition ${
            tab === 'marketplace'
              ? 'border-violet-400/25 bg-violet-500/12 text-violet-100'
              : 'border-transparent text-white/45 hover:border-white/10 hover:bg-white/[0.05] hover:text-white/75'
          }`}
        >
          <Package size={15} />
          {uiMessage('agent-template-workspace.marketplace.448b7d9c5d')}
        </button>
        {canReview && (
          <button
            type="button"
            onClick={() => setTab('review')}
            className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition ${
              tab === 'review'
                ? 'border-amber-400/25 bg-amber-500/12 text-amber-100'
                : 'border-transparent text-white/45 hover:border-white/10 hover:bg-white/[0.05] hover:text-white/75'
            }`}
          >
            <ClipboardCheck size={15} />
            {uiMessage('agent-template-workspace.review-queue.576f13eaa1')}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'review' && canReview ? <TemplateReviewQueue /> : <TemplateMarketplace />}
      </div>
    </div>
  );
}
