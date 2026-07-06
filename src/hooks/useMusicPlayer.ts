import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useSocket } from './useSocket';

const _listeners = new Set<() => void>();
const _stateListeners = new Set<() => void>();

export interface MusicScene {
  colors: { bg: string; primary: string; secondary: string; accent: string };
  scene: string;
  particles: string;
  lyricsStyle: string;
  intensity: number;
  reason: string;
  terrainColors?: string[];
  emotion?: { valence: number; arousal: number };
}

export interface MusicTrack {
  name: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
  duration?: number;
}

export interface MusicLyricLine {
  time: number;
  text: string;
}

export interface MusicQueueItem {
  track: MusicTrack;
  audioUrl?: string;
  encryptedId?: string;
  originalId?: string;
}

export interface MusicAtmosphere {
  track: MusicTrack;
  mood: string;
  weather?: string;
  lumiReason?: string;
  audioUrl?: string;
  nativePlayback?: boolean;
  queue?: MusicQueueItem[];
  queueIndex?: number;
  lyrics?: MusicLyricLine[];
  trackKey?: string;
  scene?: MusicScene;
}

export interface MusicPlayerState {
  isPlaying: boolean;
  track: MusicTrack | null;
  progress: number;
  duration: number;
  volume: number;
  mood: string;
  weather?: string;
  lumiReason?: string;
  lyrics: MusicLyricLine[];
  trackKey?: string | null;
  scene: MusicScene | null;
  queue: MusicQueueItem[];
  queueIndex: number;
  visible: boolean;
  source: 'netease' | 'minimax' | 'url' | null;
  lastError?: string;
}

const DEFAULT_MUSIC_PLAYER_STATE: MusicPlayerState = {
  isPlaying: false,
  track: null,
  progress: 0,
  duration: 0,
  volume: 70,
  mood: 'peaceful',
  weather: undefined,
  lumiReason: undefined,
  lyrics: [],
  trackKey: null,
  scene: null,
  queue: [],
  queueIndex: -1,
  visible: false,
  source: null,
};

let _musicSnapshot: MusicPlayerState = DEFAULT_MUSIC_PLAYER_STATE;
let _musicVisible = false;
let _audio: HTMLAudioElement | null = null;
let _boundSocket: any = null;
let _socketHandlers: Record<string, (...args: any[]) => void> | null = null;
let _failedQueueIndexes = new Set<number>();
let _duckingReasons = new Map<string, number>();
let _duckingLevel = 1;
let _playbackWatchdog: ReturnType<typeof setTimeout> | null = null;
let _playAttempt = 0;
let _nativeProgressTimer: ReturnType<typeof setInterval> | null = null;
let _userVolume = DEFAULT_MUSIC_PLAYER_STATE.volume;
let _nativeVolumeRestoreTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeDurationSeconds(value?: number | null) {
  const duration = Number(value || 0);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration > 1000 ? duration / 1000 : duration;
}

function getTrackKey(track: MusicTrack | null | undefined, explicitKey?: string | null) {
  if (explicitKey) return /^\d+$/.test(explicitKey) ? `song:${explicitKey}` : explicitKey;
  if (!track?.name) return null;
  return [
    track.name,
    track.artists?.join('/') || '',
    track.album || '',
    track.duration || '',
  ].join('|');
}

function shouldKeepNativeProgress(prev: MusicPlayerState, incomingProgress: number, duration: number) {
  if (incomingProgress >= prev.progress) return false;
  if (duration > 0 && prev.progress >= duration - 4 && incomingProgress <= 2) return false;
  if (incomingProgress === 0 && prev.progress > 3) return true;
  return prev.progress - incomingProgress <= 2;
}

function startNativeProgressTicker() {
  if (_nativeProgressTimer) return;
  _nativeProgressTimer = setInterval(() => {
    if (_musicSnapshot.source !== 'netease' || !_musicSnapshot.isPlaying) {
      stopNativeProgressTicker();
      return;
    }
    setMusicState(prev => {
      if (prev.source !== 'netease' || !prev.isPlaying) return prev;
      const rawProgress = prev.progress + 1;
      const nextProgress = prev.duration > 0
        ? rawProgress % prev.duration
        : rawProgress;
      return { ...prev, progress: nextProgress };
    });
  }, 1000);
}

function stopNativeProgressTicker() {
  if (_nativeProgressTimer) {
    clearInterval(_nativeProgressTimer);
    _nativeProgressTimer = null;
  }
}

