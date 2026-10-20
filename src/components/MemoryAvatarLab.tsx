import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ArrowRight, ArrowLeft, Loader2, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '../contexts/AppContext';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { memoryAvatarCopy } from '../i18n/locales/memoryAvatar';
import { memoryTerritoryCopy } from '../i18n/locales/memoryTerritory';
import { CN_WECHAT_ALIASES } from '../i18n/regions/cn/recognition';
import { MemoryAvatarCreate } from './MemoryAvatarCreate';
import { MemoryAvatarProfile } from './MemoryAvatarProfile';
import { getStoredToken } from '../services/authService';
import type { MemoryAvatar } from '../../shared/memory_avatar';
import { apiFetch } from '../services/apiClient';

interface DistillSummary {
  messageCount: number;
  memoryCount: number;
  cognitiveStyle?: Record<string, number>;
  socialStyle?: Record<string, number>;
  tone?: string;
  topPhrases?: string[];
}

interface DistillResult {
  personalityConfig: any;
  seedMemories: Array<{
    type: string;
    content: string;
    keywords: string[];
    confidence: number;
    evidenceGrade: 'verbatim' | 'artifact' | 'impression';
  }>;
  evidenceMap: Array<{ memoryIndex: number; grade: string; source: string }>;
  relationshipType: string;
  narrative: string;
  inferredName: string;
  summary: DistillSummary;
}


const DIM_ORDER = ['analytical', 'intuitive', 'systematic', 'creative', 'warmth', 'directness', 'playfulness', 'formality'];

function MiniRadar({ cognitiveStyle, socialStyle, isZh = true }: { cognitiveStyle?: Record<string, number>; socialStyle?: Record<string, number>; isZh?: boolean }) {
  if (!cognitiveStyle || !socialStyle) return null;
  const values = { ...cognitiveStyle, ...socialStyle };
  const dimensions = memoryAvatarCopy(isZh ? 'zh' : 'en').dimensions as Record<string, string>;
  const cx = 90, cy = 90, r = 75;

  const vertices = DIM_ORDER.map((dim, i) => {
    const angle = (Math.PI * 2 * i) / DIM_ORDER.length - Math.PI / 2;
    const val = Math.max(0.05, values[dim] || 0);
    return { x: cx + r * val * Math.cos(angle), y: cy + r * val * Math.sin(angle) };
  });

  return (
    <svg width={200} height={200} viewBox="0 0 180 180" className="mx-auto max-w-full text-muted-foreground">
      {[0.25, 0.5, 0.75, 1].map(scale => (
        <polygon key={scale} points={DIM_ORDER.map((_, i) => {
          const a = (Math.PI * 2 * i) / DIM_ORDER.length - Math.PI / 2;
          return `${cx + r * scale * Math.cos(a)},${cy + r * scale * Math.sin(a)}`;
        }).join(' ')} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={0.5} />
      ))}
      {DIM_ORDER.map((dim, i) => {
        const angle = (Math.PI * 2 * i) / DIM_ORDER.length - Math.PI / 2;
        const lx = cx + (r + 15) * Math.cos(angle);
        const ly = cy + (r + 15) * Math.sin(angle);
        return <text key={dim} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" className="fill-current" style={{ fontSize: '7px', fontFamily: 'monospace' }}>{dimensions[dim] || dim}</text>;
      })}
      <polygon points={vertices.map(v => `${v.x},${v.y}`).join(' ')} fill="rgba(192,132,252,0.25)" stroke="rgba(192,132,252,0.6)" strokeWidth={1} />
      {vertices.map((v, i) => <circle key={i} cx={v.x} cy={v.y} r={2.5} fill="rgba(192,132,252,0.9)" />)}
    </svg>
  );
}

