import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, Settings2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { designVoice, listVoices, synthesizeSpeech, VOICE_PROVIDER_CHANGED_EVENT } from '@/services/voiceService';
import { desktopWorkflowCopy } from '../i18n/locales/desktopWorkflows';
import { VoicePicker } from './VoicePicker';

const VoiceForge = lazy(() => import('./VoiceForge').then(module => ({ default: module.VoiceForge })));

function PanelFallback({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-24 items-center justify-center text-xs font-bold uppercase tracking-widest text-white/35">
      {label}
    </div>
  );
}

function VoiceCard({
  voice,
  isCloned,
  isPlaying,
  onPlay,
}: {
  voice: any;
  isCloned?: boolean;
  isPlaying?: boolean;
  onPlay: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 rounded-xl p-3 transition-all group ${
      isPlaying
        ? 'bg-sky-500/10 border border-sky-500/20'
        : 'bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.06]'
    }`}>
      <button
        onClick={onPlay}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all ${
          isPlaying ? 'bg-sky-500 text-white' : 'bg-white/10 text-white/50 group-hover:text-white'
        }`}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-bold text-white/80">{voice.name}</div>
        <div className="text-[10px] uppercase text-white/40">{voice.language || voice.provider || ''}</div>
      </div>
      {isCloned && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />}
    </div>
  );
}

