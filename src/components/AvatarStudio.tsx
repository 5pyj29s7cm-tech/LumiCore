import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Brush, Sparkles, Cat, Bird, Disc3, Flame, Loader2, Check, ArrowRight, Wand2, RotateCcw, Download, Upload, Image, Shirt, Palette, Star, Heart, Rabbit, PawPrint } from 'lucide-react';
import { toast } from 'sonner';
import { getDefaultPets, generateCustomPet, recolorPet } from '../pets/defaults';
import { PetConfig, PetPalette, CustomPetTags, COLOR_PRESETS, BUILTIN_PALETTES } from '../pets/types';
import { SpriteAnimator, PetAvatar } from './SpriteAnimator';
import { ALL_ACCESSORIES, AccessoryDef, AccessoryCategory } from '../pets/accessories';
import { apiFetch } from '@/services/apiClient';

const BUILTIN_ANIMATIONS = ['idle', 'run', 'wave', 'jump', 'waiting'];
const CUSTOM_PETS_KEY = 'lumi_custom_pets';
type UiLang = 'en' | 'zh';
type LocalizedText = { zh: string; en: string };

const pickText = (lang: UiLang, text: LocalizedText) => lang === 'zh' ? text.zh : text.en;

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

const PET_DESCS: Record<string, string> = {
  'lumi-cat': '温暖治愈的猫猫，会眨眼、摇尾巴、撒娇挥手。适合日常陪伴。',
  'lumi-blob': 'Q弹软萌的史莱姆，一蹦一跳、眼睛闪闪。活泼可爱风。',
  'lumi-bird': '圆滚滚的小鸟，扑腾翅膀、叽叽喳喳。轻快灵动风。',
  'lumi-dragon': '迷你小龙，有翅膀和小角。适合喜欢奇幻风格的用户。',
  'lumi-fox': '橙色小狐狸，三角大耳、蓬松尾巴带白尖。机灵俏皮。',
  'lumi-rabbit': '软萌小白兔，长耳朵垂下来、圆圆短尾巴。温柔治愈。',
  'lumi-bear': '棕色小熊，圆耳朵、厚实爪垫。憨态可掬，给人安全感。',
  'lumi-hamster': '圆圆小仓鼠，鼓鼓的腮帮子、迷你小耳朵。超萌可爱。',
};

const SPECIES_LABELS: Record<string, LocalizedText> = {
  cat: { zh: '猫咪', en: 'Cat' },
  blob: { zh: '史莱姆', en: 'Blob' },
  bird: { zh: '小鸟', en: 'Bird' },
  dragon: { zh: '小龙', en: 'Dragon' },
  fox: { zh: '狐狸', en: 'Fox' },
  rabbit: { zh: '兔子', en: 'Rabbit' },
  bear: { zh: '小熊', en: 'Bear' },
  hamster: { zh: '仓鼠', en: 'Hamster' },
};

const PATTERN_LABELS: Record<string, LocalizedText> = {
  striped: { zh: '条纹', en: 'Striped' },
  spotted: { zh: '斑点', en: 'Spotted' },
  bicolor: { zh: '双色', en: 'Bicolor' },
  gradient: { zh: '渐变', en: 'Gradient' },
};

const SPECIAL_LABELS: Record<string, LocalizedText> = {
  glowing: { zh: '发光', en: 'Glow' },
  sparkly: { zh: '闪光', en: 'Sparkle' },
};

