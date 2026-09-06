import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, CameraOff, Check, ChevronDown, Loader2, MessageCircle, Mic, MicOff, Phone, PhoneOff, Plus, Send, Settings2, Square, UserRound, Video } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { useApp } from '@/contexts/AppContext';
import { useLocale } from '../lib/useT';
import { memoryAvatarCopy } from '../i18n/locales/memoryAvatar';
import { memoryTerritoryCopy } from '../i18n/locales/memoryTerritory';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE, type MemoryAvatar, type MemoryAvatarAppearance } from '../../shared/memory_avatar';
import { useMemoryAvatarConversation } from '../hooks/useMemoryAvatarConversation';
import { useMemoryAvatarCall } from '../hooks/useMemoryAvatarCall';
import { MemoryAvatarStage } from './MemoryAvatarStage';
import { MemoryAvatarProfile } from './MemoryAvatarProfile';
import { MemoryAvatarPortraitStage } from './MemoryAvatarPortraitStage';
import { memoryPortraitCopy } from '../i18n/locales/memoryPortrait';

interface SanctuaryAgent extends Partial<MemoryAvatar> {
  id: string;
  name: string;
  category?: string;
  territory?: string;
  distilledFrom?: string;
  data?: string;
}
interface SanctuaryProps {
  agent: SanctuaryAgent | null;
  lang?: 'en' | 'zh';
  isOpen: boolean;
  onClose: () => void;
  avatars?: SanctuaryAgent[];
  onSelectAvatar?: (id: string) => void;
  onCreateAnother?: () => void;
  onAvatarUpdated?: (avatar: MemoryAvatar) => void;
  onAvatarArchived?: (id: string) => void;
}
function asRecord(agent: SanctuaryAgent): MemoryAvatar {
  return {
    id: agent.id, name: agent.name, relationshipType: agent.relationshipType || 'close_friend',
    status: agent.status || 'active', revision: agent.revision || 1, narrative: agent.narrative || '',
    appearance: { ...DEFAULT_MEMORY_AVATAR_APPEARANCE, ...agent.appearance }, voice: agent.voice || {},
    presentation: agent.presentation,
    memoryCount: agent.memoryCount ?? agent.seedMemoryIds?.length ?? 0, isFrozen: agent.isFrozen !== false,
    personalityConfig: agent.personalityConfig || {}, evidenceMap: agent.evidenceMap || [], seedMemoryIds: agent.seedMemoryIds || [],
    createdAt: agent.createdAt || '', updatedAt: agent.updatedAt || agent.createdAt || '',
  };
}

/** Closing really unmounts the call, even when the desktop keeps this lazy surface loaded. */
export function Sanctuary(props: SanctuaryProps) {
  const { user } = useApp();
  const fallbackLocale = useLocale();
  const ownerId = String(user?.uid || '');
  if (!props.isOpen || !props.agent || !ownerId) return null;
  return <MemoryTerritory key={JSON.stringify([ownerId, props.agent.id])} {...props} agent={props.agent} ownerId={ownerId} locale={props.lang || fallbackLocale} />;
}

