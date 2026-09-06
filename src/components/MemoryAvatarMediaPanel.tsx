import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileAudio, Image, Loader2, RotateCcw, Trash2, Upload, Video, X } from 'lucide-react';
import type { MemoryAvatar, MemoryAvatarMedia } from '../../shared/memory_avatar';
import { memoryAvatarMediaService } from '../services/memoryAvatarMediaService';
import { memoryAvatarService, MemoryAvatarApiError } from '../services/memoryAvatarService';
import { getStoredToken } from '../services/authService';
import { memoryMediaCopy } from '../i18n/locales/memoryMedia';
import { MemoryAvatarMediaPreview } from './MemoryAvatarMediaPreview';

interface Props {
  avatar: MemoryAvatar; ownerId: string; locale: 'zh' | 'en'; disabled?: boolean; active?: boolean;
  onUpdated: (avatar: MemoryAvatar) => void; onBeforeMutation?: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}
interface UploadItem {
  id: string; file: File; caption: string; title: string;
  state: 'queued' | 'uploading' | 'saved' | 'failed' | 'cancelled' | 'invalid';
  loaded: number; total?: number;
  errorCode?: string;
}
export const MEMORY_MEDIA_ACCEPT = '.jpg,.jpeg,.png,.webp,.wav,.mp3,.flac,.ogg,.m4a,.mp4,.mov,.webm';
function acceptable(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const kind = /^(jpg|jpeg|png|webp)$/.test(extension) ? 'image'
    : /^(wav|mp3|flac|ogg|m4a)$/.test(extension) || (extension === 'webm' && file.type.startsWith('audio/')) ? 'audio'
      : /^(mp4|mov|webm)$/.test(extension) ? 'video' : null;
  return Boolean(kind && file.size > 0 && file.size <= ({ image: 20, audio: 30, video: 200 }[kind] * 1024 * 1024));
}
const actionClass = 'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-[#d4c5a8] hover:bg-white/5 disabled:opacity-35';

export function MemoryAvatarMediaPanel(props: Props) {
  return <PrivateMediaPanel key={JSON.stringify([props.ownerId, props.avatar.id, getStoredToken()])} {...props} />;
}