const ANIMATION_LABELS: Record<string, LocalizedText> = {
  idle: { zh: '待机', en: 'Idle' },
  run: { zh: '奔跑', en: 'Run' },
  wave: { zh: '挥手', en: 'Wave' },
  jump: { zh: '跳跃', en: 'Jump' },
  waiting: { zh: '等待', en: 'Wait' },
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
    toast.success(`${pet.name} ${ui('已设为桌面形象', 'set as desktop avatar')}`);
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
      toast.success(`${newPet.name} ${ui('已生成！', 'generated!')}`);
    } catch (err: any) {
      toast.error(err.message || ui('生成失败', 'Generation failed'));
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
      toast.success(`${ui('已导出', 'Exported')} ${pet.name}`);
    } catch {
      toast.error(ui('导出失败', 'Export failed'));
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
        toast.success(`${ui('已导入', 'Imported')} ${importedPet.name}`);
      } catch {
        toast.error(ui('无效的 .pet.json 文件（需含内嵌 spritesheet）', 'Invalid .pet.json file with embedded spritesheet required'));
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
    else toast.error(ui('请拖入 .pet.json 文件', 'Drop a .pet.json file'));
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
              <p className="text-sm font-bold text-cyan-400">{ui('释放以导入 .pet.json', 'Release to import .pet.json')}</p>
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
            <h2 className="text-sm font-black text-white/90 uppercase tracking-wider">{ui('形象设计室', 'Avatar Studio')}</h2>
            <p className="text-xs text-white/55 font-mono">{ui('桌面伙伴设计', 'Avatar Design Studio')}</p>
          </div>
        </div>
        <div className="lumi-panel flex items-center gap-2 p-1">
          {([
            ['gallery', ui('形象画廊', 'Gallery'), 'text-cyan-400', 'bg-cyan-500/20'],
            ['generate', ui('AI 定制', 'AI Custom'), 'text-fuchsia-400', 'bg-fuchsia-500/20'],
            ['colors', ui('调色', 'Colors'), 'text-amber-400', 'bg-amber-500/20'],
            ['wardrobe', ui('装扮', 'Wardrobe'), 'text-emerald-400', 'bg-emerald-500/20'],
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
          [ui('声音', 'Voice'), ui('选择 Lumi 的声音', 'Choose Lumi voice')],
          [ui('形象', 'Avatar'), ui('选择身体', 'Select body')],
          [ui('风格', 'Style'), ui('调整颜色', 'Tune colors')],
          [ui('桌面', 'Desktop'), ui('保存伙伴', 'Save companion')],
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
                <p className="text-[12px] font-bold uppercase tracking-wider text-white/45">{ui('形象画廊', 'Avatar Gallery')}</p>
                <span className="text-[12px] text-white/30 font-mono">{allPets.length} {ui('款', 'items')}</span>
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
                {ui('导入社区宠物（拖拽或点击）', 'Import community pet (drag or click)')}
              </button>
            </div>
          ) : tab === 'generate' ? (
            <div className="space-y-4">
              <p className="text-[12px] font-bold uppercase tracking-wider text-white/45">{ui('AI 形象生成', 'AI Avatar Generation')}</p>
              <div className="space-y-3">
                <div className="lumi-panel flex items-center gap-2 p-2">
                  <button
                    onClick={() => setAiMode(true)}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${aiMode ? 'bg-fuchsia-500/20 text-fuchsia-400' : 'text-white/45 hover:text-white/40'}`}
                  >
                    <Sparkles size={12} className="inline mr-1" /> {ui('AI 增强', 'AI Enhanced')}
                  </button>
                  <button
                    onClick={() => setAiMode(false)}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${!aiMode ? 'bg-cyan-500/20 text-cyan-400' : 'text-white/45 hover:text-white/40'}`}
                  >
                    <Wand2 size={12} className="inline mr-1" /> {ui('程序生成', 'Procedural')}
                  </button>
                </div>
                <textarea
                  value={genPrompt}
                  onChange={e => setGenPrompt(e.target.value)}
                  placeholder={ui('描述你想要的桌面宠物，例如：一只橙色的小狐狸，有蓬松的大尾巴和白肚皮，可爱机灵...', 'Describe the desktop pet you want, e.g. an orange fox with a fluffy tail, white belly, and playful personality...')}
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
                      {ui('AI 生成中...', 'Generating with AI...')}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2"><Sparkles size={14} /> {ui('开始生成', 'Generate')}</span>
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
                <p><Sparkles size={10} className="inline mr-1" />{ui('AI 增强会理解你的描述，自动匹配物种、配色、花纹、眼睛形状等', 'AI Enhanced understands your prompt and matches species, palette, pattern, eye shape, and more.')}</p>
                <p className="mt-1 text-fuchsia-300/30">{ui('支持中英文描述 · 生成约需 15-30 秒', 'Chinese and English prompts supported · about 15-30 seconds')}</p>
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
                {SPECIES_LABELS[activePet.tags.species] ? pickText(uiLang, SPECIES_LABELS[activePet.tags.species]) : activePet.tags.species}
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
                    {PATTERN_LABELS[activePet.tags.pattern] ? pickText(uiLang, PATTERN_LABELS[activePet.tags.pattern]) : activePet.tags.pattern}
                  </span>
                )}
                {activePet.tags.special && activePet.tags.special !== 'none' && (
                  <span className="px-2 py-0.5 rounded-full bg-yellow-500/10 text-[12px] text-yellow-400">
                    {SPECIAL_LABELS[activePet.tags.special] ? pickText(uiLang, SPECIAL_LABELS[activePet.tags.special]) : activePet.tags.special}
                  </span>
                )}
                {activePet.tags.hasWings && <span className="px-2 py-0.5 rounded-full bg-white/5 text-[12px] text-white/40">{ui('翅膀', 'Wings')}</span>}
                {activePet.tags.hasHorns && <span className="px-2 py-0.5 rounded-full bg-white/5 text-[12px] text-white/40">{ui('角', 'Horns')}</span>}
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
                {ANIMATION_LABELS[anim] ? pickText(uiLang, ANIMATION_LABELS[anim]) : anim}
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
                {ui('还原默认圆球', 'Restore default sphere')}
              </button>
            )}
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => handleSelectPet(activePet)}
              className="lumi-button-primary rounded-2xl border-cyan-500/25 bg-cyan-500/15 px-8 py-3 text-sm text-cyan-300 hover:bg-cyan-500/25"
            >
              <Sparkles size={16} />
              {ui('设为桌面形象', 'Set as Desktop Avatar')}
              <ArrowRight size={14} />
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Color Panel ──

