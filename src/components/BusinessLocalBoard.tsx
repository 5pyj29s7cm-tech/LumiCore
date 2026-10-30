import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../contexts/AppContext';
import { apiFetch } from '../services/apiClient';
import { withRequestDeadline } from '../lib/requestDeadline';
import { businessLocalBoardCopy } from '../i18n/locales/businessLocalBoard';
import { LOCAL_OPERATIONS_BOARD_COLUMNS, MAX_LOCAL_OPERATIONS_BOARD_ROWS, isLocalOperationsBoardId, isLocalOperationsBoardRows,
  type LocalOperationsBoardId, type LocalOperationsBoardRecord, type LocalOperationsBoardRow } from '../../shared/local_operations_board';

type Props = { boardId: string; workspaceId?: string; lang: string };
const MAX_SAVE_BYTES = 1_500_000;

/** CSV is a user download of input, never a saved ledger or an execution receipt. */
export function operationsBoardCsv(boardId: LocalOperationsBoardId, rows: LocalOperationsBoardRow[], lang: string): string {
  const copy = businessLocalBoardCopy(lang), columns = LOCAL_OPERATIONS_BOARD_COLUMNS[boardId];
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

export function BusinessLocalBoard(props: Props) {
  const { user, workDomain, orgConnection } = useApp();
  if (!isLocalOperationsBoardId(props.boardId)) return null;
  if (!user) return <p>{businessLocalBoardCopy(props.lang).signedOut}</p>;
  const workspaceId = props.boardId === 'social-calendar' ? '_unbound' : props.workspaceId || '_unbound';
  const scope = JSON.stringify([user.uid, user.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole, props.boardId, workspaceId]);
  return <BoardEditor key={scope} {...props} boardId={props.boardId} workspaceId={workspaceId}
    userId={user.uid}
    domain={workDomain === 'work' ? 'work' : 'personal'} orgId={workDomain === 'work' ? orgConnection?.orgId || '' : ''} />;
}

function BoardEditor({ boardId, workspaceId, lang, userId, domain, orgId }: Props & { boardId: LocalOperationsBoardId; workspaceId: string; userId: string; domain: string; orgId: string }) {
  const copy = businessLocalBoardCopy(lang), messages = useRef(copy); messages.current = copy;
  const columns = LOCAL_OPERATIONS_BOARD_COLUMNS[boardId];
  const endpoint = `/api/business/local-boards/${encodeURIComponent(boardId)}/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ userId, domain, orgId })}`;
  const [rows, setRows] = useState<LocalOperationsBoardRow[]>([]), [baseline, setBaseline] = useState('[]');
  const [version, setVersion] = useState(0), [loaded, setLoaded] = useState(false), [phase, setPhase] = useState<'loading' | 'saving' | ''>('loading');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [needsReload, setNeedsReload] = useState(false);
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortController | null>(null);
  const dirty = JSON.stringify(rows) !== baseline;
  const validateRecord = useCallback((value: any): value is LocalOperationsBoardRecord => Boolean(value
    && value.boardId === boardId && value.workspaceId === workspaceId
    && Number.isSafeInteger(value.version) && value.version > 0
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    && isLocalOperationsBoardRows(boardId, value.rows)), [boardId, workspaceId]);
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
          || !Object.hasOwn(data, 'record') || (data.record !== null && !validateRecord(data.record))) throw new Error('Invalid board load');
        return data.record as LocalOperationsBoardRecord | null;
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
    if (!isLocalOperationsBoardRows(boardId, rows)) { setError(copy.invalid); return; }
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
          || data.record.rows.length !== expected.length || !data.record.rows.every((row: LocalOperationsBoardRow, index: number) => row.id === expected[index].id
            && row.reviewStatus === expected[index].reviewStatus && columns.every(key => row.cells[key] === expected[index].cells[key]))) throw new Error('Unconfirmed board save');
        return data.record as LocalOperationsBoardRecord;
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
    const blob = new Blob([operationsBoardCsv(boardId, rows, lang)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${boardId}-${workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section aria-label={copy.title} className="space-y-3 rounded-2xl border border-white/10 bg-black/15 p-4">
    <h3 className="font-semibold text-white/90">{copy.titles[boardId]}</h3><p className="text-xs text-white/55">{copy.scope}</p>
    {error && <div role="alert" className="text-sm text-amber-200">{error}</div>}
    {(phase || notice) && <p role="status" className="text-xs text-white/70">{phase === 'loading' ? copy.loading : phase === 'saving' ? copy.saving : notice}</p>}
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <button disabled={!editable || rows.length >= MAX_LOCAL_OPERATIONS_BOARD_ROWS} onClick={() => { setNotice(''); setRows(current => [...current, { id: crypto.randomUUID(), cells: Object.fromEntries(columns.map(key => [key, ''])), reviewStatus: 'pending' }]); }}>{copy.add}</button>
      <button disabled={!editable || !dirty} onClick={() => void save()}>{copy.save}</button>
      <button disabled={Boolean(phase)} onClick={() => void load()}>{loaded ? copy.reload : copy.retry}</button>
      <button disabled={!loaded || Boolean(phase) || !rows.some(row => columns.some(key => row.cells[key]?.trim()))} onClick={download}>{copy.export}</button>
      {loaded && <span>{copy.version(version)}{dirty ? ` · ${copy.dirty}` : ''}</span>}
    </div>
    {rows.length >= MAX_LOCAL_OPERATIONS_BOARD_ROWS && <p className="text-xs text-amber-200">{copy.limit}</p>}
    <p className="text-xs text-white/45">{copy.draftExport}</p>
    {loaded && !rows.length && <p className="text-sm text-white/55">{copy.empty}</p>}
    {loaded && boardId === 'social-calendar' && <SocialCalendar rows={rows} lang={lang} />}
    {loaded && boardId === 'trend-discovery' && <TrendTable rows={rows} lang={lang} />}
    {Boolean(rows.length) && <div className="max-h-[32rem] overflow-auto"><table className="w-full text-left text-xs">
      <thead><tr>{columns.map(key => <th key={key} className="p-2">{copy.columns[key]}</th>)}<th className="p-2">{copy.review}</th><th /></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id}>
        {columns.map(key => <td key={key} className="p-1"><input aria-label={copy.row(index + 1, copy.columns[key])} value={row.cells[key]} maxLength={2000} disabled={!editable}
          onChange={event => updateCell(row.id, key, event.target.value)} className="min-w-28 w-full rounded border border-white/15 bg-black/20 px-2 py-1.5" /></td>)}
        <td className="p-1"><select aria-label={copy.row(index + 1, copy.review)} value={row.reviewStatus} disabled={!editable} className="rounded bg-black/40 p-1.5"
          onChange={event => { setNotice(''); setRows(current => current.map(value => value.id === row.id ? { ...value, reviewStatus: event.target.value as LocalOperationsBoardRow['reviewStatus'] } : value)); }}>
          <option value="pending">{copy.pending}</option><option value="reviewed">{copy.reviewed}</option>
        </select></td>
        <td className="p-1"><button aria-label={copy.row(index + 1, copy.remove)} disabled={!editable} onClick={() => { setNotice(''); setRows(current => current.filter(value => value.id !== row.id)); }}>{copy.remove}</button></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function manualNumber(value: string, nonNegative = false): number | null {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && (!nonNegative || number >= 0) ? number : null;
}
const byDate = (a: LocalOperationsBoardRow, b: LocalOperationsBoardRow) => a.cells.date.localeCompare(b.cells.date);

function SocialCalendar({ rows, lang }: { rows: LocalOperationsBoardRow[]; lang: string }) {
  const c = businessLocalBoardCopy(lang), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const dated = rows.filter(row => validDate(row.cells.date)), invalidRange = Boolean(from && to && from > to);
  const visible = invalidRange ? [] : dated.filter(row => (!from || row.cells.date >= from) && (!to || row.cells.date <= to)).sort(byDate);
  const total = (key: string) => {
    const values = visible.map(row => manualNumber(row.cells[key], true)).filter((value): value is number => value !== null);
    const sum = values.reduce((a, b) => a + b, 0);
    return c.total(c.columns[key], values.length && Number.isFinite(sum) ? new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 10 }).format(sum) : c.unavailable, values.length);
  };
  return <section aria-label={c.calendar} className="space-y-3 rounded-xl border border-white/10 p-3">
    <h4>{c.calendar}</h4><p className="text-xs text-white/55">{c.calendarScope}</p>
    <div className="flex flex-wrap gap-3 text-xs"><label>{c.from}<input type="date" value={from} onChange={e => setFrom(e.target.value)} className="ml-2 bg-slate-800 p-1" /></label>
      <label>{c.to}<input type="date" value={to} onChange={e => setTo(e.target.value)} className="ml-2 bg-slate-800 p-1" /></label>
      <button onClick={() => { setFrom(''); setTo(''); }}>{c.resetFilters}</button></div>
    {invalidRange && <p role="alert">{c.invalidRange}</p>}
    <div className="text-xs"><p>{total('views')}</p><p>{total('interactions')}</p></div>
    {rows.length > dated.length && <p className="text-xs text-amber-200">{c.undated(rows.length - dated.length)}</p>}
    {!visible.length ? <p className="text-xs">{c.noSchedule}</p> : <ol className="space-y-2">{visible.map(row => <li key={row.id} className="rounded bg-white/5 p-2 text-sm">
      <time dateTime={row.cells.date}>{row.cells.date}</time><span> · {row.cells.channel} · {row.cells.campaign}</span>
      <p className="whitespace-pre-wrap">{row.cells.content}</p><p className="text-xs text-white/50">{c.columns.source}: {row.cells.source}</p>
      <span className="text-xs">{row.reviewStatus === 'reviewed' ? c.reviewed : c.pending}</span>
    </li>)}</ol>}
  </section>;
}

function TrendTable({ rows, lang }: { rows: LocalOperationsBoardRow[]; lang: string }) {
  const c = businessLocalBoardCopy(lang), [filters, setFilters] = useState({ topic: '', metric: '', unit: '' });
  const valid = rows.filter(row => validDate(row.cells.date) && manualNumber(row.cells.value) !== null && ['topic', 'metric', 'unit'].every(key => row.cells[key].trim()));
  const keys = ['topic', 'metric', 'unit'] as const;
  const visible = valid.filter(row => keys.every(key => !filters[key] || row.cells[key].trim() === filters[key])).sort(byDate);
  return <section aria-label={c.trend} className="space-y-3 rounded-xl border border-white/10 p-3">
    <h4>{c.trend}</h4><p className="text-xs text-white/55">{c.trendScope}</p>
    <div className="flex flex-wrap gap-3 text-xs">{keys.map(key => <label key={key}>{c.columns[key]}<select className="ml-2 bg-slate-800 p-1" value={filters[key]} onChange={e => setFilters(current => ({ ...current, [key]: e.target.value }))}>
      <option value="">{c.all}</option>{Array.from(new Set(rows.map(row => row.cells[key].trim()).filter(Boolean))).sort().map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>)}<button onClick={() => setFilters({ topic: '', metric: '', unit: '' })}>{c.resetFilters}</button></div>
    {rows.length > valid.length && <p className="text-xs text-amber-200">{c.invalidTrend(rows.length - valid.length)}</p>}
    {visible.length > 0 && <TrendGraphs rows={visible} lang={lang} />}
    {!visible.length ? <p className="text-xs">{c.noTrend}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{['date', ...keys, 'value', 'source'].map(key => <th key={key} className="p-2">{c.columns[key]}</th>)}</tr></thead>
      <tbody>{visible.map(row => <tr key={row.id}>{['date', ...keys, 'value', 'source'].map(key => <td key={key} className="p-2">{row.cells[key]}</td>)}</tr>)}</tbody></table></div>}
  </section>;
}

function TrendGraphs({ rows, lang }: { rows: LocalOperationsBoardRow[]; lang: string }) {
  const c = businessLocalBoardCopy(lang), groups = new Map<string, LocalOperationsBoardRow[]>();
  for (const row of rows) {
    const key = JSON.stringify(['topic', 'metric', 'unit'].map(field => row.cells[field].trim()));
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return <div className="space-y-3"><p className="text-xs text-white/50">{c.chartScope}</p><div className="grid gap-3 md:grid-cols-2">{Array.from(groups, ([key, points]) => {
    const label = JSON.parse(key).join(' · '), dates = points.map(row => Date.parse(`${row.cells.date}T00:00:00.000Z`));
    const values = points.map(row => manualNumber(row.cells.value)!);
    const min = Math.min(...values), max = Math.max(...values), range = max - min;
    const distinctDates = new Set(dates).size === dates.length && dates.length >= 2;
    const coordinates = distinctDates && Number.isFinite(range) ? values.map((value, index) => ({
      x: 40 + (dates[index] - dates[0]) / (dates.at(-1)! - dates[0]) * 260,
      y: range === 0 ? 70 : 120 - (value - min) / range * 100,
    })) : null;
    return <figure key={key} className="rounded border border-white/10 p-2"><figcaption className="text-xs">{label}</figcaption>
      {!coordinates ? <p className="text-xs text-white/50">{distinctDates ? c.chartRange : c.chartNeedsDates}</p> : <svg role="img" aria-label={`${c.chart}: ${label}`} viewBox="0 0 340 150" className="w-full text-cyan-200">
        <text x="0" y="20" fontSize="10" fill="currentColor">{max}</text><text x="0" y="120" fontSize="10" fill="currentColor">{min}</text>
        <polyline fill="none" stroke="currentColor" strokeWidth="2" points={coordinates.map(point => `${point.x},${point.y}`).join(' ')} />
        {coordinates.map((point, index) => <circle key={points[index].id} cx={point.x} cy={point.y} r="3" fill="currentColor"><title>{`${points[index].cells.date}: ${points[index].cells.value} ${points[index].cells.unit} · ${points[index].cells.source}`}</title></circle>)}
        <text x="40" y="145" fontSize="10" fill="currentColor">{points[0].cells.date}</text><text x="300" y="145" textAnchor="end" fontSize="10" fill="currentColor">{points.at(-1)!.cells.date}</text>
      </svg>}
    </figure>;
  })}</div></div>;
}
