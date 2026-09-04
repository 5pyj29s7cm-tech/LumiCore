import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Image as ImageIcon, Loader2, Sparkles, Video, X } from 'lucide-react';
import type { MediaGenerationArtifact, MediaGenerationKind } from '@/lib/mediaGenerationArtifacts';
import { mediaGenerationCopy } from '@/i18n/locales/mediaGeneration';

export type MediaGenerationStudioStatus = 'idle' | 'submitting' | 'generating' | 'completed' | 'error';

export type MediaGenerationRequest = {
  mode: MediaGenerationKind;
  prompt: string;
  size: string;
  count?: number;
  duration?: number;
  referenceImage?: string;
};

type Props = {
  mode: MediaGenerationKind;
  locale: 'zh' | 'en';
  busy: boolean;
  status: MediaGenerationStudioStatus;
  statusDetail?: string;
  artifacts: MediaGenerationArtifact[];
  onModeChange: (mode: MediaGenerationKind) => void;
  onClose: () => void;
  onGenerate: (request: MediaGenerationRequest) => void;
  onOpenArtifact: (artifact: MediaGenerationArtifact) => void;
  onArtifactReady: (artifact: MediaGenerationArtifact) => void;
  onArtifactError: (artifact: MediaGenerationArtifact) => void;
};

const IMAGE_SIZE_VALUES = ['1024x1024', '1792x1024', '1024x1792'] as const;
const VIDEO_SIZE_VALUES = ['1280x720', '720x1280', '960x960'] as const;

