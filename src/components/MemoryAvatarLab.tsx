import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, FileText, Sparkles, Heart, Users, Briefcase, GraduationCap, User, X, ArrowRight, ArrowLeft, Eye, Castle, Loader2, CheckCircle, AlertTriangle, Zap, Mic, Headphones } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '../contexts/AppContext';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { memoryAvatarCopy } from '../i18n/locales/memoryAvatar';
import { CN_WECHAT_ALIASES } from '../i18n/regions/cn/recognition';

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

const localize = (isZh: boolean, zh: string, en: string) => (isZh ? zh : en);

const RELATIONSHIP_TYPES = [
  { id: 'close_friend', icon: <Users size={18} /> },
  { id: 'family', icon: <Heart size={18} /> },
  { id: 'lover', icon: <Heart size={18} className="text-rose-400" /> },
  { id: 'mentor', icon: <GraduationCap size={18} /> },
  { id: 'colleague', icon: <Briefcase size={18} /> },
];

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
    <svg width={200} height={200} viewBox="0 0 180 180" className="mx-auto">
      {[0.25, 0.5, 0.75, 1].map(scale => (
        <polygon key={scale} points={DIM_ORDER.map((_, i) => {
          const a = (Math.PI * 2 * i) / DIM_ORDER.length - Math.PI / 2;
          return `${cx + r * scale * Math.cos(a)},${cy + r * scale * Math.sin(a)}`;
        }).join(' ')} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} />
      ))}
      {DIM_ORDER.map((dim, i) => {
        const angle = (Math.PI * 2 * i) / DIM_ORDER.length - Math.PI / 2;
        const lx = cx + (r + 15) * Math.cos(angle);
        const ly = cy + (r + 15) * Math.sin(angle);
        return <text key={dim} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" className="fill-white/20" style={{ fontSize: '7px', fontFamily: 'monospace' }}>{dimensions[dim] || dim}</text>;
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
  // `lang` is passed by DesktopUI as the authoritative shell locale.  Keep
  // the `t.langCode` fallback for callers/tests that render the lab alone.
  const isZh = (lang || t?.langCode || 'zh') !== 'en';
  const locale = isZh ? 'zh' : 'en';
  const copy = memoryAvatarCopy(locale);
  // The legacy lab used uiMessage's global locale implicitly.  That could
  // lag one render behind the desktop language switch, leaving this panel in
  // English while the rest of the desktop was Chinese.  Bind every message
  // in this surface to the same locale as the parent shell.
  const message = (key: Parameters<typeof uiMessage>[0]) => uiMessage(key, locale);
  const [currentStep, setCurrentStep] = useState(1);
  const [distilling, setDistilling] = useState(false);
  const [creating, setCreating] = useState(false);
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

  const handleFileLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // Detect format from filename
    if (CN_WECHAT_ALIASES.some(alias => file.name.includes(alias)) || file.name.includes('wechat')) setFormat('wechat');
    else if (file.name.includes('QQ') || file.name.includes('qq')) setFormat('qq');
    else setFormat('plain');

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setChatLog(text);
      const lineCount = text.split('\n').filter(l => l.trim()).length;
      toast.success(formatUiMessage('memory-avatar-lab.loaded-value0-lines-from-value1.f8752f8cd7', { value0: lineCount, value1: file.name }, locale));
    };
    reader.readAsText(file);
  }, [locale]);

  const handleAudioUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAudioFile(file);
    // Transcribe audio via server
    setAudioTranscribing(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = (reader.result as string).split(',')[1];
        const res = await fetch('/api/audio/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64, fileName: file.name }),
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setAudioTranscript(data.text || '');
          // Append transcript to chat log for richer distillation
          if (data.text) {
            setChatLog(prev => `${prev}\n\n[${copy.audioRecordHeader}]\n${data.text.split('\n').map((l: string) => `Target: ${l}`).join('\n')}`);
            const seconds = Math.round((data.text?.length || 0) / 20);
            toast.success(formatUiMessage('memory-avatar-lab.transcribed-about-value0-seconds-of.e79c9b7d86', { value0: seconds }, locale));
          }
        } else {
          toast.error(copy.transcriptionFailed);
        }
      } catch {
        toast.error(copy.transcriptionFailed);
      } finally {
        setAudioTranscribing(false);
      }
    };
    reader.readAsDataURL(file);
  }, [copy.audioRecordHeader, copy.transcriptionFailed, locale]);

  const handleDistill = async () => {
    if (!user) { login(); return; }
    if (!chatLog.trim()) { toast.error(copy.uploadChatLogFirst); return; }
    setDistilling(true);
    try {
      const res = await fetch('/api/memory-avatars/distill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatLog,
          format,
          relationshipType,
          ...(audioTranscript ? { audioTranscript } : {}),
        }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error((await res.json()).error || copy.distillationFailed);
      const result: DistillResult = await res.json();
      setDistillResult(result);
      setSanctuaryName(result.inferredName);
      setCurrentStep(2);
      toast.success(copy.distilledPersonality(result.inferredName, result.seedMemories.length));
    } catch (err: any) {
      toast.error(err.message || copy.distillationFailed);
    } finally {
      setDistilling(false);
    }
  };

  const handleCreateSanctuary = async () => {
    if (!user) { login(); return; }
    if (!distillResult) return;
    setCreating(true);
    try {
      const res = await fetch('/api/memory-avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: sanctuaryName || distillResult.inferredName,
          relationshipType: distillResult.relationshipType,
          personalityConfig: distillResult.personalityConfig,
          evidenceMap: distillResult.evidenceMap,
          seedMemories: distillResult.seedMemories,
          narrative: distillResult.narrative,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || copy.memoryAvatarCreationFailed);
      }
      const avatar = await res.json();
      setCreatedAvatar(avatar);
      toast.success(copy.sanctuaryCreatedFor(avatar.name));
      setCurrentStep(3);
      onEnterSanctuary?.(avatar);
    } catch (err: any) {
      toast.error(err.message || copy.creationFailed);
    } finally {
      setCreating(false);
    }
  };

  const reset = () => {
    setCurrentStep(1);
    setChatLog('');
    setFileName('');
    setFormat('wechat');
    setRelationshipType('close_friend');
    setDistillResult(null);
    setCreatedAvatar(null);
    setSanctuaryName('');
    setAudioFile(null);
    setAudioTranscript('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (audioInputRef.current) audioInputRef.current.value = '';
  };

  const steps = [
    { id: 1, title: message('memory-avatar-lab.data-upload.f8882ffe87'), icon: <Upload size={18} /> },
    { id: 2, title: message('memory-avatar-lab.personality-distill.d018bf8865'), icon: <Zap size={18} /> },
    { id: 3, title: message('memory-avatar-lab.sanctuary-setup.5a3c664734'), icon: <Castle size={18} /> },
  ];

  const relationshipLabel = (id: string) => {
    const rel = (copy.relationships as Record<string, { label: string; desc: string }>)[id];
    return rel?.label || id;
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950/90">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Castle size={18} className="text-fuchsia-400" />
          <div>
            <h2 className="text-sm font-black text-white/90 uppercase tracking-wider">{copy.labTitle}</h2>
            <p className="text-xs text-white/55 font-mono">{copy.labTitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {steps.map((step, i) => (
            <div key={step.id} className="flex items-center gap-1">
              {i > 0 && <div className="w-6 h-px bg-white/10" />}
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all ${currentStep >= step.id ? 'bg-fuchsia-500/20 text-fuchsia-400 border border-fuchsia-500/30' : 'bg-white/5 text-white/45 border border-white/5'}`}>
                {step.icon}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-6">
        <AnimatePresence mode="wait">
          {/* Step 1: Upload */}
          {currentStep === 1 && (
            <motion.div key="s1" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="max-w-2xl mx-auto space-y-6">
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-xs text-amber-300/80 leading-relaxed">
                <AlertTriangle size={14} className="inline mr-2" />
                {message('memory-avatar-lab.this-memory-avatar-is-distilled.4692efbcd3')}
              </div>

              <div className="space-y-3">
                <label className="text-xs font-bold uppercase tracking-wider text-white/55">{message('memory-avatar-lab.chat-log-file.bb299f7d8a')}</label>
                <input ref={fileInputRef} type="file" accept=".txt,.json,.csv" onChange={handleFileLoad} className="hidden" />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-white/10 rounded-2xl p-10 flex flex-col items-center justify-center gap-4 hover:border-fuchsia-500/30 hover:bg-white/[0.02] transition-all cursor-pointer"
                >
                  {fileName ? (
                    <>
                      <FileText size={36} className="text-fuchsia-400" />
                      <span className="text-sm text-white/60 font-medium">{fileName}</span>
                      <span className="text-xs text-white/45">{formatUiMessage('memory-avatar-lab.value0-lines-loaded.de56ef52af', { value0: chatLog.split('\n').filter(l => l.trim()).length }, locale)}</span>
                    </>
                  ) : (
                    <>
                      <Upload size={36} className="text-white/40" />
                      <div className="text-center space-y-1">
                        <p className="text-sm text-white/40">{message('memory-avatar-lab.upload-exported-chat-logs.384bfeac0a')}</p>
                        <p className="text-xs text-white/40">{message('memory-avatar-lab.supports-wechat-qq-txt-exports.cda5368eb6')}</p>
                      </div>
                    </>
                  )}
                </div>
                <div className="flex gap-2">
                  {(['wechat', 'qq', 'plain'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase transition-all ${format === f ? 'bg-fuchsia-500/20 border border-fuchsia-500/30 text-fuchsia-400' : 'bg-white/5 border border-white/5 text-white/55 hover:bg-white/10'}`}
                    >
                      {f === 'wechat' ? message('memory-avatar-lab.wechat.47409ec635') : f === 'qq' ? copy.qq : copy.plain}
                    </button>
                  ))}
                </div>
              </div>

              {/* Audio upload for voice recording */}
              <div className="space-y-3">
                <label className="text-xs font-bold uppercase tracking-wider text-white/55">{message('memory-avatar-lab.voice-recording-optional.8e9886fb36')}</label>
                <input ref={audioInputRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" onChange={handleAudioUpload} className="hidden" />
                <div
                  onClick={() => audioInputRef.current?.click()}
                  className="border-2 border-dashed border-white/10 rounded-2xl p-6 flex flex-col items-center justify-center gap-3 hover:border-fuchsia-500/30 hover:bg-white/[0.02] transition-all cursor-pointer"
                >
                  {audioFile ? (
                    <>
                      {audioTranscribing ? (
                        <>
                          <Loader2 size={28} className="text-fuchsia-400 animate-spin" />
                          <span className="text-xs text-white/40">{message('memory-avatar-lab.transcribing.c331c36c02')}</span>
                        </>
                      ) : (
                        <>
                          <Headphones size={28} className="text-fuchsia-400" />
                          <span className="text-xs text-white/50">{audioFile.name}</span>
                          <span className="text-xs text-white/45">{message('memory-avatar-lab.transcribed-voice-traits-will-be.838fb403af')}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <Mic size={28} className="text-white/40" />
                      <div className="text-center space-y-1">
                        <p className="text-xs text-white/55">{message('memory-avatar-lab.upload-voice-recording.d41cb378e2')}</p>
                        <p className="text-[12px] text-white/35">{message('memory-avatar-lab.mp3-wav-ogg-used-to.a17b38b21d')}</p>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-xs font-bold uppercase tracking-wider text-white/55">{message('memory-avatar-lab.relationship-type.b9cd2f96c7')}</label>
                <div className="grid grid-cols-5 gap-2">
                  {RELATIONSHIP_TYPES.map(rel => (
                    <button
                      key={rel.id}
                      onClick={() => setRelationshipType(rel.id)}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all ${relationshipType === rel.id ? 'bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-400' : 'bg-white/5 border-white/5 text-white/55 hover:bg-white/10'}`}
                    >
                      {rel.icon}
                      <span className="text-[12px] font-bold">{(copy.relationships as Record<string, { label: string }>)[rel.id]?.label || rel.id}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={handleDistill}
                  disabled={!chatLog.trim() || distilling}
                  className="flex items-center gap-2 px-8 py-3 bg-fuchsia-500/20 border border-fuchsia-500/30 rounded-xl text-sm font-bold text-fuchsia-400 hover:bg-fuchsia-500/30 disabled:opacity-30 transition-all"
                >
                  {distilling ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                  {distilling ? message('memory-avatar-lab.distilling.028f02afbb') : message('memory-avatar-lab.start-personality-distill.3b5dc0a853')}
                  <ArrowRight size={14} />
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 2: Results Preview */}
          {currentStep === 2 && distillResult && (
            <motion.div key="s2" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="max-w-3xl mx-auto space-y-6">
              {/* Narrative */}
              <div className="p-6 bg-white/5 border border-white/10 rounded-2xl space-y-3">
                <div className="flex items-center gap-2">
                  <Eye size={14} className="text-fuchsia-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-white/55">{message('memory-avatar-lab.distill-result.ae34ae3926')} - {distillResult.inferredName}</span>
                </div>
                <p className="text-sm text-white/60 leading-relaxed italic">"{distillResult.narrative}"</p>
                <div className="flex gap-3 text-xs text-white/55 font-mono">
                  <span>{formatUiMessage('memory-avatar-lab.value0-messages.1a2f7d0c60', { value0: distillResult.summary.messageCount }, locale)}</span>
                  <span>{formatUiMessage('memory-avatar-lab.value0-memories.1bea29c434', { value0: distillResult.seedMemories.length }, locale)}</span>
                  <span>{relationshipLabel(distillResult.relationshipType)}</span>
                  <span className="text-fuchsia-400">{distillResult.personalityConfig.expressionStyle.tone}</span>
                </div>
              </div>

              {/* Radar */}
              <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/55 mb-3">{message('memory-avatar-lab.8-d-personality-vector.7aae255fba')}</h3>
                <MiniRadar cognitiveStyle={distillResult.summary.cognitiveStyle} socialStyle={distillResult.summary.socialStyle} isZh={isZh} />
              </div>

              {/* Common phrases */}
              {distillResult.summary.topPhrases && distillResult.summary.topPhrases.length > 0 && (
                <div className="p-4 bg-white/5 border border-white/10 rounded-2xl space-y-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-white/55">{message('memory-avatar-lab.common-phrases.f7abfd0f03')}</span>
                  <div className="flex flex-wrap gap-2">
                    {distillResult.summary.topPhrases.map((p, i) => (
                      <span key={i} className="px-3 py-1 bg-fuchsia-500/10 border border-fuchsia-500/20 rounded-full text-xs text-fuchsia-300">{p}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Seed Memories with Evidence */}
              <div className="p-4 bg-white/5 border border-white/10 rounded-2xl space-y-3">
                <span className="text-xs font-bold uppercase tracking-wider text-white/55">{message('memory-avatar-lab.seed-memories.21492d3467')} ({distillResult.seedMemories.length})</span>
                <div className="space-y-2 max-h-64 overflow-auto">
                  {distillResult.seedMemories.slice(0, 10).map((mem, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 bg-white/[0.02] rounded-xl border border-white/5">
                      <EvidenceBadge grade={mem.evidenceGrade} isZh={isZh} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white/50 leading-relaxed">{mem.content}</p>
                        <span className="text-[12px] text-white/40 font-mono">{mem.keywords?.join(', ')}</span>
                      </div>
                      <span className="text-[12px] text-white/40 font-mono">{Math.round(mem.confidence * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Sanctuary config */}
              <div className="p-4 bg-white/5 border border-white/10 rounded-2xl space-y-3">
                <span className="text-xs font-bold uppercase tracking-wider text-white/55">{message('memory-avatar-lab.sanctuary-settings.0498da5129')}</span>
                <input
                  value={sanctuaryName}
                  onChange={(e) => setSanctuaryName(e.target.value)}
                  placeholder={message('memory-avatar-lab.sanctuary-name.432e121118')}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white/80 placeholder:text-white/40 focus:outline-none focus:border-fuchsia-500/30"
                />
                <div className="text-[12px] text-white/45 font-mono space-y-1">
                  <p>{message('memory-avatar-lab.tool-permission-none-chat-only.7cb2212746')}</p>
                  <p>{message('memory-avatar-lab.memory-isolation-private-not-shared.e99ab197a6')}</p>
                  <p>{message('memory-avatar-lab.evolution-frozen-no-automatic-drift.92f93d919a')}</p>
                  <p>{message('memory-avatar-lab.notifications-off-visible-only-inside.e2569b60ea')}</p>
                </div>
              </div>

              <div className="flex justify-between pt-2">
                <button onClick={() => setCurrentStep(1)} className="flex items-center gap-2 px-6 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white/40 hover:bg-white/10 transition-all">
                  <ArrowLeft size={14} /> {message('memory-avatar-lab.back.5db5cac55e')}
                </button>
                <button onClick={handleCreateSanctuary} disabled={creating} className="flex items-center gap-2 px-8 py-3 bg-fuchsia-500/20 border border-fuchsia-500/30 rounded-xl text-sm font-bold text-fuchsia-400 hover:bg-fuchsia-500/30 disabled:opacity-30 transition-all">
                  {creating ? <Loader2 size={16} className="animate-spin" /> : <Castle size={16} />}
                  {creating ? message('memory-avatar-lab.creating.ba147d5f24') : message('memory-avatar-lab.create-sanctuary.f2cde9d0b0')}
                  <ArrowRight size={14} />
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 3: Created */}
          {currentStep === 3 && distillResult && (
            <motion.div key="s3" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="max-w-md mx-auto text-center space-y-8 py-12">
              <div className="w-24 h-24 rounded-[2rem] bg-fuchsia-500/20 flex items-center justify-center mx-auto border border-fuchsia-500/30 shadow-[0_0_60px_rgba(192,132,252,0.15)]">
                <CheckCircle size={48} className="text-fuchsia-400" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-black tracking-tighter text-white/90">{message('memory-avatar-lab.sanctuary-created.792e5da4c0')}</h2>
                <p className="text-sm text-white/40 max-w-sm mx-auto">
                  {formatUiMessage('memory-avatar-lab.the-memory-avatar-for-value0.1eb3e87088', { value0: sanctuaryName || distillResult.inferredName }, locale)}
                </p>
              </div>
              <div className="flex gap-4 justify-center">
                <button onClick={reset} className="px-6 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white/40 hover:bg-white/10 transition-all">
                  {message('memory-avatar-lab.create-another.e1f98b1538')}
                </button>
                <button
                  onClick={() => createdAvatar && onEnterSanctuary?.(createdAvatar)}
                  disabled={!createdAvatar}
                  className="px-6 py-3 bg-fuchsia-500/20 border border-fuchsia-500/30 rounded-xl text-sm font-bold text-fuchsia-400 hover:bg-fuchsia-500/30 disabled:opacity-40 transition-all"
                >
                  {message('memory-avatar-lab.enter-sanctuary.800a2ea891')} <ArrowRight size={14} className="inline ml-1" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
