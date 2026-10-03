import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowUpRight, BriefcaseBusiness, Library, Radio, RefreshCw, WandSparkles } from 'lucide-react';
import { businessWorkbenchCopy } from '../i18n/locales/businessWorkbench';
import type { EcommerceWorkbenchDraft } from './EcommerceHub';
import { apiJson } from '../services/apiClient';
import { useApp } from '../contexts/AppContext';
import type { EcommerceOutcomeId } from '../i18n/locales/ecommerceModules';
import type { EcommerceReportKind, EcommerceWorkbenchSnapshot } from '../../shared/ecommerce_workbench';
import { makeChatArtifact, type ChatArtifact } from '../../shared/chat_artifacts';
import { ChatArtifactCards } from './ChatArtifactCards';
import { ChatFilePreview, type ChatPreviewFile } from './ChatFilePreview';
const Commerce = lazy(() => import('./EcommerceAutomationWorkspace').then(m => ({ default: m.EcommerceAutomationWorkspace })));
const Finance = lazy(() => import('./FinanceWorkbench').then(m => ({ default: m.FinanceWorkbench })));
type Line = 'ecommerce' | 'finance';
type Subject = { id: string; productLine: Line; scopeId: string; name: string; attributes: Record<string, string> };
const isTask = (item: any) => item && typeof item.id === 'string' && typeof item.title === 'string'
  && ['result', 'summary', 'status'].every(key => item[key] == null || typeof item[key] === 'string')
  && (item.artifacts == null || (Array.isArray(item.artifacts) && item.artifacts.every((file: any) => file && (file.path == null || typeof file.path === 'string'))));