function syncNativeProgressTicker() {
  if (_musicSnapshot.source === 'netease' && _musicSnapshot.isPlaying) startNativeProgressTicker();
  else stopNativeProgressTicker();
}

function notifyMusicState() {
  _listeners.forEach(fn => fn());
  _stateListeners.forEach(fn => fn());
}

function setMusicState(updater: MusicPlayerState | ((state: MusicPlayerState) => MusicPlayerState)) {
  _musicSnapshot = typeof updater === 'function' ? updater(_musicSnapshot) : updater;
  _musicVisible = _musicSnapshot.visible;
  syncNativeProgressTicker();
  notifyMusicState();
}

function setMusicVisible(visible: boolean) {
  setMusicState(prev => ({ ...prev, visible }));
}

export function setMusicLayerVisible(visible: boolean) {
  setMusicVisible(visible);
}

function getEffectiveVolume() {
  return Math.max(0, Math.min(1, (_musicSnapshot.volume / 100) * _duckingLevel));
}

function applyAudioVolume() {
  if (_audio) _audio.volume = getEffectiveVolume();
}

function syncNativePlaybackVolume(level = Math.round(_userVolume * _duckingLevel)) {
  if (_musicSnapshot.source === 'netease') {
    _boundSocket?.emit?.('music:volume', { level: Math.max(0, Math.min(100, level)) });
  }
}

function prevSourceIsNetease() {
  return _musicSnapshot.source === 'netease';
}

function scheduleNativeVolumeRestore() {
  if (_nativeVolumeRestoreTimer) clearTimeout(_nativeVolumeRestoreTimer);
  if (_musicSnapshot.source !== 'netease' || _duckingReasons.size > 0) return;

  const restore = () => syncNativePlaybackVolume(_userVolume);
  restore();
  _nativeVolumeRestoreTimer = setTimeout(() => {
    restore();
    _nativeVolumeRestoreTimer = null;
  }, 800);
}

function stopLocalAudioForNativePlayback() {
  clearPlaybackWatchdog();
  if (!_audio) return;
  _audio.pause();
  _audio.removeAttribute('src');
  try { _audio.load(); } catch {}
}

function clearPlaybackWatchdog() {
  if (_playbackWatchdog) {
    clearTimeout(_playbackWatchdog);
    _playbackWatchdog = null;
  }
}

function reportPlaybackError(message: string, audioUrl?: string) {
  console.warn('[Music]', message);
  _boundSocket?.emit?.('music:playback_error', {
    message,
    audioUrl,
    track: _musicSnapshot.track,
    queueIndex: _musicSnapshot.queueIndex,
  });
}

function tryNextPlayableTrack(message: string, audioUrl?: string): boolean {
  clearPlaybackWatchdog();
  const queue = _musicSnapshot.queue || [];
  if (_musicSnapshot.queueIndex >= 0) {
    _failedQueueIndexes.add(_musicSnapshot.queueIndex);
  }
  if (!queue.length || _failedQueueIndexes.size >= queue.length) return false;

  const baseIndex = _musicSnapshot.queueIndex >= 0 ? _musicSnapshot.queueIndex : 0;
  for (let offset = 1; offset <= queue.length; offset += 1) {
    const index = (baseIndex + offset) % queue.length;
    if (!_failedQueueIndexes.has(index) && queue[index]?.audioUrl) {
      setMusicState(prev => ({ ...prev, lastError: message }));
      reportPlaybackError(`${message}; trying another candidate`, audioUrl);
      playQueueAt(index);
      return true;
    }
  }
  return false;
}

function handlePlaybackFailure(message: string, audioUrl?: string) {
  if (tryNextPlayableTrack(message, audioUrl)) return;
  setMusicState(prev => ({
    ...prev,
    isPlaying: false,
    lastError: message,
  }));
  reportPlaybackError(message, audioUrl);
}

function setMusicDucking(reason: string, active: boolean, level = 0.32) {
  if (active) {
    _duckingReasons.set(reason, Math.max(0.05, Math.min(1, level)));
  } else {
    _duckingReasons.delete(reason);
  }
  _duckingLevel = _duckingReasons.size ? Math.min(...Array.from(_duckingReasons.values())) : 1;
  applyAudioVolume();
  syncNativePlaybackVolume();
  if (_duckingReasons.size === 0) scheduleNativeVolumeRestore();
}

