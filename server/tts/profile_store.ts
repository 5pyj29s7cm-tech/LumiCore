import { readDB, writeDB } from '../../db_layer';

export interface VoiceProfileScope {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}

export function voiceProfileScope(userId: string, domain?: string, orgId?: string): VoiceProfileScope {
  const work = domain === 'work' && Boolean(orgId);
  return {
    userId,
    domain: work ? 'work' : 'personal',
    orgId: work ? String(orgId) : '',
  };
}

export function voiceProfileStorageKey(scope: VoiceProfileScope): string {
  return scope.domain === 'work' ? `org:${scope.orgId}` : scope.userId;
}

export function listScopedVoiceProfiles(scope: VoiceProfileScope): any[] {
  const db = readDB();
  return [...(db.voiceProfiles?.[voiceProfileStorageKey(scope)] || [])];
}

export function addScopedVoiceProfile(scope: VoiceProfileScope, profile: Record<string, any>): any {
  const db = readDB();
  if (!db.voiceProfiles) db.voiceProfiles = {};
  const key = voiceProfileStorageKey(scope);
  if (!db.voiceProfiles[key]) db.voiceProfiles[key] = [];
  const stored = {
    ...profile,
    domain: scope.domain,
    orgId: scope.orgId,
    createdBy: scope.userId,
  };
  db.voiceProfiles[key].push(stored);
  writeDB(db);
  return stored;
}

export function removeScopedVoiceProfile(scope: VoiceProfileScope, voiceId: string): any | null {
  const db = readDB();
  const key = voiceProfileStorageKey(scope);
  const profiles = db.voiceProfiles?.[key] || [];
  const index = profiles.findIndex((profile: any) => profile.voiceId === voiceId);
  if (index < 0) return null;
  const [removed] = profiles.splice(index, 1);
  db.voiceProfiles[key] = profiles;
  writeDB(db);
  return removed;
}

export function isVoiceProfileAccessible(scope: VoiceProfileScope, voiceId: string): boolean {
  const target = String(voiceId || '').trim();
  if (!target || target === 'default') return true;
  const db = readDB();
  const entries = Object.entries(db.voiceProfiles || {}) as Array<[string, any[]]>;
  const owners = entries.filter(([, profiles]) => (
    Array.isArray(profiles) && profiles.some(profile => profile?.voiceId === target)
  ));
  if (owners.length === 0) return true;
  return owners.some(([key]) => key === voiceProfileStorageKey(scope));
}
