import { useEffect, useRef, useState } from 'react';
import { BarChart3, Heart, Maximize2, Pause, Play, RefreshCw, Search, SkipBack, SkipForward, Sparkles, Volume2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMusicPlayer } from '../hooks/useMusicPlayer';
import { useSocket } from '../hooks/useSocket';
import { apiFetch } from '../services/apiClient';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { translate } from '../i18n/runtime';

interface MusicProfileCount {
  name: string;
  count: number;
  ratio: number;
}

interface MusicProfile {
  playlistName: string;
  totalTracks: number;
  analyzedTracks: number;
  updatedAt: string;
  topArtists: MusicProfileCount[];
  languageMix: MusicProfileCount[];
  moodMix: MusicProfileCount[];
  styleMix: MusicProfileCount[];
  insights: string[];
  summaryCn: string;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function MusicCenter({ isOpen, onClose, t }: { isOpen: boolean; onClose: () => void; t?: any }) {
  const player = useMusicPlayer();
  const socket = useSocket();
  const [qrImgSrc, setQrImgSrc] = useState<string | null>(null);
  const [loginDone, setLoginDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgMsg, setCfgMsg] = useState('');
  const [musicPrompt, setMusicPrompt] = useState('');
  const [profile, setProfile] = useState<MusicProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;

  const defaultMusicPrompt = profile?.topArtists?.[0]?.name
    ? translate('musicArtistPrompt', { artist: profile.topArtists[0].name })
    : translate('musicDefaultPrompt');

  const loadMusicProfile = async () => {
    try {
      const res = await apiFetch('/api/music/profile');
      const data = await res.json();
      if (res.ok) setProfile(data.profile || null);
    } catch {}
  };

  useEffect(() => {
    apiFetch('/api/ncm/configure/status').then(r => r.json()).then(s => {
      setConfigured(s.configured);
    }).catch(() => setConfigured(false));
    apiFetch('/api/ncm/login/status').then(r => r.json()).then(s => {
      setLoginDone(Boolean(s.done));
      setQrImgSrc(s.qrUrl ? `https://quickchart.io/qr?text=${encodeURIComponent(s.qrUrl)}&size=220` : null);
    }).catch(() => {});
    void loadMusicProfile();
    socket?.emit('music:get_state');
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [socket]);

  const analyzeMusicProfile = async () => {
    setProfileBusy(true);
    setProfileError('');
    try {
      const res = await apiFetch('/api/music/profile/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSongs: 3000 }),
      });
      const data = await res.json();
      if (!res.ok || !data.profile) throw new Error(data.error || uiMessage('music-center.failed-to-analyze-music-profile.511255de2a'));
      setProfile(data.profile);
      toast.success(uiMessage('music-center.music-profile-updated.0bcc213805'));
    } catch (e: any) {
      const message = e?.message || uiMessage('music-center.failed-to-analyze-music-profile.511255de2a');
      setProfileError(message);
      toast.error(message);
    } finally {
      setProfileBusy(false);
    }
  };

  const saveCreds = async () => {
    if (!appId.trim() || !privateKey.trim()) return;
    setCfgBusy(true);
    setCfgMsg('');
    try {
      const res = await apiFetch('/api/ncm/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: appId.trim(), privateKey: privateKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || uiMessage('music-center.failed-to-save-credentials.052141b85e'));
      const statusRes = await apiFetch('/api/ncm/configure/status');
      const status = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok || !status.configured) {
        throw new Error(status.error || uiMessage('music-center.credentials-were-not-confirmed-by.40325a40e9'));
      }
      setConfigured(true);
      setCfgMsg(t?.musicCredentialsSaved || uiMessage('music-center.credentials-saved.8f868b963e'));
      toast.success(t?.musicCredentialsSaved || uiMessage('music-center.credentials-saved.8f868b963e'));
    } catch (e: any) {
      const message = e.message || uiMessage('music-center.request-failed.a3286c8e7a');
      setCfgMsg(message);
      toast.error(message);
    } finally {
      setCfgBusy(false);
    }
  };

  const startLogin = async () => {
    setLoading(true);
    setQrImgSrc(null);
    try {
      const res = await apiFetch('/api/ncm/login', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.done) {
        setLoginDone(true);
        setQrImgSrc(null);
        toast.success(t?.musicConnected || uiMessage('music-center.netease-cloud-connected.e05d9c29ac'));
        return;
      }
      if (!res.ok || !data.qrUrl) throw new Error(data.error || uiMessage('music-center.no-qr-url.c02db6d78e'));

      setQrImgSrc(`https://quickchart.io/qr?text=${encodeURIComponent(data.qrUrl)}&size=220`);

      const interval = setInterval(async () => {
        try {
          const sr = await apiFetch('/api/ncm/login/status');
          const ss = await sr.json();
          setLoginDone(Boolean(ss.done));
          setQrImgSrc(ss.qrUrl ? `https://quickchart.io/qr?text=${encodeURIComponent(ss.qrUrl)}&size=220` : null);
          if (ss.done) {
            clearInterval(interval);
            toast.success(t?.musicConnected || uiMessage('music-center.netease-cloud-connected.e05d9c29ac'));
          }
        } catch {}
      }, 2000);
      pollRef.current = interval;
    } catch (e: any) {
      toast.error(e.message || uiMessage('music-center.login-failed.c30ba34c8c'));
    } finally {
      setLoading(false);
    }
  };

  const requestMusicPlayback = (text: string, options?: { clearPrompt?: boolean }) => {
    const prompt = text.trim();
    if (!prompt) return false;
    if (!socket?.connected) {
      toast.error(t?.serverNotConnected || uiMessage('music-center.server-is-not-connected.63fa23c918'));
      return false;
    }
    socket.emit('agent:chat', {
      text: prompt,
      history: [],
      personalityId: 'lumi',
      source: 'music-center',
    });
    toast.info(t?.musicRequestSent || uiMessage('music-center.music-request-sent-to-lumi.05f78a50bd'));
    if (options?.clearPrompt) setMusicPrompt('');
    return true;
  };

  const askLumiToPlay = () => {
    requestMusicPlayback(musicPrompt, { clearPrompt: true });
  };

  const togglePlayback = () => {
    if (player.isPlaying) {
      player.pause();
      return;
    }
    if (player.track) {
      player.play();
      return;
    }
    requestMusicPlayback(defaultMusicPrompt);
  };

  const toggleMoodLayer = () => {
    if (player.visible) player.hide();
    else if (player.track) player.show();
    else {
      toast.info(t?.musicLayerNeedsTrack || uiMessage('music-center.ask-lumi-to-play-music.12cfd8c961'));
      promptInputRef.current?.focus();
    }
  };

  if (!isOpen) return null;

  const progressMax = Math.max(1, Math.floor(player.duration || 0));
  const displayProgress = player.duration > 0 ? (player.progress || 0) % player.duration : player.progress || 0;
  const profileUpdatedAt = profile?.updatedAt ? new Date(profile.updatedAt).toLocaleString() : '';
  const pct = (item: MusicProfileCount) => `${Math.round((item.ratio || 0) * 100)}%`;

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-1">
      <div className="space-y-5">
        <section className="lumi-panel border-red-400/10 bg-red-500/[0.04] p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${player.isPlaying ? 'bg-emerald-400 animate-pulse' : 'bg-white/25'}`} />
                <h3 className="text-sm font-black text-white/85 uppercase tracking-wider">
                  {t?.musicPlayer || uiMessage('music-center.music-player.f8cdc1ac3a')}
                </h3>
              </div>
              <p className="mt-1 text-xs text-white/40">
                {player.track ? (t?.musicNowPlaying || uiMessage('music-center.now-playing.ed6ab90e7d')) : (t?.musicIdleHint || uiMessage('music-center.ask-lumi-to-play-a.bdf7a253b2'))}
              </p>
            </div>
            <button
              onClick={onClose}
              className="lumi-icon-button h-8 w-8 border-transparent"
              title={t?.close || uiMessage('music-center.close.6cf4a7773a')}
            >
              <X size={16} />
            </button>
          </div>

          <div className="lumi-panel bg-black/30 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-base font-bold text-white/85 truncate">
                  {player.track?.name || t?.musicNoTrack || uiMessage('music-center.no-track-loaded.7f78082b4a')}
                </div>
                <div className="text-xs text-white/40 truncate">
                  {player.track?.artists?.join(' / ') || t?.musicControlHint || uiMessage('music-center.voice-chat-and-this-panel.c510478c7d')}
                </div>
              </div>
              <button
                onClick={toggleMoodLayer}
                className={`h-9 px-3 rounded-xl border transition-colors flex items-center gap-2 text-xs font-bold ${
                  player.visible
                    ? 'bg-red-500/20 border-red-400/30 text-red-200'
                    : 'bg-white/[0.045] border-white/10 text-white/55 hover:text-white hover:bg-white/10'
                }`}
                title={player.visible ? (t?.hideMusicLayer || uiMessage('music-center.hide-mood-layer.8fc19f1cf0')) : (t?.showMusicLayer || uiMessage('music-center.show-mood-layer.704fd0581f'))}
              >
                <Maximize2 size={14} />
                {player.visible ? (t?.moodLayerOn || uiMessage('music-center.mood-layer-on.cb76eff7a5')) : (t?.moodLayerOff || uiMessage('music-center.mood-layer.21d81d989e'))}
              </button>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button onClick={player.prev} className="lumi-icon-button">
                <SkipBack size={16} />
              </button>
              <button
                onClick={togglePlayback}
                className="w-11 h-11 rounded-2xl bg-red-500/20 border border-red-400/25 text-red-300 hover:bg-red-500/30 flex items-center justify-center transition-colors"
              >
                {player.isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button onClick={player.next} className="lumi-icon-button">
                <SkipForward size={16} />
              </button>
              <div className="flex-1 min-w-0">
                <input
                  type="range"
                  min={0}
                  max={progressMax}
                  value={Math.min(displayProgress, progressMax)}
                  onChange={(e) => player.seek(Number(e.target.value))}
                  className="w-full accent-red-400"
                />
                <div className="flex justify-between text-[10px] text-white/30 font-mono">
                  <span>{formatTime(displayProgress)}</span>
                  <span>{formatTime(player.duration || 0)}</span>
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <Volume2 size={15} className="text-white/35" />
              <input
                type="range"
                min={0}
                max={100}
                value={player.volume}
                onChange={(e) => player.setVolume(Number(e.target.value))}
                className="flex-1 accent-red-400"
              />
              <span className="w-9 text-right text-[10px] text-white/35 font-mono">{player.volume}%</span>
            </div>

            {player.lastError && (
              <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-100/85">
                {player.lastError}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="lumi-panel flex flex-1 items-center gap-2 px-3 py-2">
              <Search size={15} className="text-white/30" />
              <input
                ref={promptInputRef}
                value={musicPrompt}
                onChange={(e) => setMusicPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') askLumiToPlay(); }}
                placeholder={t?.musicPromptPlaceholder || uiMessage('music-center.play-jay-chou-daily-recommendations.094aa10a18')}
                className="flex-1 bg-transparent outline-none text-xs text-white/80 placeholder:text-white/25"
              />
            </div>
            <button
              onClick={askLumiToPlay}
              disabled={!musicPrompt.trim()}
              className="lumi-button h-10 border-red-400/25 bg-red-500/15 px-4 text-red-300 hover:bg-red-500/25"
            >
              {t?.play || uiMessage('music-center.play.2f621d7ab6')}
            </button>
          </div>
        </section>

        <section className="lumi-panel bg-white/[0.025] p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 size={16} className="text-red-300" />
                <h3 className="text-sm font-black text-white/85 uppercase tracking-wider">
                  {uiMessage('music-center.music-profile.e703f9b6fd')}
                </h3>
              </div>
              <p className="mt-1 text-xs text-white/40">
                {profile
                  ? formatUiMessage('music-center.value0-value1-liked-songs-analyzed.5420e128bd', { value0: profile.analyzedTracks, value1: profile.totalTracks || profile.analyzedTracks })
                  : uiMessage('music-center.based-on-netease-liked-songs.5f94eb7458')}
              </p>
            </div>
            <button
              onClick={analyzeMusicProfile}
              disabled={profileBusy}
              className="h-9 px-3 rounded-xl bg-red-500/15 border border-red-400/25 text-xs font-bold text-red-300 hover:bg-red-500/25 disabled:opacity-40 transition-colors flex items-center gap-2"
            >
              <RefreshCw size={14} className={profileBusy ? 'animate-spin' : ''} />
              {profile ? uiMessage('music-center.refresh.ccda72393e') : uiMessage('music-center.analyze.20f8e3c435')}
            </button>
          </div>

          {profileError && (
            <div className="rounded-xl bg-red-500/10 border border-red-400/20 px-3 py-2 text-xs text-red-200">
              {profileError}
            </div>
          )}

          {profile ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-black/25 border border-white/5 p-4">
                <div className="flex items-start gap-3">
                  <Sparkles size={16} className="text-red-200 mt-0.5" />
                  <div>
                    <p className="text-sm text-white/80 leading-relaxed">{profile.summaryCn}</p>
                    {profileUpdatedAt && <p className="mt-2 text-[10px] text-white/30 font-mono">{profileUpdatedAt}</p>}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                  <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-white/35">
                    <Heart size={12} /> {uiMessage('music-center.top-artists.83acdd2eb9')}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {profile.topArtists.slice(0, 6).map(item => (
                      <span key={item.name} className="px-2 py-1 rounded-lg bg-white/[0.05] text-[10px] text-white/60 border border-white/5">
                        {item.name} / {item.count}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-white/35">{uiMessage('music-center.mood.d0d40d515b')}</div>
                  <div className="mt-3 space-y-2">
                    {profile.moodMix.slice(0, 4).map(item => (
                      <div key={item.name} className="flex items-center justify-between gap-3 text-[10px]">
                        <span className="text-white/55 truncate">{item.name}</span>
                        <span className="text-white/30 font-mono">{pct(item)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-white/35">{uiMessage('music-center.style.24e729d2ea')}</div>
                  <div className="mt-3 space-y-2">
                    {[...profile.styleMix.slice(0, 2), ...profile.languageMix.slice(0, 2)].map(item => (
                      <div key={`${item.name}-${item.count}`} className="flex items-center justify-between gap-3 text-[10px]">
                        <span className="text-white/55 truncate">{item.name}</span>
                        <span className="text-white/30 font-mono">{pct(item)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-black/20 border border-white/5 p-4 text-xs text-white/40">
              {uiMessage('music-center.no-music-profile-yet.df1b94f9d2')}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <section className="lumi-panel bg-white/[0.02] p-5 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">{uiMessage('music-center.api-credentials.89e2cd1c47')}</span>
              {configured && <span className="text-[9px] text-emerald-400 font-mono bg-emerald-400/10 px-2 py-0.5 rounded-full">OK</span>}
            </div>
            <p className="text-[10px] text-white/35 leading-relaxed">
              {uiMessage('music-center.configure-netease-cloud-music-developer.93af9d7db5')}
            </p>
            <input
              type="text" placeholder={uiMessage('music-center.app-id.63ea67559e')}
              value={appId} onChange={e => setAppId(e.target.value)}
              className="lumi-field w-full py-2 text-xs focus:border-red-500/40"
            />
            <input
              type="password" placeholder={uiMessage('music-center.private-key.e858a6ebc5')}
              value={privateKey} onChange={e => setPrivateKey(e.target.value)}
              className="lumi-field w-full py-2 text-xs focus:border-red-500/40"
            />
            <button
              onClick={saveCreds} disabled={cfgBusy || !appId.trim() || !privateKey.trim()}
              className="lumi-button w-full"
            >
              {cfgBusy ? (t?.saving || uiMessage('music-center.saving.5a02b802aa')) : (t?.saveCredentials || uiMessage('music-center.save-credentials.7e47a5e3e3'))}
            </button>
            {cfgMsg && <p className="text-[10px] text-center text-white/40">{cfgMsg}</p>}
          </section>

          <section className="lumi-panel bg-white/[0.02] p-5 flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">{uiMessage('music-center.netease-cloud.52664367fe')}</span>
              {loginDone && (
                <span className="text-[9px] text-emerald-400 font-mono bg-emerald-400/10 px-2 py-0.5 rounded-full">{uiMessage('music-center.connected.4f18b17c87')}</span>
              )}
            </div>
            <p className="text-[11px] text-white/40 text-center leading-relaxed">
              {uiMessage('music-center.scan-once-to-enable-account.aa7e8ba24e')}
            </p>

            {qrImgSrc ? (
              <img src={qrImgSrc} alt={uiMessage('music-center.qr-code.8711909654')} className="w-40 h-40 rounded-xl bg-white" />
            ) : (
              <div className="lumi-panel flex h-40 w-40 items-center justify-center rounded-xl bg-white/[0.03] text-xs text-white/25">
                {loginDone ? uiMessage('music-center.connected.77956f6a16') : uiMessage('music-center.qr-login.74e074b88b')}
              </div>
            )}

            <button
              onClick={startLogin}
              disabled={loading}
              className="lumi-button w-full border-red-500/25 bg-red-500/15 py-2.5 text-sm font-medium text-red-400 hover:bg-red-500/25"
            >
              {loading ? (t?.loading || uiMessage('music-center.loading.586f5af819')) : loginDone ? (t?.musicConnected || uiMessage('music-center.connected.77956f6a16')) : (t?.scanToLogin || uiMessage('music-center.scan-to-login.f5545d0f96'))}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
