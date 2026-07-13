import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Play, Star, ChevronDown, Volume2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { listVoices, synthesizeSpeech } from '@/services/voiceService';
import { useApp } from '@/contexts/AppContext';
import { voiceSampleText } from '../i18n/locales/voiceSamples';

export function VoicePicker({ t, direction = 'up', refreshTrigger = 0 }: { t: any; direction?: 'up' | 'down'; refreshTrigger?: number }) {
  const {
    selectedVoiceId, setSelectedVoiceId, favoriteVoices, toggleFavoriteVoice,
    workDomain, orgConnection,
  } = useApp();
  const [voices, setVoices] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [langFilter, setLangFilter] = useState<string>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVoices([]);
    setOpen(false);
    setLoadingVoices(true);
    listVoices()
      .then(data => { setVoices([...data.cloned, ...data.premade]); })
      .catch(() => toast.error(t.failedToLoadVoices || 'Failed to load voices'))
      .finally(() => setLoadingVoices(false));
  }, [refreshTrigger, workDomain, orgConnection?.orgId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const languages = useMemo(() => {
    const set = new Set(voices.map(v => v.language).filter(Boolean));
    return ['all', ...Array.from(set)] as string[];
  }, [voices]);

  const filtered = useMemo(() => {
    let list = voices;
    if (search) list = list.filter(v => v.name.toLowerCase().includes(search.toLowerCase()));
    if (langFilter !== 'all') list = list.filter(v => v.language === langFilter);
    if (catFilter !== 'all') list = list.filter(v => v.category === catFilter);
    // Sort: favorites first
    return [...list].sort((a, b) => {
      const aFav = favoriteVoices.includes(a.voiceId) ? -1 : 1;
      const bFav = favoriteVoices.includes(b.voiceId) ? -1 : 1;
      return aFav - bFav;
    });
  }, [voices, search, langFilter, catFilter, favoriteVoices]);

  const currentVoice = voices.find(v => v.voiceId === selectedVoiceId);

  const playPreview = async (voice: any) => {
    if (playingId === voice.voiceId) {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      setPlayingId(null);
      return;
    }
    try {
      setPlayingId(voice.voiceId);
      const lang = voice.language || 'zh';
      const sampleText = voiceSampleText(lang);
      const buffer = await synthesizeSpeech(sampleText, voice.voiceId, voice.provider, voice.model);
      const blob = new Blob([buffer], { type: 'audio/mp3' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setPlayingId(null); URL.revokeObjectURL(url); };
      audio.onerror = () => { setPlayingId(null); URL.revokeObjectURL(url); };
      audio.play();
    } catch {
      setPlayingId(null);
    }
  };

  return (
    <div ref={pickerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-white/80 text-sm transition-all"
      >
        <Volume2 size={14} className="text-white/40" />
        <span className="max-w-[120px] truncate">{currentVoice?.name || 'Select Voice'}</span>
        <ChevronDown size={14} className={`text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            className={`absolute right-0 w-72 max-h-[360px] overflow-hidden rounded-2xl bg-zinc-900/95 backdrop-blur-xl border border-white/10 shadow-2xl z-50 flex flex-col ${direction === 'down' ? 'top-full mt-2' : 'bottom-full mb-2'}`}
          >
            {/* Search */}
            <div className="p-3 border-b border-white/5">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5">
                <Search size={14} className="text-white/55" />
                <input
                  className="bg-transparent text-white/80 text-sm placeholder-white/30 outline-none flex-1"
                  placeholder={t.searchVoices || 'Search voices...'}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Filters */}
            <div className="flex gap-2 px-3 py-2 border-b border-white/5">
              <select
                className="bg-white/5 text-white/60 text-xs rounded-lg px-2 py-1 outline-none"
                value={langFilter}
                onChange={e => setLangFilter(e.target.value)}
              >
                <option value="all">{t.voiceAllLanguages || 'All Languages'}</option>
                {languages.filter(l => l !== 'all').map(l => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
              <select
                className="bg-white/5 text-white/60 text-xs rounded-lg px-2 py-1 outline-none"
                value={catFilter}
                onChange={e => setCatFilter(e.target.value)}
              >
                <option value="all">{t.voiceAllCategories || 'All Types'}</option>
                <option value="premade">{t.premadeVoices || 'Premade'}</option>
                <option value="cloned">{t.clonedVoices || 'Cloned'}</option>
              </select>
            </div>

            {/* Voice list */}
            <div className="flex-1 overflow-y-auto">
              {loadingVoices ? (
                <div className="flex items-center justify-center py-8 text-white/55 text-sm">
                  <Loader2 size={16} className="animate-spin mr-2" /> Loading...
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-white/55 text-sm">
                  {t.voiceNoVoicesFound || 'No voices found'}
                </div>
              ) : (
                filtered.map(voice => (
                  <div
                    key={voice.voiceId}
                    onClick={() => { setSelectedVoiceId(voice.voiceId, voice.provider); setOpen(false); }}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-all group ${
                      selectedVoiceId === voice.voiceId
                        ? 'bg-white/10 text-white'
                        : 'text-white/60 hover:bg-white/5 hover:text-white/80'
                    }`}
                  >
                    {/* Favorite */}
                    <button
                      onClick={e => { e.stopPropagation(); toggleFavoriteVoice(voice.voiceId); }}
                      className={`flex-shrink-0 transition-colors ${
                        favoriteVoices.includes(voice.voiceId) ? 'text-amber-400' : 'text-white/45 hover:text-amber-400/60'
                      }`}
                    >
                      <Star size={14} fill={favoriteVoices.includes(voice.voiceId) ? 'currentColor' : 'none'} />
                    </button>

                    {/* Voice info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{voice.name}</div>
                      <div className="flex items-center gap-1 text-xs text-white/55">
                        {voice.provider && <span className="text-white/40">{voice.provider}</span>}
                        {voice.language && <span>· {voice.language}</span>}
                        {voice.category && <span className="opacity-50">· {voice.category}</span>}
                      </div>
                    </div>

                    {/* Play preview */}
                    <button
                      onClick={e => { e.stopPropagation(); playPreview(voice); }}
                      className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                        playingId === voice.voiceId
                          ? 'bg-white/10 text-white'
                          : 'text-white/45 hover:text-white/60 hover:bg-white/10 opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      {playingId === voice.voiceId ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    </button>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