function PrivateMediaPanel({ avatar, ownerId, locale, disabled = false, active = true, onUpdated, onBeforeMutation, onBusyChange }: Props) {
  const copy = memoryMediaCopy(locale);
  const [media, setMedia] = useState<MemoryAvatarMedia[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [caption, setCaption] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const identity = useRef({ ownerId, avatarId: avatar.id, token: getStoredToken() });
  const record = useRef(avatar);
  const queue = useRef<UploadItem[]>([]);
  const lease = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const activeUpload = useRef<{ id: string; controller: AbortController } | null>(null);
  const callbacks = useRef({ onUpdated, onBeforeMutation, onBusyChange });
  const listGeneration = useRef(0);
  const activeRef = useRef(active);
  callbacks.current = { onUpdated, onBeforeMutation, onBusyChange };
  activeRef.current = active;
  if (avatar.revision >= record.current.revision) record.current = avatar;
  const live = () => alive.current && identity.current.ownerId === ownerId && identity.current.avatarId === avatar.id && identity.current.token === getStoredToken();
  const makeController = () => { const controller = new AbortController(); controllers.current.add(controller); return controller; };
  const updateQueue = (update: (current: UploadItem[]) => UploadItem[]) => { if (live()) { queue.current = update(queue.current); setItems(queue.current); } };
  const publishAvatar = (next: MemoryAvatar) => {
    if (!live() || next.id !== identity.current.avatarId || next.revision < record.current.revision) return;
    record.current = next; callbacks.current.onUpdated(next);
  };
  const publishMedia = (next: MemoryAvatarMedia) => setMedia(rows => [...rows.filter(row => row.id !== next.id), next]);
  const setOperationBusy = (value: boolean) => { lease.current = value; if (live()) { setBusy(value); callbacks.current.onBusyChange?.(value); } };
  const errorText = (err: unknown) => err instanceof MemoryAvatarApiError && err.status === 409 ? copy.conflict : copy.actionFailed;

  // Revision updates keep this queue alive; only its original account/person owns it.
  useEffect(() => {
    const pendingControllers = controllers.current;
    const listVersion = listGeneration;
    alive.current = true;
    return () => {
      alive.current = false; listVersion.current++;
      pendingControllers.forEach(controller => controller.abort()); pendingControllers.clear();
      activeUpload.current = null; queue.current = [];
      callbacks.current.onBusyChange?.(false);
    };
  }, []);

  const reload = useCallback(async (showLoading = true) => {
    if (!alive.current || !activeRef.current || lease.current || identity.current.token !== getStoredToken()) return;
    const current = ++listGeneration.current;
    const controller = new AbortController(); controllers.current.add(controller);
    if (showLoading) { setLoading(true); setError(''); }
    try {
      const result = await memoryAvatarMediaService.list(identity.current.avatarId, controller.signal);
      if (!alive.current || controller.signal.aborted || current !== listGeneration.current || identity.current.token !== getStoredToken()) return;
      // Do not replace media with a response captured before a newer mutation.
      if (result.revision < record.current.revision) return;
      setMedia(result.media); setReady(true);
      if (result.revision > record.current.revision) {
        const next = await memoryAvatarService.get(identity.current.avatarId, controller.signal);
        if (!alive.current || controller.signal.aborted || current !== listGeneration.current || identity.current.token !== getStoredToken()) return;
        if (next.id === identity.current.avatarId && next.revision >= record.current.revision) {
          record.current = next; callbacks.current.onUpdated(next);
        }
      }
    } catch {
      if (alive.current && !controller.signal.aborted && current === listGeneration.current && identity.current.token === getStoredToken()) setError(copy.loadFailed);
    } finally {
      controllers.current.delete(controller);
      if (alive.current && current === listGeneration.current) setLoading(false);
    }
  }, [copy.loadFailed]);
  useEffect(() => { if (active) void reload(); }, [active, reload]);
  useEffect(() => {
    if (!active || !media.some(row => row.status === 'processing')) return;
    const timer = window.setInterval(() => { void reload(false); }, 2000);
    return () => window.clearInterval(timer);
  }, [active, media, reload]);

  const runUploads = async () => {
    if (!live() || lease.current || disabled) return;
    setOperationBusy(true); setError(''); setNotice(''); listGeneration.current++;
    try {
      await callbacks.current.onBeforeMutation?.();
      while (live()) {
        const item = queue.current.find(row => row.state === 'queued');
        if (!item) break;
        const controller = makeController(); activeUpload.current = { id: item.id, controller };
        updateQueue(rows => rows.map(row => row.id === item.id ? { ...row, state: 'uploading', loaded: 0, total: undefined } : row));
        try {
          const result = await memoryAvatarMediaService.upload(identity.current.avatarId, {
            file: item.file, title: item.title, caption: item.caption, clientRequestId: item.id, revision: record.current.revision,
          }, { signal: controller.signal, onProgress: progress => {
            if (live() && !controller.signal.aborted) updateQueue(rows => rows.map(row => row.id === item.id ? { ...row, ...progress } : row));
          } });
          if (!live() || controller.signal.aborted) continue;
          publishAvatar(result.avatar); publishMedia(result.media); setReady(true);
          updateQueue(rows => rows.map(row => row.id === item.id ? { ...row, state: 'saved' } : row));
        } catch (err) {
          if (!live()) break;
          updateQueue(rows => rows.map(row => row.id === item.id ? { ...row, state: controller.signal.aborted ? 'cancelled' : 'failed', errorCode: err instanceof MemoryAvatarApiError ? err.code : undefined } : row));
          if (err instanceof MemoryAvatarApiError && [401, 403, 404, 409, 410].includes(err.status)) {
            setError(errorText(err));
            updateQueue(rows => rows.map(row => row.state === 'queued' ? { ...row, state: 'failed' } : row));
            break;
          }
        } finally {
          controllers.current.delete(controller);
          if (activeUpload.current?.id === item.id) activeUpload.current = null;
        }
      }
    } catch (err) { if (live()) { setError(errorText(err)); updateQueue(rows => rows.map(row => row.state === 'queued' ? { ...row, state: 'failed' } : row)); } }
    finally { if (live()) { setLoading(false); setOperationBusy(false); } }
  };
  const select = (files: File[]) => {
    if (!live() || disabled || lease.current || !files.length) return;
    updateQueue(rows => [...rows, ...files.map(file => ({ id: crypto.randomUUID(), file, title: file.name.slice(0, 120), caption: caption.trim(), state: acceptable(file) ? 'queued' as const : 'invalid' as const, loaded: 0 }))]);
    void runUploads();
  };
  const retryUpload = (id: string) => {
    if (lease.current || disabled) return;
    updateQueue(rows => rows.map(row => row.id === id && ['failed', 'cancelled'].includes(row.state) ? { ...row, state: 'queued' } : row));
    void runUploads();
  };
  const mutate = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (!live() || lease.current || disabled) return;
    setOperationBusy(true); setError(''); setNotice(''); listGeneration.current++;
    const controller = makeController();
    try { await callbacks.current.onBeforeMutation?.(); if (live() && !controller.signal.aborted) await action(controller.signal); }
    catch (err) { if (live() && !controller.signal.aborted) setError(errorText(err)); }
    finally { controllers.current.delete(controller); if (live()) { setLoading(false); setOperationBusy(false); } }
  };
  const process = (row: MemoryAvatarMedia, cancel = false) => void mutate(async signal => {
    const result = await (cancel ? memoryAvatarMediaService.cancel : memoryAvatarMediaService.process)(identity.current.avatarId, row.id, record.current.revision, signal);
    if (live() && !signal.aborted) { publishAvatar(result.avatar); publishMedia(result.media); }
  });
  const portrait = (row: MemoryAvatarMedia) => void mutate(async signal => {
    const next = await memoryAvatarService.update(identity.current.avatarId, { revision: record.current.revision, presentation: { mode: 'portrait', mediaId: row.id } }, signal);
    if (live() && !signal.aborted) { publishAvatar(next); setNotice(copy.portraitSaved); }
  });
  const remove = (row: MemoryAvatarMedia) => {
    if (confirmDelete !== row.id) { setConfirmDelete(row.id); return; }
    void mutate(async signal => {
      const result = await memoryAvatarMediaService.remove(identity.current.avatarId, row.id, record.current.revision, signal);
      if (live() && !signal.aborted) {
        publishAvatar(result.avatar); setMedia(rows => rows.filter(item => item.id !== row.id));
        setExpanded(current => current === row.id ? null : current); setConfirmDelete(null); setNotice(copy.removed);
      }
    });
  };

  return <section aria-label={copy.title} className="space-y-4">
    <p className="text-xs leading-6 text-white/50">{copy.hint}</p>
    <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); select(Array.from(event.dataTransfer.files)); }} className="space-y-3 rounded-2xl border border-dashed border-[#c5baa2]/25 bg-white/[.02] p-4">
      <label className="block text-xs text-white/60">{copy.caption}<textarea value={caption} maxLength={2000} rows={2} disabled={busy || disabled} onChange={event => setCaption(event.target.value)} placeholder={copy.captionPlaceholder} className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-[#15191b] p-2 text-xs leading-5 text-white/80 outline-none" /></label>
      <input ref={fileInput} aria-label={copy.upload} type="file" multiple accept={MEMORY_MEDIA_ACCEPT} disabled={busy || disabled} className="hidden" onChange={event => { select(Array.from(event.target.files || [])); event.target.value = ''; }} />
      <button type="button" disabled={busy || disabled} onClick={() => fileInput.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c5baa2]/15 p-3 text-xs font-medium text-[#dfd1b6] disabled:opacity-35"><Upload size={15} />{copy.upload}</button>
      <p className="text-center text-[11px] text-white/35">{copy.drop}</p>
      <p className="text-[11px] leading-5 text-white/35">{copy.limits}</p>
    </div>
    {items.length > 0 && <div aria-label={copy.queue} className="space-y-2">{items.map(item => {
      const percent = item.total ? Math.min(100, Math.floor(item.loaded / item.total * 100)) : undefined;
      return <article key={item.id} className="rounded-xl border border-white/10 p-3">
        <div className="flex items-start gap-2"><p className="min-w-0 flex-1 break-all text-xs text-white/75">{item.file.name}</p>
          {item.state === 'uploading' ? <button type="button" aria-label={`${copy.cancelUpload}: ${item.file.name}`} className={actionClass} onClick={() => activeUpload.current?.id === item.id && activeUpload.current.controller.abort()}><X size={13} /></button>
            : <button type="button" disabled={busy} aria-label={`${copy.removeQueue}: ${item.file.name}`} className={actionClass} onClick={() => updateQueue(rows => rows.filter(row => row.id !== item.id))}><X size={13} /></button>}
        </div>
        {item.state === 'uploading' && <progress aria-label={`${copy.uploading}: ${item.file.name}`} max={100} value={percent} className="mt-2 h-1 w-full accent-[#c5baa2]" />}
        <p role={['failed', 'invalid'].includes(item.state) ? 'alert' : 'status'} className={`mt-1 text-[11px] leading-5 ${['failed', 'invalid'].includes(item.state) ? 'text-amber-100/75' : 'text-white/45'}`}>
          {item.state === 'uploading' ? percent === 100 ? copy.confirming : `${copy.uploading}${percent === undefined ? '…' : ` ${percent}%`}` : item.state === 'saved' ? copy.uploaded : item.state === 'queued' ? copy.waiting : item.state === 'invalid' ? copy.invalidFile : item.errorCode === 'media_tool_unavailable' ? copy.toolUnavailable : copy.uploadFailed}
        </p>
        {['failed', 'cancelled'].includes(item.state) && <button type="button" disabled={busy || disabled} onClick={() => retryUpload(item.id)} className={actionClass}><RotateCcw size={12} />{copy.retry}</button>}
      </article>;
    })}</div>}
    {error && <div role="alert" className="rounded-xl bg-amber-300/5 p-3 text-xs leading-6 text-amber-100/75">{error}<button type="button" disabled={busy} onClick={() => void reload()} className={`${actionClass} mt-1`}><RotateCcw size={12} />{copy.reload}</button></div>}
    {notice && <p role="status" className="flex items-start gap-2 text-xs leading-6 text-emerald-100/70"><Check size={14} className="mt-1 shrink-0" />{notice}</p>}
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-white/45"><Loader2 size={14} className="animate-spin" />{copy.reload}</p>}
    {ready && !media.length && <p className="rounded-xl border border-white/10 p-4 text-xs text-white/40">{copy.empty}</p>}
    {media.map(row => {
      const Icon = row.kind === 'image' ? Image : row.kind === 'video' ? Video : FileAudio;
      const selected = record.current.presentation?.mode === 'portrait' && record.current.presentation.mediaId === row.id;
      const selectable = (row.kind === 'image' && row.hasThumbnail) || (row.kind === 'video' && row.hasPoster);
      return <article key={row.id} className="overflow-hidden rounded-2xl border border-white/10 p-3">
        <div className="flex items-start gap-2"><Icon size={16} className="mt-0.5 shrink-0 text-[#c5baa2]" /><div className="min-w-0 flex-1"><h4 className="break-all text-xs leading-5 text-white/80">{row.title}</h4><p className="mt-1 text-[10px] text-white/35">{copy[row.kind]} · {(row.sizeBytes / 1024 / 1024).toFixed(1)} MB</p></div></div>
        <p role="status" className="mt-2 text-[11px] leading-5 text-white/50">{copy[row.status]}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          <button type="button" className={actionClass} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>{expanded === row.id ? copy.closePreview : copy.preview}</button>
          {selectable && <button type="button" disabled={busy || disabled || selected} onClick={() => portrait(row)} className={actionClass}>{selected && <Check size={12} />}{selected ? copy.selectedPortrait : copy.portrait}</button>}
          {row.status === 'processing' ? <button type="button" disabled={busy || disabled} onClick={() => process(row, true)} className={actionClass}>{copy.cancelProcess}</button>
            : row.status !== 'ready' && <button type="button" disabled={busy || disabled} onClick={() => process(row)} className={actionClass}>{row.status === 'stored' ? copy.process : copy.retryProcess}</button>}
        </div>
        {expanded === row.id && <div className="mt-3 space-y-3"><MemoryAvatarMediaPreview ownerId={ownerId} avatarId={avatar.id} media={row} locale={locale} enabled={active} />
          {row.caption && <p className="whitespace-pre-wrap break-words text-xs leading-6 text-white/55">{row.caption}</p>}
          <p className="text-[10px] leading-5 text-white/30">{copy.privatePreview}</p>
          <button type="button" disabled={busy || disabled} onClick={() => remove(row)} className={`${actionClass} !text-rose-200/70`}><Trash2 size={12} />{confirmDelete === row.id ? copy.confirmRemove : copy.remove}</button>
        </div>}
      </article>;
    })}
    <p className="text-[11px] leading-5 text-white/35">{copy.processHint}</p>
    <p className="text-[11px] leading-5 text-white/35">{copy.portraitHint}</p>
  </section>;
}