const isLegacy = (item: any) => item && ['ecommerce', 'finance'].includes(item.line) && Number.isFinite(item.tasks);
type Props = {
  lang: string; domain: 'personal' | 'work'; onOpenSettings: () => void; onOpenKnowledge: () => void; onOpenSkills: () => void;
  onOpenCreation: () => void; onOpenDigitalHuman: () => void;
};
export function BusinessWorkbench(props: Props) {
  const { user, orgConnection } = useApp();
  const scopeId = props.domain === 'work' ? 'work:' + (orgConnection?.orgId || '') : 'personal:' + user?.uid;
  return user ? <Workbench key={JSON.stringify([user.uid, user.role, scopeId, orgConnection?.orgRole])} {...props} scopeId={scopeId} userId={user.uid} /> : null;
}
function Workbench({ lang, domain, onOpenSettings, onOpenKnowledge, onOpenSkills, onOpenCreation, onOpenDigitalHuman, scopeId, userId }: Props & { scopeId: string; userId: string }) {
  const { workbenchDrafts } = useApp();
  const locale = lang === 'en' ? 'en' : 'zh'; const c = businessWorkbenchCopy[locale];
  const [tab, setTab] = useState<Line | 'social' | 'archive'>('social');
  const [commerceEntry, setCommerceEntry] = useState<EcommerceOutcomeId>('store-data');
  const [commerceReportKind, setCommerceReportKind] = useState<EcommerceReportKind>('orders');
  const [financeEntry, setFinanceEntry] = useState('business-dashboard');
  const [data, setData] = useState<{ subjects: Subject[]; active: Partial<Record<Line, Subject | null>>; tasks: any[]; legacy: any[] } | null>(null);
  const { subjects = [], active = {}, tasks = [], legacy = [] } = data || {};
  const [name, setName] = useState(''); const [period, setPeriod] = useState('');
  const [currency, setCurrency] = useState('CNY'); const [entityId, setEntityId] = useState('');
  const [{ error, saving }, setOperation] = useState({ error: '', saving: true });
  const [legacyDetails, setLegacyDetails] = useState<Partial<Record<Line, { tasks: any[]; files: ChatArtifact[] }>>>({});
  const [preview, setPreview] = useState<ChatPreviewFile | null>(null);
  const [snapshot, setSnapshot] = useState<{ id: string; value: EcommerceWorkbenchSnapshot | null } | null>(null);
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortSignal | null>(null);
  const revision = useRef(0), viewRevision = revision.current;
  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<() => void>, timeout = 15_000) => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || (pending.current && !pending.current.aborted)) return;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(timeout)]); pending.current = signal; revision.current++;
    setOperation({ saving: true, error: '' });
    try { const commit = await operation(signal); signal.throwIfAborted(); commit(); }
    catch (error) { if (!owner.signal.aborted && pending.current === signal) setOperation({ saving: false, error: error instanceof Error ? error.message : String(error) }); }
    finally { if (pending.current === signal) { pending.current = null; if (!owner.signal.aborted) setOperation(current => ({ ...current, saving: false })); } }
  }, []);
  const isSubject = useCallback((item: any): item is Subject => item && typeof item.id === 'string' && item.id && item.scopeId === scopeId
    && ['ecommerce', 'finance'].includes(item.productLine) && typeof item.name === 'string' && item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)
    && Object.values(item.attributes).every(value => typeof value === 'string'), [scopeId]);
  const load = useCallback(() => run(async signal => {
    const [workspaces, workflows, archives] = await Promise.all(['/api/business/workspaces', '/api/industry/workflows', '/api/business/legacy'].map(url => apiJson(url, { signal })));
    if (!Array.isArray(workspaces?.items) || !workspaces.items.every(isSubject) || !workspaces.active || typeof workspaces.active !== 'object' || Array.isArray(workspaces.active) || !['ecommerce', 'finance'].every(line => workspaces.active[line] == null || (isSubject(workspaces.active[line]) && workspaces.active[line].productLine === line))
      || !Array.isArray(workflows?.tasks) || !workflows.tasks.every(isTask) || !Array.isArray(archives?.items) || !archives.items.every(isLegacy)) throw new Error('Invalid business workspace response');
    return () => { setData({ subjects: workspaces.items, active: workspaces.active, tasks: workflows.tasks, legacy: archives.items }); setLegacyDetails({}); setSnapshot(current => current?.id === (workspaces.active.ecommerce?.id || '') ? current : null); setPreview(null); };
  }), [run, isSubject]);
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; setPreview(null); void load(); return () => owner.abort(); }, [load, tab]);
  const storeId = active.ecommerce?.id || '';
  const acceptSnapshot = useCallback((value: EcommerceWorkbenchSnapshot | null) => {
    if (!lifetime.current?.signal.aborted && viewRevision === revision.current) setSnapshot({ id: storeId, value });
  }, [storeId, viewRevision]);
  const saveDraft = useCallback((value: EcommerceWorkbenchDraft) => {
    workbenchDrafts?.set('commerce:' + storeId, value);
  }, [workbenchDrafts, storeId]);
  const bind = (id?: string) => {
    if ((tab !== 'ecommerce' && tab !== 'finance') || !data || (!id && !name.trim())) return;
    return run(async signal => {
      const { item } = await apiJson('/api/business/workspaces', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id ? { id } : { productLine: tab, name: name.trim(), attributes: { currency, ...(tab === 'ecommerce' ? { reportingPeriod: period, entityId } : { accountingPeriod: period, entityName: name.trim() }) } }) }) || {};
      if (!isSubject(item) || item.productLine !== tab || (id && item.id !== id)) throw new Error('Workspace binding was not confirmed');
      return () => { setData(current => current && { ...current, subjects: [...current.subjects.filter(subject => subject.id !== item.id), item], active: { ...current.active, [tab]: item } }); setName(''); setSnapshot(null); };
    });
  };
  const legacyAction = (line: Line, importing: boolean) => run(async signal => {
    const result = await apiJson(`/api/business/legacy/${line}${importing ? '/import' : ''}`, { method: importing ? 'POST' : 'GET', signal });
    if (importing) {
      if (!isLegacy(result) || result.line !== line || result.persisted !== true) throw new Error('Archive import was not confirmed');
      return () => { setData(current => current && { ...current, legacy: [...current.legacy.filter(item => item.line !== line), result] }); setLegacyDetails(current => ({ ...current, [line]: undefined })); };
    }
    if (result?.line !== line || result.owner !== userId || !Array.isArray(result.tasks) || !result.tasks.every(isTask) || !Array.isArray(result.artifacts)
      || !result.artifacts.every((file: any) => file && typeof file.path === 'string' && typeof file.originalPath === 'string' && /^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('Invalid business archive response');
    const files = result.artifacts.map((item: any) => ({ ...makeChatArtifact(item.originalPath), id: item.sha256, path: item.path, url: `/api/files/business-archive/${line}/${item.sha256}` }));
    return () => setLegacyDetails(current => ({ ...current, [line]: { tasks: result.tasks, files } }));
  }, 60_000);
  return <div className="flex h-full min-h-0 flex-col bg-[#0b1318] text-white" data-business-workbench>
    <header className="shrink-0 border-b border-white/10 px-5 py-4">
      <div className="flex items-center gap-3"><BriefcaseBusiness size={22} className="text-emerald-300" /><div><h2 className="text-lg font-semibold">{c.title}</h2><p className="text-xs text-white/50">{c.subtitle}</p></div></div>
      <nav className="mt-4 flex flex-wrap gap-2" aria-label={c.title}>{(['social', 'ecommerce', 'finance', 'archive'] as const).map(id => <button type="button" key={id} onClick={() => setTab(id)} aria-pressed={tab === id} className={`rounded-xl px-4 py-2 text-sm ${tab === id ? 'bg-emerald-300 text-slate-950' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>{id === 'social' ? c.social : id === 'ecommerce' ? c.commerce : id === 'finance' ? c.finance : c.archive}</button>)}</nav>
      {(tab === 'ecommerce' || tab === 'finance') && <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2"><label className="text-xs text-white/60" htmlFor="business-subject">{c.subject}</label><select id="business-subject" value={active[tab]?.id || ''} onChange={e => void bind(e.target.value)} disabled={saving || !data} className="rounded-lg bg-slate-800 p-2 text-xs"><option value="" disabled>{c.emptySubject}</option>{subjects.filter(s => s.productLine === tab).map(s => <option key={s.id} value={s.id}>{s.name} · {s.attributes.accountingPeriod || s.attributes.reportingPeriod || ''}</option>)}</select></div>
        <form onSubmit={e => { e.preventDefault(); void bind(); }}><fieldset disabled={saving || !data} className="flex min-w-0 flex-wrap gap-2">
          <input aria-label={c.name} placeholder={c.name} required value={name} onChange={e => setName(e.target.value)} className="min-w-32 rounded-lg bg-white/5 p-2 text-xs" />
          <input aria-label={c.period} placeholder={c.period} value={period} onChange={e => setPeriod(e.target.value)} className="rounded-lg bg-white/5 p-2 text-xs" />
          <input aria-label={c.currency} value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} className="w-16 rounded-lg bg-white/5 p-2 text-xs" />
          {tab === 'ecommerce' && <select aria-label={c.linkedEntity} value={entityId} onChange={e => setEntityId(e.target.value)} className="rounded-lg bg-slate-800 p-2 text-xs"><option value="">{c.noEntity}</option>{subjects.filter(s => s.productLine === 'finance').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          <button disabled={saving} className="rounded-lg border border-white/15 px-3 text-xs disabled:opacity-40">{c.create}</button>
        </fieldset></form>
        <div className="flex flex-wrap gap-1">{Object.entries(tab === 'ecommerce' ? c.commerceEntries : c.financeEntries).map(([id, label]) => <button type="button" key={id} onClick={() => tab === 'ecommerce' ? setCommerceEntry(id as EcommerceOutcomeId) : setFinanceEntry(id)} className={`rounded-lg px-3 py-1.5 text-xs ${(tab === 'ecommerce' ? commerceEntry : financeEntry) === id ? 'bg-white/15 text-white' : 'text-white/50 hover:bg-white/5'}`}>{label}</button>)}</div>
      </div>}
      {error && <p role="alert" className="mt-2 text-sm text-rose-300">{error}<button type="button" disabled={saving} onClick={() => void load()} className="ml-3 underline">{c.refresh}</button></p>}
    </header>
    <main className="min-h-0 flex-1 overflow-auto"><fieldset disabled={saving} className="contents"><Suspense fallback={<p className="p-5">{c.loading}</p>}>
      {tab === 'social' ? <section className="space-y-6 p-5 sm:p-7">
        <div className="rounded-2xl border border-emerald-200/10 bg-gradient-to-br from-emerald-300/10 to-transparent p-6">
          <p className="text-xs font-medium tracking-widest text-emerald-200">{c.social}</p>
          <h3 className="mt-3 text-2xl font-semibold">{c.socialOverview.title}</h3>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">{c.socialOverview.description}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { id: 'creation', copy: c.socialOverview.creation, Icon: WandSparkles, onClick: onOpenCreation },
            { id: 'library', copy: c.socialOverview.library, Icon: Library, onClick: onOpenKnowledge },
            ...(domain === 'personal' ? [{ id: 'avatar', copy: c.socialOverview.avatar, Icon: Radio, onClick: onOpenDigitalHuman }] : []),
          ].map(({ id, copy, Icon, onClick }) => <button type="button" key={id} onClick={() => onClick()} className="group flex flex-col items-start rounded-2xl border border-white/10 bg-white/[0.025] p-5 text-left transition hover:border-emerald-200/30 hover:bg-white/[0.05]">
            <Icon size={23} className="text-emerald-200" />
            <h4 className="mt-5 font-semibold">{copy.title}</h4>
            <p className="mt-2 flex-1 text-sm leading-6 text-white/55">{copy.description}</p>
            <span className="mt-5 inline-flex items-center gap-2 text-sm text-emerald-200">{copy.action}<ArrowUpRight size={15} /></span>
          </button>)}
        </div>
      </section> :
      saving && !data ? <p className="p-5">{c.loading}</p> : !data ? null : tab === 'ecommerce' ? <Commerce key={`commerce:${storeId}:${commerceEntry}`} appId={commerceEntry} draft={workbenchDrafts?.get('commerce:' + storeId) as EcommerceWorkbenchDraft | undefined} onDraftChange={saveDraft} lang={locale} initialReportKind={commerceReportKind} onOpenSettings={onOpenSettings} snapshot={snapshot?.id === storeId ? snapshot.value : null} onSnapshotChange={acceptSnapshot} onOpenWorkspace={target => {
        if (target === 'reviews' || target === 'inventory') {
          setCommerceReportKind(target === 'inventory' ? 'inventory' : 'reviews');
          setCommerceEntry('store-data');
        } else setCommerceEntry(target);
      }} /> : tab === 'finance' ? <Finance key={`finance:${active.finance?.id || ''}:${financeEntry}`} lang={locale} domain={domain} initialWorkflowId={financeEntry} onOpenKnowledge={onOpenKnowledge} onOpenSkills={onOpenSkills} /> : <section className="space-y-3 p-5">
        <button type="button" disabled={saving} onClick={() => void load()} className="flex items-center gap-2 text-sm text-emerald-200"><RefreshCw size={14} />{c.refresh}</button>
        <p className="text-xs text-white/50">{c.scope}</p>
        {domain === 'personal' && <section className="rounded-xl border border-white/10 p-4"><h3 className="font-medium">{c.legacy}</h3><p className="my-2 text-xs text-white/50">{c.historical}</p>{(['ecommerce', 'finance'] as const).map(line => <div key={line} className="my-3"><button type="button" disabled={saving} onClick={() => void legacyAction(line, !legacy.some(item => item.line === line))} className="text-sm text-emerald-200">{line === 'ecommerce' ? c.commerce : c.finance} · {legacy.find(item => item.line === line)?.tasks ?? c.importLegacy}</button><ChatArtifactCards files={legacyDetails[line]?.files || []} isZh={locale === 'zh'} onPreview={setPreview} />{legacyDetails[line]?.tasks.map(task => <details className="mt-2 rounded-lg bg-white/5 p-3" key={task.id}><summary>{task.title}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs text-white/65">{task.result || task.summary}</pre></details>)}</div>)}</section>}
        {!tasks.length && <p className="py-12 text-center text-white/50">{c.noTasks}</p>}
        {tasks.map(task => <details key={task.id} className="rounded-xl border border-white/10 bg-white/[0.025] p-4"><summary className="flex cursor-pointer items-center gap-3"><Archive size={16} /><span className="flex-1">{({...c.commerceEntries, ...c.financeEntries} as Record<string, string>)[task.metadata?.industryWorkflow?.entryId] || task.title}<small className="ml-3 text-white/45">{task.metadata?.industryWorkflow?.context?.industryWorkspace?.name}</small></span><span className="text-xs text-emerald-200">{(c.statuses as Record<string,string>)[task.status] || c.unknown}</span></summary><pre className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-white/75">{task.result || task.summary}</pre><ChatArtifactCards files={(task.artifacts || []).filter((item: any) => item.path && item.status !== 'planned').map((item: any) => makeChatArtifact(item.path))} isZh={locale === 'zh'} onPreview={setPreview} /></details>)}
      </section>}
    </Suspense></fieldset></main>
    {preview && <ChatFilePreview file={preview} isZh={locale === 'zh'} onClose={() => setPreview(null)} />}
  </div>;
}
