import { useCallback, useEffect, useRef, useState } from 'react';
import { EcommerceHub, type EcommerceWorkbenchDraft } from './EcommerceHub';
import { businessRecoveryCopy } from '../i18n/locales/businessRecovery';
import { apiJson } from '../services/apiClient';
import { readIndustryWorkflowPage, readIndustryWorkflow, type IndustryWorkflowTaskRef } from '../lib/industryWorkflowClient';
import type { EcommerceReportKind, EcommerceWorkbenchSnapshot } from '../../shared/ecommerce_workbench';

export function EcommerceDraftRecovery({ draft, onDraftChange, workspaceId = '', lang, initialReportKind, onSnapshotChange }: {
  draft?: EcommerceWorkbenchDraft; onDraftChange?: (draft: EcommerceWorkbenchDraft) => void; workspaceId?: string; lang: 'zh' | 'en'; initialReportKind: EcommerceReportKind;
  onSnapshotChange?: (snapshot: EcommerceWorkbenchSnapshot | null) => void;
}) {
  const c = businessRecoveryCopy(lang), current = useRef(draft);
  const [restored, setRestored] = useState({ draft, revision: 0 }), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [archives, setArchives] = useState<IndustryWorkflowTaskRef[]>([]);
  const [cursor, setCursor] = useState('');
  const owner = useRef<AbortController | null>(null), pending = useRef(false);
  useEffect(() => { const controller = new AbortController(); owner.current = controller; return () => controller.abort(); }, []);
  const accept = useCallback((value: EcommerceWorkbenchDraft) => { current.current = value; onDraftChange?.(value); }, [onDraftChange]);
  const operation = async (fn: (signal: AbortSignal) => Promise<() => void>) => {
    const controller = owner.current; if (!controller || controller.signal.aborted || pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    try { const commit = await fn(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])); if (!controller.signal.aborted) commit(); }
    catch (error) { if (!controller.signal.aborted) setMessage(String(error)); }
    finally { if (!controller.signal.aborted) { setBusy(false); pending.current = false; } }
  };
  const path = '/api/business/drafts/ecommerce/' + encodeURIComponent(workspaceId || '_unbound');
  const restore = (value: EcommerceWorkbenchDraft) => { accept(value); setRestored(current => ({draft:value,revision:current.revision+1})); };
  return <div className="space-y-3"><div className="space-x-3 p-4">
    <button disabled={busy} onClick={() => void operation(async signal => { const data = await apiJson(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:current.current}),signal}); if(data?.persisted !== true) throw new Error('Draft persistence was not confirmed'); return () => setMessage(c.saved); })}>{c.saveDraft}</button>
    <button disabled={busy} onClick={() => void operation(async signal => { const data = await apiJson(path,{signal}); return () => data?.record?.draft ? restore(data.record.draft) : setMessage(c.noDraft); })}>{c.loadDraft}</button>
    <button disabled={busy} onClick={() => void operation(async signal => { const page = await readIndustryWorkflowPage('store-data',workspaceId,'',signal); return () => { setArchives(page.tasks.filter(task => task.metadata?.industryWorkflow?.originalReports)); setCursor(page.nextCursor || ''); }; })}>{c.archives}</button>
    {cursor && <button disabled={busy} onClick={() => void operation(async signal => { const page = await readIndustryWorkflowPage('store-data',workspaceId,cursor,signal); return () => { setArchives(current=>[...current,...page.tasks.filter(task => task.metadata?.industryWorkflow?.originalReports && !current.some(item=>item.id===task.id))]); setCursor(page.nextCursor || ''); }; })}>{c.more}</button>}
    {message && <p role="status">{message}</p>}
    {archives.map(task => <button key={task.id} disabled={busy} onClick={() => void operation(async signal => {
      const detail = await readIndustryWorkflow(task.id,signal), meta=detail.metadata?.industryWorkflow;
      if(meta?.entryId !== 'store-data' || (meta.context?.industryWorkspace?.id || '') !== workspaceId || !meta.originalReports) throw new Error('Archive does not match this workspace');
      const summary=meta.normalizedInputSummary || {}, value: EcommerceWorkbenchDraft={sources:Object.fromEntries(Object.entries(meta.originalReports).map(([kind,table])=>[kind,{table,name:summary.sources?.find((source: any)=>source.kind===kind)?.sourceName || kind,mapping:meta.originalColumnMappings?.[kind] || {}}])) as EcommerceWorkbenchDraft['sources'],selectedPlatform:summary.platform || 'generic',grossMarginPercent:summary.assumptions?.grossMarginPercent ?? 35,targetStockDays:summary.assumptions?.targetStockDays ?? 30,pasteValue:'',archiveTaskId:task.id};
      return () => restore(value);
    })}>{c.restoreArchive}: {task.title || task.id}</button>)}
  </div><EcommerceHub key={restored.revision} draft={restored.draft} onDraftChange={accept} lang={lang} initialReportKind={initialReportKind} workflowEntryId="store-data" onSnapshotChange={onSnapshotChange}/></div>;
}
