import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Image, Loader2, Sparkles } from 'lucide-react';
import { memoryTerritoryCopy } from '../i18n/locales/memoryTerritory';
import { memoryAvatarCopy } from '../i18n/locales/memoryAvatar';
import { memoryMediaCopy } from '../i18n/locales/memoryMedia';
import { memoryAvatarService } from '../services/memoryAvatarService';
import type { MemoryAvatar } from '../../shared/memory_avatar';

export function MemoryAvatarCreate({ locale, ownerId, onCreated, onLogin, mode = 'direct', onModeChange, completed = false, disabled = false, children }: {
  locale: 'zh' | 'en'; ownerId: string; onCreated: (avatar: MemoryAvatar) => void;
  onLogin: () => void;
  mode?: 'direct' | 'records' | 'photo'; onModeChange: (mode: 'direct' | 'records' | 'photo') => void;
  completed?: boolean; disabled?: boolean; children?: ReactNode;
}) {
  const copy = memoryTerritoryCopy(locale);
  const relationships = memoryAvatarCopy(locale).relationships;
  const [name, setName] = useState('');
  const [narrative, setNarrative] = useState('');
  const [relationshipType, setRelationship] = useState('close_friend');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<{ fingerprint: string; id: string } | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const generationRef = generation;
    generationRef.current++;
    busy.current = false;
    operation.current = null;
    setPending(false); setError(''); setName(''); setNarrative(''); setRelationship('close_friend');
    return () => { generationRef.current++; };
  }, [ownerId]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ownerId) { onLogin(); return; }
    if (busy.current || !name.trim()) return;
    const current = generation.current;
    const fields = { name: name.trim(), narrative: narrative.trim(), relationshipType };
    const fingerprint = JSON.stringify(fields);
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() };
    busy.current = true; setPending(true); setError('');
    try {
      const avatar = await memoryAvatarService.create({ ...fields, clientRequestId: operation.current.id });
      if (generation.current === current) onCreated(avatar);
    } catch {
      if (generation.current === current) setError(copy.createError);
    } finally {
      if (generation.current === current) { busy.current = false; setPending(false); }
    }
  };

  return <div data-memory-avatar-create="" className="h-full overflow-y-auto bg-background text-foreground">
    <div className="mx-auto grid min-h-full max-w-5xl items-start gap-10 px-6 py-20 md:grid-cols-[.9fr_1.1fr] md:gap-16 md:px-10">
      <div className="md:sticky md:top-10">
        <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[#c5baa2]/20 bg-[#c5baa2]/10 text-muted-foreground"><Sparkles size={22} /></div>
        <p className="text-xs tracking-[.18em] text-muted-foreground">{copy.title}</p>
        <h2 className="mt-4 text-3xl font-medium leading-snug tracking-tight sm:text-4xl">{mode === 'records' ? copy.createFromRecords : mode === 'photo' ? copy.createFromPhoto : copy.createTitle}</h2>
        <p className="mt-5 max-w-sm text-sm leading-7 text-muted-foreground">{mode === 'records' ? copy.recordsHint : mode === 'photo' ? copy.photoHint : copy.createHint}</p>
        <p className="mt-4 max-w-sm text-xs leading-6 text-muted-foreground">{memoryMediaCopy(locale).createHint}</p>
        <nav aria-label={copy.create} className="mt-9 flex flex-wrap gap-2 md:flex-col md:items-start">
          <button type="button" aria-pressed={mode === 'direct'} disabled={pending || disabled} onClick={() => onModeChange('direct')} className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors disabled:opacity-40 ${mode === 'direct' ? 'border-foreground/30 bg-foreground/5 text-foreground' : 'border-border text-muted-foreground hover:bg-foreground/5'}`}>
            <Sparkles size={17} />{copy.createBlank}
          </button>
          <button type="button" aria-pressed={mode === 'records'} disabled={pending || disabled} onClick={() => onModeChange('records')} className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors disabled:opacity-40 ${mode === 'records' ? 'border-foreground/30 bg-foreground/5 text-foreground' : 'border-border text-muted-foreground hover:bg-foreground/5'}`}>
            <BookOpen size={17} />{copy.createFromRecords}
          </button>
          <button type="button" aria-pressed={mode === 'photo'} disabled={pending || disabled} onClick={() => onModeChange('photo')} className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors disabled:opacity-40 ${mode === 'photo' ? 'border-foreground/30 bg-foreground/5 text-foreground' : 'border-border text-muted-foreground hover:bg-foreground/5'}`}>
            <Image size={17} className="shrink-0" />{copy.createFromPhoto}
          </button>
        </nav>
      </div>
      {mode === 'records' || completed ? <div className="min-w-0">{children}</div> : <form onSubmit={create} className="space-y-5 rounded-[28px] border border-border bg-card p-6 sm:p-8">
        <label className="block text-sm text-foreground">{copy.name}
          <input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder={copy.namePlaceholder} disabled={pending} className="mt-2 w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground outline-none focus:border-foreground/40" />
        </label>
        <label className="block text-sm text-foreground">{copy.relationship}
          <select value={relationshipType} onChange={e => setRelationship(e.target.value)} disabled={pending} className="mt-2 w-full rounded-xl border border-border bg-background px-4 py-3 outline-none focus:border-foreground/40">
            {Object.entries(relationships).map(([id, value]) => <option value={id} key={id}>{value.label}</option>)}
          </select>
        </label>
        <label className="block text-sm text-foreground">{copy.introduction}
          <textarea rows={5} maxLength={2000} value={narrative} onChange={e => setNarrative(e.target.value)} placeholder={copy.introductionPlaceholder} disabled={pending} className="mt-2 w-full resize-y rounded-xl border border-border bg-background px-4 py-3 text-sm leading-6 outline-none focus:border-foreground/40" />
        </label>
        {error && <p role="alert" className="text-sm leading-6 text-amber-500">{error}</p>}
        <button type="submit" disabled={pending || !name.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#d4c5a8] px-4 py-3.5 text-sm font-semibold text-[#202521] transition-colors hover:bg-[#e2d4b8] disabled:opacity-40">
          {pending ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />}{pending ? copy.creating : mode === 'photo' ? copy.photoCreateAction : copy.createAction}
        </button>
      </form>}
    </div>
  </div>;
}
