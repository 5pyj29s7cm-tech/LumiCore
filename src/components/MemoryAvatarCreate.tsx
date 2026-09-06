import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Loader2, Sparkles } from 'lucide-react';
import { memoryTerritoryCopy } from '../i18n/locales/memoryTerritory';
import { memoryAvatarCopy } from '../i18n/locales/memoryAvatar';
import { memoryAvatarService } from '../services/memoryAvatarService';
import type { MemoryAvatar } from '../../shared/memory_avatar';

export function MemoryAvatarCreate({ locale, ownerId, onCreated, onImport, onLogin }: {
  locale: 'zh' | 'en'; ownerId: string; onCreated: (avatar: MemoryAvatar) => void;
  onImport: () => void; onLogin: () => void;
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
    generation.current++;
    busy.current = false;
    operation.current = null;
    setPending(false); setError(''); setName(''); setNarrative(''); setRelationship('close_friend');
    return () => { generation.current++; };
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

  return <div className="min-h-full bg-[#141719] text-[#ece9e2]">
    <div className="mx-auto grid min-h-full max-w-5xl items-center gap-10 px-6 py-20 md:grid-cols-[.9fr_1.1fr] md:gap-16 md:px-10">
      <div>
        <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[#c5baa2]/20 bg-[#c5baa2]/10 text-[#cfc2aa]"><Sparkles size={22} /></div>
        <p className="text-xs tracking-[.18em] text-[#c5baa2]">{copy.title}</p>
        <h2 className="mt-4 text-3xl font-medium leading-snug tracking-tight sm:text-4xl">{copy.createTitle}</h2>
        <p className="mt-5 max-w-sm text-sm leading-7 text-[#a3a5a4]">{copy.createHint}</p>
        <button type="button" disabled={pending} onClick={onImport} className="mt-9 flex items-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm text-[#c7c8c2] transition-colors hover:bg-white/5 disabled:opacity-40">
          <BookOpen size={17} />{copy.createFromRecords}<ArrowRight size={15} />
        </button>
      </div>
      <form onSubmit={create} className="space-y-5 rounded-[28px] border border-white/10 bg-white/[.025] p-6 sm:p-8">
        <label className="block text-sm text-[#c7c8c2]">{copy.name}
          <input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder={copy.namePlaceholder} disabled={pending} className="mt-2 w-full rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-white outline-none focus:border-[#c5baa2]/60" />
        </label>
        <label className="block text-sm text-[#c7c8c2]">{copy.relationship}
          <select value={relationshipType} onChange={e => setRelationship(e.target.value)} disabled={pending} className="mt-2 w-full rounded-xl border border-white/10 bg-[#1b1e20] px-4 py-3 outline-none focus:border-[#c5baa2]/60">
            {Object.entries(relationships).map(([id, value]) => <option value={id} key={id}>{value.label}</option>)}
          </select>
        </label>
        <label className="block text-sm text-[#c7c8c2]">{copy.introduction}
          <textarea rows={5} maxLength={2000} value={narrative} onChange={e => setNarrative(e.target.value)} placeholder={copy.introductionPlaceholder} disabled={pending} className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-sm leading-6 outline-none focus:border-[#c5baa2]/60" />
        </label>
        {error && <p role="alert" className="text-sm leading-6 text-amber-200">{error}</p>}
        <button type="submit" disabled={pending || !name.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#d4c5a8] px-4 py-3.5 text-sm font-semibold text-[#202521] transition-colors hover:bg-[#e2d4b8] disabled:opacity-40">
          {pending ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />}{pending ? copy.creating : copy.createAction}
        </button>
      </form>
    </div>
  </div>;
}
