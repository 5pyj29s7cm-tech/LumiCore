import { readDB, writeDB } from '../../db_layer';

export interface UserIdentityPreference {
  preferredAddress: string;
  source: 'explicit_user_statement';
  confirmedAt: string;
  sourceInteractionId?: string;
}

const MAX_ADDRESS_LENGTH = 48;
const historyScanCompleted = new Set<string>();
const INVALID_ADDRESS_RE = /^(?:me|you|him|her|them|when|later|back|maybe|anything|whatever|someone|anyone|\u6211|\u4f60|\u4ed6|\u5979|\u5b83|\u8054\u7cfb\u4eba|\u6587\u4ef6|\u6587\u4ef6\u5939)$/iu;

const EXPLICIT_ADDRESS_PATTERNS: RegExp[] = [
  /(?:\u4f60)?(?:\u5e94\u8be5|\u53ef\u4ee5|\u5f97|\u8981)?(?:\u79f0\u547c|\u53eb)\u6211(?:\u4e3a|\u4f5c|\u505a)?[\s\uff1a:]*(?<address>[^\s,\uff0c\u3002\uff01\uff1f!?;\uff1b:\uff1a"'\u201c\u201d\u2018\u2019]{1,24})/u,
  /(?:\u4ee5\u540e|\u4eca\u540e)?(?:\u8bf7)?(?:\u79f0\u547c|\u53eb)\u6211(?:\u4e3a|\u4f5c|\u505a)?[\s\uff1a:]*(?<address>[^\s,\uff0c\u3002\uff01\uff1f!?;\uff1b:\uff1a"'\u201c\u201d\u2018\u2019]{1,24})/u,
  /(?:\u6211\u7684\u540d\u5b57\u662f|\u6211\u53eb)[\s\uff1a:]*(?<address>[^\s,\uff0c\u3002\uff01\uff1f!?;\uff1b:\uff1a"'\u201c\u201d\u2018\u2019]{1,24})/u,
  /\b(?:please\s+)?address\s+me\s+as\s+(?<address>[^,.!?;\n]{1,48})/i,
  /\byou\s+(?:should|can)\s+call\s+me\s+(?<address>[^,.!?;\n]{1,48})/i,
  /\bmy\s+name\s+is\s+(?<address>[^,.!?;\n]{1,48})/i,
];

function preferenceKey(userId: string): string {
  return `user_identity_${userId || 'anonymous'}`;
}

function normalizeAddress(value: string): string {
  const normalized = String(value || '')
    .replace(/^[\s"'\u201c\u201d\u2018\u2019]+|[\s"'\u201c\u201d\u2018\u2019]+$/g, '')
    .replace(/(?:\u5427|\u5c31\u597d|\u5373\u53ef|\u53ef\u4ee5\u4e86)$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > MAX_ADDRESS_LENGTH || INVALID_ADDRESS_RE.test(normalized)) return '';
  return normalized;
}

export function extractExplicitUserAddress(text: string): string | null {
  const source = String(text || '').trim();
  if (!source) return null;
  for (const pattern of EXPLICIT_ADDRESS_PATTERNS) {
    const match = pattern.exec(source);
    const address = normalizeAddress(match?.groups?.address || '');
    if (address) return address;
  }
  return null;
}

function parsePreference(value: unknown): UserIdentityPreference | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const preferredAddress = normalizeAddress(String((parsed as any)?.preferredAddress || ''));
    if (!preferredAddress) return null;
    return {
      preferredAddress,
      source: 'explicit_user_statement',
      confirmedAt: String((parsed as any)?.confirmedAt || new Date(0).toISOString()),
      sourceInteractionId: String((parsed as any)?.sourceInteractionId || '') || undefined,
    };
  } catch {
    return null;
  }
}

function savePreference(
  userId: string,
  preferredAddress: string,
  sourceInteractionId?: string,
): UserIdentityPreference {
  const db = readDB();
  if (!db.settings) db.settings = [];
  const key = preferenceKey(userId);
  const existingIndex = db.settings.findIndex((item: any) => item.key === key);
  const existing = existingIndex >= 0 ? parsePreference(db.settings[existingIndex].value) : null;
  if (existing?.preferredAddress === preferredAddress) return existing;

  const preference: UserIdentityPreference = {
    preferredAddress,
    source: 'explicit_user_statement',
    confirmedAt: new Date().toISOString(),
    sourceInteractionId,
  };
  const value = JSON.stringify(preference);
  if (existingIndex >= 0) db.settings[existingIndex].value = value;
  else db.settings.push({ key, value });
  writeDB(db);
  return preference;
}

export function getUserIdentityPreference(userId: string): UserIdentityPreference | null {
  const db = readDB();
  const setting = (db.settings || []).find((item: any) => item.key === preferenceKey(userId));
  return setting ? parsePreference(setting.value) : null;
}

export function resolveUserIdentityPreference(
  userId: string,
  currentUserText?: string,
): UserIdentityPreference | null {
  const explicitCurrent = extractExplicitUserAddress(currentUserText || '');
  if (explicitCurrent) return savePreference(userId, explicitCurrent);

  const stored = getUserIdentityPreference(userId);
  if (stored) return stored;
  if (historyScanCompleted.has(userId)) return null;
  historyScanCompleted.add(userId);

  const db = readDB();
  const history = [...(db.interactions || [])]
    .filter((item: any) => item.userId === userId && item.role === 'user')
    .sort((a: any, b: any) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  for (const item of history) {
    const preferredAddress = extractExplicitUserAddress(String(item.message || ''));
    if (preferredAddress) return savePreference(userId, preferredAddress, String(item.id || '') || undefined);
  }
  return null;
}

export function formatUserIdentityBoundary(userId?: string, currentUserText?: string): string {
  let preference: UserIdentityPreference | null = null;
  try {
    preference = userId ? resolveUserIdentityPreference(userId, currentUserText) : null;
  } catch {
    preference = null;
  }
  return [
    '## User Identity Boundary',
    preference
      ? `The user explicitly confirmed their preferred form of address as ${JSON.stringify(preference.preferredAddress)}. Treat this as authoritative until the same user explicitly changes it.`
      : 'No explicit preferred form of address is stored. Use a neutral form of address or ask; never invent one.',
    'Names found in contacts, chat recipients, filenames, folders, documents, cases, projects, tool results, retrieved memories, dreams, or task targets describe external entities. Never infer that any of them is the user or the user\'s preferred name.',
    'Words such as owner or master describe authorization roles inside policy; do not use them as spoken titles unless the user explicitly chose that title.',
  ].join('\n');
}