function getQueueItem(offset: number): { item: MusicQueueItem; index: number } | null {
  const queue = _musicSnapshot.queue || [];
  if (!queue.length) return null;
  const baseIndex = _musicSnapshot.queueIndex >= 0 ? _musicSnapshot.queueIndex : 0;
  const index = (baseIndex + offset + queue.length) % queue.length;
  return { item: queue[index], index };
}

function ensureAudio() {
  if (_audio || typeof Audio === 'undefined') return _audio;
  const audio = new Audio();
  audio.volume = getEffectiveVolume();
  audio.addEventListener('timeupdate', () => {
    setMusicState(prev => ({ ...prev, progress: audio.currentTime }));
    if (_playbackWatchdog && !audio.paused && audio.currentTime > 0.25) {
      clearPlaybackWatchdog();
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    setMusicState(prev => ({ ...prev, duration: Number.isFinite(audio.duration) ? audio.duration : prev.duration }));
  });
  audio.addEventListener('ended', () => {
    clearPlaybackWatchdog();
    const nextItem = getQueueItem(1);
    if (nextItem) {
      playQueueAt(nextItem.index);
      return;
    }
    setMusicState(prev => ({ ...prev, isPlaying: false, progress: prev.duration || prev.progress }));
  });
  audio.addEventListener('error', () => {
    handlePlaybackFailure('Music audio failed to load or play', audio.currentSrc || audio.src);
  });
  _audio = audio;
  return _audio;
}

function playAudioUrl(audioUrl: string, restart = false) {
  const audio = ensureAudio();
  if (!audio) return;
  clearPlaybackWatchdog();
  const attempt = ++_playAttempt;
  if (restart || audio.src !== audioUrl) {
    audio.pause();
    audio.currentTime = 0;
    audio.src = audioUrl;
    audio.load();
  }
  applyAudioVolume();
  const startTime = audio.currentTime || 0;
  audio.play()
    .then(() => {
      if (attempt !== _playAttempt) return;
      setMusicState(prev => ({ ...prev, isPlaying: true, lastError: undefined }));
      _playbackWatchdog = setTimeout(() => {
        if (attempt !== _playAttempt) return;
        const progressed = !audio.paused && audio.currentTime > startTime + 0.25;
        if (!progressed) {
          const reason = audio.readyState >= 2
            ? 'Music audio started but no playback progress was detected'
            : 'Music audio did not load enough data to play';
          handlePlaybackFailure(reason, audioUrl);
        }
      }, 7000);
    })
    .catch((err: any) => {
      const message = err?.message || 'Music audio playback was blocked or failed';
      handlePlaybackFailure(message, audioUrl);
    });
}

function playQueueAt(index: number) {
  const item = _musicSnapshot.queue[index];
  if (!item?.audioUrl) {
    setMusicState(prev => ({ ...prev, lastError: 'No playable track in the current queue' }));
    return;
  }

  setMusicState(prev => ({
    ...prev,
    track: item.track,
    trackKey: getTrackKey(item.track, item.originalId || item.encryptedId || null),
    queueIndex: index,
    progress: 0,
    duration: normalizeDurationSeconds(item.track.duration),
    lyrics: [],
    source: 'url',
    isPlaying: true,
    lastError: undefined,
  }));
  playAudioUrl(item.audioUrl, true);
}

function bindMusicSocket(socket: any) {
  if (!socket || socket === _boundSocket) return;
  if (_boundSocket && _socketHandlers) {
    for (const [event, handler] of Object.entries(_socketHandlers)) {
      _boundSocket.off?.(event, handler);
    }
  }

  _boundSocket = socket;
  const onAtmosphere = (data: MusicAtmosphere) => {
    const nativePlayback = data.nativePlayback === true || (!data.audioUrl && data.queue?.some(item => item.encryptedId || item.originalId));
    const queue = nativePlayback
      ? (data.queue || [])
      : data.queue?.length
      ? data.queue.filter(item => Boolean(item.audioUrl))
      : data.audioUrl
        ? [{ track: data.track, audioUrl: data.audioUrl }]
        : [];
    const queueIndex = Math.max(0, Math.min(data.queueIndex ?? 0, Math.max(0, queue.length - 1)));
    const activeQueueItem = queue[queueIndex];
    const trackKey = getTrackKey(data.track, data.trackKey || activeQueueItem?.originalId || activeQueueItem?.encryptedId || null);
    _failedQueueIndexes = new Set<number>();
    setMusicState(prev => ({
      ...prev,
      track: data.track,
      trackKey,
      mood: data.mood,
      weather: data.weather,
      lumiReason: data.lumiReason,
      lyrics: data.lyrics || [],
      scene: data.scene || null,
      queue,
      queueIndex: queue.length ? queueIndex : -1,
      visible: true,
      isPlaying: true,
      progress: 0,
      duration: normalizeDurationSeconds(data.track.duration),
      source: nativePlayback ? 'netease' : data.audioUrl ? 'url' : 'netease',
      lastError: undefined,
    }));
    if (nativePlayback) {
      stopLocalAudioForNativePlayback();
      syncNativePlaybackVolume();
    } else if (data.audioUrl) {
      playAudioUrl(data.audioUrl, true);
    }
  };

  const onState = (data: any) => {
    const isNativeState = data.source === 'netease' || (prevSourceIsNetease() && data.source == null);
    if (data.source === 'netease') stopLocalAudioForNativePlayback();
    setMusicState(prev => {
      const incomingTrack = data.trackName ? {
        name: data.trackName,
        artists: data.artists || [],
        album: data.album,
        coverUrl: data.coverUrl,
        duration: data.duration,
      } : null;
      const incomingTrackKey = getTrackKey(incomingTrack, data.trackKey);
      const previousTrackKey = getTrackKey(prev.track, prev.trackKey);
      const trackChanged = Boolean(incomingTrack && incomingTrackKey && incomingTrackKey !== previousTrackKey);
      const duration = data.duration != null
        ? normalizeDurationSeconds(data.duration)
        : trackChanged
          ? normalizeDurationSeconds(incomingTrack?.duration)
          : prev.duration;
      let progress = trackChanged ? 0 : prev.progress;
      if (data.progress != null) {
        const incomingProgress = Number(data.progress);
        progress = Number.isFinite(incomingProgress) ? incomingProgress : progress;
        if (
          isNativeState &&
          !trackChanged &&
          (data.playing ?? prev.isPlaying) &&
          Number.isFinite(incomingProgress) &&
          shouldKeepNativeProgress(prev, incomingProgress, duration)
        ) {
          progress = prev.progress;
        }
      }

      return {
        ...prev,
        track: incomingTrack || prev.track,
        trackKey: incomingTrackKey || prev.trackKey,
        isPlaying: data.playing ?? prev.isPlaying,
        progress,
        duration,
        lyrics: trackChanged ? [] : prev.lyrics,
        volume: isNativeState ? prev.volume : data.volume ?? prev.volume,
        source: data.source ?? (isNativeState ? 'netease' : prev.source),
      };
    });
    if (data.volume != null && !isNativeState) applyAudioVolume();
    if ((data.source === 'netease' || isNativeState) && (data.playing ?? _musicSnapshot.isPlaying) && _duckingReasons.size === 0) {
      scheduleNativeVolumeRestore();
    }
    if (data.audioUrl && data.source !== 'netease') playAudioUrl(data.audioUrl);
  };

  const onLyrics = (data: { lyrics: MusicLyricLine[]; trackKey?: string } | MusicLyricLine[]) => {
    const lyrics = Array.isArray(data) ? data : data.lyrics;
    const trackKey = Array.isArray(data) ? undefined : data.trackKey;
    setMusicState(prev => {
      if (trackKey && prev.trackKey && trackKey !== prev.trackKey) return prev;
      return { ...prev, trackKey: trackKey || prev.trackKey, lyrics: lyrics || [] };
    });
  };

  const onError = (data: { message: string }) => {
    console.warn('[Music]', data.message);
    setMusicState(prev => ({ ...prev, lastError: data.message || 'Music playback error' }));
  };

  _socketHandlers = {
    'music:atmosphere': onAtmosphere,
    'music:state': onState,
    'music:lyrics': onLyrics,
    'music:error': onError,
  };
  for (const [event, handler] of Object.entries(_socketHandlers)) {
    socket.on(event, handler);
  }
  socket.emit?.('music:get_state');
}

export function useMusicVisible() {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    () => _musicVisible,
  );
}

