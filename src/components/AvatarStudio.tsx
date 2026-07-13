import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Brush, Sparkles, Cat, Bird, Disc3, Flame, Loader2, Check, ArrowRight, Wand2, RotateCcw, Download, Upload, Image, Shirt, Palette, Star, Heart, Rabbit, PawPrint } from 'lucide-react';
import { toast } from 'sonner';
import { getDefaultPets, generateCustomPet, recolorPet } from '../pets/defaults';
import { PetConfig, PetPalette, CustomPetTags, COLOR_PRESETS, BUILTIN_PALETTES } from '../pets/types';
import { SpriteAnimator, PetAvatar } from './SpriteAnimator';
import { ALL_ACCESSORIES, AccessoryDef, AccessoryCategory } from '../pets/accessories';
import { apiFetch } from '@/services/apiClient';
import { uiMessage } from '../i18n/uiMessages';
import { avatarStudioCopy } from '../i18n/locales/avatarStudio';

const BUILTIN_ANIMATIONS = ['idle', 'run', 'wave', 'jump', 'waiting'];
const CUSTOM_PETS_KEY = 'lumi_custom_pets';
type UiLang = 'en' | 'zh';

function customPetsKey(scope: string): string {
  return `${CUSTOM_PETS_KEY}_${scope.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function loadCustomPets(scope: string): PetConfig[] {
  try {
    const scoped = localStorage.getItem(customPetsKey(scope));
    const raw = scoped ?? (scope === 'personal' ? localStorage.getItem(CUSTOM_PETS_KEY) : null);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((pet: any) => pet?.id && pet?.name && pet?.atlas && pet?.spritesheet);
  } catch {
    return [];
  }
}

function storeCustomPets(scope: string, pets: PetConfig[]) {
  try {
    localStorage.setItem(customPetsKey(scope), JSON.stringify(pets.slice(0, 30)));
  } catch {
    toast.error('Failed to save custom avatars locally');
  }
}

const PET_ICONS: Record<string, React.ReactNode> = {
  'lumi-cat': <Cat size={16} />,
  'lumi-blob': <Disc3 size={16} />,
  'lumi-bird': <Bird size={16} />,
  'lumi-dragon': <Flame size={16} />,
  'lumi-fox': <Star size={16} />,
  'lumi-rabbit': <Rabbit size={16} />,
  'lumi-bear': <PawPrint size={16} />,
  'lumi-hamster': <Heart size={16} />,
};

export function AvatarStudio({
  t,
  lang,
  selectedPetId,
  onSelectPet,
  onResetToSphere,
  equippedAccessories,
  onChangeAccessories,
  storageScope = 'personal',
}: {
  t: any;
  lang?: UiLang;
  selectedPetId?: string;
  onSelectPet: (pet: PetConfig) => void;
  onResetToSphere?: () => void;
  equippedAccessories?: string[];
  onChangeAccessories?: (ids: string[]) => void;
  storageScope?: string;
}) {
  const uiLang: UiLang = lang || (t?.langCode === 'en' ? 'en' : 'zh');
  const copy = avatarStudioCopy(uiLang);
  const ui = useCallback((zh: string, en: string) => uiLang === 'zh' ? zh : en, [uiLang]);
  const pets = getDefaultPets();
  const [customPets, setCustomPets] = useState<PetConfig[]>(() => loadCustomPets(storageScope));
  const allPets = [...pets, ...customPets];
  const [activePet, setActivePet] = useState<PetConfig>(() =>
    pets.find(p => p.id === selectedPetId) || loadCustomPets(storageScope).find(p => p.id === selectedPetId) || pets[0],
  );
  const [previewAnim, setPreviewAnim] = useState('idle');
  const [animKey, setAnimKey] = useState(0);
  const [tab, setTab] = useState<'gallery' | 'generate' | 'wardrobe' | 'colors'>('gallery');
  const [genPrompt, setGenPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiMode, setAiMode] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Color editing state
  const [editPalette, setEditPalette] = useState<PetPalette>(activePet.palette || BUILTIN_PALETTES.cat);
  const [activeColorSlot, setActiveColorSlot] = useState<keyof PetPalette>('body');

  useEffect(() => {
    storeCustomPets(storageScope, customPets);
  }, [customPets, storageScope]);

  // Sync palette when activePet changes
  useEffect(() => {
    if (activePet.palette) setEditPalette(activePet.palette);
  }, [activePet.id]);

  const handleSelectPet = useCallback((pet: PetConfig) => {
    setActivePet(pet);
    onSelectPet(pet);
    toast.success(`${pet.name} ${uiMessage('avatar-studio.set-as-desktop-avatar.b783357c5f')}`);
    setAnimKey(k => k + 1);
  }, [onSelectPet, ui]);

  const handleRecolor = useCallback((slot: keyof PetPalette, color: string) => {
    const newPalette = { ...editPalette, [slot]: color };
    setEditPalette(newPalette);
    const recolored = recolorPet(activePet, newPalette);
    setActivePet(recolored);
    setCustomPets(prev => [recolored, ...prev.filter(p => p.id !== recolored.id && p.id !== activePet.id)]);
    onSelectPet(recolored);
    setAnimKey(k => k + 1);
  }, [editPalette, activePet, onSelectPet]);

  const handleGenerate = useCallback(async () => {
    if (!genPrompt.trim()) return;
    setGenerating(true);
    try {
      const res = await apiFetch('/api/pets/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: genPrompt.trim(), mode: aiMode ? 'ai_enhanced' : 'procedural' }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Generation failed');
      const result = await res.json();
      const newPet = generateCustomPet(result.petName, result.tags as CustomPetTags);
      setCustomPets(prev => [newPet, ...prev.filter(p => p.id !== newPet.id)]);
      setActivePet(newPet);
      onSelectPet(newPet);
      setTab('gallery');
      setAnimKey(k => k + 1);
      toast.success(`${newPet.name} ${uiMessage('avatar-studio.generated.a6757bf964')}`);
    } catch (err: any) {
      toast.error(err.message || uiMessage('avatar-studio.generation-failed.15602af793'));
    } finally {
      setGenerating(false);
    }
  }, [genPrompt, handleSelectPet, aiMode, ui]);

  // Export pet as single .pet.json with embedded spritesheet (base64)
  const handleExport = useCallback((pet: PetConfig) => {
    try {
      const manifest = {
        id: pet.id,
        name: pet.name,
        author: pet.author,
        atlas: pet.atlas,
        spritesheet: pet.spritesheet,
        palette: pet.palette,
        tags: pet.tags,
        format: 'codex-pets-v2',
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = `${pet.id}.pet.json`;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${uiMessage('avatar-studio.exported.c94549fd80')} ${pet.name}`);
    } catch {
      toast.error(uiMessage('avatar-studio.export-failed.758b24672a'));
    }
  }, [ui]);

  // Import — supports single .pet.json with embedded spritesheet
  const importRef = useRef<HTMLInputElement>(null);
  const handleImportFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const manifest = JSON.parse(reader.result as string);
        if (!manifest.id || !manifest.name || !manifest.atlas) throw new Error('Invalid');
        const importedPet: PetConfig = {
          id: manifest.id,
          name: manifest.name,
          author: manifest.author || 'Community',
          spritesheet: manifest.spritesheet || '',
          atlas: manifest.atlas,
          thumbnail: manifest.spritesheet || '',
          palette: manifest.palette,
          tags: manifest.tags,
        };
        if (!importedPet.spritesheet) throw new Error('Missing spritesheet');
        setCustomPets(prev => [importedPet, ...prev.filter(p => p.id !== importedPet.id)]);
        handleSelectPet(importedPet);
        toast.success(`${uiMessage('avatar-studio.imported.e0637ed3f4')} ${importedPet.name}`);
      } catch {
        toast.error(uiMessage('avatar-studio.invalid-pet-json-file-with.afcf99f582'));
      }
    };
    reader.readAsText(file);
  }, [handleSelectPet, ui]);

  const handleImportClick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
    if (importRef.current) importRef.current.value = '';
  }, [handleImportFile]);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith('.json')) handleImportFile(file);
    else toast.error(uiMessage('avatar-studio.drop-a-pet-json-file.2fbf3fd8d9'));
  }, [handleImportFile, ui]);

  return (
    <div className="flex h-full flex-col bg-zinc-950/85" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {/* Drag overlay */}
      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-cyan-500/10 border-2 border-dashed border-cyan-400/40 rounded-xl flex items-center justify-center backdrop-blur-sm"
          >
            <div className="text-center">
              <Upload size={48} className="text-cyan-400 mx-auto mb-2" />
              <p className="text-sm font-bold text-cyan-400">{uiMessage('avatar-studio.release-to-import-pet-json.0f631d8ecd')}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-white/[0.08] px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/15 bg-cyan-400/10 text-cyan-300">
            <Brush size={18} />
          </span>
          <div>
            <h2 className="text-sm font-black text-white/90 uppercase tracking-wider">{uiMessage('avatar-studio.avatar-studio.ef5c66e7de')}</h2>
            <p className="text-xs text-white/55 font-mono">{uiMessage('avatar-studio.avatar-design-studio.c85bccb706')}</p>
          </div>
        </div>
        <div className="lumi-panel flex items-center gap-2 p-1">
          {([
            ['gallery', uiMessage('avatar-studio.gallery.f67a1e90ae'), 'text-cyan-400', 'bg-cyan-500/20'],
            ['generate', uiMessage('avatar-studio.ai-custom.7f25d48a69'), 'text-fuchsia-400', 'bg-fuchsia-500/20'],
            ['colors', uiMessage('avatar-studio.colors.0d56946595'), 'text-amber-400', 'bg-amber-500/20'],
            ['wardrobe', uiMessage('avatar-studio.wardrobe.f967f66abe'), 'text-emerald-400', 'bg-emerald-500/20'],
          ] as const).map(([id, label, activeColor, activeBg]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-bold uppercase transition-colors ${
                tab === id ? `${activeBg} ${activeColor} border-white/10` : 'border-transparent text-white/55 hover:bg-white/[0.05] hover:text-white/75'
              }`}
            >
              {id === 'colors' ? <Palette size={12} className="inline mr-1" /> : null}
              {id === 'wardrobe' ? <Shirt size={12} className="inline mr-1" /> : null}
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 border-b border-white/[0.08] bg-black/20 px-6 py-3">
        {[
          [uiMessage('avatar-studio.voice.3ab75bf387'), uiMessage('avatar-studio.choose-lumi-voice.82c3fc6955')],
          [uiMessage('avatar-studio.avatar.752623ebb7'), uiMessage('avatar-studio.select-body.998b5f21bb')],
          [uiMessage('avatar-studio.style.3ab81c0ad3'), uiMessage('avatar-studio.tune-colors.bd84b6c96c')],
          [uiMessage('avatar-studio.desktop.849ee52db0'), uiMessage('avatar-studio.save-companion.91056b3eb9')],
        ].map(([label, desc], index) => (
          <div key={label} className="lumi-panel min-w-0 rounded-xl px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${
                index === 1 ? 'bg-cyan-300 text-black' : 'bg-white/10 text-white/45'
              }`}>
                {index + 1}
              </span>
              <span className="truncate text-[11px] font-black uppercase tracking-[0.12em] text-white/72">{label}</span>
            </div>
            <p className="mt-1 truncate text-[10px] font-semibold text-white/35">{desc}</p>
          </div>
        ))}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Gallery / Generate / Wardrobe / Colors Panel */}
        <div className="custom-scrollbar w-72 flex-shrink-0 overflow-y-auto border-r border-white/[0.08] p-4">
          {tab === 'gallery' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[12px] font-bold uppercase tracking-wider text-white/45">{uiMessage('avatar-studio.avatar-gallery.58743b7972')}</p>
                <span className="text-[12px] text-white/30 font-mono">{allPets.length} {uiMessage('avatar-studio.items.b301473daa')}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {allPets.map(pet => {
                  const isCustom = customPets.some(cp => cp.id === pet.id);
                  return (
                  <motion.div
                    key={pet.id}
                    whileHover={{ scale: 1.03 }}
                    onClick={() => { setActivePet(pet); setAnimKey(k => k + 1); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setActivePet(pet);
                        setAnimKey(k => k + 1);
                      }
                    }}
                    onMouseEnter={() => setHoveredId(pet.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    className={`group relative rounded-xl border p-2 text-left transition-colors ${
                      activePet.id === pet.id
                        ? 'bg-cyan-500/10 border-cyan-500/30 ring-1 ring-cyan-500/20'
                        : 'bg-white/[0.04] border-white/[0.08] hover:bg-white/10'
                    }`}
                  >
                    {/* Preview */}
                    <div className="w-full aspect-square rounded-lg bg-white/[0.03] flex items-center justify-center overflow-hidden mb-1.5">
                      <div className="scale-[0.30] origin-center">
                        <PetAvatar
                          pet={pet}
                          animation="idle"
                          scale={0.45}
                          accessoryIds={equippedAccessories}
                        />
                      </div>
                    </div>
                    {/* Info */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-white/40 scale-75">{PET_ICONS[pet.id] || <Sparkles size={14} />}</span>
                      <span className="text-[12px] font-bold text-white/60 truncate flex-1">{pet.name}</span>
                    </div>
                    <div className="text-[12px] text-white/35 mt-0.5 flex items-center gap-1.5">
                      {pet.author}
                      {isCustom && <span className="w-1 h-1 rounded-full bg-fuchsia-400 inline-block" />}
                    </div>
                    {activePet.id === pet.id && (
                      <Check size={12} className="absolute top-2 right-2 text-cyan-400" />
                    )}
                    {/* Export button */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleExport(pet); }}
                      className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md bg-black/40 border border-white/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/10"
                    >
                      <Download size={10} className="text-white/50" />
                    </button>
                  </motion.div>
                  );
                })}
              </div>
              {/* Import */}
              <input ref={importRef} type="file" accept=".json" onChange={handleImportClick} className="hidden" />
              <button
                onClick={() => importRef.current?.click()}
                className="lumi-button mt-2 w-full border-dashed p-3 text-xs"
              >
                <Upload size={12} />
                {uiMessage('avatar-studio.import-community-pet-drag-or.a94426c60b')}
              </button>
            </div>
          ) : tab === 'generate' ? (
            <div className="space-y-4">
              <p className="text-[12px] font-bold uppercase tracking-wider text-white/45">{uiMessage('avatar-studio.ai-avatar-generation.5dc06b465c')}</p>
              <div className="space-y-3">
                <div className="lumi-panel flex items-center gap-2 p-2">
                  <button
                    onClick={() => setAiMode(true)}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${aiMode ? 'bg-fuchsia-500/20 text-fuchsia-400' : 'text-white/45 hover:text-white/40'}`}
                  >
                    <Sparkles size={12} className="inline mr-1" /> {uiMessage('avatar-studio.ai-enhanced.019211bc3f')}
                  </button>
                  <button
                    onClick={() => setAiMode(false)}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${!aiMode ? 'bg-cyan-500/20 text-cyan-400' : 'text-white/45 hover:text-white/40'}`}
                  >
                    <Wand2 size={12} className="inline mr-1" /> {uiMessage('avatar-studio.procedural.739afe4921')}
                  </button>
                </div>
                <textarea
                  value={genPrompt}
                  onChange={e => setGenPrompt(e.target.value)}
                  placeholder={uiMessage('avatar-studio.describe-the-desktop-pet-you.fa31447047')}
                  className="lumi-field h-32 w-full resize-none text-xs focus:border-fuchsia-500/20"
                />
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleGenerate}
                  disabled={!genPrompt.trim() || generating}
                   className="lumi-button-primary w-full flex-col border-fuchsia-500/25 bg-fuchsia-500/15 px-4 py-3 text-xs text-fuchsia-300 hover:bg-fuchsia-500/25"
                >
                  {generating ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-fuchsia-400/30 border-t-fuchsia-400 rounded-full animate-spin" />
                      {uiMessage('avatar-studio.generating-with-ai.7e2e45b478')}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2"><Sparkles size={14} /> {uiMessage('avatar-studio.generate.8ddb57be93')}</span>
                  )}
                </motion.button>
                {generating && (
                  <div className="h-0.5 w-full bg-white/5 rounded-full overflow-hidden mt-1">
                    <motion.div
                      className="h-full bg-gradient-to-r from-fuchsia-400 to-pink-400"
                      initial={{ width: '0%' }}
                      animate={{ width: '100%' }}
                      transition={{ duration: 12, ease: 'easeInOut' }}
                    />
                  </div>
                )}
              </div>
              <div className="lumi-panel border-fuchsia-500/10 bg-fuchsia-500/5 p-3 text-[12px] leading-relaxed text-fuchsia-300/50">
                <p><Sparkles size={10} className="inline mr-1" />{uiMessage('avatar-studio.ai-enhanced-understands-your-prompt.2b3d118665')}</p>
                <p className="mt-1 text-fuchsia-300/30">{uiMessage('avatar-studio.chinese-and-english-prompts-supported.c74f5ede38')}</p>
              </div>
            </div>
          ) : tab === 'colors' ? (
            <ColorPanel lang={uiLang} palette={editPalette} activeSlot={activeColorSlot} onSelectSlot={setActiveColorSlot} onChangeColor={handleRecolor} />
          ) : (
            <WardrobePanel
              equipped={equippedAccessories || []}
              onChange={onChangeAccessories || (() => {})}
              lang={uiLang}
            />
          )}
        </div>

        {/* Right: Preview + Actions */}
        <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-6">
          {/* Large Preview */}
          <div className="relative">
            <motion.div
              className="lumi-surface flex h-72 w-64 items-center justify-center overflow-hidden rounded-3xl bg-white/[0.02] shadow-[0_0_80px_rgba(0,200,200,0.06)]"
              whileHover={{ borderColor: 'rgba(0,200,200,0.2)', boxShadow: '0 0 100px rgba(0,200,200,0.1)' }}
            >
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${activePet.id}-${animKey}`}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.2 }}
                >
                  <PetAvatar pet={activePet} animation={previewAnim} scale={1.1} accessoryIds={equippedAccessories} />
                </motion.div>
              </AnimatePresence>
            </motion.div>
            {/* Species badge */}
            {activePet.tags?.species && (
              <div className="absolute -top-2 -right-2 px-2 py-0.5 rounded-full bg-cyan-500/20 border border-cyan-500/30 text-[12px] text-cyan-400 font-bold">
                {(copy.species as Record<string, string>)[activePet.tags.species] || activePet.tags.species}
              </div>
            )}
          </div>

          {/* Pet Info + Tags */}
          <div className="text-center space-y-1">
            <h3 className="text-lg font-bold text-white/80">{activePet.name}</h3>
            <p className="text-xs text-white/55 font-mono">by {activePet.author}</p>
            {activePet.tags && (
              <div className="flex items-center justify-center gap-1.5 flex-wrap mt-1">
                {activePet.tags.pattern && activePet.tags.pattern !== 'solid' && (
                  <span className="px-2 py-0.5 rounded-full bg-white/5 text-[12px] text-white/40">
                    {(copy.patterns as Record<string, string>)[activePet.tags.pattern] || activePet.tags.pattern}
                  </span>
                )}
                {activePet.tags.special && activePet.tags.special !== 'none' && (
                  <span className="px-2 py-0.5 rounded-full bg-yellow-500/10 text-[12px] text-yellow-400">
                    {(copy.specials as Record<string, string>)[activePet.tags.special] || activePet.tags.special}
                  </span>
                )}
                {activePet.tags.hasWings && <span className="px-2 py-0.5 rounded-full bg-white/5 text-[12px] text-white/40">{uiMessage('avatar-studio.wings.466635a795')}</span>}
                {activePet.tags.hasHorns && <span className="px-2 py-0.5 rounded-full bg-white/5 text-[12px] text-white/40">{uiMessage('avatar-studio.horns.3e47a097bf')}</span>}
              </div>
            )}
          </div>

          {/* Animation Controls */}
          <div className="flex items-center gap-2">
            {BUILTIN_ANIMATIONS.map(anim => (
              <button
                key={anim}
                onClick={() => { setPreviewAnim(anim); setAnimKey(k => k + 1); }}
                className={`px-3 py-1.5 rounded-lg text-[12px] font-bold uppercase transition-all ${
                  previewAnim === anim
                    ? 'bg-cyan-500/20 border border-cyan-500/30 text-cyan-400'
                    : 'bg-white/[0.04] border border-white/[0.08] text-white/55 hover:bg-white/10'
                }`}
              >
                {(copy.animations as Record<string, string>)[anim] || anim}
              </button>
            ))}
            <button
              onClick={() => setAnimKey(k => k + 1)}
              className="lumi-icon-button h-8 w-8 rounded-lg"
            >
              <RotateCcw size={12} />
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3">
            {onResetToSphere && selectedPetId && (
              <button
                onClick={() => onResetToSphere()}
                className="lumi-button h-11 rounded-2xl px-5 text-sm"
              >
                {uiMessage('avatar-studio.restore-default-sphere.c8836d9f16')}
              </button>
            )}
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => handleSelectPet(activePet)}
              className="lumi-button-primary rounded-2xl border-cyan-500/25 bg-cyan-500/15 px-8 py-3 text-sm text-cyan-300 hover:bg-cyan-500/25"
            >
              <Sparkles size={16} />
              {uiMessage('avatar-studio.set-as-desktop-avatar.a24191c1bf')}
              <ArrowRight size={14} />
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Color Panel ──

function ColorPanel({
  lang,
  palette,
  activeSlot,
  onSelectSlot,
  onChangeColor,
}: {
  lang: UiLang;
  palette: PetPalette;
  activeSlot: keyof PetPalette;
  onSelectSlot: (slot: keyof PetPalette) => void;
  onChangeColor: (slot: keyof PetPalette, color: string) => void;
}) {
  const colorSlots = avatarStudioCopy(lang).colorSlots;
  const activeSlotLabel = colorSlots.find(slot => slot.key === activeSlot)?.label;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Palette size={14} className="text-amber-400" />
        <p className="text-xs font-black uppercase tracking-wider text-white/50">{uiMessage('avatar-studio.color-palette.ec5803586d', (lang === 'zh') ? 'zh' : 'en')}</p>
      </div>

      {/* Slot selector */}
      <div className="grid grid-cols-2 gap-1.5">
        {colorSlots.map(slot => (
          <button
            key={slot.key}
            onClick={() => onSelectSlot(slot.key as keyof PetPalette)}
            className={`flex items-center gap-2 rounded-xl border p-2 transition-colors ${
              activeSlot === slot.key
                ? 'bg-amber-500/10 border-amber-500/30'
                : 'bg-white/[0.04] border-white/[0.08] hover:bg-white/10'
            }`}
          >
            <div
              className="w-6 h-6 rounded-lg border border-white/10 flex-shrink-0"
              style={{ backgroundColor: palette[slot.key as keyof PetPalette] }}
            />
            <div className="text-left min-w-0">
              <div className="text-xs font-bold text-white/60">{slot.label}</div>
              <div className="text-[12px] text-white/35">{slot.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Color grid */}
      <div>
        <p className="text-xs text-white/40 mb-2">
          {uiMessage('avatar-studio.choose.9c29923883', (lang === 'zh') ? 'zh' : 'en')} {activeSlotLabel || activeSlot} {uiMessage('avatar-studio.color.afe7234768', (lang === 'zh') ? 'zh' : 'en')}
        </p>
        <div className="grid grid-cols-10 gap-1">
          {COLOR_PRESETS.map((color, i) => (
            <button
              key={i}
              onClick={() => onChangeColor(activeSlot, color)}
              className={`w-6 h-6 rounded-lg border-2 transition-all hover:scale-110 ${
                palette[activeSlot] === color ? 'border-white ring-2 ring-white/20' : 'border-transparent'
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>

      {/* Reset */}
      <button
        onClick={() => {
          const defaults = BUILTIN_PALETTES.cat;
          onChangeColor('body', defaults.body);
          onChangeColor('accent', defaults.accent);
          onChangeColor('belly', defaults.belly);
          onChangeColor('eye', defaults.eye);
        }}
        className="lumi-button w-full p-2 text-[12px]"
      >
        {uiMessage('avatar-studio.reset-to-default.bb474ace01', (lang === 'zh') ? 'zh' : 'en')}
      </button>
    </div>
  );
}

