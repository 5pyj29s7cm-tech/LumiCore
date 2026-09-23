import { useCallback, useEffect, useRef, useState } from 'react';
import { AvatarLiveInbox, type AvatarLiveComment, type AvatarLiveStageConfig, type AvatarLiveTurn, type AvatarLiveHistoryTurn } from '../../shared/avatar_live';
import { avatarLiveService } from '../services/avatarLiveService';
import { captureLiveScreen, cropLiveScreen, type LiveScreenRegion } from '../lib/avatarLiveScreen';
import { AvatarLivePlayback } from '../lib/avatarLivePlayback';

type Row = AvatarLiveComment & { status?: 'pending' | 'done' | 'failed' };
export function useAvatarLivePreview(config: AvatarLiveStageConfig) {
  const [running, setRunning] = useState(false), [busy, setBusy] = useState(false), [audioReady, setAudioReady] = useState(false), [audioPending, setAudioPending] = useState(false);
  const [speaking, setSpeaking] = useState(false), [subtitle, setSubtitle] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null), [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [comments, setComments] = useState<Row[]>([]), [history, setHistory] = useState<AvatarLiveTurn[]>([]);
  const [error, setError] = useState(''), [queue, setQueue] = useState({ queued: 0, skipped: 0 });
  const [scanRetry, setScanRetry] = useState(0);
  const [lastScan, setLastScan] = useState<{ at: number; visible: number; fresh: number } | null>(null);
  const [archivedHistory, setArchivedHistory] = useState<AvatarLiveHistoryTurn[]>([]), [historyError, setHistoryError] = useState(false);
  const player = useRef<AvatarLivePlayback | null>(null), outputLevel = useRef(0), caption = useRef('');
  const closing = useRef<Promise<void> | null>(null), enabling = useRef(false), cleanupFailed = useRef(false);
  const currentConfig = useRef(config); currentConfig.current = config;
  const ready = useRef(false), mounted = useRef(true), epoch = useRef(0);
  const reading = useRef<AbortController | null>(null), replying = useRef<AbortController | null>(null);
  const turns = useRef<AvatarLiveTurn[]>([]), inbox = useRef(new AvatarLiveInbox());
  const resumeReading = useRef<(() => void) | null>(null);
  const pause = useCallback(() => {
    reading.current?.abort(); reading.current = null;
    resumeReading.current = null;
    replying.current?.abort(); replying.current = null;
    inbox.current.reset(); player.current?.stop(); caption.current = '';
    if (mounted.current) { setRunning(false); setBusy(false); setSpeaking(false); setSubtitle(''); setScanRetry(0); setQueue({ queued: 0, skipped: 0 }); }
  }, []);
  const close = useCallback(() => {
    if (closing.current) return closing.current;
    epoch.current++; pause();
    const playback = player.current; player.current = null; ready.current = false;
    if (mounted.current) { setAudioReady(false); setAudioPending(true); setStream(null); setSurface(null); }
    // This runs in the main renderer, so hiding controls or leaving the page
    // cannot destroy a second WebView before its cloud-session cleanup finishes.
    const pending = (playback?.closeAndWait() || Promise.resolve()).catch(() => {
      cleanupFailed.current = true;
      if (mounted.current) setError('live_cleanup_unconfirmed');
    }).finally(() => {
      if (closing.current === pending) closing.current = null;
      if (mounted.current) setAudioPending(false);
    });
    closing.current = pending;
    return pending;
  }, [pause]);
  const enable = useCallback(async () => {
    if (ready.current || enabling.current || closing.current || cleanupFailed.current) return;
    enabling.current = true; setAudioPending(true); setError('');
    const current = ++epoch.current;
    const active = () => mounted.current && current === epoch.current;
    const playback = new AvatarLivePlayback(currentConfig.current, {
      level: outputLevel,
      stream: value => { if (active()) setStream(value); },
      surface: value => { if (active()) setSurface(value); },
      speaking: value => { if (active()) { setSpeaking(value); setSubtitle(value ? caption.current : ''); } },
    });
    player.current = playback;
    try {
      await playback.enable();
      if (active()) { ready.current = true; setAudioReady(true); }
    } catch { if (active()) { void close(); setError('live_audio_blocked'); } }
    finally { enabling.current = false; if (active()) setAudioPending(false); }
  }, [close]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void close(); };
  }, [close]);
  useEffect(() => {
    const controller = new AbortController(); setArchivedHistory([]); setHistoryError(false);
    void avatarLiveService.history(config.avatarId, controller.signal).then(rows => {
      if (!controller.signal.aborted) setArchivedHistory(rows);
    }).catch(() => { if (!controller.signal.aborted) setHistoryError(true); });
    return () => controller.abort();
  }, [config.avatarId, config.ownerId]);

  const respond = useCallback(async (comment: AvatarLiveComment, brief: string) => {
    if (replying.current) return;
    if (!ready.current) { setError('live_audio_blocked'); return; }
    const controller = new AbortController(); replying.current = controller; setBusy(true); setError('');
    setComments(rows => rows.map(row => row.id === comment.id ? { ...row, status: 'pending' } : row));
    const timeout = setTimeout(() => controller.abort(), 140_000);
    const stopPlayback = () => player.current?.stop();
    controller.signal.addEventListener('abort', stopPlayback, { once: true });
    try {
      const reply = await avatarLiveService.reply(currentConfig.current.avatarId, { brief, comment, history: turns.current.slice(-8), locale: currentConfig.current.locale }, controller.signal);
      controller.signal.throwIfAborted();
      const playback = player.current;
      if (!ready.current || !playback) throw new Error('live_audio_blocked');
      caption.current = reply.text;
      await playback.play(reply, crypto.randomUUID());
      controller.signal.throwIfAborted();
      const turn = { nickname: comment.nickname, comment: comment.text, reply: reply.text };
      turns.current = [...turns.current, turn].slice(-8);
      setHistory(rows => [...rows, turn].slice(-30));
      setComments(rows => rows.map(row => row.id === comment.id ? { ...row, status: 'done' } : row));
      if (reply.requestId) {
        try {
          await avatarLiveService.acknowledge(currentConfig.current.avatarId, reply.requestId, controller.signal);
          const rows = await avatarLiveService.history(currentConfig.current.avatarId, controller.signal);
          if (mounted.current && !controller.signal.aborted) { setArchivedHistory(rows); setHistoryError(false); }
        } catch {
          // Sound already played. A missing archival acknowledgement must not
          // change it to failed speech or cause automatic audio replay.
          if (mounted.current) setHistoryError(true);
        }
      }
    } catch (cause) {
      if (mounted.current) setComments(rows => rows.map(row => row.id === comment.id ? { ...row, status: 'failed' } : row));
      if (!controller.signal.aborted && mounted.current) { pause(); setError(cause instanceof Error ? cause.message : 'live_service_unavailable'); }
      else if (replying.current === controller && mounted.current) { pause(); setError('live_service_unavailable'); }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', stopPlayback);
      if (replying.current === controller) { replying.current = null; if (mounted.current) setBusy(false); }
    }
  }, [pause]);

  const start = useCallback((region: LiveScreenRegion, brief: string, automatic: boolean) => {
    if (reading.current) return;
    if (!ready.current) { setError('live_audio_blocked'); return; }
    setError(''); setScanRetry(0); setLastScan(null); setComments([]); inbox.current.reset();
    let controller = new AbortController(); reading.current = controller; setRunning(true);
    let previous = '';
    const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve(); };
      const timer = setTimeout(end, milliseconds); signal.addEventListener('abort', end, { once: true });
    });
    const drain = async () => {
      while (!controller.signal.aborted && automatic && !replying.current) {
        const comment = inbox.current.take();
        setQueue({ queued: inbox.current.queued, skipped: inbox.current.skipped });
        if (!comment) return;
        await respond(comment, brief);
      }
    };
    const read = async () => {
      const current = controller;
      let failures = 0;
      while (!current.signal.aborted) {
        try {
          const frame = await captureLiveScreen(); controller.signal.throwIfAborted();
          const image = await cropLiveScreen(frame, region); controller.signal.throwIfAborted();
          if (image !== previous) {
            const rows = await avatarLiveService.scan(currentConfig.current.avatarId, image, controller.signal);
            controller.signal.throwIfAborted(); previous = image;
            const fresh = inbox.current.ingest(rows);
            setLastScan({ at: Date.now(), visible: rows.length, fresh: fresh.length });
            setComments(current => [...current, ...fresh].slice(-60));
            setQueue({ queued: inbox.current.queued, skipped: inbox.current.skipped });
            if (automatic) void drain();
          }
          failures = 0; setScanRetry(0); setError('');
          await wait(3000, current.signal);
        } catch (cause) {
          if (current.signal.aborted || !mounted.current || reading.current !== current) return;
          const code = cause instanceof Error ? cause.message : '';
          const fatal = ['live_region_changed', 'live_desktop_required', 'live_avatar_unavailable', 'live_personal_scope_required', 'live_unauthorized', 'live_forbidden'].includes(code);
          failures++;
          // A failed read must not interrupt a reply already playing, erase
          // deduplication, or turn previously visible comments into new input.
          if (!fatal && failures <= 3) {
            setScanRetry(failures); setError('live_scan_retrying');
            await wait(Math.min(12_000, 3000 * 2 ** (failures - 1)), current.signal);
            continue;
          }
          reading.current = null; setRunning(false); setScanRetry(0);
          setError(fatal ? code : 'live_scan_failed');
          resumeReading.current = fatal ? null : () => {
            if (reading.current || !ready.current) return;
            controller = new AbortController(); reading.current = controller;
            setRunning(true); setError(''); resumeReading.current = null; void read();
          };
          return;
        }
      }
    };
    resumeReading.current = null; void read();
  }, [respond]);
  const retryReading = useCallback(() => resumeReading.current?.(), []);
  const test = useCallback((text: string, nickname: string, brief: string) => {
    const comment: AvatarLiveComment = { id: crypto.randomUUID(), text, nickname, source: 'test', receivedAt: Date.now() };
    setComments(rows => [...rows, comment].slice(-60)); void respond(comment, brief);
  }, [respond]);
  return { running, busy, audioReady, audioPending, speaking, subtitle, stream, surface, outputLevel, comments, history, archivedHistory, historyError, error, queue, scanRetry, lastScan, retryReading, enable, close, pause, start, respond, test };
}