export function useMusicPlayerSnapshot() {
  return useSyncExternalStore(
    (cb) => { _stateListeners.add(cb); return () => { _stateListeners.delete(cb); }; },
    () => _musicSnapshot,
  );
}

export function useMusicPlayerRuntime() {
  const socket = useSocket();

  useEffect(() => {
    ensureAudio();
  }, []);

  useEffect(() => {
    bindMusicSocket(socket);
  }, [socket]);

  useEffect(() => {
    const handler = (event: Event) => {
      const visible = Boolean((event as CustomEvent<{ visible?: boolean }>).detail?.visible);
      setMusicVisible(visible);
    };
    window.addEventListener('lumi:music-layer', handler);
    return () => window.removeEventListener('lumi:music-layer', handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean; reason?: string; level?: number }>).detail || {};
      setMusicDucking(detail.reason || 'voice', Boolean(detail.active), detail.level);
    };
    window.addEventListener('lumi:music-ducking', handler);
    return () => window.removeEventListener('lumi:music-ducking', handler);
  }, []);

  useEffect(() => {
    const stopNativeOnLeave = () => {
      if (_musicSnapshot.source === 'netease' && _musicSnapshot.isPlaying) {
        socket?.emit('music:pause');
      }
      setMusicDucking('voice-call', false);
    };
    window.addEventListener('pagehide', stopNativeOnLeave);
    window.addEventListener('beforeunload', stopNativeOnLeave);
    return () => {
      window.removeEventListener('pagehide', stopNativeOnLeave);
      window.removeEventListener('beforeunload', stopNativeOnLeave);
    };
  }, [socket]);

  return socket;
}

