import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { apiFetch } from '@/services/apiClient';
import { useSocket } from '@/hooks/useSocket';
import { generatedSkillsCopy } from '../i18n/locales/generatedSkills';
import type { GeneratedSkillHistoryItem } from '../../server/skills/generated_history';

export function GeneratedSkillHistory({ lang, refreshToken, onReview, onInstalled }: {
  lang: 'zh' | 'en'; refreshToken?: string; onReview: (draft: any) => void; onInstalled: () => void;
}) {
  const copy = generatedSkillsCopy[lang];
  const socket = useSocket();
  const [items, setItems] = useState<GeneratedSkillHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const response = await apiFetch('/api/skills/generated', { cache: 'no-store' });
      if (!response.ok) throw new Error('History unavailable');
      const result = await response.json(); setItems(Array.isArray(result.skills) ? result.skills : []);
    } catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshToken]);
  useEffect(() => {
    const reload = () => { void refresh(); };
    const events = ['skill:installed', 'skill:updated', 'skill:uninstalled', 'connect'];
    for (const event of events) socket?.on(event, reload);
    window.addEventListener('focus', reload);
    return () => { for (const event of events) socket?.off(event, reload); window.removeEventListener('focus', reload); };
  }, [socket, refresh]);
  const review = async (item: GeneratedSkillHistoryItem) => {
    setReviewing(item.id); setError(false);
    try {
      const response = await apiFetch('/api/skills/generated/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftId: item.draftId }) });
      if (!response.ok) throw new Error('Draft unavailable');
      onReview(await response.json());
    } catch { setError(true); } finally { setReviewing(null); }
  };
  return <section className="lumi-panel p-6 space-y-5" aria-label={copy.title}>
    <div className="flex items-start justify-between gap-4">
      <div><h4 className="flex items-center gap-2 text-sm font-bold text-white"><Sparkles size={17} className="text-celestial-saturn" />{copy.title}</h4>
        <p className="mt-2 text-xs leading-relaxed text-white/55">{copy.description}</p></div>
      <button type="button" onClick={() => void refresh()} disabled={loading} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-white/65 hover:bg-white/10 disabled:opacity-40"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />{copy.refresh}</button>
    </div>
    {error && <p role="alert" className="text-xs text-amber-300">{copy.error}</p>}
    {loading && !items.length ? <p className="text-xs text-white/55">{copy.loading}</p> : !error && !items.length ? <p className="text-sm text-white/55">{copy.empty}</p> : null}
    <div className="grid gap-3 md:grid-cols-2">{items.map(item => <article key={item.id} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><h5 className="min-w-0 break-words text-sm font-semibold text-white/90">{item.displayName}</h5>
        <span className={`rounded-full px-2 py-1 text-[11px] ${item.status === 'installed' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200'}`}>{copy[item.status]}</span></div>
      {item.displayName !== item.skillName && <p className="mt-1 break-all text-[11px] text-white/40">{item.skillName}</p>}
      <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-white/55">{item.description}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] text-white/40">{item.generatedAt && Number.isFinite(Date.parse(item.generatedAt)) ? new Date(item.generatedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') : ''}</span>
        <button type="button" disabled={reviewing !== null} onClick={() => item.draftId ? void review(item) : onInstalled()} className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/15 disabled:opacity-40">{reviewing === item.id ? copy.reviewing : item.draftId ? copy.review : copy.manage}</button>
      </div>
    </article>)}</div>
  </section>;
}
