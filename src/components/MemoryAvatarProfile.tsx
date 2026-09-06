import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, BookOpen, Check, ChevronDown, FileText, Loader2, Plus, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import type { MemoryAvatar, MemoryAvatarAppearance, MemoryAvatarMaterial } from '../../shared/memory_avatar';
import { memoryAvatarService, MemoryAvatarApiError } from '../services/memoryAvatarService';
import { listVoices } from '../services/voiceService';
import { memoryAvatarCopy } from '../i18n/locales/memoryAvatar';
import { memoryTerritoryCopy } from '../i18n/locales/memoryTerritory';

interface Props {
  avatar: MemoryAvatar; ownerId: string; locale: 'zh' | 'en';
  onUpdated: (avatar: MemoryAvatar) => void; onArchived: (id: string) => void; onClose: () => void;
  onBeforeMutation?: () => void | Promise<void>;
  onPreviewAppearance?: (appearance: MemoryAvatarAppearance | null) => void;
}
const inputClass = 'mt-2 w-full rounded-xl border border-white/10 bg-[#161a1c] px-3 py-2.5 text-sm text-[#e6e7e1] outline-none focus:border-[#c5baa2]/60 disabled:opacity-50';

export function MemoryAvatarProfile(props: Props) {
  return <MemoryAvatarProfileEditor key={JSON.stringify([props.ownerId, props.avatar.id])} {...props} />;
}

