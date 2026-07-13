import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, FileText, HelpCircle, Loader2, Shield, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '../../contexts/AppContext';
import { useT } from '../../lib/useT';
import type { LegalCaseFile } from '../../lib/legalCaseStore';
import { LegalCaseContextBar } from './LegalCaseContextBar';
import { uiMessage } from '../../i18n/uiMessages';
import {
  chinaLegalCopy,
  parseChinaContractRisks,
  type ChinaContractRisk,
} from '../../i18n/regions/cn/legal';

type RiskItem = ChinaContractRisk;

export function LegalContractReview({ caseFile }: { caseFile?: LegalCaseFile | null }) {
  const t = useT();
  const { workDomain, orgConnection } = useApp();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultContract = useMemo(() => (
    (caseFile?.materials || []).find(material => material.type === 'contract' && material.content)?.content || ''
  ), [caseFile]);
  const [contract, setContract] = useState(defaultContract);
  const [result, setResult] = useState('');
  const [risks, setRisks] = useState<RiskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedRisk, setSelectedRisk] = useState<RiskItem | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setContract(defaultContract);
    setResult('');
    setRisks([]);
    setSelectedRisk(null);
  }, [caseFile?.id]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach(file => formData.append('files', file));
      const res = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('legal-contract-review.file-upload-parsing-failed.2381d47571'));
      const text = (data.files || [])
        .map((file: any) => String(file.content || file.preview || '').trim())
        .filter(Boolean)
        .join('\n\n');
      if (!text) throw new Error(uiMessage('legal-contract-review.no-reviewable-text-extracted.a5b8b434b8'));
      setContract(prev => [prev, text].filter(Boolean).join('\n\n'));
      toast.success(uiMessage('legal-contract-review.file-parsed-into-contract-text.c0159991c0'));
    } catch (err: any) {
      const message = err?.message || uiMessage('legal-contract-review.file-upload-parsing-failed.2381d47571');
      setResult(`${uiMessage('legal-contract-review.error.1d47687da7')}: ${message}`);
      toast.error(message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const review = async () => {
    if (!contract.trim() || loading) return;
    setLoading(true);
    setResult('');
    setRisks([]);
    setSelectedRisk(null);
    try {
      const res = await fetch('/api/legal/contract-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract: contract.slice(0, 10000),
          domain: workDomain,
          orgId: workDomain === 'work' && orgConnection?.orgId ? orgConnection.orgId : undefined,
          caseId: caseFile?.id,
          caseName: caseFile ? (caseFile.title || caseFile.party || caseFile.caseNumber || undefined) : undefined,
          caseType: caseFile?.cause || chinaLegalCopy('zh').contractReviewCaseType,
          court: caseFile?.court,
          persistCase: Boolean(caseFile),
        }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('legal-contract-review.contract-review-failed.05af7a7d1f'));
      const text = data.text || data.response || data.reply || data.message || '';
      const parsedRisks = parseChinaContractRisks(text);
      setResult(text);
      setRisks(parsedRisks);
      setSelectedRisk(parsedRisks[0] || null);
      if (caseFile?.id) {
        window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed', {
          detail: { caseId: caseFile.id, toolName: 'legal_review_contract' },
        }));
      }
    } catch (e: any) {
      setResult(`${uiMessage('legal-contract-review.error.1d47687da7')}: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-blue-400/20 bg-blue-500/10 text-blue-300">
              <Shield size={22} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-white">{t.legalContractReviewTitle || uiMessage('legal-contract-review.contract-review.d4cc309459')}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">
                {t.legalContractReviewDesc || uiMessage('legal-contract-review.review-clause-risks-legal-basis.84a59ad01a')}
              </p>
            </div>
          </div>
        </section>

        <LegalCaseContextBar
          caseFile={caseFile}
          state={loading ? 'running' : result ? 'result' : 'input'}
          detail={uiMessage('legal-contract-review.existing-case-contracts-are-prefilled.7b8235f485')}
        />

        <section className="grid min-h-[560px] gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="inline-flex items-center gap-2 text-sm font-medium text-white">
                <FileText size={16} className="text-blue-300" />
                {uiMessage('legal-contract-review.contract-text.c30d0eba56')}
              </h3>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || loading}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {uiMessage('legal-contract-review.upload.b6fb916ac9')}
              </button>
              <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" onChange={handleFileUpload} className="hidden" />
            </div>
            <textarea
              value={contract}
              onChange={event => setContract(event.target.value)}
              placeholder={t.legalContractReviewPlaceholder || uiMessage('legal-contract-review.paste-contract-text-or-upload.3dbd66ea5b')}
              className="min-h-[420px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 font-mono text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-blue-400/35"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-white/40">{uiMessage('legal-contract-review.the-first-10-000-characters.9326837798')}</p>
              <button
                onClick={review}
                disabled={loading || !contract.trim()}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2.5 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Shield size={16} />}
                {t.legalContractReviewReview || uiMessage('legal-contract-review.review.e3dfc24f76')}
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-4">
            <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
              <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-white">
                <AlertTriangle size={16} className="text-amber-300" />
                {t.legalContractReviewRisks || uiMessage('legal-contract-review.risk-items.8ca8515682')} ({risks.length})
              </h3>
              {risks.length === 0 ? (
                <div className="flex h-36 flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <AlertCircle size={26} className="text-white/20" />
                  <span>{uiMessage('legal-contract-review.risk-items-appear-here-after.28ad75a4ab')}</span>
                </div>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto custom-scrollbar">
                  {risks.map((risk, index) => {
                    const meta = riskLevelMeta(risk.level, ui);
                    return (
                      <button
                        key={`${risk.level}-${index}`}
                        onClick={() => setSelectedRisk(risk)}
                        className={`w-full rounded-lg border p-3 text-left transition ${meta.panelClass} ${
                          selectedRisk === risk ? 'ring-1 ring-white/20' : 'hover:ring-1 hover:ring-white/10'
                        }`}
                      >
                        <div className="mb-1 flex items-center gap-2">
                          {meta.icon}
                          <span className={`text-xs font-medium ${meta.textClass}`}>{meta.label}</span>
                        </div>
                        <p className="truncate text-sm text-white/80">{risk.clause}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="min-h-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] p-4">
              {selectedRisk ? (
                <div className="space-y-3">
                  <RiskBadge level={selectedRisk.level} ui={ui} />
                  <div>
                    <p className="mb-1 text-xs text-white/40">{uiMessage('legal-contract-review.clause-issue.1a1690d0c3')}</p>
                    <p className="text-sm leading-6 text-white/80">{selectedRisk.clause}</p>
                  </div>
                  {selectedRisk.reason && (
                    <div>
                      <p className="mb-1 text-xs text-white/40">{uiMessage('legal-contract-review.reason.08ee62c029')}</p>
                      <p className="text-sm leading-6 text-white/65">{selectedRisk.reason}</p>
                    </div>
                  )}
                  {selectedRisk.statuteRef && (
                    <div>
                      <p className="mb-1 text-xs text-white/40">{uiMessage('legal-contract-review.legal-basis.3712aebaaf')}</p>
                      <p className="text-sm leading-6 text-white/65">{selectedRisk.statuteRef}</p>
                    </div>
                  )}
                  {selectedRisk.suggestion && (
                    <div>
                      <p className="mb-1 text-xs text-white/40">{uiMessage('legal-contract-review.suggestion.9b6c2da3ca')}</p>
                      <p className="text-sm leading-6 text-emerald-200/80">{selectedRisk.suggestion}</p>
                    </div>
                  )}
                </div>
              ) : result ? (
                <div className="h-full overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/15 p-3 text-sm leading-7 text-white/72 custom-scrollbar">
                  {result}
                </div>
              ) : (
                <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <FileText size={30} className="text-white/20" />
                  <span>{uiMessage('legal-contract-review.review-results-will-appear-here.df0e833747')}</span>
                </div>
              )}
            </section>
          </div>
        </section>
      </div>
    </div>
  );
}

function RiskBadge({ level, ui }: { level: RiskItem['level']; ui: (zh: string, en: string) => string }) {
  const meta = riskLevelMeta(level, ui);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${meta.panelClass} ${meta.textClass}`}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

function riskLevelMeta(level: RiskItem['level'], ui: (zh: string, en: string) => string) {
  const map = {
    high: {
      icon: <AlertTriangle size={14} className="text-red-300" />,
      textClass: 'text-red-200',
      panelClass: 'border-red-400/20 bg-red-500/10',
      label: uiMessage('legal-contract-review.high-risk.63340f60da'),
    },
    medium: {
      icon: <HelpCircle size={14} className="text-amber-300" />,
      textClass: 'text-amber-200',
      panelClass: 'border-amber-400/20 bg-amber-500/10',
      label: uiMessage('legal-contract-review.medium-risk.a87f13c2ef'),
    },
    low: {
      icon: <Check size={14} className="text-emerald-300" />,
      textClass: 'text-emerald-200',
      panelClass: 'border-emerald-400/20 bg-emerald-500/10',
      label: uiMessage('legal-contract-review.low-risk.682385645d'),
    },
  };
  return map[level];
}
