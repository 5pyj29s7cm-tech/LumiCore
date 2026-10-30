import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../contexts/AppContext';
import { apiFetch } from '../services/apiClient';
import { withRequestDeadline } from '../lib/requestDeadline';
import { financeLocalWorksheetCopy } from '../i18n/locales/financeLocalWorksheet';
import { FINANCE_WORKSHEET_COLUMNS, MAX_FINANCE_WORKSHEET_ROWS, isFinanceWorksheetEntry, isFinanceWorksheetRows,
  type FinanceWorksheetEntry, type FinanceWorksheetRecord, type FinanceWorksheetRow } from '../../shared/finance_local_worksheet';

type Props = { entryId: string; workspaceId?: string; lang: string };
const MAX_SAVE_BYTES = 1_500_000;

/** CSV is a user download of input, never a saved ledger or an execution receipt. */
export function financeWorksheetCsv(entryId: FinanceWorksheetEntry, rows: FinanceWorksheetRow[], lang: string): string {
  const copy = financeLocalWorksheetCopy(lang), columns = FINANCE_WORKSHEET_COLUMNS[entryId];
  const quote = (value: string) => {
    // Spreadsheet applications may ignore leading whitespace/control characters
    // before evaluating a formula. Force those cells to literal text.
    const literal = /^[\s\u0000-\u001f\u007f-\u009f\uFEFF]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value) ? "'" + value : value;
    return '"' + literal.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [
    [...columns.map(key => copy.columns[key]), copy.review],
    ...rows.filter(row => columns.some(key => row.cells[key]?.trim())).map(row => [...columns.map(key => row.cells[key]), row.reviewStatus === 'reviewed' ? copy.reviewed : copy.pending]),
  ].map(row => row.map(quote).join(',')).join('\r\n');
}

export function FinanceLocalWorksheet(props: Props) {
  const { user, workDomain, orgConnection } = useApp();
  if (!isFinanceWorksheetEntry(props.entryId)) return null;
  if (!user) return <p>{financeLocalWorksheetCopy(props.lang).signedOut}</p>;
  const workspaceId = props.workspaceId || '_unbound';
  const scope = JSON.stringify([user.uid, user.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole, props.entryId, workspaceId]);
  return <WorksheetEditor key={scope} {...props} entryId={props.entryId} workspaceId={workspaceId}
    userId={user.uid}
    domain={workDomain === 'work' ? 'work' : 'personal'} orgId={workDomain === 'work' ? orgConnection?.orgId || '' : ''} />;
}

