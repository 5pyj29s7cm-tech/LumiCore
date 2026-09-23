import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Maximize, Pause, ScanLine, Send, Volume2, VolumeX } from 'lucide-react';
import type { MemoryAvatar } from '../../shared/memory_avatar';
import { avatarLiveCopy } from '../i18n/locales/avatarLive';
import { useAvatarLivePreview } from '../hooks/useAvatarLivePreview';
import { captureLiveScreen, validateLiveRegion, type LiveScreenFrame, type LiveScreenRegion } from '../lib/avatarLiveScreen';
import { useAliyunAvatarConfig } from '../hooks/useAliyunAvatarConfig';
import { aliyunAvatarCopy } from '../i18n/locales/aliyunAvatar';
import { MemoryAvatarStage } from './MemoryAvatarStage';
import { MemoryAvatarPortraitStage } from './MemoryAvatarPortraitStage';

export function AvatarLiveWorkbench({ avatar, ownerId, locale, onClose }: { avatar: MemoryAvatar; ownerId: string; locale: 'zh' | 'en'; onClose: () => void }) {
  const copy = avatarLiveCopy(locale);
  const [brief, setBrief] = useState(''), [test, setTest] = useState(''), [automatic, setAutomatic] = useState(false), [consent, setConsent] = useState(false), [portrait, setPortrait] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [frame, setFrame] = useState<LiveScreenFrame | null>(null), [region, setRegion] = useState<LiveScreenRegion | null>(null), [selection, setSelection] = useState<LiveScreenRegion | null>(null);
  const [captureError, setCaptureError] = useState(''), [capturing, setCapturing] = useState(false);
  const captureEpoch = useRef(0);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const mediaId = avatar.presentation?.mode === 'portrait' ? avatar.presentation.mediaId : undefined;
  const aliyun = useAliyunAvatarConfig(ownerId, avatar.id);
  const usePortrait = portrait && Boolean(mediaId || aliyun?.enabled);
  const live = useAvatarLivePreview({ avatarId: avatar.id, ownerId, name: avatar.name, appearance: avatar.appearance, locale,
    ...(usePortrait ? { portraitMediaId: mediaId, portraitProvider: aliyun?.enabled ? 'aliyun' : 'did' } : {}) });
  const locked = live.running || live.busy;
  const hasBrief = Boolean(brief.trim() || avatar.publicBrief?.trim());
  const canReply = hasBrief && live.audioReady && !locked;
  useEffect(() => {
    if (!presenting) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setPresenting(false); } };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [presenting]);
  const button = 'inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm hover:bg-white/5 disabled:opacity-35';
  const select = async () => {
    live.pause(); setCaptureError(''); setCapturing(true); const current = ++captureEpoch.current;
    try { const next = await captureLiveScreen(); if (current === captureEpoch.current) { setFrame(next); setSelection(null); } }
    catch (cause) { if (current === captureEpoch.current) setCaptureError(cause instanceof Error ? cause.message : 'live_capture_failed'); }
    finally { if (current === captureEpoch.current) setCapturing(false); }
  };
  const errorText = captureError ? captureError === 'live_desktop_required' ? copy.desktopError : copy.captureError
    : live.error === 'live_region_changed' ? copy.regionError : live.error === 'live_desktop_required' ? copy.desktopError
    : live.error === 'live_audio_blocked' ? copy.audioError : live.error === 'live_cleanup_unconfirmed' ? copy.cleanupError : live.error === 'live_scan_failed' ? copy.scanError
      : live.error === 'live_scan_retrying' ? `${copy.scanRetrying} (${live.scanRetry}/3)`
        : ['live_unauthorized', 'live_forbidden', 'live_avatar_unavailable', 'live_personal_scope_required'].includes(live.error) ? copy.accessError : copy.error;
  return <section className="fixed inset-0 z-[215] flex flex-col overflow-hidden bg-[#131d1f] text-[#e4e8de]">
    <header hidden={presenting} className={`${presenting ? 'hidden' : 'flex'} shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6 py-4`}><button type="button" onClick={() => { captureEpoch.current++; void live.close(); onClose(); }} className="flex items-center gap-2 text-sm"><ArrowLeft size={18} />{copy.back}</button><strong>{copy.title} · {avatar.name}</strong><button type="button" onClick={live.pause} className={`${button} bg-amber-100/10 text-amber-100`}><Pause size={16} />{copy.stop}</button></header>
    <div className={`${presenting ? '' : 'grid gap-6 overflow-y-auto p-6 lg:grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)]'} min-h-0 flex-1`}>
      <div hidden={presenting} className={`${presenting ? 'hidden' : ''} space-y-5`}><p className="text-sm leading-6 text-white/60">{copy.intro}</p>
        {avatar.publicBrief && <details className="rounded-xl border border-white/10 bg-black/10 p-4"><summary className="cursor-pointer text-sm text-[#c4d5b1]">{copy.savedBrief}</summary><p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-white/65">{avatar.publicBrief}</p><p className="mt-3 text-xs text-white/40">{copy.savedBriefHint}</p></details>}
        <label className="block text-sm">{copy.brief}<textarea value={brief} disabled={locked} maxLength={4000} onChange={event => setBrief(event.target.value)} placeholder={copy.briefPlaceholder} className="mt-2 h-36 w-full resize-y rounded-xl border border-white/10 bg-black/15 p-4 text-sm leading-6 outline-none focus:border-[#b9c49e]" /></label>
        <div className="space-y-3 rounded-2xl border border-white/10 p-4"><div className="flex flex-wrap gap-2"><button type="button" disabled={live.audioPending} onClick={() => { if (live.audioReady) void live.close(); else void live.enable(); }} className={button}>{live.audioReady ? <VolumeX size={16} /> : <Volume2 size={16} />}{live.audioPending ? copy.audioPending : live.audioReady ? copy.disable : copy.enable}</button><button type="button" onClick={() => setPresenting(true)} className={button}><Maximize size={16} />{copy.present}</button></div><p className="text-xs leading-5 text-white/55">{copy.presentationHint}</p><p role="status" className={`text-xs ${live.audioReady ? 'text-green-200' : 'text-white/55'}`}>{live.audioReady ? copy.audioReady : copy.audioMissing}</p>
          {(mediaId || aliyun?.enabled) && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={portrait} disabled={live.audioReady || live.audioPending} onChange={event => setPortrait(event.target.checked)} />{aliyun?.enabled ? aliyunAvatarCopy(locale).live : copy.portrait}</label><p className="text-xs leading-5 text-white/45">{aliyun?.enabled ? aliyunAvatarCopy(locale).liveHint : copy.portraitHint}</p></>}
        </div>
        <div className="space-y-3 rounded-2xl border border-white/10 p-4"><button type="button" onClick={() => void select()} disabled={capturing || locked} className={button}><ScanLine size={16} />{copy.select}</button>{region && <p className="text-xs text-green-200">{copy.region} · {region.width} × {region.height}</p>}
          <label className="flex items-start gap-2 text-xs leading-5"><input className="mt-1" type="checkbox" checked={consent} disabled={locked} onChange={event => setConsent(event.target.checked)} />{copy.consent}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={automatic} disabled={locked} onChange={event => setAutomatic(event.target.checked)} />{copy.auto}</label><p className="text-xs leading-5 text-white/45">{copy.autoHint}</p>
          <button type="button" disabled={!region || !consent || !canReply || capturing} onClick={() => region && live.start(region, brief, automatic)} className={`${button} bg-[#b9c49e] text-[#152021]`}>{copy.start}</button><span className="ml-3 text-xs text-white/60">{live.running ? copy.running : copy.idle}</span>
        </div>
        <form onSubmit={event => { event.preventDefault(); if (test.trim() && canReply) { live.test(test.trim(), copy.viewer, brief); setTest(''); } }} className="space-y-2"><label className="text-sm" htmlFor="avatar-live-test">{copy.test}</label><div className="flex gap-2"><input id="avatar-live-test" value={test} maxLength={500} onChange={event => setTest(event.target.value)} placeholder={copy.testPlaceholder} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-sm" /><button type="submit" disabled={!test.trim() || !canReply} className={button} title={copy.testSend}><Send size={17} /><span className="sr-only">{copy.testSend}</span></button></div></form>
        <p className="text-xs leading-6 text-white/40">{copy.private}</p>
      </div>
      <div className={presenting ? '' : 'space-y-5'}>
        <div role="region" aria-label={copy.preview} className={presenting ? 'group fixed inset-0 z-10 overflow-hidden bg-[#101b1c]' : 'group relative h-[420px] min-h-72 overflow-hidden rounded-2xl border border-white/10 bg-[#101b1c]'}>
          {usePortrait ? <MemoryAvatarPortraitStage ownerId={ownerId} avatarId={avatar.id} mediaId={mediaId} stream={live.stream} surface={live.surface} speaking={live.speaking} name={avatar.name} locale={locale} />
            : <MemoryAvatarStage avatarId={avatar.id} presentation={avatar.presentation} appearance={avatar.appearance} outputLevelRef={live.outputLevel} state={live.speaking ? 'speaking' : 'idle'} name={avatar.name} locale={locale} active />}
          <span className="pointer-events-none absolute left-5 top-5 rounded-full bg-black/30 px-4 py-2 text-xs text-white/75">{copy.ready}</span>
          {live.subtitle && <p aria-live="polite" className="absolute inset-x-6 bottom-8 rounded-2xl bg-black/65 px-5 py-3 text-center text-lg leading-relaxed">{live.subtitle}</p>}
          {presenting && <div className="absolute right-5 top-5 flex gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"><button type="button" onClick={() => setPresenting(false)} className={`${button} bg-black/75`}><ArrowLeft size={16} />{copy.controls}</button><button type="button" onClick={live.pause} className={`${button} bg-black/75`}><Pause size={16} />{copy.stop}</button></div>}
          {presenting && !live.audioReady && <button type="button" disabled={live.audioPending} onClick={() => void live.enable()} className={`${button} absolute bottom-8 left-1/2 -translate-x-1/2 bg-black/75`}><Volume2 size={16} />{live.audioPending ? copy.audioPending : copy.enable}</button>}
          {presenting && (live.error || captureError) && <p role="alert" className="absolute inset-x-6 bottom-24 rounded-xl bg-black/80 p-4 text-sm text-amber-100">{errorText}</p>}
        </div>
        <div hidden={presenting} className={`${presenting ? 'hidden' : ''} space-y-5`}>
        {(live.error || captureError) && <p role="alert" className="rounded-xl border border-amber-200/20 bg-amber-100/5 p-4 text-sm leading-6 text-amber-100">{errorText}</p>}
        {live.error === 'live_scan_failed' && <button type="button" disabled={!live.audioReady} onClick={live.retryReading} className={button}>{copy.retryReading}</button>}
        {live.lastScan && <p role="status" className="text-xs leading-5 text-white/60">{copy.lastScan} {new Date(live.lastScan.at).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US')} · {copy.visible} {live.lastScan.visible} · {copy.newComments} {live.lastScan.fresh}{live.lastScan.visible === 0 ? ` · ${copy.emptyScan}` : live.comments.length === 0 ? ` · ${copy.baseline}` : ''}</p>}
        <div className="flex items-center justify-between text-xs text-white/50"><span>{live.busy ? copy.busy : copy.comments}</span><span>{copy.queue} {live.queue.queued} · {copy.skipped} {live.queue.skipped}</span></div>
        <div className="min-h-40 space-y-2 rounded-2xl border border-white/10 p-4">{!live.comments.length && <p className="text-sm text-white/40">{copy.empty}</p>}{live.comments.slice(-20).map(row => <div key={row.id} className="flex items-start gap-3 rounded-lg bg-white/[.035] p-3"><div className="min-w-0 flex-1"><p className="text-xs text-[#b9c49e]">{row.nickname}</p><p className="mt-1 break-words text-sm leading-6">{row.text}</p></div>{!automatic && <button type="button" disabled={live.busy || !live.audioReady || !hasBrief || Boolean(row.status) || Date.now() - row.receivedAt > 60_000} onClick={() => void live.respond(row, brief)} className="shrink-0 text-xs text-[#b9c49e] disabled:opacity-30">{row.status === 'done' ? '✓' : copy.respond}</button>}</div>)}</div>
        <h3 className="text-sm text-white/70">{copy.history}</h3><div className="space-y-3">{live.history.slice(-10).map((row, index) => <div key={index} className="rounded-xl bg-white/[.035] p-4 text-sm leading-6"><p className="text-white/40">{row.nickname}: {row.comment}</p><p className="mt-2">{row.reply}</p></div>)}</div>
        {live.historyError && <p role="status" className="text-xs text-amber-100">{copy.historyError}</p>}
        <details className="rounded-xl border border-white/10 p-4"><summary className="cursor-pointer text-sm">{copy.archive}</summary><div className="mt-3 max-h-80 space-y-3 overflow-y-auto">{live.archivedHistory.map(row => <div key={row.requestId} className="rounded-lg bg-white/[.035] p-3 text-sm leading-6"><p className="text-xs text-white/40">{new Date(row.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')} · {row.spokenAt ? copy.spoken : copy.generated}</p><p className="text-white/60">{row.nickname}: {row.comment}</p><p>{row.reply}</p></div>)}</div></details>
        </div>
      </div>
    </div>
    {frame && <div role="dialog" aria-modal="true" aria-label={copy.select} className="absolute inset-0 z-10 flex flex-col gap-4 overflow-auto bg-[#10191b] p-6"><p className="max-w-4xl text-sm leading-6 text-white/70">{copy.selectHint}</p><div className="min-h-0 flex-1 overflow-auto"><div className="relative mx-auto w-full max-w-[1400px] touch-none select-none" onPointerDown={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      origin.current = { x: Math.round((event.clientX - bounds.left) / bounds.width * frame.width), y: Math.round((event.clientY - bounds.top) / bounds.height * frame.height) };
      event.currentTarget.setPointerCapture(event.pointerId); setSelection(null);
    }} onPointerMove={event => {
      if (!origin.current) return; const bounds = event.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(frame.width, Math.round((event.clientX - bounds.left) / bounds.width * frame.width))), y = Math.max(0, Math.min(frame.height, Math.round((event.clientY - bounds.top) / bounds.height * frame.height)));
      setSelection({ x: Math.min(x, origin.current.x), y: Math.min(y, origin.current.y), width: Math.abs(x - origin.current.x), height: Math.abs(y - origin.current.y), screenWidth: frame.width, screenHeight: frame.height, screenX: frame.screen_x, screenY: frame.screen_y });
    }} onPointerUp={() => { origin.current = null; }} onPointerCancel={() => { origin.current = null; }}><img src={`data:image/png;base64,${frame.image_base64}`} draggable={false} alt={copy.select} className="pointer-events-none block w-full" />{selection && <div className="pointer-events-none absolute border-2 border-lime-300 bg-lime-300/15" style={{ left: `${selection.x / frame.width * 100}%`, top: `${selection.y / frame.height * 100}%`, width: `${selection.width / frame.width * 100}%`, height: `${selection.height / frame.height * 100}%` }} />}</div></div><div className="flex gap-3"><button type="button" disabled={!selection || selection.width < 32 || selection.height < 32} onClick={() => { if (selection) { validateLiveRegion(frame, selection); setRegion(selection); setFrame(null); setConsent(false); } }} className={button}>{copy.confirm}</button><button type="button" onClick={() => setFrame(null)} className={button}>{copy.cancel}</button></div></div>}
  </section>;
}