// ── Wardrobe Panel ──

const CATEGORY_ORDER: AccessoryCategory[] = ['hat', 'glasses', 'mask', 'scarf', 'collar', 'ears', 'back', 'tail', 'faceMark', 'aura'];

function WardrobePanel({
  equipped,
  onChange,
  lang,
}: {
  equipped: string[];
  onChange: (ids: string[]) => void;
  lang: UiLang;
}) {
  const categories = avatarStudioCopy(lang).categories as Record<string, string>;
  const accessoryNames = avatarStudioCopy(lang).accessoryNames as Record<string, string>;
  const toggle = (id: string) => {
    if (equipped.includes(id)) {
      onChange(equipped.filter(x => x !== id));
    } else {
      const acc = ALL_ACCESSORIES.find(a => a.id === id);
      const filtered = equipped.filter(x => {
        const existing = ALL_ACCESSORIES.find(a => a.id === x);
        return acc && existing && existing.category !== acc.category;
      });
      onChange([...filtered, id]);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Shirt size={14} className="text-emerald-400" />
        <p className="text-xs font-black uppercase tracking-wider text-white/50">{uiMessage('avatar-studio.accessories.caa5117c66', (lang === 'zh') ? 'zh' : 'en')}</p>
        <span className="text-[12px] text-white/45">({equipped.length} {uiMessage('avatar-studio.equipped.0b1d34f15d', (lang === 'zh') ? 'zh' : 'en')})</span>
      </div>

      {CATEGORY_ORDER.map(cat => {
        const items = ALL_ACCESSORIES.filter(a => a.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-widest text-white/40">
              {categories[cat] || cat}
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {items.map(acc => {
                const active = equipped.includes(acc.id);
                return (
                  <button
                    key={acc.id}
                    onClick={() => toggle(acc.id)}
                    className={`rounded-xl border p-2 text-left transition-colors ${
                      active
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : 'bg-white/[0.04] border-white/[0.08] hover:bg-white/10'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {active && <Check size={10} className="text-emerald-400 flex-shrink-0" />}
                      <div className="min-w-0">
                        <div className={`text-xs font-bold truncate ${active ? 'text-emerald-400' : 'text-white/50'}`}>
                          {accessoryNames[acc.id] || acc.name}
                        </div>
                        <div className="text-[12px] text-white/40 truncate">{categories[acc.category] || acc.category}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {equipped.length > 0 && (
        <button
          onClick={() => onChange([])}
          className="lumi-button w-full p-2 text-[12px]"
        >
          {uiMessage('avatar-studio.remove-all.0a9317958e', (lang === 'zh') ? 'zh' : 'en')}
        </button>
      )}
    </div>
  );
}
