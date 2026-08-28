/**
 * LumiCore Skill Marketplace Registry
 *
 * Dynamically discovers skills from:
 *   - Bundled skills in server/skills/bundled/
 *   - Community registry (published skills)
 *   - Local ~/lumi_skills/ installs
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readDB, writeDB } from '../../db_layer';
import { getTranslation, translateCategory } from '../skills/translations';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SKILLS_DIR = path.join(os.homedir(), 'lumi_skills');

function resolveBundledDir(): string {
  const candidates = [
    path.join(process.cwd(), 'server', 'skills', 'bundled'),
    path.join(__dirname, '..', 'skills', 'bundled'),
    path.join(__dirname, 'server', 'skills', 'bundled'),
    path.join(__dirname, '..', 'server', 'skills', 'bundled'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

const BUNDLED_DIR = resolveBundledDir();

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  author: string;
  downloads: number;
  rating: number;
  category: string;
  icon: string;
  installSource: 'bundled' | 'community';
  installPath?: string;
  installed: boolean;
  version?: string;
  toolCount?: number;
  requiresApiKey?: boolean;
  apiKeyEnv?: string;
  apiKeyUrl?: string;
  requiresSetup?: boolean;
  setupNote?: string;
}

export interface SkillRating {
  skillId: string;
  userId: string;
  rating: number;
  review?: string;
  timestamp: string;
}

export interface MarketplaceAgentScope {
  ownerUid?: string;
  domain?: string;
  orgId?: string;
}

/** Scan bundled directory to discover available skills */
function discoverBundledSkills(_scope?: MarketplaceAgentScope): MarketplaceSkill[] {
  const skills: MarketplaceSkill[] = [];
  if (!fs.existsSync(BUNDLED_DIR)) return skills;

  const entries = fs.readdirSync(BUNDLED_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(BUNDLED_DIR, entry.name, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const lumi = pkg.lumi || {};
      const installed = isInstalledSkill(entry.name, lumi.displayName);
      skills.push({
        id: `skill-${entry.name}`,
        name: lumi.displayName || toDisplayName(entry.name),
        description: pkg.description || '',
        author: 'Lumi Official',
        downloads: 0,
        rating: 0,
        category: lumi.category || 'Other',
        icon: lumi.icon || 'Zap',
        installSource: 'bundled',
        installPath: path.join(BUNDLED_DIR, entry.name),
        installed,
        version: pkg.version,
        toolCount: lumi.toolCount || 1,
        requiresApiKey: lumi.requiresApiKey || false,
        apiKeyEnv: lumi.apiKeyEnv,
        apiKeyUrl: lumi.apiKeyUrl,
        requiresSetup: lumi.requiresSetup || false,
        setupNote: lumi.setupNote,
      });
    } catch { /* skip invalid packages */ }
  }
  return skills;
}

/** Community skill registry stored in DB */
const COMMUNITY_REGISTRY: MarketplaceSkill[] = [];

function toSkillSlug(value?: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^skill-/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isInstalledSkill(dirName: string, displayName?: string): boolean {
  const candidates = new Set([dirName, toSkillSlug(displayName)]);
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(SKILLS_DIR, candidate))) return true;
  }
  return false;
}

/** Get community registry from DB */
function getCommunityRegistry(_scope?: MarketplaceAgentScope): MarketplaceSkill[] {
  const db = readDB();
  if (!db.communitySkills) return [];
  return db.communitySkills.map((s: any) => {
    const dirName = s.id.replace('skill-', '');
    const installed = isInstalledSkill(dirName, s.name);
    return {
      ...s,
      installSource: 'community' as const,
      installPath: s.installPath,
      installed,
    };
  });
}

/** Apply cached translations to a skill list */
function applyTranslations(skills: MarketplaceSkill[], lang?: string): MarketplaceSkill[] {
  if (!lang || lang === 'en') return skills;
  for (const s of skills) {
    const t = getTranslation(s.id, lang);
    if (t) {
      if (t.displayName) s.name = t.displayName;
      if (t.description) s.description = t.description;
      if (t.setupNote && s.setupNote) s.setupNote = t.setupNote;
    }
    s.category = translateCategory(s.category, lang);
  }
  return skills;
}

