import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BriefcaseBusiness, Library, Radio, WandSparkles } from 'lucide-react';
import { businessWorkbenchCopy } from '../i18n/locales/businessWorkbench';
import type { EcommerceWorkbenchDraft } from './EcommerceHub';
import { apiJson } from '../services/apiClient';
import { useApp } from '../contexts/AppContext';
import type { EcommerceOutcomeId } from '../i18n/locales/ecommerceModules';
import type { EcommerceReportKind, EcommerceWorkbenchSnapshot } from '../../shared/ecommerce_workbench';
import { BusinessLocalBoard } from './BusinessLocalBoard';
const Commerce = lazy(() => import('./EcommerceAutomationWorkspace').then(m => ({ default: m.EcommerceAutomationWorkspace })));
const Finance = lazy(() => import('./FinanceWorkbench').then(m => ({ default: m.FinanceWorkbench })));
type Line = 'ecommerce' | 'finance';
export type BusinessSection = Line | 'social';
type Subject = { id: string; productLine: Line; scopeId: string; name: string; attributes: Record<string, string> };
type Props = {
  section?: BusinessSection; lang: string; domain: 'personal' | 'work'; onOpenSettings: () => void; onOpenKnowledge: () => void; onOpenSkills: () => void;
  onOpenCreation: () => void; onOpenDigitalHuman: () => void;
};
export function BusinessWorkbench(props: Props) {
  const { user, orgConnection } = useApp();
  const scopeId = props.domain === 'work' ? 'work:' + (orgConnection?.orgId || '') : 'personal:' + user?.uid;
  return user ? <Workbench key={JSON.stringify([user.uid, user.role, scopeId, orgConnection?.orgRole])} {...props} scopeId={scopeId} /> : null;
}
function Workbench({ section = 'social', lang, domain, onOpenSettings, onOpenKnowledge, onOpenSkills, onOpenCreation, onOpenDigitalHuman, scopeId }: Props & { scopeId: string }) {
  const { workbenchDrafts } = useApp();
  const locale = lang === 'en' ? 'en' : 'zh'; const c = businessWorkbenchCopy[locale];
  const tab = section;
  const title = tab === 'social' ? c.social : tab === 'ecommerce' ? c.commerce : c.finance;
  const [commerceEntry, setCommerceEntry] = useState<EcommerceOutcomeId>('store-data');
  const [commerceReportKind, setCommerceReportKind] = useState<EcommerceReportKind>('orders');
  const [financeEntry, setFinanceEntry] = useState('business-dashboard');
  const [data, setData] = useState<{ subjects: Subject[]; active: Partial<Record<Line, Subject | null>> } | null>(null);
  const { subjects = [], active = {} } = data || {};
  const [name, setName] = useState(''); const [period, setPeriod] = useState('');
  const [currency, setCurrency] = useState('CNY'); const [entityId, setEntityId] = useState('');
  const [{ error, saving }, setOperation] = useState({ error: '', saving: true });
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
    const workspaces = await apiJson('/api/business/workspaces', { signal });
    if (!Array.isArray(workspaces?.items) || !workspaces.items.every(isSubject) || !workspaces.active || typeof workspaces.active !== 'object' || Array.isArray(workspaces.active) || !['ecommerce', 'finance'].every(line => workspaces.active[line] == null || (isSubject(workspaces.active[line]) && workspaces.active[line].productLine === line))) throw new Error('Invalid business workspace response');
    return () => { setData({ subjects: workspaces.items, active: workspaces.active }); setSnapshot(current => current?.id === (workspaces.active.ecommerce?.id || '') ? current : null); };
  }), [run, isSubject]);
  useEffect(() => {
    const owner = new AbortController(); lifetime.current = owner;
    if (tab === 'social') setOperation({ saving: false, error: '' });
    else void load();
    return () => owner.abort();
  }, [load, tab]);
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
  return <div className="flex h-full min-h-0 flex-col bg-[#0b1318] text-white" data-business-workbench>
    <header className="shrink-0 border-b border-white/10 px-5 py-4">
      <div className="flex items-center gap-3"><BriefcaseBusiness size={22} className="text-emerald-300" /><div><h2 className="text-lg font-semibold">{title}</h2><p className="text-xs text-white/50">{c.scope}</p></div></div>
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
    <main className="min-h-0 flex-1 overflow-auto"><fieldset disabled={tab !== 'social' && saving} className="contents"><Suspense fallback={<p className="p-5">{c.loading}</p>}>
      {tab === 'social' ? <section className="space-y-6 p-5 sm:p-7">
        <div className="rounded-2xl border border-emerald-200/10 bg-gradient-to-br from-emerald-300/10 to-transparent p-6">
          <p className="text-xs font-medium tracking-widest text-emerald-200">{c.social}</p>
          <h3 className="mt-3 text-2xl font-semibold">{c.socialOverview.title}</h3>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">{c.socialOverview.description}</p>
        </div>
        <BusinessLocalBoard boardId="social-calendar" workspaceId="_unbound" lang={lang} />
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
      saving && !data ? <p className="p-5">{c.loading}</p> : !data ? null : tab === 'ecommerce' ? <Commerce key={`commerce:${storeId}:${commerceEntry}`} appId={commerceEntry} workspaceId={storeId} draft={workbenchDrafts?.get('commerce:' + storeId) as EcommerceWorkbenchDraft | undefined} onDraftChange={saveDraft} lang={locale} initialReportKind={commerceReportKind} onOpenSettings={onOpenSettings} snapshot={snapshot?.id === storeId ? snapshot.value : null} onSnapshotChange={acceptSnapshot} onOpenWorkspace={target => {
        if (target === 'reviews' || target === 'inventory') {
          setCommerceReportKind(target === 'inventory' ? 'inventory' : 'reviews');
          setCommerceEntry('store-data');
        } else setCommerceEntry(target);
      }} /> : <Finance key={`finance:${active.finance?.id || ''}:${financeEntry}`} workspaceId={active.finance?.id || ''} lang={locale} domain={domain} initialWorkflowId={financeEntry} onOpenKnowledge={onOpenKnowledge} onOpenSkills={onOpenSkills} />}
    </Suspense></fieldset></main>
  </div>;
}