export function useMusicPlayer() {
  const socket = useMusicPlayerRuntime();
  const state = useMusicPlayerSnapshot();

  const play = useCallback(() => {
    if (_musicSnapshot.source === 'netease') {
      scheduleNativeVolumeRestore();
      socket?.emit('music:resume');
      setMusicState(prev => ({ ...prev, isPlaying: true, lastError: undefined }));
      setTimeout(() => scheduleNativeVolumeRestore(), 1000);
      return;
    }
    const audio = ensureAudio();
    if (audio?.src) {
      audio.play()
        .then(() => setMusicState(prev => ({ ...prev, isPlaying: true, lastError: undefined })))
        .catch((err: any) => setMusicState(prev => ({ ...prev, lastError: err?.message || 'Music playback failed' })));
    } else {
      setMusicState(prev => ({ ...prev, isPlaying: true }));
    }
    socket?.emit('music:resume');
  }, [socket]);

  const pause = useCallback(() => {
    ensureAudio()?.pause();
    socket?.emit('music:pause');
    setMusicState(prev => ({ ...prev, isPlaying: false }));
  }, [socket]);

  const next = useCallback(() => {
    if (_musicSnapshot.source === 'netease') {
      scheduleNativeVolumeRestore();
      socket?.emit('music:next');
      setMusicState(prev => ({ ...prev, progress: 0, lastError: undefined }));
      return;
    }
    const nextItem = getQueueItem(1);
    if (nextItem) {
      playQueueAt(nextItem.index);
      return;
    }
    setMusicState(prev => ({ ...prev, lastError: 'No next song is available in the current queue' }));
  }, [socket]);

  const prev = useCallback(() => {
    if (_musicSnapshot.source === 'netease') {
      scheduleNativeVolumeRestore();
      socket?.emit('music:prev');
      setMusicState(prev => ({ ...prev, progress: 0, lastError: undefined }));
      return;
    }
    const prevItem = getQueueItem(-1);
    if (prevItem) {
      playQueueAt(prevItem.index);
      return;
    }
    setMusicState(prev => ({ ...prev, lastError: 'No previous song is available in the current queue' }));
  }, [socket]);

  const seek = useCallback((seconds: number) => {
    if (_musicSnapshot.source !== 'netease') {
      const audio = ensureAudio();
      if (audio) audio.currentTime = seconds;
    }
    socket?.emit('music:seek', { seconds });
    setMusicState(prev => ({ ...prev, progress: seconds }));
  }, [socket]);

  const setVolume = useCallback((level: number) => {
    const volume = Math.max(0, Math.min(100, level));
    _userVolume = volume;
    ensureAudio();
    socket?.emit('music:volume', { level: Math.round(volume * _duckingLevel) });
    setMusicState(prev => ({ ...prev, volume }));
    applyAudioVolume();
  }, [socket]);

  const show = useCallback(() => setMusicVisible(true), []);
  const hide = useCallback(() => setMusicVisible(false), []);

  return {
    ...state,
    play,
    pause,
    next,
    prev,
    seek,
    setVolume,
    show,
    hide,
  };
}
