import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  defaultMediaGenerationOperation,
  mediaGenerationKindForOperation,
  type MediaGenerationArtifact,
  type MediaGenerationKind,
  type MediaGenerationOperation,
  type MediaGenerationSourceOperation,
} from '@/lib/mediaGenerationArtifacts';
import { mediaGenerationCopy } from '@/i18n/locales/mediaGeneration';

export type MediaGenerationStudioStatus =
  | 'idle'
  | 'submitting'
  | 'generating'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'error';

export type MediaGenerationRequest = {
  mode: MediaGenerationKind;
  operation: MediaGenerationOperation;
  prompt: string;
  size: string;
  count?: number;
  duration?: number;
  primaryImage?: string;
  referenceImages?: string[];
  referenceImage?: string;
  primaryArtifactId?: string;
  referenceArtifactIds?: string[];
  referenceArtifactId?: string;
};

export type MediaGenerationSourceSlot = 'primary' | 'reference' | 'first_frame';

export type MediaGenerationSourceChange = {
  operation: MediaGenerationSourceOperation;
  slot: MediaGenerationSourceSlot;
  value: string;
  artifact?: MediaGenerationArtifact;
};

export type MediaGenerationStudioProps = {
  /** Legacy image/video surface selection. `operation` selects the exact tool lane. */
  mode: MediaGenerationKind;
  operation?: MediaGenerationOperation;
  locale: 'zh' | 'en';
  busy: boolean;
  status: MediaGenerationStudioStatus;
  statusDetail?: string;
  artifacts: MediaGenerationArtifact[];
  sourceArtifacts?: MediaGenerationArtifact[];
  primaryImage?: string;
  referenceImages?: string[];
  referenceImage?: string;
  primaryArtifactId?: string;
  referenceArtifactIds?: string[];
  referenceArtifactId?: string;
  retryRequest?: MediaGenerationRequest | null;
  onModeChange: (mode: MediaGenerationKind) => void;
  onOperationChange?: (operation: MediaGenerationOperation) => void;
  onSourceChange?: (change: MediaGenerationSourceChange) => void;
  onRequestSourceImage?: (
    operation: MediaGenerationSourceOperation,
    slot: MediaGenerationSourceSlot,
  ) => void;
  onClose: () => void;
  onGenerate: (request: MediaGenerationRequest) => void;
  onCancel?: () => void;
  onRetry?: (request: MediaGenerationRequest) => void;
  onOpenArtifact: (artifact: MediaGenerationArtifact) => void;
  onSaveArtifact?: (artifact: MediaGenerationArtifact) => void;
  onContinueEdit?: (artifact: MediaGenerationArtifact) => void;
  onUseAsVideoReference?: (artifact: MediaGenerationArtifact) => void;
  onArtifactReady: (artifact: MediaGenerationArtifact) => void;
  onArtifactError: (artifact: MediaGenerationArtifact) => void;
};

const IMAGE_SIZE_VALUES = ['1024x1024', '1792x1024', '1024x1792'] as const;
const VIDEO_SIZE_VALUES = ['1280x720', '720x1280', '960x960'] as const;

type SourceImageFieldProps = {
  label: string;
  required: boolean;
  requiredText: string;
  placeholder: string;
  value: string;
  artifacts: MediaGenerationArtifact[];
  selectedArtifactId?: string;
  disabled: boolean;
  uploadLabel: string;
  chooseLabel: string;
  clearLabel: string;
  onChange: (value: string) => void;
  onChoose: (artifact: MediaGenerationArtifact) => void;
  onClear: () => void;
  onUpload?: () => void;
};

