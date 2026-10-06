export interface AtlasDefinition {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  animations: Record<string, AnimationRow>;
}

export interface AnimationRow {
  row: number;
  frameCount: number;
  frameDuration: number; // ms per frame
  loop?: boolean;
}

export interface PetConfig {
  id: string;
  name: string;
  author: string;
  spritesheet: string; // base64 data URL or URL path
  atlas: AtlasDefinition;
  thumbnail?: string; // preview image (first idle frame)
  palette?: PetPalette; // color palette for recolor support
  tags?: CustomPetTags; // generation tags (for custom pets)
}

// ── Color Palette ──
export interface PetPalette {
  body: string;
  bodyDark: string;
  accent: string;
  belly: string;
  eye: string;
  eyeWhite: string;
  pattern: string;
}

// ── Expanded generation tags ──
export type PetSpecies = 'cat' | 'fox' | 'rabbit' | 'bear' | 'hamster' | 'blob' | 'bird' | 'dragon' | 'custom';
export type PetPattern = 'solid' | 'striped' | 'spotted' | 'bicolor' | 'gradient';
export type PetEyeShape = 'round' | 'oval' | 'slit' | 'star' | 'heart';
export type PetMouthStyle = 'smile' | 'open' | 'shocked' | 'neutral' | 'tongue';
export type PetSize = 'tiny' | 'small' | 'normal' | 'large';
export type PetSpecial = 'none' | 'glowing' | 'sparkly';

export interface CustomPetTags {
  species: PetSpecies;
  color: string;
  pattern?: PetPattern;
  patternColor?: string;
  eyeShape?: PetEyeShape;
  eyeColor?: string;
  mouthStyle?: PetMouthStyle;
  size?: PetSize;
  hasWings?: boolean;
  hasHorns?: boolean;
  special?: PetSpecial;
}

// Default palettes per built-in species
export const BUILTIN_PALETTES: Record<string, PetPalette> = {
  cat:    { body: '#f4a460', bodyDark: '#d2843e', accent: '#e8915a', belly: '#ffe4c4', eye: '#2d2d2d', eyeWhite: '#fff', pattern: '#ddd' },
  blob:   { body: '#5cba5c', bodyDark: '#2d8a2d', accent: '#98e898', belly: '#c8f7c8', eye: '#1a1a1a', eyeWhite: '#fff', pattern: '#3a8a3a' },
  bird:   { body: '#f5d442', bodyDark: '#c07810', accent: '#e8a820', belly: '#fff9cc', eye: '#1a1a1a', eyeWhite: '#fff', pattern: '#e85d3a' },
  dragon: { body: '#5ddb5d', bodyDark: '#2ea82e', accent: '#4ec94e', belly: '#c8f7c8', eye: '#1a3a1a', eyeWhite: '#ff0', pattern: '#3aad3a' },
  fox:    { body: '#f49c4a', bodyDark: '#d4782a', accent: '#f8c080', belly: '#fff4e0', eye: '#2d1a0a', eyeWhite: '#fff', pattern: '#fff' },
  rabbit: { body: '#f5f0e8', bodyDark: '#d8d0c0', accent: '#faf5f0', belly: '#fff', eye: '#553030', eyeWhite: '#fff', pattern: '#f0c0c0' },
  bear:   { body: '#8B6914', bodyDark: '#5c4510', accent: '#a07828', belly: '#d4b878', eye: '#1a1a1a', eyeWhite: '#fff', pattern: '#6b5010' },
  hamster:{ body: '#e8c080', bodyDark: '#c89850', accent: '#f0d8a0', belly: '#fff8f0', eye: '#1a0a0a', eyeWhite: '#fff', pattern: '#d4a060' },
};

// Color presets for the UI picker (10 columns)
export const COLOR_PRESETS = [
  '#f4a460','#f0f0f0','#3a3a3a','#e85545','#5599dd','#5ddb5d','#9966cc','#f0a0b0','#f5d442','#888888',
  '#ff6b35','#ffe4c4','#4a3728','#ff4444','#3366cc','#2ea82e','#6633aa','#ff88aa','#ffaa00','#cccccc',
  '#ff8c69','#ffd700','#8B6914','#cc3333','#00bfff','#90ee90','#bb88ee','#ffc0cb','#fffacd','#e0e0e0',
  '#ffb347','#fff8dc','#d2b48c','#ff9999','#87ceeb','#3cb371','#da70d6','#ffb6c1','#f0e68c','#b0b0b0',
];

export const DEFAULT_ATLAS: AtlasDefinition = {
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
  animations: {
    idle:      { row: 0, frameCount: 6, frameDuration: 180, loop: true },
    run:       { row: 1, frameCount: 8, frameDuration: 100, loop: true },
    runLeft:   { row: 2, frameCount: 8, frameDuration: 100, loop: true },
    wave:      { row: 3, frameCount: 4, frameDuration: 150, loop: false },
    jump:      { row: 4, frameCount: 6, frameDuration: 80, loop: false },
    failed:    { row: 5, frameCount: 4, frameDuration: 200, loop: false },
    waiting:   { row: 6, frameCount: 4, frameDuration: 250, loop: true },
    runFast:   { row: 7, frameCount: 8, frameDuration: 60, loop: true },
    review:    { row: 8, frameCount: 4, frameDuration: 300, loop: true },
  },
};