/** Get all marketplace skills: bundled + community, with download counts & ratings from DB */
export function getMarketplaceSkills(lang?: string, scope?: MarketplaceAgentScope): MarketplaceSkill[] {
  const bundled = discoverBundledSkills(scope);
  const community = getCommunityRegistry(scope);
  const db = readDB();

  const all = [...bundled, ...community];

  // Enrich with ratings from DB
  if (db.skillRatings) {
    for (const skill of all) {
      const ratings = (db.skillRatings as SkillRating[]).filter(r => r.skillId === skill.id);
      if (ratings.length > 0) {
        skill.rating = Math.round((ratings.reduce((a, b) => a + b.rating, 0) / ratings.length) * 10) / 10;
      }
    }
  }

  // Enrich with download counts from DB
  if (db.skillDownloads) {
    for (const skill of all) {
      skill.downloads = (db.skillDownloads as Record<string, number>)[skill.id] || skill.downloads;
    }
  }

  return applyTranslations(all, lang);
}

export function getSkillById(id: string, lang?: string, scope?: MarketplaceAgentScope): MarketplaceSkill | undefined {
  const skill = getMarketplaceSkills(undefined, scope).find(s => s.id === id);
  if (!skill) return undefined;
  return applyTranslations([skill], lang)[0];
}

export function searchSkills(query: string, lang?: string, scope?: MarketplaceAgentScope): MarketplaceSkill[] {
  const q = query.toLowerCase();
  const skills = getMarketplaceSkills(lang, scope);
  return skills.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.category.toLowerCase().includes(q)
  );
}

export function getCategories(lang?: string, scope?: MarketplaceAgentScope): string[] {
  const categories = new Set<string>();
  for (const s of getMarketplaceSkills(undefined, scope)) {
    categories.add(translateCategory(s.category, lang));
  }
  return [...categories].sort();
}

/** Record a skill installation */
export function recordInstall(skillId: string): void {
  const db = readDB();
  if (!db.skillDownloads) db.skillDownloads = {};
  db.skillDownloads[skillId] = (db.skillDownloads[skillId] || 0) + 1;
  writeDB(db);
}

/** Publish a community skill */
export function publishSkill(skill: {
  id?: string;
  name: string;
  description: string;
  author: string;
  category: string;
  icon: string;
  installPath?: string;
  version?: string;
  toolCount?: number;
}): MarketplaceSkill {
  const skillId = skill.id || `skill-${skill.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const db = readDB();
  if (!db.communitySkills) db.communitySkills = [];

  const entry: MarketplaceSkill = {
    id: skillId,
    name: skill.name,
    description: skill.description,
    author: skill.author || 'Community',
    downloads: 0,
    rating: 0,
    category: skill.category || 'Other',
    icon: skill.icon || 'Zap',
    installSource: 'community' as const,
    installPath: skill.installPath,
    installed: false,
    version: skill.version,
    toolCount: skill.toolCount || 1,
  };

  const existing = db.communitySkills.findIndex((s: any) => s.id === skillId);
  if (existing >= 0) {
    db.communitySkills[existing] = entry;
  } else {
    db.communitySkills.push(entry);
  }
  writeDB(db);
  return entry;
}

/** Rate a skill */
export function rateSkill(skillId: string, userId: string, rating: number, review?: string): SkillRating {
  if (rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');

  const db = readDB();
  if (!db.skillRatings) db.skillRatings = [];

  // Update existing rating or add new
  const existing = (db.skillRatings as SkillRating[]).findIndex(
    r => r.skillId === skillId && r.userId === userId,
  );
  const entry: SkillRating = {
    skillId, userId, rating, review,
    timestamp: new Date().toISOString(),
  };

  if (existing >= 0) {
    (db.skillRatings as SkillRating[])[existing] = entry;
  } else {
    (db.skillRatings as SkillRating[]).push(entry);
  }
  writeDB(db);
  return entry;
}

/** Get ratings for a skill */
export function getSkillRatings(skillId: string): SkillRating[] {
  const db = readDB();
  if (!db.skillRatings) return [];
  return (db.skillRatings as SkillRating[]).filter(r => r.skillId === skillId);
}

function toDisplayName(dirName: string): string {
  return dirName
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