export function MediaGenerationStudio({
  mode,
  locale,
  busy,
  status,
  statusDetail,
  artifacts,
  onModeChange,
  onClose,
  onGenerate,
  onOpenArtifact,
  onArtifactReady,
  onArtifactError,
}: Props) {
  const copy = mediaGenerationCopy(locale);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<string>(mode === 'image' ? IMAGE_SIZE_VALUES[0] : VIDEO_SIZE_VALUES[0]);
  const [count, setCount] = useState(1);
  const [duration, setDuration] = useState(6);
  const [referenceImage, setReferenceImage] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setSize(mode === 'image' ? IMAGE_SIZE_VALUES[0] : VIDEO_SIZE_VALUES[0]);
  }, [mode]);

  useEffect(() => {
    const focusPrompt = () => promptRef.current?.focus({ preventScroll: true });
    const restoreVisiblePrompt = () => {
      if (document.visibilityState === 'visible') focusPrompt();
    };
    window.addEventListener('focus', focusPrompt);
    document.addEventListener('visibilitychange', restoreVisiblePrompt);
    return () => {
      window.removeEventListener('focus', focusPrompt);
      document.removeEventListener('visibilitychange', restoreVisiblePrompt);
    };
  }, []);

  const options = mode === 'image'
    ? [
        { value: IMAGE_SIZE_VALUES[0], label: copy.square },
        { value: IMAGE_SIZE_VALUES[1], label: copy.landscape },
        { value: IMAGE_SIZE_VALUES[2], label: copy.portrait },
      ]
    : [
        { value: VIDEO_SIZE_VALUES[0], label: copy.landscape },
        { value: VIDEO_SIZE_VALUES[1], label: copy.portrait },
        { value: VIDEO_SIZE_VALUES[2], label: copy.square },
      ];
  const statusCopy = (() => {
    if (status === 'submitting') return copy.statusSubmitting;
    if (status === 'generating') return statusDetail || copy.statusGenerating;
    if (status === 'completed') return copy.statusCompleted;
    if (status === 'error') return statusDetail || copy.statusError;
    return copy.statusIdle;
  })();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || busy) return;
    onGenerate({
      mode,
      prompt: normalizedPrompt,
      size,
      ...(mode === 'image' ? { count } : {
        duration,
        referenceImage: referenceImage.trim() || undefined,
      }),
    });
  };

  return (
    <section
      data-media-generation-studio
      data-media-generation-mode={mode}
      className="absolute inset-0 z-[215] flex min-h-0 flex-col overflow-hidden bg-[#03070d]/96 backdrop-blur-2xl"
      aria-label={mode === 'image' ? copy.imageStudio : copy.videoStudio}
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-4 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
            mode === 'image'
              ? 'border-rose-200/20 bg-rose-300/10 text-rose-100'
              : 'border-amber-200/20 bg-amber-300/10 text-amber-100'
          }`}>
            {mode === 'image' ? <ImageIcon size={21} /> : <Video size={21} />}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-black tracking-wide text-white/90">
              {mode === 'image' ? copy.imageGeneration : copy.videoGeneration}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-white/38">
              {copy.configuredModelReceipt}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={copy.returnToCommandCenter}
          title={copy.returnToCommandCenter}
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5 [scrollbar-width:none] md:grid md:grid-cols-[minmax(300px,0.8fr)_minmax(360px,1.2fr)] md:px-8 md:py-7 [&::-webkit-scrollbar]:hidden">
        <form onSubmit={submit} className="flex min-h-0 flex-col rounded-[1.75rem] border border-white/[0.09] bg-white/[0.035] p-5 shadow-2xl shadow-black/20">
          <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl bg-black/25 p-1.5">
            {(['image', 'video'] as const).map(item => (
              <button
                key={item}
                type="button"
                data-media-generation-tab={item}
                disabled={busy}
                onClick={() => onModeChange(item)}
                className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold transition-colors ${
                  mode === item ? 'bg-white/12 text-white' : 'text-white/38 hover:bg-white/[0.06] hover:text-white/65'
                } disabled:cursor-not-allowed disabled:opacity-45`}
              >
                {item === 'image' ? <ImageIcon size={15} /> : <Video size={15} />}
                {item === 'image' ? copy.image : copy.video}
              </button>
            ))}
          </div>

          <label className="text-[11px] font-black uppercase tracking-[0.16em] text-white/48" htmlFor="media-generation-prompt">
            {copy.describe}
          </label>
          <textarea
            id="media-generation-prompt"
            ref={promptRef}
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            rows={7}
            autoFocus
            placeholder={mode === 'image'
              ? copy.imagePlaceholder
              : copy.videoPlaceholder}
            className="mt-2 min-h-40 w-full resize-none rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm leading-6 text-white/85 outline-none transition-colors placeholder:text-white/22 focus:border-cyan-200/35"
          />

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-[11px] font-bold text-white/48">
              <span>{copy.frameRatio}</span>
              <select
                value={size}
                onChange={event => setSize(event.target.value)}
                className="h-11 w-full rounded-xl border border-white/10 bg-[#080d15] px-3 text-xs text-white/75 outline-none focus:border-cyan-200/35"
              >
                {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {mode === 'image' ? (
              <label className="space-y-2 text-[11px] font-bold text-white/48">
                <span>{copy.imageCount}</span>
                <select
                  value={count}
                  onChange={event => setCount(Number(event.target.value))}
                  className="h-11 w-full rounded-xl border border-white/10 bg-[#080d15] px-3 text-xs text-white/75 outline-none focus:border-cyan-200/35"
                >
                  {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            ) : (
              <label className="space-y-2 text-[11px] font-bold text-white/48">
                <span>{copy.duration}</span>
                <select
                  value={duration}
                  onChange={event => setDuration(Number(event.target.value))}
                  className="h-11 w-full rounded-xl border border-white/10 bg-[#080d15] px-3 text-xs text-white/75 outline-none focus:border-cyan-200/35"
                >
                  {[5, 6, 10].map(value => <option key={value} value={value}>{value} {copy.seconds}</option>)}
                </select>
              </label>
            )}
          </div>

          {mode === 'video' && (
            <label className="mt-4 space-y-2 text-[11px] font-bold text-white/48">
              <span>{copy.firstFrame}</span>
              <input
                value={referenceImage}
                onChange={event => setReferenceImage(event.target.value)}
                placeholder={copy.firstFramePlaceholder}
                className="h-11 w-full rounded-xl border border-white/10 bg-black/25 px-3 text-xs text-white/75 outline-none placeholder:text-white/22 focus:border-cyan-200/35"
              />
            </label>
          )}

          <button
            type="submit"
            disabled={!prompt.trim() || busy}
            className="mt-6 flex h-12 items-center justify-center gap-2 rounded-2xl border border-cyan-100/20 bg-cyan-200 text-sm font-black text-[#031015] shadow-[0_12px_36px_rgba(34,211,238,0.18)] transition-all hover:-translate-y-0.5 hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
            {busy
              ? copy.generatingAction
              : mode === 'image' ? copy.generateImage : copy.generateVideo}
          </button>
        </form>

        <div className="flex min-h-[22rem] flex-col overflow-hidden rounded-[1.75rem] border border-white/[0.09] bg-black/20">
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-4">
            {status === 'completed' ? <CheckCircle2 size={15} className="text-emerald-300" /> : status === 'error' ? <X size={15} className="text-red-300" /> : <Sparkles size={15} className="text-cyan-200/70" />}
            <span className={`text-xs ${status === 'error' ? 'text-red-100/75' : 'text-white/50'}`}>{statusCopy}</span>
          </div>
          <div data-media-generation-results className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {artifacts.length === 0 ? (
              <div className="max-w-xs text-center">
                <span className="mx-auto flex h-20 w-20 items-center justify-center rounded-[1.75rem] border border-dashed border-white/12 bg-white/[0.025] text-white/18">
                  {mode === 'image' ? <ImageIcon size={32} /> : <Video size={32} />}
                </span>
                <p className="mt-4 text-sm font-semibold text-white/38">{copy.resultsAppear}</p>
                <p className="mt-2 text-[11px] leading-5 text-white/24">{copy.noFakeCompletion}</p>
              </div>
            ) : (
              <div className="grid w-full grid-cols-1 gap-4 xl:grid-cols-2">
                {artifacts.map(artifact => (
                  <article key={artifact.id} className="group overflow-hidden rounded-2xl border border-white/10 bg-black/35">
                    <div className="aspect-video overflow-hidden bg-black/45">
                      {artifact.kind === 'image' ? (
                        <img
                          src={artifact.url}
                          alt={artifact.fileName || copy.generateImage}
                          onLoad={() => onArtifactReady(artifact)}
                          onError={() => onArtifactError(artifact)}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <video
                          src={artifact.url}
                          controls
                          preload="metadata"
                          onLoadedMetadata={() => onArtifactReady(artifact)}
                          onError={() => onArtifactError(artifact)}
                          className="h-full w-full object-contain"
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenArtifact(artifact)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-xs text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white/80"
                    >
                      <span className="truncate">{artifact.fileName || (artifact.kind === 'image' ? copy.viewImage : copy.viewVideo)}</span>
                      <ExternalLink size={13} className="shrink-0" />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