function WorksheetEditor({ entryId, workspaceId, lang, userId, domain, orgId }: Props & { entryId: FinanceWorksheetEntry; workspaceId: string; userId: string; domain: string; orgId: string }) {
  const copy = financeLocalWorksheetCopy(lang), messages = useRef(copy); messages.current = copy;
  const columns = FINANCE_WORKSHEET_COLUMNS[entryId];
  const endpoint = `/api/business/finance-worksheets/${encodeURIComponent(entryId)}/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ userId, domain, orgId })}`;
  const [rows, setRows] = useState<FinanceWorksheetRow[]>([]), [baseline, setBaseline] = useState('[]');
  const [version, setVersion] = useState(0), [loaded, setLoaded] = useState(false), [phase, setPhase] = useState<'loading' | 'saving' | ''>('loading');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [needsReload, setNeedsReload] = useState(false);
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortController | null>(null);
  const dirty = JSON.stringify(rows) !== baseline;
  const validateRecord = useCallback((value: any): value is FinanceWorksheetRecord => Boolean(value
    && value.entryId === entryId && value.workspaceId === workspaceId
    && Number.isSafeInteger(value.version) && value.version > 0
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    && isFinanceWorksheetRows(entryId, value.rows)), [entryId, workspaceId]);
  const load = useCallback(async () => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || pending.current) return;
    const controller = pending.current = new AbortController();
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    setPhase('loading'); setError(''); setNotice('');
    try {
      const record = await withRequestDeadline(async signal => {
        const response = await apiFetch(endpoint, { signal, cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || data.scope?.userId !== userId || data.scope?.domain !== domain || data.scope?.orgId !== orgId
          || !Object.hasOwn(data, 'record') || (data.record !== null && !validateRecord(data.record))) throw new Error('Invalid worksheet load');
        return data.record as FinanceWorksheetRecord | null;
      }, signal);
      signal.throwIfAborted();
      const next = record?.rows || [];
      setRows(next); setBaseline(JSON.stringify(next)); setVersion(record?.version || 0); setLoaded(true); setNeedsReload(false);
    } catch {
      if (!signal.aborted) { setError(messages.current.loadFailed); setNeedsReload(true); }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!owner.signal.aborted) setPhase('');
    }
  }, [endpoint, validateRecord, userId, domain, orgId]);
  useEffect(() => {
    const owner = lifetime.current = new AbortController(); void load();
    return () => { owner.abort(); pending.current?.abort(); pending.current = null; };
  }, [load]);
  const save = async () => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || pending.current || !loaded || needsReload || !dirty) return;
    if (!isFinanceWorksheetRows(entryId, rows)) { setError(copy.invalid); return; }
    const body = JSON.stringify({ rows, expectedVersion: version });
    if (new TextEncoder().encode(body).byteLength > MAX_SAVE_BYTES) { setError(copy.tooLarge); return; }
    const controller = pending.current = new AbortController(), expected = rows;
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    setPhase('saving'); setError(''); setNotice('');
    let conflict = false;
    try {
      const record = await withRequestDeadline(async signal => {
        const response = await apiFetch(endpoint, { method: 'PUT', signal, headers: { 'Content-Type': 'application/json' }, body });
        const data = await response.json().catch(() => null); conflict = response.status === 409;
        if (!response.ok || data?.persisted !== true || data.scope?.userId !== userId || data.scope?.domain !== domain || data.scope?.orgId !== orgId
          || !validateRecord(data.record) || data.record.version !== version + 1
          || data.record.rows.length !== expected.length || !data.record.rows.every((row: FinanceWorksheetRow, index: number) => row.id === expected[index].id
            && row.reviewStatus === expected[index].reviewStatus && columns.every(key => row.cells[key] === expected[index].cells[key]))) throw new Error('Unconfirmed worksheet save');
        return data.record as FinanceWorksheetRecord;
      }, signal);
      signal.throwIfAborted();
      setRows(record.rows); setBaseline(JSON.stringify(record.rows)); setVersion(record.version); setNotice(messages.current.saved);
    } catch {
      if (!signal.aborted) { setError(conflict ? messages.current.conflict : messages.current.saveFailed); setNeedsReload(true); }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!owner.signal.aborted) setPhase('');
    }
  };
  const editable = loaded && !phase && !needsReload;
  const updateCell = (id: string, key: string, value: string) => {
    if (!editable) return;
    setNotice(''); setRows(current => current.map(row => row.id === id ? { ...row, cells: { ...row.cells, [key]: value }, reviewStatus: 'pending' } : row));
  };
  const download = () => {
    if (!loaded || !rows.some(row => columns.some(key => row.cells[key]?.trim()))) return;
    const blob = new Blob([financeWorksheetCsv(entryId, rows, lang)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${entryId}-${workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section aria-label={copy.title} className="space-y-3 rounded-2xl border border-white/10 bg-black/15 p-4">
    <h3 className="font-semibold text-white/90">{copy.title}</h3><p className="text-xs text-white/55">{copy.scope}</p>
    {error && <div role="alert" className="text-sm text-amber-200">{error}</div>}
    {(phase || notice) && <p role="status" className="text-xs text-white/70">{phase === 'loading' ? copy.loading : phase === 'saving' ? copy.saving : notice}</p>}
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <button disabled={!editable || rows.length >= MAX_FINANCE_WORKSHEET_ROWS} onClick={() => { setNotice(''); setRows(current => [...current, { id: crypto.randomUUID(), cells: Object.fromEntries(columns.map(key => [key, ''])), reviewStatus: 'pending' }]); }}>{copy.add}</button>
      <button disabled={!editable || !dirty} onClick={() => void save()}>{copy.save}</button>
      <button disabled={Boolean(phase)} onClick={() => void load()}>{loaded ? copy.reload : copy.retry}</button>
      <button disabled={!loaded || Boolean(phase) || !rows.some(row => columns.some(key => row.cells[key]?.trim()))} onClick={download}>{copy.export}</button>
      {loaded && <span>{copy.version(version)}{dirty ? ` · ${copy.dirty}` : ''}</span>}
    </div>
    {rows.length >= MAX_FINANCE_WORKSHEET_ROWS && <p className="text-xs text-amber-200">{copy.limit}</p>}
    <p className="text-xs text-white/45">{copy.draftExport}</p>
    {loaded && !rows.length && <p className="text-sm text-white/55">{copy.empty}</p>}
    {Boolean(rows.length) && <div className="max-h-[32rem] overflow-auto"><table className="w-full text-left text-xs">
      <thead><tr>{columns.map(key => <th key={key} className="p-2">{copy.columns[key]}</th>)}<th className="p-2">{copy.review}</th><th /></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id}>
        {columns.map(key => <td key={key} className="p-1"><input aria-label={copy.row(index + 1, copy.columns[key])} value={row.cells[key]} maxLength={2000} disabled={!editable}
          onChange={event => updateCell(row.id, key, event.target.value)} className="min-w-28 w-full rounded border border-white/15 bg-black/20 px-2 py-1.5" /></td>)}
        <td className="p-1"><select aria-label={copy.row(index + 1, copy.review)} value={row.reviewStatus} disabled={!editable} className="rounded bg-black/40 p-1.5"
          onChange={event => { setNotice(''); setRows(current => current.map(value => value.id === row.id ? { ...value, reviewStatus: event.target.value as FinanceWorksheetRow['reviewStatus'] } : value)); }}>
          <option value="pending">{copy.pending}</option><option value="reviewed">{copy.reviewed}</option>
        </select></td>
        <td className="p-1"><button aria-label={copy.row(index + 1, copy.remove)} disabled={!editable} onClick={() => { setNotice(''); setRows(current => current.filter(value => value.id !== row.id)); }}>{copy.remove}</button></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