const COLOR_SLOTS: { key: keyof PetPalette; label: LocalizedText; desc: LocalizedText }[] = [
  { key: 'body', label: { zh: '身体', en: 'Body' }, desc: { zh: '主体颜色', en: 'Main color' } },
  { key: 'accent', label: { zh: '装饰', en: 'Accent' }, desc: { zh: '耳朵/角/翅膀', en: 'Ears / horns / wings' } },
  { key: 'belly', label: { zh: '腹部', en: 'Belly' }, desc: { zh: '肚皮颜色', en: 'Belly color' } },
  { key: 'eye', label: { zh: '眼睛', en: 'Eyes' }, desc: { zh: '瞳孔颜色', en: 'Eye color' } },
];

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
  const activeSlotLabel = COLOR_SLOTS.find(s => s.key === activeSlot)?.label;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Palette size={14} className="text-amber-400" />
        <p className="text-xs font-black uppercase tracking-wider text-white/50">{lang === 'zh' ? '颜色调板' : 'Color Palette'}</p>
      </div>

      {/* Slot selector */}
      <div className="grid grid-cols-2 gap-1.5">
        {COLOR_SLOTS.map(slot => (
          <button
            key={slot.key}
            onClick={() => onSelectSlot(slot.key)}
            className={`flex items-center gap-2 rounded-xl border p-2 transition-colors ${
              activeSlot === slot.key
                ? 'bg-amber-500/10 border-amber-500/30'
                : 'bg-white/[0.04] border-white/[0.08] hover:bg-white/10'
            }`}
          >
            <div
              className="w-6 h-6 rounded-lg border border-white/10 flex-shrink-0"
              style={{ backgroundColor: palette[slot.key] }}
            />
            <div className="text-left min-w-0">
              <div className="text-xs font-bold text-white/60">{pickText(lang, slot.label)}</div>
              <div className="text-[12px] text-white/35">{pickText(lang, slot.desc)}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Color grid */}
      <div>
        <p className="text-xs text-white/40 mb-2">
          {lang === 'zh' ? '选择' : 'Choose'} {activeSlotLabel ? pickText(lang, activeSlotLabel) : activeSlot} {lang === 'zh' ? '颜色' : 'color'}
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
        {lang === 'zh' ? '恢复默认' : 'Reset to Default'}
      </button>
    </div>
  );
}

// ── Wardrobe Panel ──

const CATEGORY_LABELS: Record<string, LocalizedText> = {
  hat: { zh: '帽子', en: 'Hats' },
  glasses: { zh: '眼镜', en: 'Glasses' },
  scarf: { zh: '围巾', en: 'Scarves' },
  collar: { zh: '项圈', en: 'Collars' },
  ears: { zh: '耳朵', en: 'Ears' },
  tail: { zh: '尾巴', en: 'Tails' },
  mask: { zh: '面具', en: 'Masks' },
  back: { zh: '背饰', en: 'Back' },
  faceMark: { zh: '印记', en: 'Marks' },
  aura: { zh: '光环', en: 'Auras' },
};

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
        <p className="text-xs font-black uppercase tracking-wider text-white/50">{lang === 'zh' ? '配件装扮' : 'Accessories'}</p>
        <span className="text-[12px] text-white/45">({equipped.length} {lang === 'zh' ? '件' : 'equipped'})</span>
      </div>

      {CATEGORY_ORDER.map(cat => {
        const items = ALL_ACCESSORIES.filter(a => a.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-widest text-white/40">
              {CATEGORY_LABELS[cat] ? pickText(lang, CATEGORY_LABELS[cat]) : cat}
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
                          {lang === 'zh' ? acc.nameCN : acc.name}
                        </div>
                        <div className="text-[12px] text-white/40 truncate">{lang === 'zh' ? acc.name : acc.nameCN}</div>
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
          {lang === 'zh' ? '卸下全部' : 'Remove All'}
        </button>
      )}
    </div>
  );
}
