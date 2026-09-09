import { useCallback, useEffect, useRef, useState } from 'react';
import { synthesizeSpeech, VOICE_PROVIDER_CHANGED_EVENT } from '../services/voiceService';

// Auditions share one playback owner, independent of how many cards/pickers
// are mounted. This does not own or schedule conversational audio.
let stopCurrentPreview: (() => void) | null = null;

export function useVoicePreview(onError: (message?: string) => void) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  const mounted = useRef(true);
  const current = useRef<{
    id: string; controller: AbortController; audio?: HTMLAudioElement; url?: string;
  } | null>(null);

  const stop = useCallback(() => {
    const playback = current.current;
    current.current = null;
    if (stopCurrentPreview === stop) stopCurrentPreview = null;
    if (playback) {
      playback.controller.abort();
      if (playback.audio) {
        playback.audio.onended = null;
        playback.audio.onerror = null;
        try {
          playback.audio.pause();
          playback.audio.removeAttribute('src');
          playback.audio.load();
        } catch { /* A detached media element must not retain its object URL. */ }
      }
      if (playback.url) URL.revokeObjectURL(playback.url);
    }
    if (mounted.current) { setPlayingId(null); setIsLoading(false); }
  }, []);

  const play = useCallback(async (voice: any, sampleText: string) => {
    const id = String(voice.voiceId || voice.id);
    if (current.current?.id === id) { stop(); return; }
    stopCurrentPreview?.();
    if (!mounted.current) return;
    const playback = { id, controller: new AbortController() } as NonNullable<typeof current.current>;
    current.current = playback;
    stopCurrentPreview = stop;
    setPlayingId(id);
    setIsLoading(true);
    try {
      let source = voice.provider === 'ark' && voice.demoAudio ? String(voice.demoAudio) : '';
      if (!source) {
        const buffer = await synthesizeSpeech(sampleText, id, voice.provider, voice.model, playback.controller.signal);
        if (playback.controller.signal.aborted || current.current !== playback) return;
        source = playback.url = URL.createObjectURL(new Blob([buffer], { type: 'audio/mp3' }));
      }
      if (playback.controller.signal.aborted || current.current !== playback) return;
      const audio = playback.audio = new Audio(source);
      audio.onended = () => { if (current.current === playback) stop(); };
      audio.onerror = () => {
        if (current.current !== playback) return;
        stop();
        errorCallback.current();
      };
      await audio.play();
      if (current.current === playback && mounted.current) setIsLoading(false);
    } catch (error: any) {
      if (playback.controller.signal.aborted || current.current !== playback) return;
      stop();
      errorCallback.current(error?.message);
    }
  }, [stop]);

  useEffect(() => {
    mounted.current = true;
    window.addEventListener(VOICE_PROVIDER_CHANGED_EVENT, stop);
    return () => {
      mounted.current = false;
      window.removeEventListener(VOICE_PROVIDER_CHANGED_EVENT, stop);
      stop();
    };
  }, [stop]);

  return { playingId, isLoading, play, stop };
}