function MemoryTerritory({ agent, ownerId, locale, avatars = [], onClose, onSelectAvatar, onCreateAnother, onAvatarUpdated, onAvatarArchived }: SanctuaryProps & { agent: SanctuaryAgent; ownerId: string; locale: 'zh' | 'en' }) {
  const copy = memoryTerritoryCopy(locale);
  const relationshipCopy = memoryAvatarCopy(locale);
  const portraitCopy = memoryPortraitCopy(locale);
  const socket = useSocket();
  const [avatar, setAvatar] = useState(() => asRecord(agent));
  const [profileOpen, setProfileOpen] = useState(false);
  const [preview, setPreview] = useState<MemoryAvatarAppearance | null>(null);
  const [draft, setDraft] = useState('');
  const [startingCall, setStartingCall] = useState(false);
  const [startError, setStartError] = useState('');
  const [portraitConsent, setPortraitConsent] = useState(false);
  const portraitMediaId = avatar.presentation?.mode === 'portrait' ? avatar.presentation.mediaId : undefined;
  const startBusy = useRef(false);
  const startGeneration = useRef(0);
  const mounted = useRef(true);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const cameraPreview = useRef<HTMLVideoElement>(null);
  const conversation = useMemoryAvatarConversation({ socket, avatarId: avatar.id, ownerId, locale });
  const call = useMemoryAvatarCall({ socket, avatarId: avatar.id, ownerId, voiceId: avatar.voice.voiceId, enabled: true,
    portrait: Boolean(portraitMediaId && portraitConsent), portraitMediaId,
    onTranscript: conversation.appendVoiceTranscript, onResponse: conversation.appendVoiceResponse });
  const callActive = call.state !== 'idle' || startingCall;
  const relationship = relationshipCopy.relationships[avatar.relationshipType as keyof typeof relationshipCopy.relationships]?.label || relationshipCopy.memoryLabel;
  const people = avatars.some(person => person.id === avatar.id) ? avatars : [avatar, ...avatars];
  const canStartCall = !callActive && !conversation.busy && Boolean(socket?.connected);
  const canSend = !callActive && !conversation.busy && !conversation.loading && Boolean(draft.trim());
  const stateLabel = call.state === 'idle' ? (startingCall ? copy.connecting : conversation.busy ? copy.thinking : copy.ready)
    : call.state === 'queued' ? copy.waiting : copy[call.state];
  const errorCode = 'errorCode' in call ? String(call.errorCode || '') : '';
  const callError = !call.error ? startError : errorCode === 'CAMERA_UNAVAILABLE' ? copy.cameraUnavailable
    : errorCode === 'AVATAR_UNAVAILABLE' ? copy.avatarUnavailable
    : errorCode === 'STT_UNAVAILABLE' || errorCode === 'STT_FAILED' || errorCode === 'STRICT_VOICE_UNAVAILABLE' ? copy.speechInputUnavailable
    : errorCode === 'TTS_OUTPUT_UNAVAILABLE' ? copy.voiceOutputUnavailable
    : errorCode === 'PERSISTENCE_UNKNOWN' ? copy.callSaveFailed
    : errorCode === 'PORTRAIT_UNAVAILABLE' ? portraitCopy.unavailable
    : errorCode === 'VOICE_INPUT_UNAVAILABLE' ? copy.voiceInputUnavailable : copy.callUnavailable;

  useEffect(() => { setAvatar(asRecord(agent)); }, [agent]);
  useEffect(() => { setPortraitConsent(false); }, [portraitMediaId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [conversation.messages]);
  useEffect(() => {
    const video = cameraPreview.current;
    if (!video || !call.cameraStream) return;
    video.srcObject = call.cameraStream;
    void video.play().catch(() => {});
    return () => { video.pause(); video.srcObject = null; };
  }, [call.cameraStream]);

  const updateAvatar = useCallback((next: MemoryAvatar) => { setAvatar(next); setPreview(null); onAvatarUpdated?.(next); }, [onAvatarUpdated]);
  const closeProfile = () => { setProfileOpen(false); setPreview(null); };
  const endVoice = call.end;
  const endCall = useCallback(() => {
    startGeneration.current++; startBusy.current = false; setStartingCall(false); endVoice();
  }, [endVoice]);
  const leave = () => { endCall(); onClose(); };
  const selectAvatar = (id: string) => { if (id !== avatar.id) { endCall(); onSelectAvatar?.(id); } };
  const createAnother = () => { endCall(); onCreateAnother?.(); };
  const archive = (id: string) => { endCall(); if (onAvatarArchived) onAvatarArchived(id); else onClose(); };
  const startCall = (video: boolean) => {
    if (!canStartCall || startBusy.current) return;
    const current = ++startGeneration.current;
    startBusy.current = true; setStartingCall(true); setStartError('');
    const operation = video ? call.startVideo() : call.startVoice();
    void Promise.resolve(operation).catch(() => { if (mounted.current && current === startGeneration.current) setStartError(copy.callUnavailable); })
      .finally(() => { if (current === startGeneration.current) { startBusy.current = false; if (mounted.current) setStartingCall(false); } });
  };
  const send = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    if (conversation.send(draft)) setDraft('');
  };
  const controlClass = 'inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35';

  return <div role="dialog" aria-modal="true" aria-label={copy.title} className="fixed inset-0 z-[210] flex min-h-0 flex-col overflow-hidden bg-[#14191b] text-[#e4e7df]">
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-white/[.07] px-4 sm:h-[72px] sm:px-6">
      <button type="button" onClick={leave} aria-label={copy.leave} title={copy.leave} className="flex shrink-0 items-center gap-2 rounded-lg py-2 pr-2 text-sm text-[#b7bdb5] hover:text-white"><ArrowLeft size={19} /><span className="hidden sm:inline">{copy.leave}</span></button>
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium tracking-wide text-[#e5ddcb]">{copy.title}</p><p className="mt-0.5 hidden truncate text-[11px] text-[#8e9990] sm:block">{copy.subtitle}</p></div>
      <button type="button" onClick={() => profileOpen ? closeProfile() : setProfileOpen(true)} aria-pressed={profileOpen} aria-label={profileOpen ? copy.conversation : copy.profile} title={profileOpen ? copy.conversation : copy.profile} className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-[#d4d8ce] hover:bg-white/5">{profileOpen ? <MessageCircle size={16} /> : <Settings2 size={16} />}<span className="hidden min-[420px]:inline">{profileOpen ? copy.conversation : copy.profile}</span></button>
      {onCreateAnother && <button type="button" onClick={createAnother} aria-label={copy.create} title={copy.create} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#d4c5a8] px-3 py-2 text-xs font-semibold text-[#242b26]"><Plus size={16} /><span className="hidden min-[420px]:inline">{copy.create}</span></button>}
    </header>

    <div className="flex min-h-0 flex-1">
      <aside aria-label={copy.people} className="hidden w-48 shrink-0 flex-col border-r border-white/[.07] bg-[#171d1e] lg:flex">
        <div className="px-5 pb-3 pt-6 text-[11px] tracking-wide text-[#8d9a90]">{copy.people}</div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">{people.map(person => <button type="button" key={person.id} onClick={() => selectAvatar(person.id)} aria-current={person.id === avatar.id ? 'page' : undefined} className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${person.id === avatar.id ? 'bg-[#c5baa2]/10 text-[#e2d8c3]' : 'text-[#a7b1a7] hover:bg-white/[.035]'}`}>
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm ${person.id === avatar.id ? 'bg-[#d4c5a8]/15' : 'bg-white/[.04]'}`}>{person.name.trim().slice(0, 1) || <UserRound size={16} />}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{person.id === avatar.id ? avatar.name : person.name}</span><span className="mt-1 block truncate text-[10px] text-[#8b998d]">{relationshipCopy.relationships[(person.relationshipType || 'close_friend') as keyof typeof relationshipCopy.relationships]?.label || relationshipCopy.memoryLabel}</span></span>
          {person.id === avatar.id && <Check size={12} className="shrink-0 text-[#a7b69c]" />}
        </button>)}</nav>
        <p className="border-t border-white/[.05] px-5 py-5 text-[10px] leading-5 text-[#77847b]">{copy.private}</p>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-white/[.06] bg-[#171d1e] px-4 py-3 lg:hidden"><UserRound size={15} className="shrink-0 text-[#c5baa2]" /><label className="relative min-w-0 flex-1"><span className="sr-only">{copy.people}</span><select aria-label={copy.people} value={avatar.id} onChange={event => selectAvatar(event.target.value)} className="w-full appearance-none rounded-lg bg-transparent py-1 pr-6 text-sm outline-none">{people.map(person => <option key={person.id} value={person.id} className="bg-[#1c2224]">{person.id === avatar.id ? avatar.name : person.name}</option>)}</select><ChevronDown size={14} className="pointer-events-none absolute right-0 top-1.5 text-[#95a091]" /></label><span className="text-[10px] text-[#8c988d]">{relationship}</span></div>
        <main className={`flex min-h-0 min-w-0 flex-1 flex-col ${profileOpen ? 'overflow-hidden' : 'overflow-y-auto'} md:flex-row md:overflow-hidden`}>
          <section aria-label={avatar.name} className={`relative min-w-0 shrink-0 overflow-hidden ${profileOpen ? 'hidden md:block' : 'block'} h-[min(56vh,500px)] min-h-[380px] bg-[#1c2424] md:h-auto md:min-h-0 md:flex-1`}>
            <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(ellipse at 50% 33%, ${preview?.backgroundColor || avatar.appearance.backgroundColor}88, #1a2222 80%)` }} />
            <div className="absolute inset-0 bottom-10">{portraitMediaId && !preview
              ? <MemoryAvatarPortraitStage key={portraitMediaId} ownerId={ownerId} avatarId={avatar.id} mediaId={portraitMediaId} stream={call.portraitStream || null} speaking={Boolean(call.portraitSpeaking)} name={avatar.name} locale={locale} />
              : <MemoryAvatarStage appearance={preview || avatar.appearance} outputLevelRef={call.outputLevelRef} state={call.state} name={avatar.name} locale={locale} active />}</div>
            <div className="absolute left-5 right-5 top-5 flex items-start justify-between gap-3 sm:left-7 sm:right-7 sm:top-6">
              <p role="status" className="flex max-w-[75%] items-start gap-2 text-[11px] leading-5 text-[#b9c3b5]"><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${callActive ? 'bg-[#b8d3a4]' : 'bg-[#7d9484]'}`} />{stateLabel}</p>
              {callActive && call.elapsedSeconds > 0 && <span className="font-mono text-[10px] tabular-nums text-[#91a38f]">{Math.floor(call.elapsedSeconds / 60).toString().padStart(2, '0')}:{Math.floor(call.elapsedSeconds % 60).toString().padStart(2, '0')}</span>}
            </div>
            {call.cameraStream && <div className="absolute right-4 top-14 w-[104px] overflow-hidden rounded-xl border border-[#d4ddcd]/20 bg-black/40 shadow-xl sm:right-6 sm:w-32"><video ref={cameraPreview} muted autoPlay playsInline aria-label={copy.cameraLocal} className="aspect-[4/3] w-full -scale-x-100 object-cover" /><p className="px-2 py-1 text-center text-[9px] text-[#d4ddcd]">{copy.cameraSharing}</p></div>}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-[#17201f] via-[#17201f]/80 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 px-4 pb-5 pt-12 text-center sm:px-6 md:pb-8">
              <p className="text-[9px] tracking-wide text-[#95a28f]">{portraitMediaId ? (call.portraitStream ? portraitCopy.label : portraitCopy.still) : copy.digitalLabel}</p>
              <h2 className="mt-1.5 truncate text-2xl font-medium tracking-tight text-[#e4e3d7] sm:text-3xl">{avatar.name}</h2>
              <p className="mt-2 text-[11px] text-[#a2af9b]">{relationship}<span className="mx-2 opacity-40">·</span>{copy.memoryCount(avatar.memoryCount)}</p>
              {portraitMediaId && <label className="mx-auto mt-3 flex max-w-sm cursor-pointer items-start gap-2 text-left text-[10px] leading-4 text-[#bec9b3]">
                <input type="checkbox" checked={portraitConsent} disabled={callActive} onChange={event => setPortraitConsent(event.target.checked)} className="mt-0.5 shrink-0 accent-[#d4c5a8]" />
                <span><span className="mb-1 block font-medium">{portraitCopy.enable}</span>{portraitCopy.consent}</span>
              </label>}
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {!callActive ? <>
                  <button type="button" onClick={() => startCall(false)} disabled={!canStartCall} className={`${controlClass} bg-[#d4c5a8] text-[#273024] hover:bg-[#e1d4b9]`}><Phone size={15} />{copy.voiceCall}</button>
                  <button type="button" onClick={() => startCall(true)} disabled={!canStartCall} className={`${controlClass} border border-[#b8c2ab]/20 bg-[#8c9c82]/10 text-[#d4ddca] hover:bg-[#8c9c82]/20`}><Video size={16} />{copy.videoCall}</button>
                </> : <>
                  <button type="button" aria-label={call.isMuted ? copy.unmute : copy.mute} title={call.isMuted ? copy.unmute : copy.mute} aria-pressed={call.isMuted} onClick={call.toggleMute} className={`${controlClass} w-10 !px-0 ${call.isMuted ? 'bg-[#c5baa2]/25' : 'bg-[#b4c4a3]/10'} text-[#d2dcc7]`}>{call.isMuted ? <MicOff size={17} /> : <Mic size={17} />}</button>
                  <button type="button" aria-label={call.isCameraOn ? copy.cameraOff : copy.cameraOn} title={call.isCameraOn ? copy.cameraOff : copy.cameraOn} aria-pressed={call.isCameraOn} onClick={call.toggleCamera} className={`${controlClass} w-10 !px-0 ${call.isCameraOn ? 'bg-[#c5baa2]/25' : 'bg-[#b4c4a3]/10'} text-[#d2dcc7]`}>{call.isCameraOn ? <Camera size={17} /> : <CameraOff size={17} />}</button>
                  <button type="button" onClick={endCall} className={`${controlClass} bg-[#8e5e51] text-[#f3e4db] hover:bg-[#9d6e60]`}><PhoneOff size={16} />{copy.endCall}</button>
                  {(call.state === 'speaking' || call.state === 'thinking' || call.state === 'queued' || (portraitConsent && portraitMediaId && call.state !== 'connecting')) && <button type="button" onClick={call.interrupt} aria-label={copy.interrupt} title={copy.interrupt} className={`${controlClass} w-10 !px-0 bg-[#b4c4a3]/10 text-[#d2dcc7]`}><Square size={12} /></button>}
                </>}
              </div>
              {callError && <p role="alert" className="mx-auto mt-3 max-w-sm text-[11px] leading-5 text-[#dfbfa4]">{callError}</p>}
            </div>
          </section>

          <aside className={`${profileOpen ? 'h-full min-h-0' : 'min-h-[320px] flex-1'} flex w-full shrink-0 flex-col border-t border-white/[.07] bg-[#1c2224] md:h-full md:min-h-0 md:w-[330px] md:flex-none md:border-l md:border-t-0`}>
            {profileOpen ? <MemoryAvatarProfile avatar={avatar} ownerId={ownerId} locale={locale} onUpdated={updateAvatar} onArchived={archive} onClose={closeProfile} onBeforeMutation={endCall} onPreviewAppearance={setPreview} /> : <>
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/[.05] px-5"><h3 className="text-xs font-medium text-[#cbd0c4]">{copy.conversation}</h3><button type="button" aria-label={copy.profile} title={copy.profile} onClick={() => setProfileOpen(true)} className="rounded-lg p-2 text-[#8c9b8c] hover:bg-white/5"><Settings2 size={15} /></button></div>
              <div aria-live="polite" aria-relevant="additions text" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
                {conversation.loading && <p className="flex items-center gap-2 text-xs text-[#8e9d8b]"><Loader2 size={13} className="animate-spin" />{copy.connecting}</p>}
                {!conversation.loading && !conversation.error && conversation.messages.length === 0 && <p className="py-7 text-center text-xs leading-6 text-[#889888]">{copy.noMessages}</p>}
                {conversation.messages.map(message => <article key={message.id} className={message.role === 'user' ? 'ml-5' : 'mr-2'}><p className="mb-1.5 text-[10px] text-[#90a08b]">{message.role === 'user' ? copy.you : avatar.name}</p><p className={`whitespace-pre-wrap break-words text-[13px] leading-6 ${message.role === 'user' ? 'rounded-2xl rounded-tr-sm bg-[#b6c4a4]/[.07] px-3 py-2 text-[#c7d0bc]' : 'text-[#d6dccd]'}`}>{message.text}{message.pending && <span className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-[#c5baa2]" />}</p></article>)}
                {conversation.error && <div role="alert" className="text-xs leading-6 text-[#ddc4a3]">{conversation.error}<button type="button" onClick={() => void conversation.refresh()} className="ml-2 underline underline-offset-2">{copy.retry}</button></div>}
                <div ref={transcriptEnd} />
              </div>
              <form onSubmit={send} className="shrink-0 border-t border-white/[.06] p-4">
                <div className="rounded-2xl border border-[#becbb0]/10 bg-[#151c1d] p-3"><textarea aria-label={copy.textPlaceholder} placeholder={copy.textPlaceholder} value={draft} maxLength={20000} rows={2} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} className="w-full resize-none bg-transparent text-[13px] leading-6 text-[#d3dcc8] outline-none placeholder:text-[#6f806e]" /><div className="mt-1 flex items-center justify-end gap-2">{conversation.busy && !callActive && <button type="button" onClick={conversation.interrupt} aria-label={copy.interrupt} title={copy.interrupt} className="rounded-lg p-2 text-[#b9c7ae] hover:bg-white/5"><Square size={12} /></button>}<button type="submit" disabled={!canSend} aria-label={copy.send} title={copy.send} className="rounded-xl bg-[#c5baa2]/20 p-2 text-[#dfd5bd] transition-colors hover:bg-[#c5baa2]/30 disabled:opacity-30"><Send size={16} /></button></div></div>
              </form>
            </>}
          </aside>
        </main>
      </div>
    </div>
  </div>;
}
