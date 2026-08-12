import { createHash } from 'crypto';

export interface CommunityLumiProfile {
  agentId: string;
  displayName: string;
  description: string;
  capabilities: string[];
  trustTags: string[];
  homeNode: string;
  publicKeyFingerprint: string;
  updatedAt: string;
}

export interface CommunityLumiDirectorySnapshot {
  configured: boolean;
  status: 'not_configured' | 'online' | 'offline' | 'invalid_configuration';
  sourceOrigin: string;
  profiles: CommunityLumiProfile[];
  fetchedAt: string;
  error?: string;
}

const MAX_DIRECTORY_PROFILES = 100;
const DIRECTORY_TIMEOUT_MS = 8_000;

function directoryUrl(): URL | null {
  const raw = String(process.env.LUMI_COMMUNITY_DIRECTORY_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && loopback && url.protocol === 'http:')) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(item => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean)))
    .slice(0, limit);
}

function normalizeProfile(value: unknown): CommunityLumiProfile | null {
  const raw = value as Record<string, unknown>;
  const agentId = String(raw?.agentId || '').trim().slice(0, 160);
  const displayName = String(raw?.displayName || raw?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const publicKey = String(raw?.publicKey || '').trim().slice(0, 16_000);
  if (!agentId || !displayName || !publicKey) return null;
  return {
    agentId,
    displayName,
    description: String(raw.description || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    capabilities: normalizeStrings(raw.capabilities, 30),
    trustTags: normalizeStrings(raw.trustTags, 12),
    homeNode: String(raw.homeNode || '').trim().slice(0, 240),
    publicKeyFingerprint: createHash('sha256').update(publicKey).digest('hex'),
    updatedAt: Number.isFinite(Date.parse(String(raw.updatedAt || ''))) ? String(raw.updatedAt) : '',
  };
}

export async function fetchCommunityLumiDirectory(limit = 24): Promise<CommunityLumiDirectorySnapshot> {
  const configuredRaw = String(process.env.LUMI_COMMUNITY_DIRECTORY_URL || '').trim();
  const url = directoryUrl();
  const fetchedAt = new Date().toISOString();
  if (!configuredRaw) return { configured: false, status: 'not_configured', sourceOrigin: '', profiles: [], fetchedAt };
  if (!url) return {
    configured: true,
    status: 'invalid_configuration',
    sourceOrigin: '',
    profiles: [],
    fetchedAt,
    error: 'Community directory must use HTTPS (loopback HTTP is allowed only outside production).',
  };

  const requestUrl = new URL(url.toString());
  requestUrl.searchParams.set('limit', String(Math.max(1, Math.min(Number(limit) || 24, MAX_DIRECTORY_PROFILES))));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECTORY_TIMEOUT_MS);
  try {
    const apiKey = String(process.env.LUMI_COMMUNITY_DIRECTORY_API_KEY || '').trim();
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Directory returned HTTP ${response.status}.`);
    const body = await response.json() as any;
    const source = Array.isArray(body) ? body : Array.isArray(body?.profiles) ? body.profiles : [];
    const profiles = source
      .slice(0, MAX_DIRECTORY_PROFILES)
      .map(normalizeProfile)
      .filter((profile: CommunityLumiProfile | null): profile is CommunityLumiProfile => Boolean(profile));
    return {
      configured: true,
      status: 'online',
      sourceOrigin: url.origin,
      profiles,
      fetchedAt,
    };
  } catch (error: any) {
    return {
      configured: true,
      status: 'offline',
      sourceOrigin: url.origin,
      profiles: [],
      fetchedAt,
      error: error?.name === 'AbortError' ? 'Community directory timed out.' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}
