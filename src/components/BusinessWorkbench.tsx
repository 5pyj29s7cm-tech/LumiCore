import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Archive, BriefcaseBusiness, RefreshCw } from 'lucide-react';
import { businessWorkbenchCopy } from '../i18n/locales/businessWorkbench';
import { getDesktopSessionProof } from '../services/authService';
import type { EcommerceOutcomeId } from '../i18n/locales/ecommerceModules';
import type { EcommerceWorkbenchSnapshot } from '../../shared/ecommerce_workbench';
import { makeChatArtifact, chatArtifactKind, type ChatArtifact } from '../../shared/chat_artifacts';
import { ChatArtifactCards } from './ChatArtifactCards';
import { ChatFilePreview, type ChatPreviewFile } from './ChatFilePreview';
const Commerce = lazy(() => import('./EcommerceAutomationWorkspace').then(m => ({ default: m.EcommerceAutomationWorkspace })));
const Finance = lazy(() => import('./FinanceWorkbench').then(m => ({ default: m.FinanceWorkbench })));
type Line = 'ecommerce' | 'finance';
type Subject = { id: string; productLine: Line; name: string; attributes: Record<string, string> };
export function BusinessWorkbench({ lang, domain, onOpenSettings, onOpenKnowledge, onOpenSkills }: {
  lang: string; domain: 'personal' | 'work'; onOpenSettings: () => void; onOpenKnowledge: () => void; onOpenSkills: () => void;
}) {
  const locale = lang === 'en' ? 'en' : 'zh'; const c = businessWorkbenchCopy[locale];
  const [tab, setTab] = useState<Line | 'archive'>('ecommerce');
  const [commerceEntry, setCommerceEntry] = useState<EcommerceOutcomeId>('store-data');
  const [financeEntry, setFinanceEntry] = useState('business-dashboard');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [active, setActive] = useState<Partial<Record<Line, Subject>>>({});
  const [name, setName] = useState(''); const [period, setPeriod] = useState('');
  const [currency, setCurrency] = useState('CNY'); const [entityId, setEntityId] = useState('');
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [tasks, setTasks] = useState<any[]>([]);
  const [legacy, setLegacy] = useState<any[]>([]);
  const [legacyTasks, setLegacyTasks] = useState<Record<string, any[]>>({});
  const [legacyFiles, setLegacyFiles] = useState<Partial<Record<Line, ChatArtifact[]>>>({});
  const [preview, setPreview] = useState<ChatPreviewFile | null>(null);
  const [snapshot, setSnapshot] = useState<EcommerceWorkbenchSnapshot | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const responses = await Promise.all(['/api/business/workspaces', '/api/industry/workflows', '/api/business/legacy'].map(url => fetch(url, { credentials: 'include', signal }).then(async r => {
      const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data;
    })));
    if (signal?.aborted) return;
    setSubjects(responses[0].items); setActive(responses[0].active); setTasks(responses[1].tasks); setLegacy(responses[2].items); setError('');
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); }); return () => controller.abort(); }, [load, tab, domain]);
  const bind = async (id?: string) => {
    if (tab === 'archive' || saving) return;
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/business/workspaces', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id ? { id } : { productLine: tab, name, attributes: { currency, ...(tab === 'ecommerce' ? { reportingPeriod: period, entityId } : { accountingPeriod: period, entityName: name }) } }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setName(''); setSnapshot(null); await load();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  const legacyAction = async (line: Line, importing: boolean) => {
    setSaving(true);
    try {
      const r = await fetch(`/api/business/legacy/${line}${importing ? '/import' : ''}`, { method: importing ? 'POST' : 'GET', credentials: 'include', headers: importing ? { 'x-lumi-desktop-session': getDesktopSessionProof() || '' } : {} });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (importing) await load(); else {
        setLegacyTasks(current => ({ ...current, [line]: data.tasks || [] }));
        setLegacyFiles(current => ({ ...current, [line]: (data.artifacts || []).map((item: any) => ({ id: item.sha256, path: item.path, fileName: item.originalPath.split(/[\\/]/).pop(), kind: chatArtifactKind(item.originalPath), url: `/api/files/business-archive/${line}/${item.sha256}` })) }));
      }
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  return <div className="flex h-full min-h-0 flex-col bg-[#0b1318] text-white" data-business-workbench>
    <header className="shrink-0 border-b border-white/10 px-5 py-4">
      <div className="flex items-center gap-3"><BriefcaseBusiness size={22} className="text-emerald-300" /><div><h2 className="text-lg font-semibold">{c.title}</h2><p className="text-xs text-white/50">{c.subtitle}</p></div></div>
      <nav className="mt-4 flex flex-wrap gap-2" aria-label={c.title}>{(['ecommerce', 'finance', 'archive'] as const).map(id => <button type="button" key={id} onClick={() => setTab(id)} aria-pressed={tab === id} className={`rounded-xl px-4 py-2 text-sm ${tab === id ? 'bg-emerald-300 text-slate-950' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>{id === 'ecommerce' ? c.commerce : id === 'finance' ? c.finance : c.archive}</button>)}</nav>
      {tab !== 'archive' && <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2"><label className="text-xs text-white/60" htmlFor="business-subject">{c.subject}</label><select id="business-subject" value={active[tab]?.id || ''} onChange={e => void bind(e.target.value)} disabled={saving} className="rounded-lg bg-slate-800 p-2 text-xs"><option value="" disabled>{c.emptySubject}</option>{subjects.filter(s => s.productLine === tab).map(s => <option key={s.id} value={s.id}>{s.name} · {s.attributes.accountingPeriod || s.attributes.reportingPeriod || ''}</option>)}</select></div>
        <form onSubmit={e => { e.preventDefault(); void bind(); }} className="flex flex-wrap gap-2">
          <input aria-label={c.name} placeholder={c.name} required value={name} onChange={e => setName(e.target.value)} className="min-w-32 rounded-lg bg-white/5 p-2 text-xs" />
          <input aria-label={c.period} placeholder={c.period} value={period} onChange={e => setPeriod(e.target.value)} className="rounded-lg bg-white/5 p-2 text-xs" />
          <input aria-label={c.currency} value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} className="w-16 rounded-lg bg-white/5 p-2 text-xs" />
          {tab === 'ecommerce' && <select aria-label={c.linkedEntity} value={entityId} onChange={e => setEntityId(e.target.value)} className="rounded-lg bg-slate-800 p-2 text-xs"><option value="">{c.noEntity}</option>{subjects.filter(s => s.productLine === 'finance').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          <button disabled={saving} className="rounded-lg border border-white/15 px-3 text-xs disabled:opacity-40">{c.create}</button>
        </form>
        <div className="flex flex-wrap gap-1">{Object.entries(tab === 'ecommerce' ? c.commerceEntries : c.financeEntries).map(([id, label]) => <button type="button" key={id} onClick={() => tab === 'ecommerce' ? setCommerceEntry(id as EcommerceOutcomeId) : setFinanceEntry(id)} className={`rounded-lg px-3 py-1.5 text-xs ${(tab === 'ecommerce' ? commerceEntry : financeEntry) === id ? 'bg-white/15 text-white' : 'text-white/50 hover:bg-white/5'}`}>{label}</button>)}</div>
      </div>}
      {error && <p role="alert" className="mt-2 text-sm text-rose-300">{error}</p>}
    </header>
    <main className="min-h-0 flex-1 overflow-auto"><Suspense fallback={<p className="p-5">{c.loading}</p>}>
      {tab === 'ecommerce' ? <Commerce key={`commerce:${active.ecommerce?.id || ''}:${commerceEntry}`} appId={commerceEntry} lang={locale} onOpenSettings={onOpenSettings} snapshot={snapshot} onSnapshotChange={setSnapshot} onOpenWorkspace={target => setCommerceEntry(target === 'reviews' || target === 'inventory' ? 'store-data' : target)} /> : tab === 'finance' ? <Finance key={`finance:${active.finance?.id || ''}:${financeEntry}`} lang={locale} domain={domain} initialWorkflowId={financeEntry} onOpenKnowledge={onOpenKnowledge} onOpenSkills={onOpenSkills} /> : <section className="space-y-3 p-5">
        <button type="button" onClick={() => void load().catch(e => setError(e.message))} className="flex items-center gap-2 text-sm text-emerald-200"><RefreshCw size={14} />{c.refresh}</button>
        <p className="text-xs text-white/50">{c.scope}</p>
        {domain === 'personal' && <section className="rounded-xl border border-white/10 p-4"><h3 className="font-medium">{c.legacy}</h3><p className="my-2 text-xs text-white/50">{c.historical}</p>{(['ecommerce', 'finance'] as const).map(line => <div key={line} className="my-3"><button type="button" disabled={saving} onClick={() => void legacyAction(line, !legacy.some(item => item.line === line))} className="text-sm text-emerald-200">{line === 'ecommerce' ? c.commerce : c.finance} · {legacy.find(item => item.line === line)?.tasks ?? c.importLegacy}</button><ChatArtifactCards files={legacyFiles[line] || []} isZh={locale === 'zh'} onPreview={setPreview} />{legacyTasks[line]?.map(task => <details className="mt-2 rounded-lg bg-white/5 p-3" key={task.id}><summary>{task.title}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs text-white/65">{task.result || task.summary}</pre></details>)}</div>)}</section>}
        {!tasks.length && <p className="py-12 text-center text-white/50">{c.noTasks}</p>}
        {tasks.map(task => <details key={task.id} className="rounded-xl border border-white/10 bg-white/[0.025] p-4"><summary className="flex cursor-pointer items-center gap-3"><Archive size={16} /><span className="flex-1">{({...c.commerceEntries, ...c.financeEntries} as Record<string, string>)[task.metadata?.industryWorkflow?.entryId] || task.title}<small className="ml-3 text-white/45">{task.metadata?.industryWorkflow?.context?.industryWorkspace?.name}</small></span><span className="text-xs text-emerald-200">{(c.statuses as Record<string,string>)[task.status] || c.unknown}</span></summary><pre className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-white/75">{task.result || task.summary}</pre><ChatArtifactCards files={(task.artifacts || []).filter((item: any) => item.path && item.status !== 'planned').map((item: any) => makeChatArtifact(item.path))} isZh={locale === 'zh'} onPreview={setPreview} /></details>)}
      </section>}
    </Suspense></main>
    {preview && <ChatFilePreview file={preview} isZh={locale === 'zh'} onClose={() => setPreview(null)} />}
  </div>;
}
