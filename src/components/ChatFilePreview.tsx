import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, X } from 'lucide-react';
import { apiFetch } from '@/services/apiClient';
import { localFileResourcePath, saveFileResource } from '@/services/fileResource';
import { useFileResource } from '@/hooks/useFileResource';
import { chatArtifactKind, type ChatDocumentPreview } from '../../shared/chat_artifacts';
import { chatPreviewCopy } from '@/i18n/locales/chatPreview';

export type ChatPreviewFile = { fileName: string; url: string; path?: string; kind?: string };

export function ChatFilePreview({ file, isZh, onClose, onOpenSystem }: {
  file: ChatPreviewFile; isZh: boolean; onClose: () => void; onOpenSystem?: () => Promise<unknown>;
}) {
  const copy = chatPreviewCopy(isZh);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<ChatDocumentPreview>();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(false);
  const kind = file.kind || chatArtifactKind(file.fileName);
  const media = ['image', 'video', 'audio'].includes(kind);
  const resource = useFileResource(media ? file.url : undefined);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], video[controls], audio[controls], [tabindex="0"]') || [])];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    setPreview(undefined); setError(false); setZoom(false);
    if (media) return;
    const controller = new AbortController();
    const local = localFileResourcePath(file.url);
    if (!local) { setPreview({ kind: 'unsupported' }); return; }
    const url = new URL(local, 'http://local.invalid');
    url.searchParams.set('preview', '1');
    void apiFetch(`${url.pathname}${url.search}`, { signal: controller.signal, redirect: 'error' })
      .then(async response => {
        if (!response.ok) throw new Error('Preview unavailable');
        const data = await response.json();
        if (!controller.signal.aborted) setPreview(data);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [file.url, media, attempt]);

  const save = async () => {
    setSaving(true);
    try { await saveFileResource(file.url, file.fileName); }
    catch { setError(true); }
    finally { setSaving(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-6" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${copy.preview}: ${file.fileName}`}
        className="flex max-h-[90vh] min-h-[240px] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-black/10 bg-white text-slate-800 shadow-2xl outline-none dark:border-white/15 dark:bg-slate-950 dark:text-slate-100">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-500/20 p-4">
          <div className="min-w-0 flex-1"><div className="text-xs opacity-60">{copy.preview}</div><div className="truncate font-semibold" title={file.path}>{file.fileName}</div></div>
          <button type="button" className="flex items-center gap-1 rounded-lg border border-slate-500/25 px-3 py-2 text-xs" onClick={() => void save()} disabled={saving}><Download size={14} />{copy.download}</button>
          {onOpenSystem && <button type="button" className="flex items-center gap-1 rounded-lg border border-slate-500/25 px-3 py-2 text-xs" onClick={() => { void onOpenSystem().catch(() => setError(true)); }}><ExternalLink size={14} />{copy.open}</button>}
          <button type="button" className="rounded-lg p-2 hover:bg-slate-500/15" aria-label={copy.close} onClick={onClose}><X size={20} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {(error || resource.error) && <div role="alert" className="mb-4 rounded-xl bg-amber-500/10 p-4 text-sm">{media && !resource.error ? copy.mediaFailed : copy.failed}
            {!media && <button type="button" onClick={() => setAttempt(value => value + 1)} className="ml-3 underline">{copy.retry}</button>}
          </div>}
          {!error && !resource.error && (media ? !resource.url : !preview) && <p role="status">{copy.loading}</p>}
          {kind === 'image' && resource.url && <button type="button" className="block min-h-0 w-full" aria-label={copy.zoom} onClick={() => setZoom(value => !value)}><img src={resource.url} alt={file.fileName} onError={() => setError(true)} className={zoom ? 'mx-auto max-w-none' : 'mx-auto max-h-[68vh] max-w-full object-contain'} /></button>}
          {kind === 'video' && resource.url && <video src={resource.url} controls playsInline preload="metadata" onError={() => setError(true)} className="mx-auto max-h-[68vh] w-full rounded-xl bg-black" aria-label={file.fileName} />}
          {kind === 'audio' && resource.url && <audio src={resource.url} controls preload="metadata" onError={() => setError(true)} className="w-full" aria-label={file.fileName} />}
          {preview?.extracted && <p className="mb-3 text-xs opacity-60">{copy.extracted}</p>}
          {preview?.kind === 'text' && <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-7">{preview.text?.trim() ? preview.text : copy.empty}</pre>}
          {preview?.kind === 'table' && preview.sections?.map((section, index) => <section key={index} className="mb-6"><h3 className="mb-2 font-semibold">{section.name}</h3><div className="overflow-auto rounded-xl border border-slate-500/20"><table className="w-full border-collapse text-left text-sm"><tbody>{section.rows.map((row, r) => <tr key={r} className={r === 0 ? 'bg-slate-500/10 font-semibold' : ''}>{row.map((cell, c) => <td key={c} className="max-w-md whitespace-pre-wrap break-words border border-slate-500/15 px-3 py-2">{cell}</td>)}</tr>)}</tbody></table></div></section>)}
          {preview?.kind === 'unsupported' && <p className="p-6 text-sm">{copy.unsupported}</p>}
          {preview?.truncated && <p className="mt-3 text-xs opacity-60">{copy.partial}</p>}
        </div>
      </div>
    </div>, document.body,
  );
}