function MemoryAvatarProfileEditor({ avatar, ownerId, locale, onUpdated, onArchived, onClose, onBeforeMutation, onPreviewAppearance }: Props) {
  const copy = memoryTerritoryCopy(locale);
  const relationships = memoryAvatarCopy(locale).relationships;
  const [tab, setTab] = useState<'details' | 'memories' | 'appearance'>('details');
  const [record, setRecord] = useState(avatar);
  const [name, setName] = useState(avatar.name);
  const [narrative, setNarrative] = useState(avatar.narrative);
  const [relationship, setRelationship] = useState(avatar.relationshipType);
  const [appearance, setAppearance] = useState(avatar.appearance);
  const [voiceId, setVoiceId] = useState(avatar.voice?.voiceId || '');
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceError, setVoiceError] = useState(false);
  const [materials, setMaterials] = useState<MemoryAvatarMaterial[]>([]);
  const [materialTitle, setMaterialTitle] = useState('');
  const [materialText, setMaterialText] = useState('');
  const [materialKind, setMaterialKind] = useState<MemoryAvatarMaterial['kind']>('text');
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [materialsReady, setMaterialsReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const sourceRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const acceptRecord = useCallback((next: MemoryAvatar) => {
    setRecord(next); setName(next.name); setNarrative(next.narrative);
    setRelationship(next.relationshipType); setAppearance(next.appearance); setVoiceId(next.voice?.voiceId || '');
    onUpdated(next);
  }, [onUpdated]);
  const reportError = (err: unknown) => {
    const isConflict = err instanceof MemoryAvatarApiError && err.status === 409;
    setConflict(isConflict); setError(isConflict ? copy.conflict : copy.saveError);
  };

  // Identity changes remount the private editor. A new authoritative revision
  // invalidates older requests without leaving their UI busy lease behind.
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    busy.current = false; setPending(false);
    setRecord(avatar); setName(avatar.name); setNarrative(avatar.narrative);
    setRelationship(avatar.relationshipType); setAppearance(avatar.appearance); setVoiceId(avatar.voice?.voiceId || '');
    setConflict(false); setError(''); setMaterialsReady(false); setLoading(true);
    memoryAvatarService.materials(avatar.id, controller.signal).then(result => {
      if (current !== generation.current) return;
      setMaterials(result.materials); setMaterialsReady(true);
      // A newer source revision must not be attached to the old editable profile.
      if (result.revision !== avatar.revision) { setConflict(true); setError(copy.conflict); }
    }).catch(err => {
      if (!controller.signal.aborted && current === generation.current) { setError(copy.materialLoadError); }
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; controller.abort(); };
  }, [avatar.id, avatar.revision, ownerId]);

  useEffect(() => {
    if (tab !== 'appearance') return;
    let cancelled = false;
    setVoiceLoading(true); setVoiceError(false);
    listVoices().then(catalog => {
      if (cancelled) return;
      const available = [...catalog.premade, ...catalog.cloned].filter(voice => !voice.status || voice.status === 'ready');
      const rows = available.map(voice => ({ id: String(voice.voiceId || voice.voice_id || voice.id || ''), name: String(voice.name || voice.voiceId || voice.voice_id || voice.id || '') })).filter(voice => voice.id);
      setVoices([...new Map(rows.map(voice => [voice.id, voice])).values()]);
    }).catch(() => { if (!cancelled) setVoiceError(true); }).finally(() => { if (!cancelled) setVoiceLoading(false); });
    return () => { cancelled = true; };
  }, [tab]);

  const mutate = async (action: () => Promise<void>) => {
    if (busy.current) return;
    const current = generation.current;
    busy.current = true; setPending(true); setNotice(''); setError('');
    try { await onBeforeMutation?.(); if (current === generation.current) await action(); }
    catch (err) { if (current === generation.current) reportError(err); }
    finally { if (current === generation.current) { busy.current = false; setPending(false); } }
  };
  const save = () => {
    const current = generation.current;
    void mutate(async () => {
      const next = await memoryAvatarService.update(record.id, { revision: record.revision, name: name.trim(), narrative: narrative.trim(), relationshipType: relationship, appearance, voice: { voiceId } });
      if (current !== generation.current) return;
      acceptRecord(next); setNotice(copy.saved); setConflict(false); onPreviewAppearance?.(null);
    });
  };
  const reload = async () => {
    if (busy.current) return;
    const current = generation.current;
    busy.current = true;
    setLoading(true); setError(''); setNotice('');
    try {
      const [next, sources] = await Promise.all([memoryAvatarService.get(record.id), memoryAvatarService.materials(record.id)]);
      if (current !== generation.current) return;
      if (next.revision !== sources.revision) { setConflict(true); setError(copy.conflict); return; }
      acceptRecord(next); setMaterials(sources.materials); setMaterialsReady(true); setConflict(false); onPreviewAppearance?.(null);
    } catch (err) { if (current === generation.current) reportError(err); }
    finally { if (current === generation.current) { busy.current = false; setLoading(false); } }
  };
  const addMaterial = (event: React.FormEvent) => {
    event.preventDefault();
    if (!materialTitle.trim() || !materialText.trim()) return;
    const current = generation.current;
    const content = { title: materialTitle.trim(), text: materialText.trim(), kind: materialKind };
    const fingerprint = JSON.stringify(content);
    if (sourceRequest.current?.fingerprint !== fingerprint) sourceRequest.current = { fingerprint, id: crypto.randomUUID() };
    const clientRequestId = sourceRequest.current.id;
    void mutate(async () => {
      const result = await memoryAvatarService.addMaterial(record.id, { ...content, revision: record.revision, clientRequestId });
      if (current !== generation.current) return;
      acceptRecord(result.avatar); setMaterials(rows => [...rows.filter(row => row.id !== result.material.id), result.material]);
      setMaterialTitle(''); setMaterialText(''); setMaterialKind('text'); sourceRequest.current = null;
      setNotice(copy.materialAdded); setConflict(false);
    });
  };
  const removeMaterial = (id: string) => {
    if (confirmRemove !== id) { setConfirmRemove(id); return; }
    const current = generation.current;
    void mutate(async () => {
      const result = await memoryAvatarService.removeMaterial(record.id, id, record.revision);
      if (current !== generation.current) return;
      acceptRecord(result.avatar); setMaterials(rows => rows.filter(row => row.id !== id));
      setNotice(copy.materialRemoved); setConfirmRemove(null); setConflict(false);
    });
  };
  const archive = () => {
    if (confirmRemove !== 'archive') { setConfirmRemove('archive'); return; }
    const current = generation.current;
    void mutate(async () => {
      await memoryAvatarService.archive(record.id, record.revision);
      if (current === generation.current) onArchived(record.id);
    });
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    const current = generation.current;
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { setError(copy.invalidFile); return; }
    if (file.size > 100_000) { setError(copy.fileTooLarge); return; }
    try {
      const text = await file.text();
      if (current !== generation.current) return;
      if (text.length > 20_000) { setError(copy.fileTooLarge); return; }
      setMaterialTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 120)); setMaterialText(text); setMaterialKind('document'); setError('');
    } catch { if (current === generation.current) setError(copy.invalidFile); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  };
  const previewAppearance = (next: MemoryAvatarAppearance) => { setAppearance(next); onPreviewAppearance?.(next); };

  return <section aria-label={copy.profile} className="flex h-full min-h-0 flex-col bg-[#1c2022] text-[#d9dcd6]">
    <div className="flex items-center justify-between border-b border-white/[.07] px-5 py-4">
      <h3 className="text-sm font-semibold">{copy.profile}</h3>
      <button type="button" onClick={onClose} aria-label={copy.close} className="rounded-lg p-2 text-white/50 hover:bg-white/5 hover:text-white"><X size={17} /></button>
    </div>
    <div role="tablist" className="grid grid-cols-3 gap-1 border-b border-white/[.07] p-2">
      {(['details', 'memories', 'appearance'] as const).map(value => <button type="button" role="tab" aria-selected={tab === value} key={value} onClick={() => { setTab(value); setConfirmRemove(null); }} className={`rounded-lg px-1 py-2.5 text-xs ${tab === value ? 'bg-[#c5baa2]/15 text-[#e3d5b9]' : 'text-white/45 hover:bg-white/5'}`}>{copy[value]}</button>)}
    </div>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
      {error && <div role="alert" className="rounded-xl border border-amber-300/15 bg-amber-300/5 p-3 text-xs leading-6 text-amber-100/80">{error}{(conflict || !materialsReady) && <button type="button" onClick={() => void reload()} className="mt-2 flex items-center gap-2 underline"><RotateCcw size={13} />{copy.reload}</button>}</div>}
      {notice && <p role="status" className="flex items-start gap-2 rounded-xl bg-emerald-400/5 p-3 text-xs leading-6 text-emerald-100/70"><Check className="mt-1 shrink-0" size={14} />{notice}</p>}
      {tab === 'details' && <>
        <label className="block text-xs text-white/60">{copy.name}<input className={inputClass} value={name} maxLength={120} disabled={pending} onChange={e => setName(e.target.value)} /></label>
        <label className="block text-xs text-white/60">{copy.relationship}<select className={inputClass} value={relationship} disabled={pending} onChange={e => setRelationship(e.target.value)}>{Object.entries(relationships).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</select></label>
        <label className="block text-xs text-white/60">{copy.introduction}<textarea className={`${inputClass} resize-y leading-6`} rows={7} maxLength={2000} value={narrative} disabled={pending} placeholder={copy.introductionPlaceholder} onChange={e => setNarrative(e.target.value)} /></label>
        <p className="text-xs leading-6 text-white/35">{copy.editStopsCall}</p>
        <button type="button" disabled={pending || conflict || !name.trim()} onClick={save} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#d4c5a8] px-4 py-3 text-sm font-semibold text-[#222825] disabled:opacity-40">{pending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{pending ? copy.saving : copy.save}</button>
        <div className="border-t border-white/10 pt-6"><p className="text-xs leading-6 text-white/35">{copy.archiveHint}</p><button type="button" disabled={pending || conflict} onClick={archive} className="mt-3 flex items-center gap-2 text-xs text-rose-200/70 disabled:opacity-40"><Archive size={14} />{confirmRemove === 'archive' ? copy.archiveConfirm : copy.archive}</button></div>
      </>}
      {tab === 'appearance' && <>
        <fieldset disabled={pending}><legend className="mb-3 text-xs text-white/55">{copy.look}</legend><div className="grid grid-cols-3 gap-2">{(['neutral', 'feminine', 'masculine'] as const).map(preset => <button type="button" aria-pressed={appearance.preset === preset} key={preset} onClick={() => previewAppearance({ ...appearance, preset })} className={`rounded-xl border py-3 text-xs ${appearance.preset === preset ? 'border-[#c5baa2]/50 bg-[#c5baa2]/10 text-[#e2d5bd]' : 'border-white/10 text-white/50'}`}>{copy[preset]}</button>)}</div></fieldset>
        <div className="grid grid-cols-2 gap-3">{([['skinColor', 'skin'], ['hairColor', 'hair'], ['outfitColor', 'outfit'], ['backgroundColor', 'background']] as const).map(([field, label]) => <label key={field} className="flex items-center justify-between rounded-xl border border-white/10 px-3 py-3 text-xs text-white/60">{copy[label]}<input type="color" aria-label={copy[label]} value={appearance[field]} disabled={pending} onChange={e => previewAppearance({ ...appearance, [field]: e.target.value })} className="h-7 w-8 cursor-pointer rounded border-0 bg-transparent" /></label>)}</div>
        <label className="block text-xs text-white/60">{copy.voice}<select className={inputClass} value={voiceId} disabled={pending || voiceLoading} onChange={e => setVoiceId(e.target.value)}><option value="">{copy.defaultVoice}</option>{voiceId && !voices.some(voice => voice.id === voiceId) && <option value={voiceId}>{voiceId}</option>}{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>
        <p className="text-xs leading-6 text-white/35">{voiceLoading ? copy.loadingVoices : voiceError ? copy.voicesUnavailable : copy.voiceHint}</p>
        <button type="button" disabled={pending || conflict} onClick={save} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#d4c5a8] px-4 py-3 text-sm font-semibold text-[#222825] disabled:opacity-40">{pending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{pending ? copy.saving : copy.save}</button>
      </>}
      {tab === 'memories' && <>
        <p className="text-xs leading-6 text-white/50">{copy.materialsHint}</p>
        <form onSubmit={addMaterial} className="space-y-3 rounded-2xl border border-white/10 p-4">
          <label className="block text-xs text-white/55">{copy.materialTitle}<input className={inputClass} maxLength={120} required value={materialTitle} disabled={pending || loading || !materialsReady} placeholder={copy.materialTitlePlaceholder} onChange={e => setMaterialTitle(e.target.value)} /></label>
          <label className="block text-xs text-white/55">{copy.materialText}<textarea className={`${inputClass} resize-y leading-6`} rows={6} maxLength={20000} required value={materialText} disabled={pending || loading || !materialsReady} placeholder={copy.materialTextPlaceholder} onChange={e => setMaterialText(e.target.value)} /></label>
          <input type="file" ref={fileRef} accept=".txt,.md,.markdown,text/plain,text/markdown" className="hidden" onChange={e => void importFile(e.target.files?.[0])} />
          <button type="button" disabled={pending} onClick={() => fileRef.current?.click()} className="flex items-center gap-2 text-xs text-[#d5c6a9]"><Upload size={14} />{copy.uploadText}</button>
          <p className="text-[11px] leading-5 text-white/35">{copy.uploadHint}</p>
          <button type="submit" disabled={pending || loading || !materialsReady || conflict || !materialText.trim() || !materialTitle.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c5baa2]/15 px-3 py-3 text-xs font-semibold text-[#e6d8bb] disabled:opacity-40">{pending ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}{pending ? copy.adding : copy.addMaterial}</button>
        </form>
        <div className="flex items-center justify-between text-xs text-white/50"><span>{materialsReady ? copy.materialCount(materials.length) : ''}</span>{loading && <Loader2 size={14} className="animate-spin" />}</div>
        {!loading && materialsReady && materials.length === 0 && <div className="rounded-xl border border-dashed border-white/10 p-4 text-xs leading-6 text-white/35"><BookOpen size={20} className="mb-3" />{copy.noMaterials}</div>}
        {materialsReady && materials.map(material => <article key={material.id} className="overflow-hidden rounded-xl border border-white/10">
          <button type="button" aria-expanded={expanded === material.id} onClick={() => setExpanded(expanded === material.id ? null : material.id)} className="flex w-full items-center gap-3 p-3 text-left"><FileText size={16} className="shrink-0 text-[#c5baa2]" /><span className="min-w-0 flex-1 truncate text-xs">{material.title}</span><ChevronDown size={14} className={expanded === material.id ? 'rotate-180' : ''} /></button>
          {expanded === material.id && <div className="border-t border-white/5 p-3"><p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-6 text-white/55">{material.text}</p><button type="button" disabled={pending || conflict} onClick={() => removeMaterial(material.id)} className="mt-4 flex items-center gap-2 text-xs text-rose-200/65 disabled:opacity-40"><Trash2 size={13} />{confirmRemove === material.id ? copy.removeConfirm : copy.removeMaterial}</button></div>}
        </article>)}
      </>}
    </div>
  </section>;
}