function SourceImageField({
  label,
  required,
  requiredText,
  placeholder,
  value,
  artifacts,
  selectedArtifactId,
  disabled,
  uploadLabel,
  chooseLabel,
  clearLabel,
  onChange,
  onChoose,
  onClear,
  onUpload,
}: SourceImageFieldProps) {
  return (
    <fieldset className="mt-4 space-y-2" disabled={disabled} aria-label={label}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-bold text-white/48">
          {label}{required ? ' *' : ''}
        </span>
        {onUpload && (
          <button
            type="button"
            onClick={onUpload}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-bold text-white/48 transition-colors hover:bg-white/[0.08] hover:text-white/75 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Upload size={12} />
            {uploadLabel}
          </button>
        )}
      </div>
      <div className="relative">
        <input
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          aria-required={required}
          className="h-11 w-full rounded-xl border border-white/10 bg-black/25 px-3 pr-10 text-xs text-white/75 outline-none placeholder:text-white/22 focus:border-cyan-200/35"
        />
        {value && (
          <button
            type="button"
            onClick={onClear}
            aria-label={clearLabel}
            title={clearLabel}
            className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-white/32 transition-colors hover:bg-white/10 hover:text-white/75"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {required && !value.trim() && <p className="text-[10px] text-amber-100/55">{requiredText}</p>}
      {artifacts.length > 0 && (
        <div className="space-y-2 pt-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/28">{chooseLabel}</p>
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {artifacts.map(artifact => {
              const selected = selectedArtifactId === artifact.id
                || (!selectedArtifactId && value === (artifact.path || artifact.url));
              return (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => onChoose(artifact)}
                  title={artifact.fileName || label}
                  aria-pressed={selected}
                  className={`h-16 w-20 shrink-0 overflow-hidden rounded-xl border bg-black/35 transition-colors ${
                    selected
                      ? 'border-cyan-200/60 ring-2 ring-cyan-200/15'
                      : 'border-white/10 hover:border-white/25'
                  }`}
                >
                  <img src={artifact.url} alt={artifact.fileName || label} className="h-full w-full object-cover" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </fieldset>
  );
}

export function MediaGenerationStudio({
  mode,
  operation,
  locale,
  busy,
  status,
  statusDetail,
  artifacts,
  sourceArtifacts = [],
  primaryImage,
  referenceImages,
  referenceImage,
  primaryArtifactId,
  referenceArtifactIds,
  referenceArtifactId,
  retryRequest,
  onModeChange,
  onOperationChange,
  onSourceChange,
  onRequestSourceImage,
  onClose,
  onGenerate,
  onCancel,
  onRetry,
  onOpenArtifact,
  onSaveArtifact,
  onContinueEdit,
  onUseAsVideoReference,
  onArtifactReady,
  onArtifactError,
}: MediaGenerationStudioProps) {
  const copy = mediaGenerationCopy(locale);
  const [localOperation, setLocalOperation] = useState<MediaGenerationOperation>(() => (
    operation || defaultMediaGenerationOperation(mode)
  ));
  const activeOperation = operation || localOperation;
  const activeKind = mediaGenerationKindForOperation(activeOperation);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<string>(activeKind === 'image' ? IMAGE_SIZE_VALUES[0] : VIDEO_SIZE_VALUES[0]);
  const [count, setCount] = useState(1);
  const [duration, setDuration] = useState(6);
  const [localPrimaryImage, setLocalPrimaryImage] = useState(primaryImage || '');
  const [localReferenceImages, setLocalReferenceImages] = useState<string[]>(referenceImages || []);
  const [localReferenceImage, setLocalReferenceImage] = useState(referenceImage || '');
  const [localPrimaryArtifactId, setLocalPrimaryArtifactId] = useState(primaryArtifactId || '');
  const [localEditReferenceArtifactId, setLocalEditReferenceArtifactId] = useState(referenceArtifactIds?.[0] || '');
  const [localVideoReferenceArtifactId, setLocalVideoReferenceArtifactId] = useState(referenceArtifactId || '');
  const [lastRequest, setLastRequest] = useState<MediaGenerationRequest | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const resolvedPrimaryImage = primaryImage === undefined ? localPrimaryImage : primaryImage;
  const resolvedReferenceImages = referenceImages === undefined ? localReferenceImages : referenceImages;
  const resolvedReferenceImage = referenceImage === undefined ? localReferenceImage : referenceImage;
  const resolvedPrimaryArtifactId = primaryArtifactId === undefined
    ? resolvedPrimaryImage === localPrimaryImage ? localPrimaryArtifactId : ''
    : primaryArtifactId;
  const resolvedEditReferenceArtifactId = referenceArtifactIds === undefined
    ? (resolvedReferenceImages[0] || '') === (localReferenceImages[0] || '')
      ? localEditReferenceArtifactId
      : ''
    : referenceArtifactIds[0] || '';
  const resolvedVideoReferenceArtifactId = referenceArtifactId === undefined
    ? resolvedReferenceImage === localReferenceImage ? localVideoReferenceArtifactId : ''
    : referenceArtifactId;
  const editReferenceImage = resolvedReferenceImages[0] || '';
  const selectableImageArtifacts = sourceArtifacts.filter(artifact => artifact.kind === 'image');
  const isWorking = busy || status === 'submitting' || status === 'generating' || status === 'cancelling';
  const sourceRequired = activeOperation === 'image_edit' || activeOperation === 'image_to_video';
  const hasRequiredSource = activeOperation === 'image_edit'
    ? Boolean(resolvedPrimaryImage.trim())
    : activeOperation === 'image_to_video'
      ? Boolean(resolvedReferenceImage.trim())
      : true;
  const requestToRetry = retryRequest || lastRequest;

  useEffect(() => {
    if (operation) {
      setLocalOperation(operation);
      return;
    }
    setLocalOperation(current => (
      mediaGenerationKindForOperation(current) === mode
        ? current
        : defaultMediaGenerationOperation(mode)
    ));
  }, [mode, operation]);

  useEffect(() => {
    setSize(activeKind === 'image' ? IMAGE_SIZE_VALUES[0] : VIDEO_SIZE_VALUES[0]);
  }, [activeKind]);

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

  const switchOperation = (nextOperation: MediaGenerationOperation) => {
    if (isWorking || nextOperation === activeOperation) return;
    const nextKind = mediaGenerationKindForOperation(nextOperation);
    setLocalOperation(nextOperation);
    onOperationChange?.(nextOperation);
    if (nextKind !== mode) onModeChange(nextKind);
  };

  const notifySourceChange = (
    targetOperation: MediaGenerationSourceOperation,
    slot: MediaGenerationSourceSlot,
    value: string,
    artifact?: MediaGenerationArtifact,
  ) => {
    onSourceChange?.({ operation: targetOperation, slot, value, artifact });
  };

  const setPrimarySource = (value: string, artifact?: MediaGenerationArtifact) => {
    setLocalPrimaryImage(value);
    setLocalPrimaryArtifactId(artifact?.id || '');
    notifySourceChange('image_edit', 'primary', value, artifact);
  };

  const setEditReferenceSource = (value: string, artifact?: MediaGenerationArtifact) => {
    setLocalReferenceImages(value.trim() ? [value] : []);
    setLocalEditReferenceArtifactId(artifact?.id || '');
    notifySourceChange('image_edit', 'reference', value, artifact);
  };

  const setVideoReferenceSource = (value: string, artifact?: MediaGenerationArtifact) => {
    setLocalReferenceImage(value);
    setLocalVideoReferenceArtifactId(artifact?.id || '');
    notifySourceChange('image_to_video', 'first_frame', value, artifact);
  };

  const options = activeKind === 'image'
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

  const operationOptions: Array<{
    value: MediaGenerationOperation;
    label: string;
    icon: React.ReactNode;
  }> = [
    { value: 'text_to_image', label: copy.textToImage, icon: <ImageIcon size={14} /> },
    { value: 'image_edit', label: copy.imageEdit, icon: <Pencil size={14} /> },
    { value: 'text_to_video', label: copy.textToVideo, icon: <Video size={14} /> },
    { value: 'image_to_video', label: copy.imageToVideo, icon: <Sparkles size={14} /> },
  ];

  const statusCopy = (() => {
    if (status === 'submitting') return copy.statusSubmitting;
    if (status === 'generating') return statusDetail || copy.statusGenerating;
    if (status === 'cancelling') return statusDetail || copy.statusCancelling;
    if (status === 'cancelled') return statusDetail || copy.statusCancelled;
    if (status === 'completed') return copy.statusCompleted;
    if (status === 'error') return statusDetail || copy.statusError;
    return copy.statusIdle;
  })();

  const buildRequest = (): MediaGenerationRequest => {
    const base = {
      mode: activeKind,
      operation: activeOperation,
      prompt: prompt.trim(),
      size,
    } as const;
    if (activeOperation === 'text_to_image') return { ...base, count };
    if (activeOperation === 'image_edit') {
      const boundedReferences = resolvedReferenceImages.map(value => value.trim()).filter(Boolean).slice(0, 1);
      return {
        ...base,
        primaryImage: resolvedPrimaryImage.trim(),
        referenceImages: boundedReferences,
        ...(resolvedPrimaryArtifactId ? { primaryArtifactId: resolvedPrimaryArtifactId } : {}),
        ...(resolvedEditReferenceArtifactId
          ? { referenceArtifactIds: [resolvedEditReferenceArtifactId] }
          : {}),
      };
    }
    if (activeOperation === 'image_to_video') {
      return {
        ...base,
        duration,
        referenceImage: resolvedReferenceImage.trim(),
        ...(resolvedVideoReferenceArtifactId
          ? { referenceArtifactId: resolvedVideoReferenceArtifactId }
          : {}),
      };
    }
    return { ...base, duration };
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || isWorking || (sourceRequired && !hasRequiredSource)) return;
    const request = buildRequest();
    setLastRequest(request);
    onGenerate(request);
  };

  const retry = () => {
    if (!requestToRetry || isWorking) return;
    setLastRequest(requestToRetry);
    if (onRetry) onRetry(requestToRetry);
    else onGenerate(requestToRetry);
  };

  const saveArtifact = (artifact: MediaGenerationArtifact) => {
    if (onSaveArtifact) {
      onSaveArtifact(artifact);
      return;
    }
    if (typeof document === 'undefined') return;
    const anchor = document.createElement('a');
    anchor.href = artifact.url;
    anchor.download = artifact.fileName || (artifact.kind === 'image' ? 'lumi-image' : 'lumi-video');
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const focusPromptSoon = () => {
    const focus = () => promptRef.current?.focus({ preventScroll: true });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else focus();
  };

  const continueEditing = (artifact: MediaGenerationArtifact) => {
    if (isWorking) return;
    switchOperation('image_edit');
    setPrimarySource(artifact.path || artifact.url, artifact);
    onContinueEdit?.(artifact);
    focusPromptSoon();
  };

  const selectAsVideoReference = (artifact: MediaGenerationArtifact) => {
    if (isWorking) return;
    switchOperation('image_to_video');
    setVideoReferenceSource(artifact.path || artifact.url, artifact);
    onUseAsVideoReference?.(artifact);
    focusPromptSoon();
  };

  const promptPlaceholder = activeOperation === 'image_edit'
    ? copy.imageEditPlaceholder
    : activeOperation === 'image_to_video'
      ? copy.imageToVideoPlaceholder
      : activeKind === 'image'
        ? copy.imagePlaceholder
        : copy.videoPlaceholder;
  const actionLabel = activeOperation === 'image_edit'
    ? copy.editImage
    : activeKind === 'image'
      ? copy.generateImage
      : copy.generateVideo;

  return (
    <section
      data-media-generation-studio
      data-media-generation-mode={activeKind}
      data-media-generation-operation={activeOperation}
      className="absolute inset-0 z-[215] flex min-h-0 flex-col overflow-hidden bg-[#03070d]/96 backdrop-blur-2xl"
      aria-label={activeKind === 'image' ? copy.imageStudio : copy.videoStudio}
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-4 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
            activeKind === 'image'
              ? 'border-rose-200/20 bg-rose-300/10 text-rose-100'
              : 'border-amber-200/20 bg-amber-300/10 text-amber-100'
          }`}>
            {activeKind === 'image' ? <ImageIcon size={21} /> : <Video size={21} />}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-black tracking-wide text-white/90">
              {activeOperation === 'image_edit'
                ? copy.imageEdit
                : activeKind === 'image' ? copy.imageGeneration : copy.videoGeneration}
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
          <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl bg-black/25 p-1.5 sm:grid-cols-4">
            {operationOptions.map(item => (
              <button
                key={item.value}
                type="button"
                data-media-generation-tab={item.value}
                aria-pressed={activeOperation === item.value}
                disabled={isWorking}
                onClick={() => switchOperation(item.value)}
                className={`flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[11px] font-bold transition-colors ${
                  activeOperation === item.value ? 'bg-white/12 text-white' : 'text-white/38 hover:bg-white/[0.06] hover:text-white/65'
                } disabled:cursor-not-allowed disabled:opacity-45`}
              >
                {item.icon}
                <span>{item.label}</span>
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
            rows={6}
            autoFocus
            placeholder={promptPlaceholder}
            className="mt-2 min-h-36 w-full resize-none rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm leading-6 text-white/85 outline-none transition-colors placeholder:text-white/22 focus:border-cyan-200/35"
          />

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-[11px] font-bold text-white/48">
              <span>{copy.frameRatio}</span>
              <select
                value={size}
                onChange={event => setSize(event.target.value)}
                disabled={isWorking}
                className="h-11 w-full rounded-xl border border-white/10 bg-[#080d15] px-3 text-xs text-white/75 outline-none focus:border-cyan-200/35 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {options.map(optionItem => <option key={optionItem.value} value={optionItem.value}>{optionItem.label}</option>)}
              </select>
            </label>
            {activeOperation === 'text_to_image' ? (
              <label className="space-y-2 text-[11px] font-bold text-white/48">
                <span>{copy.imageCount}</span>
                <select
                  value={count}
                  onChange={event => setCount(Number(event.target.value))}
                  disabled={isWorking}
                  className="h-11 w-full rounded-xl border border-white/10 bg-[#080d15] px-3 text-xs text-white/75 outline-none focus:border-cyan-200/35 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            ) : activeKind === 'video' ? (
              <label className="space-y-2 text-[11px] font-bold text-white/48">
                <span>{copy.duration}</span>
                <select
                  value={duration}
                  onChange={event => setDuration(Number(event.target.value))}
                  disabled={isWorking}
                  className="h-11 w-full rounded-xl border border-white/10 bg-[#080d15] px-3 text-xs text-white/75 outline-none focus:border-cyan-200/35 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {[5, 6, 10].map(value => <option key={value} value={value}>{value} {copy.seconds}</option>)}
                </select>
              </label>
            ) : <div aria-hidden="true" />}
          </div>

          {activeOperation === 'image_edit' && (
            <>
              <SourceImageField
                label={copy.primaryImage}
                required
                requiredText={copy.primaryImageRequired}
                placeholder={copy.sourceImagePlaceholder}
                value={resolvedPrimaryImage}
                artifacts={selectableImageArtifacts}
                selectedArtifactId={resolvedPrimaryArtifactId}
                disabled={isWorking}
                uploadLabel={copy.uploadSourceImage}
                chooseLabel={copy.chooseFromArtifacts}
                clearLabel={copy.clearSourceImage}
                onChange={value => setPrimarySource(value)}
                onChoose={artifact => setPrimarySource(artifact.path || artifact.url, artifact)}
                onClear={() => setPrimarySource('')}
                onUpload={onRequestSourceImage
                  ? () => onRequestSourceImage('image_edit', 'primary')
                  : undefined}
              />
              <SourceImageField
                label={copy.editReferenceImage}
                required={false}
                requiredText=""
                placeholder={copy.sourceImagePlaceholder}
                value={editReferenceImage}
                artifacts={selectableImageArtifacts.filter(artifact => artifact.id !== resolvedPrimaryArtifactId)}
                selectedArtifactId={resolvedEditReferenceArtifactId}
                disabled={isWorking}
                uploadLabel={copy.uploadSourceImage}
                chooseLabel={copy.chooseFromArtifacts}
                clearLabel={copy.clearSourceImage}
                onChange={value => setEditReferenceSource(value)}
                onChoose={artifact => setEditReferenceSource(artifact.path || artifact.url, artifact)}
                onClear={() => setEditReferenceSource('')}
                onUpload={onRequestSourceImage
                  ? () => onRequestSourceImage('image_edit', 'reference')
                  : undefined}
              />
            </>
          )}

          {activeOperation === 'image_to_video' && (
            <SourceImageField
              label={copy.videoReferenceImage}
              required
              requiredText={copy.videoReferenceRequired}
              placeholder={copy.sourceImagePlaceholder}
              value={resolvedReferenceImage}
              artifacts={selectableImageArtifacts}
              selectedArtifactId={resolvedVideoReferenceArtifactId}
              disabled={isWorking}
              uploadLabel={copy.uploadSourceImage}
              chooseLabel={copy.chooseFromArtifacts}
              clearLabel={copy.clearSourceImage}
              onChange={value => setVideoReferenceSource(value)}
              onChoose={artifact => setVideoReferenceSource(artifact.path || artifact.url, artifact)}
              onClear={() => setVideoReferenceSource('')}
              onUpload={onRequestSourceImage
                ? () => onRequestSourceImage('image_to_video', 'first_frame')
                : undefined}
            />
          )}

          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <button
              type="submit"
              disabled={!prompt.trim() || isWorking || !hasRequiredSource}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl border border-cyan-100/20 bg-cyan-200 text-sm font-black text-[#031015] shadow-[0_12px_36px_rgba(34,211,238,0.18)] transition-all hover:-translate-y-0.5 hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
            >
              {isWorking ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
              {status === 'cancelling'
                ? copy.cancellingAction
                : isWorking ? copy.generatingAction : actionLabel}
            </button>
            {onCancel && (status === 'submitting' || status === 'generating' || status === 'cancelling') && (
              <button
                type="button"
                onClick={onCancel}
                disabled={status === 'cancelling'}
                className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-red-200/20 bg-red-300/[0.08] px-4 text-xs font-black text-red-100/75 transition-colors hover:bg-red-300/[0.15] hover:text-red-50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {status === 'cancelling' ? <Loader2 size={15} className="animate-spin" /> : <Square size={14} />}
                {status === 'cancelling' ? copy.cancellingAction : copy.cancelGeneration}
              </button>
            )}
          </div>

          {(status === 'error' || status === 'cancelled') && requestToRetry && (
            <button
              type="button"
              onClick={retry}
              disabled={isWorking}
              className="mt-2 flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-xs font-bold text-white/62 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw size={14} />
              {copy.retrySameSettings}
            </button>
          )}
        </form>

        <div className="flex min-h-[22rem] flex-col overflow-hidden rounded-[1.75rem] border border-white/[0.09] bg-black/20">
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-4">
            {status === 'completed' ? (
              <CheckCircle2 size={15} className="text-emerald-300" />
            ) : status === 'error' || status === 'cancelled' ? (
              <X size={15} className={status === 'error' ? 'text-red-300' : 'text-amber-200'} />
            ) : status === 'submitting' || status === 'generating' || status === 'cancelling' ? (
              <Loader2 size={15} className="animate-spin text-cyan-200/70" />
            ) : (
              <Sparkles size={15} className="text-cyan-200/70" />
            )}
            <span className={`text-xs ${status === 'error' ? 'text-red-100/75' : status === 'cancelled' ? 'text-amber-100/70' : 'text-white/50'}`}>
              {statusCopy}
            </span>
          </div>
          <div data-media-generation-results className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {artifacts.length === 0 ? (
              <div className="max-w-xs text-center">
                <span className="mx-auto flex h-20 w-20 items-center justify-center rounded-[1.75rem] border border-dashed border-white/12 bg-white/[0.025] text-white/18">
                  {activeKind === 'image' ? <ImageIcon size={32} /> : <Video size={32} />}
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
                    <div className="border-t border-white/[0.07] px-3 py-3">
                      <p className="truncate px-1 text-xs font-semibold text-white/55">
                        {artifact.fileName || (artifact.kind === 'image' ? copy.viewImage : copy.viewVideo)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenArtifact(artifact)}
                          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-bold text-white/52 transition-colors hover:bg-white/[0.08] hover:text-white/80"
                        >
                          <ExternalLink size={12} />
                          {artifact.kind === 'image' ? copy.viewImage : copy.viewVideo}
                        </button>
                        <button
                          type="button"
                          onClick={() => saveArtifact(artifact)}
                          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-bold text-white/52 transition-colors hover:bg-white/[0.08] hover:text-white/80"
                        >
                          <Download size={12} />
                          {copy.saveArtifact}
                        </button>
                        {artifact.kind === 'image' && (
                          <>
                            <button
                              type="button"
                              onClick={() => continueEditing(artifact)}
                              disabled={isWorking}
                              className="flex items-center gap-1.5 rounded-lg border border-rose-200/15 bg-rose-300/[0.06] px-2.5 py-1.5 text-[10px] font-bold text-rose-100/60 transition-colors hover:bg-rose-300/[0.12] hover:text-rose-50 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Pencil size={12} />
                              {copy.continueEditing}
                            </button>
                            <button
                              type="button"
                              onClick={() => selectAsVideoReference(artifact)}
                              disabled={isWorking}
                              className="flex items-center gap-1.5 rounded-lg border border-amber-200/15 bg-amber-300/[0.06] px-2.5 py-1.5 text-[10px] font-bold text-amber-100/60 transition-colors hover:bg-amber-300/[0.12] hover:text-amber-50 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Video size={12} />
                              {copy.useAsVideoReference}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
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
