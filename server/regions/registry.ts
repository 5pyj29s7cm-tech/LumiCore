import { CN_CAPABILITY_PACK } from './packs/cn';
import { GLOBAL_CAPABILITY_PACK } from './packs/global';
import type { LumiRegion, RegionalCapabilityPack } from './types';

const PACKS: Record<LumiRegion, RegionalCapabilityPack> = {
  global: GLOBAL_CAPABILITY_PACK,
  cn: CN_CAPABILITY_PACK,
};

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const CN_PLATFORM_RE = /(?:feishu|wechat|wecom|fachan|qichacha|china\s+judgments|people'?s\s+courts?)/i;

export function normalizeRegion(value: unknown): LumiRegion | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  for (const pack of Object.values(PACKS)) {
    if (pack.id === normalized || pack.aliases.includes(normalized)) return pack.id;
  }
  return null;
}

export function inferRegion(input: {
  region?: unknown;
  locale?: unknown;
  text?: unknown;
  source?: unknown;
}): LumiRegion {
  const explicit = normalizeRegion(input.region);
  if (explicit) return explicit;

  const locale = String(input.locale || '').trim().toLowerCase().replace('_', '-');
  if (CN_CAPABILITY_PACK.locales.some(candidate => locale === candidate || locale.startsWith(`${candidate}-`))) {
    return 'cn';
  }

  const context = `${String(input.source || '')}\n${String(input.text || '')}`;
  if (HAN_RE.test(context) || CN_PLATFORM_RE.test(context)) return 'cn';
  return 'global';
}

export function getRegionalCapabilityPack(input: Parameters<typeof inferRegion>[0]): RegionalCapabilityPack {
  return PACKS[inferRegion(input)];
}

export function formatRegionalLegalPrompt(pack: RegionalCapabilityPack): string {
  if (!pack.legal) return '';
  return [
    `Regional capability pack: ${pack.id}.`,
    `External legal platforms: ${pack.legal.externalPlatforms.join(', ')}.`,
    `Similar-case authority order: ${pack.legal.authorityOrder.join(' -> ')}.`,
    `External-platform boundary: ${pack.legal.collaborationBoundary}`,
  ].join('\n');
}

export function listRegionalCapabilityPacks(): RegionalCapabilityPack[] {
  return Object.values(PACKS);
}
