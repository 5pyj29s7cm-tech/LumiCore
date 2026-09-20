import { useCallback, useEffect, useRef, useState } from 'react';
import { AvatarLiveInbox, type AvatarLiveComment, type AvatarLiveStageConfig, type AvatarLiveTurn } from '../../shared/avatar_live';
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
  const player = useRef<AvatarLivePlayback | null>(null), outputLevel = useRef(0), caption = useRef('');
  const closing = useRef<Promise<void> | null>(null), enabling = useRef(false), cleanupFailed = useRef(false);
  const currentConfig = useRef(config); currentConfig.current = config;
  const ready = useRef(false), mounted = useRef(true), epoch = useRef(0);
  const reading = useRef<AbortController | null>(null), replying = useRef<AbortController | null>(null);
  const turns = useRef<AvatarLiveTurn[]>([]), inbox = useRef(new AvatarLiveInbox());
  const pause = useCallback(() => {
    reading.current?.abort(); reading.current = null;
    replying.current?.abort(); replying.current = null;
    inbox.current.reset(); player.current?.stop(); caption.current = '';
    if (mounted.current) { setRunning(false); setBusy(false); setSpeaking(false); setSubtitle(''); setQueue({ queued: 0, skipped: 0 }); }
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
    setError(''); setComments([]); inbox.current.reset();
    const controller = new AbortController(); reading.current = controller; setRunning(true);
    let previous = '';
    const drain = async () => {
      while (!controller.signal.aborted && automatic && !replying.current) {
        const comment = inbox.current.take();
        setQueue({ queued: inbox.current.queued, skipped: inbox.current.skipped });
        if (!comment) return;
        await respond(comment, brief);
      }
    };
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const frame = await captureLiveScreen(); controller.signal.throwIfAborted();
          const image = await cropLiveScreen(frame, region); controller.signal.throwIfAborted();
          if (image !== previous) {
            const rows = await avatarLiveService.scan(currentConfig.current.avatarId, image, controller.signal);
            controller.signal.throwIfAborted(); previous = image;
            const fresh = inbox.current.ingest(rows);
            setComments(current => [...current, ...fresh].slice(-60));
            setQueue({ queued: inbox.current.queued, skipped: inbox.current.skipped });
            if (automatic) void drain();
          }
          await new Promise<void>(resolve => {
            const end = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', end); resolve(); };
            const timer = setTimeout(end, 3000); controller.signal.addEventListener('abort', end, { once: true });
          });
        }
      } catch (cause) {
        if (!controller.signal.aborted && mounted.current) { pause(); const code = cause instanceof Error ? cause.message : ''; setError(code === 'live_region_changed' || code === 'live_desktop_required' ? code : 'live_scan_failed'); }
      }
    })();
  }, [pause, respond]);
  const test = useCallback((text: string, nickname: string, brief: string) => {
    const comment: AvatarLiveComment = { id: crypto.randomUUID(), text, nickname, source: 'test', receivedAt: Date.now() };
    setComments(rows => [...rows, comment].slice(-60)); void respond(comment, brief);
  }, [respond]);
  return { running, busy, audioReady, audioPending, speaking, subtitle, stream, surface, outputLevel, comments, history, error, queue, enable, close, pause, start, respond, test };
}