function EvidenceBadge({ grade, isZh = true }: { grade: 'verbatim' | 'artifact' | 'impression'; isZh?: boolean }) {
  const config = {
    verbatim: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400' },
    artifact: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', text: 'text-blue-400' },
    impression: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400' },
  };
  const c = config[grade] || config.impression;
  return <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full border ${c.bg} ${c.border} ${c.text}`}>{memoryAvatarCopy(isZh ? 'zh' : 'en').evidence[grade]}</span>;
}

export function MemoryAvatarLab({ t, lang, onEnterSanctuary }: { t: any; lang?: 'en' | 'zh'; onEnterSanctuary?: (agent: any) => void }) {
  const { user, login } = useApp();
  const [creationMode, setCreationMode] = useState<'direct' | 'records' | 'photo'>('direct');
  // `lang` is passed by DesktopUI as the authoritative shell locale.  Keep
  // the `t.langCode` fallback for callers/tests that render the lab alone.
  const isZh = (lang || t?.langCode || 'zh') !== 'en';
  const locale = isZh ? 'zh' : 'en';
  const copy = memoryAvatarCopy(locale);
  const territory = memoryTerritoryCopy(locale);
  // The legacy lab used uiMessage's global locale implicitly.  That could
  // lag one render behind the desktop language switch, leaving this panel in
  // English while the rest of the desktop was Chinese.  Bind every message
  // in this surface to the same locale as the parent shell.
  const message = (key: Parameters<typeof uiMessage>[0]) => uiMessage(key, locale);
  const [currentStep, setCurrentStep] = useState(1);
  const [distilling, setDistilling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [recordError, setRecordError] = useState('');
  const [chatLog, setChatLog] = useState('');
  const [format, setFormat] = useState<'wechat' | 'qq' | 'plain'>('wechat');
  const [fileName, setFileName] = useState('');
  const [relationshipType, setRelationshipType] = useState('close_friend');
  const [distillResult, setDistillResult] = useState<DistillResult | null>(null);
  const [createdAvatar, setCreatedAvatar] = useState<any | null>(null);
  const [sanctuaryName, setSanctuaryName] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioTranscribing, setAudioTranscribing] = useState(false);
  const [audioTranscript, setAudioTranscript] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const token = getStoredToken();
  const ownerScope = useMemo(() => ({ id: user?.uid || '', token }), [user?.uid, token]);
  const [createdPhoto, setCreatedPhoto] = useState<{ owner: typeof ownerScope; avatar: MemoryAvatar } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoAvatar = createdPhoto?.owner === ownerScope ? createdPhoto.avatar : null;
  const currentOwner = useRef(ownerScope);
  currentOwner.current = ownerScope;
  const operationGeneration = useRef(0);
  const operationAbort = useRef(new AbortController());
  const createOperation = useRef<{ fingerprint: string; id: string } | null>(null);
  const createBusy = useRef(false);
  const readers = useRef(new Set<FileReader>());
  const cancelOperations = useCallback(() => {
    operationGeneration.current++;
    operationAbort.current.abort();
    for (const reader of readers.current) { if (reader.readyState === FileReader.LOADING) reader.abort(); }
    readers.current.clear();
  }, []);
  const reset = useCallback(() => {
    cancelOperations();
    operationAbort.current = new AbortController();
    createOperation.current = null; createBusy.current = false;
    setCurrentStep(1); setChatLog(''); setFileName(''); setFormat('wechat');
    setRelationshipType('close_friend'); setDistillResult(null); setCreatedAvatar(null);
    setSanctuaryName(''); setAudioFile(null); setAudioTranscript('');
    setDistilling(false); setCreating(false); setAudioTranscribing(false); setRecordError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (audioInputRef.current) audioInputRef.current.value = '';
  }, [cancelOperations]);
  useEffect(() => {
    reset(); setCreationMode('direct'); setCreatedPhoto(null); setPhotoBusy(false);
    return cancelOperations;
  }, [ownerScope, reset, cancelOperations]);
  const beginOperation = useCallback(() => {
    const generation = operationGeneration.current;
    const signal = operationAbort.current.signal;
    return { signal, current: () => currentOwner.current === ownerScope && generation === operationGeneration.current && !signal.aborted };
  }, [ownerScope]);

  const handleFileLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const operation = beginOperation();
    setFileName(file.name); setRecordError('');
    // Detect format from filename
    if (CN_WECHAT_ALIASES.some(alias => file.name.includes(alias)) || file.name.includes('wechat')) setFormat('wechat');
    else if (file.name.includes('QQ') || file.name.includes('qq')) setFormat('qq');
    else setFormat('plain');

    const reader = new FileReader();
    readers.current.add(reader);
    reader.onloadend = () => readers.current.delete(reader);
    reader.onload = (ev) => {
      if (!operation.current()) return;
      const text = ev.target?.result as string;
      setChatLog(text);
      const lineCount = text.split('\n').filter(l => l.trim()).length;
      toast.success(formatUiMessage('memory-avatar-lab.loaded-value0-lines-from-value1.f8752f8cd7', { value0: lineCount, value1: file.name }, locale));
    };
    reader.onerror = () => { if (operation.current()) setRecordError(territory.recordsReadError); };
    reader.readAsText(file);
  }, [locale, beginOperation, territory.recordsReadError]);

  const handleAudioUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ownerScope.id) { login(); return; }
    const operation = beginOperation();
    setAudioFile(file);
    // Transcribe audio via server
    setAudioTranscribing(true); setRecordError('');
    const reader = new FileReader();
    readers.current.add(reader);
    reader.onloadend = () => readers.current.delete(reader);
    reader.onload = async () => {
      if (!operation.current()) return;
      try {
        const base64 = (reader.result as string).split(',')[1];
        const res = await apiFetch('/api/audio/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64, fileName: file.name }),
          credentials: 'include',
          signal: operation.signal,
        });
        if (!operation.current()) return;
        if (res.ok) {
          const data = await res.json();
          if (!operation.current()) return;
          setAudioTranscript(data.text || '');
          // Append transcript to chat log for richer distillation
          if (data.text) {
            setChatLog(prev => `${prev}\n\n[${copy.audioRecordHeader}]\n${data.text.split('\n').map((l: string) => `Target: ${l}`).join('\n')}`);
            const seconds = Math.round((data.text?.length || 0) / 20);
            toast.success(formatUiMessage('memory-avatar-lab.transcribed-about-value0-seconds-of.e79c9b7d86', { value0: seconds }, locale));
          }
        } else {
          setRecordError(copy.transcriptionFailed); toast.error(copy.transcriptionFailed);
        }
      } catch {
        if (operation.current()) { setRecordError(copy.transcriptionFailed); toast.error(copy.transcriptionFailed); }
      } finally {
        if (operation.current()) setAudioTranscribing(false);
      }
    };
    reader.onerror = () => {
      if (operation.current()) { setAudioTranscribing(false); setRecordError(copy.transcriptionFailed); }
    };
    reader.readAsDataURL(file);
  }, [copy.audioRecordHeader, copy.transcriptionFailed, locale, ownerScope.id, login, beginOperation]);

  const handleDistill = async () => {
    if (!user) { login(); return; }
    if (!chatLog.trim()) { toast.error(copy.uploadChatLogFirst); return; }
    const operation = beginOperation();
    setDistilling(true); setRecordError('');
    try {
      const res = await apiFetch('/api/memory-avatars/distill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatLog,
          format,
          relationshipType,
          ...(audioTranscript ? { audioTranscript } : {}),
        }),
        credentials: 'include',
        signal: operation.signal,
      });
      if (!res.ok) throw new Error((await res.json()).error || copy.distillationFailed);
      const result: DistillResult = await res.json();
      if (!operation.current()) return;
      setDistillResult(result);
      setSanctuaryName(result.inferredName);
      setCurrentStep(2);
      toast.success(copy.distilledPersonality(result.inferredName, result.seedMemories.length));
    } catch (err: any) {
      if (operation.current()) { setRecordError(err.message || copy.distillationFailed); toast.error(err.message || copy.distillationFailed); }
    } finally {
      if (operation.current()) setDistilling(false);
    }
  };

  const handleCreateSanctuary = async () => {
    if (!user) { login(); return; }
    if (!distillResult || createBusy.current) return;
    const operation = beginOperation();
    const fields = {
      name: sanctuaryName || distillResult.inferredName,
      relationshipType: distillResult.relationshipType,
      personalityConfig: distillResult.personalityConfig,
      evidenceMap: distillResult.evidenceMap,
      seedMemories: distillResult.seedMemories,
      narrative: distillResult.narrative,
    };
    const fingerprint = JSON.stringify(fields);
    if (createOperation.current?.fingerprint !== fingerprint) createOperation.current = { fingerprint, id: crypto.randomUUID() };
    createBusy.current = true;
    setCreating(true); setRecordError('');
    try {
      const res = await apiFetch('/api/memory-avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: operation.signal,
        body: JSON.stringify({ ...fields, clientRequestId: createOperation.current.id }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || copy.memoryAvatarCreationFailed);
      }
      const avatar = await res.json();
      if (!operation.current()) return;
      setCreatedAvatar(avatar);
      toast.success(copy.sanctuaryCreatedFor(avatar.name));
      setCurrentStep(3);
      onEnterSanctuary?.(avatar);
    } catch (err: any) {
      if (operation.current()) { setRecordError(err.message || copy.creationFailed); toast.error(err.message || copy.creationFailed); }
    } finally {
      if (operation.current()) { createBusy.current = false; setCreating(false); }
    }
  };

  const fieldClass = "mt-2 w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none focus:border-foreground/40 disabled:opacity-50";
  const panelClass = "space-y-5 rounded-[28px] border border-border bg-card p-6 sm:p-8";
  const actionClass = "flex items-center justify-center gap-2 rounded-xl bg-[#d4c5a8] px-5 py-3.5 text-sm font-semibold text-[#202521] transition-colors hover:bg-[#e2d4b8] disabled:opacity-40";

  return <MemoryAvatarCreate key={JSON.stringify([ownerScope.id, ownerScope.token])} locale={locale} ownerId={ownerScope.id} mode={creationMode}
    onCreated={avatar => creationMode === 'photo' ? setCreatedPhoto({ owner: ownerScope, avatar }) : onEnterSanctuary?.(avatar)} onLogin={login}
    completed={creationMode === 'photo' && Boolean(photoAvatar)} disabled={photoBusy}
    onModeChange={mode => { if (!photoBusy && mode !== creationMode) { reset(); setCreationMode(mode); } }}>
    {creationMode === 'photo' && photoAvatar ? <div className="space-y-5">
      <p className="text-sm leading-7 text-muted-foreground">{territory.photoSetup}</p>
      <div className="overflow-hidden rounded-[28px] border border-border">
        <MemoryAvatarProfile avatar={photoAvatar} ownerId={ownerScope.id} locale={locale} initialTab="media"
          onUpdated={avatar => setCreatedPhoto(current => current?.owner === ownerScope && current.avatar.id === avatar.id ? { owner: ownerScope, avatar } : current)}
          onArchived={() => setCreatedPhoto(null)} onBusyChange={setPhotoBusy} />
      </div>
      <button type="button" disabled={photoBusy} onClick={() => { if (!photoBusy) onEnterSanctuary?.(photoAvatar); }} className={actionClass + ' w-full'}><ArrowRight size={17} />{territory.recordsEnter}</button>
    </div> : <>
    {recordError && <p role="alert" className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-500">{recordError}</p>}
    {currentStep === 1 && <div className={panelClass}>
      <p className="text-xs leading-6 text-muted-foreground">{message('memory-avatar-lab.this-memory-avatar-is-distilled.4692efbcd3')}</p>
      <label className="block text-sm text-foreground">{territory.recordsUpload}
        <input ref={fileInputRef} type="file" accept=".txt,.json,.csv" onChange={handleFileLoad} disabled={distilling || audioTranscribing} className="mt-2 block w-full min-w-0 rounded-xl border border-border p-3 text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-foreground/5 file:px-3 file:py-2 file:text-foreground" />
      </label>
      {fileName && <p className="break-all text-xs text-muted-foreground">{fileName}</p>}
      <label className="block text-sm text-foreground">{territory.recordsFormat}
        <select value={format} onChange={e => setFormat(e.target.value as typeof format)} disabled={distilling || audioTranscribing} className={fieldClass}>
          <option value="wechat">{message('memory-avatar-lab.wechat.47409ec635')}</option>
          <option value="qq">{copy.qq}</option><option value="plain">{copy.plain}</option>
        </select>
      </label>
      <label className="block text-sm text-foreground">{territory.recordsSource}
        <textarea rows={9} value={chatLog} onChange={e => setChatLog(e.target.value)} disabled={distilling || audioTranscribing} className={fieldClass + ' resize-y leading-6'} />
      </label>
      <p className="text-xs leading-6 text-muted-foreground">{territory.recordsSourceHint}</p>
      <label className="block text-sm text-foreground">{territory.relationship}
        <select value={relationshipType} onChange={e => setRelationshipType(e.target.value)} disabled={distilling || audioTranscribing} className={fieldClass}>
          {Object.entries(copy.relationships).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}
        </select>
      </label>
      <label className="block text-sm text-foreground">{territory.recordsAudio}
        <input ref={audioInputRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" onChange={handleAudioUpload} disabled={audioTranscribing || distilling} className="mt-2 block w-full min-w-0 rounded-xl border border-border p-3 text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-foreground/5 file:px-3 file:py-2 file:text-foreground" />
      </label>
      {audioFile && <p role="status" className="break-all text-xs leading-6 text-muted-foreground">{audioFile.name}{audioTranscribing && ' · ' + message('memory-avatar-lab.transcribing.c331c36c02')}</p>}
      <button type="button" onClick={handleDistill} disabled={!chatLog.trim() || distilling || audioTranscribing} className={actionClass + ' w-full'}>
        {distilling ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />}
        {distilling ? territory.recordsExtracting : territory.recordsExtract}
      </button>
    </div>}
    {currentStep === 2 && distillResult && <div className="space-y-5">
      <section className={panelClass}>
        <h3 className="text-lg font-medium">{territory.recordsReview}</h3>
        <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{distillResult.narrative}</p>
        <p className="text-xs leading-6 text-muted-foreground">{formatUiMessage('memory-avatar-lab.value0-messages.1a2f7d0c60', { value0: distillResult.summary.messageCount }, locale)} · {territory.memoryCount(distillResult.seedMemories.length)}</p>
        <label className="block text-sm text-foreground">{territory.name}
          <input value={sanctuaryName} onChange={e => setSanctuaryName(e.target.value)} disabled={creating} maxLength={120} className={fieldClass} />
        </label>
        <details className="rounded-xl border border-border p-4">
          <summary className="cursor-pointer text-sm text-foreground">{message('memory-avatar-lab.8-d-personality-vector.7aae255fba')}</summary>
          <MiniRadar cognitiveStyle={distillResult.summary.cognitiveStyle} socialStyle={distillResult.summary.socialStyle} isZh={isZh} />
          <p className="mt-3 text-sm text-muted-foreground">{distillResult.personalityConfig.expressionStyle?.tone}</p>
          {distillResult.summary.topPhrases?.length ? <p className="mt-3 break-words text-xs leading-6 text-muted-foreground">{message('memory-avatar-lab.common-phrases.f7abfd0f03')}: {distillResult.summary.topPhrases.join(' · ')}</p> : null}
        </details>
      </section>
      <section className={panelClass}>
        <h3 className="text-sm font-medium">{message('memory-avatar-lab.seed-memories.21492d3467')} ({distillResult.seedMemories.length})</h3>
        <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
          {distillResult.seedMemories.map((memory, index) => <div key={index} className="space-y-2 rounded-xl border border-border bg-background p-4">
            <EvidenceBadge grade={memory.evidenceGrade} isZh={isZh} />
            <p className="break-words text-sm leading-6 text-foreground">{memory.content}</p>
            <p className="break-words text-xs text-muted-foreground">{memory.keywords?.join(', ')} · {Math.round(memory.confidence * 100)}%</p>
          </div>)}
        </div>
        <div className="space-y-1 text-xs leading-6 text-muted-foreground">
          <p>{message('memory-avatar-lab.tool-permission-none-chat-only.7cb2212746')}</p>
          <p>{message('memory-avatar-lab.memory-isolation-private-not-shared.e99ab197a6')}</p>
          <p>{message('memory-avatar-lab.evolution-frozen-no-automatic-drift.92f93d919a')}</p>
          <p>{message('memory-avatar-lab.notifications-off-visible-only-inside.e2569b60ea')}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" disabled={creating} onClick={() => { setRecordError(''); setCurrentStep(1); }} className="flex items-center gap-2 rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground hover:bg-foreground/5 disabled:opacity-40"><ArrowLeft size={16} />{territory.recordsEdit}</button>
          <button type="button" onClick={handleCreateSanctuary} disabled={creating || !sanctuaryName.trim()} className={actionClass}>
            {creating ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />}{creating ? territory.creating : territory.createAction}
          </button>
        </div>
      </section>
    </div>}
    {currentStep === 3 && createdAvatar && <div className={panelClass}>
      <CheckCircle size={32} className="text-emerald-500" /><h3 className="text-xl font-medium">{territory.recordsCreated}</h3>
      <p className="text-sm text-muted-foreground">{createdAvatar.name}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={reset} className="rounded-xl border border-border px-4 py-3 text-sm">{territory.create}</button>
        <button type="button" onClick={() => onEnterSanctuary?.(createdAvatar)} className={actionClass}>{territory.recordsEnter}<ArrowRight size={17} /></button>
      </div>
    </div>}
    </>}
  </MemoryAvatarCreate>;
}