export function DesktopPersonalizationSoundPanel({
  t,
  onOpenAppearance,
  onOpenVoiceSettings,
}: {
  t?: any;
  onOpenAppearance?: () => void;
  onOpenVoiceSettings?: () => void;
}) {
  const { selectedVoiceId } = useApp();
  const [designPrompt, setDesignPrompt] = useState('');
  const [designName, setDesignName] = useState('');
  const [designing, setDesigning] = useState(false);
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  const [voices, setVoices] = useState<{
    provider: string | null;
    configured: boolean;
    capabilities: { clone: boolean; design: boolean };
    cloned: any[];
    premade: any[];
  }>({ provider: null, configured: false, capabilities: { clone: false, design: false }, cloned: [], premade: [] });
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const providerName = voices.provider === 'ark'
    ? '豆包'
    : voices.provider === 'cosyvoice'
      ? 'Qwen / DashScope CosyVoice'
      : voices.provider === 'local-cosyvoice'
        ? 'Local CosyVoice'
        : voices.provider === 'gptsovits'
          ? 'GPT-SoVITS'
          : ui('未选择', 'Not selected');

  const refreshCatalog = React.useCallback(() => {
    return listVoices()
      .then(data => setVoices(data))
      .catch(() => {});
  }, []);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog, voiceRefresh]);

  useEffect(() => {
    const handleProviderChanged = () => { void refreshCatalog(); };
    window.addEventListener(VOICE_PROVIDER_CHANGED_EVENT, handleProviderChanged);
    return () => window.removeEventListener(VOICE_PROVIDER_CHANGED_EVENT, handleProviderChanged);
  }, [refreshCatalog]);

  const handlePlay = async (voice: any, text?: string) => {
    const voiceId = typeof voice === 'string' ? voice : voice.voiceId;
    const provider = typeof voice === 'string' ? undefined : voice.provider;
    const model = typeof voice === 'string' ? undefined : voice.model;
    if (playingId === voiceId) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    try {
      if (typeof voice !== 'string' && voice.provider === 'ark' && voice.demoAudio) {
        const previewAudio = new Audio(voice.demoAudio);
        audioRef.current = previewAudio;
        previewAudio.onended = () => setPlayingId(null);
        previewAudio.onerror = () => { setPlayingId(null); toast.error('Playback failed'); };
        await previewAudio.play();
        setPlayingId(voiceId);
        return;
      }
      const previewBuffer = await synthesizeSpeech(
        text || desktopWorkflowCopy().common.voicePreview,
        voiceId,
        provider,
        model,
      );
      const previewUrl = URL.createObjectURL(new Blob([previewBuffer], { type: 'audio/mp3' }));
      const previewAudio = new Audio(previewUrl);
      audioRef.current = previewAudio;
      previewAudio.onended = () => {
        setPlayingId(null);
        URL.revokeObjectURL(previewUrl);
      };
      await previewAudio.play();
      setPlayingId(voiceId);
    } catch {
      toast.error('Playback failed');
    }
  };

  const handleDesign = async () => {
    if (!designPrompt.trim() || !designName.trim()) return;
    if (!voices.capabilities.design || !voices.provider) {
      toast.error('当前语音服务没有接入音色设计，Lumi 不会自动切换到其他服务。');
      return;
    }
    setDesigning(true);
    try {
      const designed = await designVoice(designPrompt.trim(), designName.trim(), voices.provider);
      toast.success(`Voice "${designed.name}" created`);
      setDesignPrompt('');
      setDesignName('');
      setVoiceRefresh(value => value + 1);
    } catch (error: any) {
      toast.error(error.message || 'Voice design failed');
    } finally {
      setDesigning(false);
    }
  };

  const voiceIdentitySteps = [
    {
      id: 'design',
      label: t?.voiceFlowDesign || 'Design',
      desc: t?.voiceFlowDesignDesc || 'Generate a voice from description',
      active: designing,
      done: voices.cloned.length + voices.premade.length > 0,
    },
    {
      id: 'clone',
      label: t?.voiceFlowClone || 'Clone',
      desc: t?.voiceFlowCloneDesc || 'Record or upload real samples',
      active: false,
      done: voices.cloned.length > 0,
    },
    {
      id: 'select',
      label: t?.voiceFlowSelect || 'Enable',
      desc: t?.voiceFlowSelectDesc || 'Choose Lumi voice',
      active: false,
      done: Boolean(selectedVoiceId),
    },
    {
      id: 'avatar',
      label: t?.voiceFlowAvatar || 'Avatar',
      desc: t?.voiceFlowAvatarDesc || 'Match voice with appearance',
      active: false,
      done: false,
    },
  ];

  return (
    <div className="flex h-full flex-col space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex shrink-0 items-center gap-3">
        <div className="rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 p-3 shadow-lg">
          <Volume2 size={24} className="text-white" />
        </div>
        <div>
          <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">{t?.voiceStudio || 'Voice Studio'}</h3>
          <p className="flex items-center gap-2 text-xs uppercase tracking-widest text-white/55">
            <span className={`h-2 w-2 shrink-0 rounded-full ${voices.configured ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'bg-amber-400'}`} />
            <span className="truncate">{ui('当前语音服务', 'Current voice service')} · {providerName}</span>
          </p>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenVoiceSettings}
            title={voices.configured
              ? ui('音色选择和声音克隆跟随当前语音服务', 'Voice selection and cloning follow the current voice service')
              : ui('前往配置语音服务', 'Configure voice service')}
            className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-[11px] font-black text-white/55 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Settings2 size={14} />
            <span className="hidden xl:inline">{ui('前往语音服务', 'Voice settings')}</span>
          </button>
          <VoicePicker t={t} direction="down" refreshTrigger={voiceRefresh} />
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-4 gap-2 rounded-2xl border border-white/5 bg-white/[0.02] p-2">
        {voiceIdentitySteps.map((step, index) => (
          <button
            key={step.id}
            onClick={step.id === 'avatar' ? onOpenAppearance : undefined}
            disabled={step.id !== 'avatar'}
            className={`group min-w-0 rounded-xl border px-3 py-2 text-left transition-colors ${
              step.done
                ? 'border-emerald-400/20 bg-emerald-400/10'
                : step.active
                  ? 'border-sky-400/30 bg-sky-400/10'
                  : step.id === 'avatar'
                    ? 'border-cyan-400/20 bg-cyan-400/10 hover:bg-cyan-400/20'
                    : 'border-white/5 bg-black/20'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${
                step.done ? 'bg-emerald-300 text-black' : step.active ? 'bg-sky-300 text-black' : 'bg-white/10 text-white/45'
              }`}>
                {step.done ? '✓' : index + 1}
              </span>
              <span className="truncate text-[11px] font-black uppercase tracking-[0.12em] text-white/72">{step.label}</span>
            </div>
            <p className="mt-1 truncate text-[10px] font-semibold text-white/35">{step.desc}</p>
          </button>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-2 gap-4 overflow-hidden">
        <div className="space-y-4 overflow-y-auto scrollbar-hide">
          <div className="space-y-4 rounded-2xl border border-white/5 bg-white/[0.02] p-4">
            <h4 className="text-xs font-black uppercase tracking-widest text-white/55">{t?.voiceDesignTab || 'Voice Design'}</h4>
            <p className="text-xs text-white/40">{t?.voiceDesignDesc || 'Describe the voice you want, and AI will generate it. No audio sample needed.'}</p>
            {!voices.capabilities.design && (
              <p className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs text-amber-100/70">
                当前选择的语音服务不支持此处的音色设计；请在语音服务中切换到 Qwen / DashScope CosyVoice。
              </p>
            )}
            <label className="text-xs font-black uppercase text-white/55">{t?.voiceDesignPrompt || 'Voice Description'}</label>
            <textarea
              value={designPrompt}
              onChange={event => setDesignPrompt(event.target.value)}
              placeholder={t?.voiceDesignPlaceholder || 'e.g. A warm, gentle female voice with a soft tone...'}
              className="h-20 w-full resize-none rounded-2xl border border-white/10 bg-black/40 p-3 text-sm text-white/80 outline-none focus:border-sky-500/50"
            />
            <label className="text-xs font-black uppercase text-white/55">{t?.voiceDesignName || 'Voice Name'}</label>
            <input
              value={designName}
              onChange={event => setDesignName(event.target.value)}
              placeholder="e.g. Storyteller_v1"
              className="w-full rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-white/80 outline-none focus:border-sky-500/50"
            />
            <button
              onClick={handleDesign}
              disabled={!voices.configured || !voices.capabilities.design || designing || !designPrompt.trim() || !designName.trim()}
              className="relative w-full overflow-hidden rounded-2xl border border-sky-500/30 bg-sky-500/20 py-3 text-sm font-black uppercase tracking-widest text-sky-400 transition-all hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {designing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-400" />
                  {t?.generating || 'Generating...'}
                </span>
              ) : t?.generateVoice || 'Generate Voice'}
            </button>
            {designing && (
              <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-white/5">
                <motion.div
                  className="h-full bg-gradient-to-r from-sky-400 to-indigo-400"
                  initial={{ width: '0%' }}
                  animate={{ width: '100%' }}
                  transition={{ duration: 8, ease: 'easeInOut' }}
                />
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
            <h4 className="mb-4 text-xs font-black uppercase tracking-widest text-white/55">{t?.voiceCloning || 'Voice Cloning'}</h4>
            <Suspense fallback={<PanelFallback label={t?.loading || 'Loading'} />}>
              <VoiceForge t={t} compact onCloneSuccess={() => setVoiceRefresh(value => value + 1)} />
            </Suspense>
          </div>
        </div>

        <div className="space-y-6 overflow-y-auto rounded-2xl border border-white/5 bg-white/[0.02] p-4 scrollbar-hide">
          {voices.cloned.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-xs font-black uppercase tracking-[0.3em] text-white/40">{t?.clonedVoices || 'Cloned Voices'}</h4>
              <div className="space-y-2">
                {voices.cloned.map((voice: any) => (
                  <VoiceCard
                    key={voice.voiceId}
                    voice={voice}
                    isCloned
                    isPlaying={playingId === voice.voiceId}
                    onPlay={() => handlePlay(voice)}
                  />
                ))}
              </div>
            </section>
          )}
          <section className="space-y-3">
            <h4 className="text-xs font-black uppercase tracking-[0.3em] text-white/40">{t?.premadeVoices || 'Premade Voices'}</h4>
            <div className="space-y-2">
              {voices.premade.map((voice: any) => (
                <VoiceCard
                  key={voice.voiceId}
                  voice={voice}
                  isPlaying={playingId === voice.voiceId}
                  onPlay={() => handlePlay(voice)}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
