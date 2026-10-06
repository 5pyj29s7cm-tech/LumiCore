import { createHash } from "crypto";

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value.map(item => String(item || '').trim()).filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  const primitive = JSON.stringify(value);
  return primitive === undefined ? 'null' : primitive;
}

export function canonicalDraftManifest(manifestSource: string): string {
  if (!manifestSource.trim()) return '';
  const manifest = JSON.parse(manifestSource) as Record<string, any>;
  const lumi = manifest.lumi && typeof manifest.lumi === 'object'
    ? { ...manifest.lumi }
    : undefined;
  if (lumi?.draftReview && typeof lumi.draftReview === 'object') {
    // Bind the approval surface (permissions, side effects, risk, checks and
    // trial result) while replacing only the one self-referential value.
    // Removing the whole review would let those user-visible security facts
    // change without invalidating the artifact.
    lumi.draftReview = {
      ...lumi.draftReview,
      contentHash: '',
    };
    manifest.lumi = lumi;
  }
  return canonicalJson(manifest);
}

export function computeGeneratedSkillArtifactHash(
  source: string,
  manifestSource = '',
  lockfileSource = '',
): string {
  return createHash('sha256')
    .update('lumi-generated-skill-artifact-v2\0', 'utf8')
    .update(source, 'utf8')
    .update('\0manifest\0', 'utf8')
    .update(canonicalDraftManifest(manifestSource), 'utf8')
    .update('\0lockfile\0', 'utf8')
    .update(lockfileSource.trim() ? canonicalJson(JSON.parse(lockfileSource)) : '', 'utf8')
    .digest('hex');
}
