import { readDB, writeDB } from '../../db_layer';
import { cloneDatabaseValue } from '../db/snapshot_changes';

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
  if (!scope.userId || !['personal', 'work'].includes(scope.domain)
    || (scope.domain === 'work' ? !scope.orgId : Boolean(scope.orgId))) throw new Error('Invalid voice profile scope');
  return scope.domain === 'work' ? `org:${scope.orgId}` : scope.userId;
}

export function listScopedVoiceProfiles(scope: VoiceProfileScope): any[] {
  const db = readDB();
  return cloneDatabaseValue(db.voiceProfiles?.[voiceProfileStorageKey(scope)] || []);
}

export function addScopedVoiceProfile(scope: VoiceProfileScope, profile: Record<string, any>): any {
  const db = readDB();
  const key = voiceProfileStorageKey(scope);
  const stored = cloneDatabaseValue({
    ...profile,
    // The store owns this required persistence field, including direct callers
    // that do not come through the voice clone/design HTTP routes.
    createdAt: profile.createdAt ?? new Date().toISOString(),
    domain: scope.domain,
    orgId: scope.orgId,
    createdBy: scope.userId,
  });
  writeDB({ ...db, voiceProfiles: { ...db.voiceProfiles, [key]: [...(db.voiceProfiles?.[key] || []), stored] } });
  return cloneDatabaseValue(stored);
}

export function updateScopedVoiceProfile(
  scope: VoiceProfileScope,
  voiceId: string,
  patch: Record<string, any>,
): any | null {
  const db = readDB();
  const key = voiceProfileStorageKey(scope);
  const profiles = db.voiceProfiles?.[key] || [];
  const index = profiles.findIndex((profile: any) => profile.voiceId === voiceId);
  if (index < 0) return null;
  const current = profiles[index];
  const next = cloneDatabaseValue({ ...current, ...patch, voiceId: current.voiceId,
    domain: current.domain, orgId: current.orgId, createdBy: current.createdBy });
  writeDB({ ...db, voiceProfiles: { ...db.voiceProfiles, [key]: profiles.map((row: any, i: number) => i === index ? next : row) } });
  return cloneDatabaseValue(next);
}

export function removeScopedVoiceProfile(scope: VoiceProfileScope, voiceId: string): any | null {
  const db = readDB();
  const key = voiceProfileStorageKey(scope);
  const profiles = db.voiceProfiles?.[key] || [];
  const index = profiles.findIndex((profile: any) => profile.voiceId === voiceId);
  if (index < 0) return null;
  const removed = profiles[index];
  writeDB({ ...db, voiceProfiles: { ...db.voiceProfiles, [key]: profiles.filter((_: any, i: number) => i !== index) } });
  return cloneDatabaseValue(removed);
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

/** Provider metadata only; never disclose another owner's profile payload. */
export function findVoiceProfileModel(voiceId: string): string | undefined {
  for (const profiles of Object.values(readDB().voiceProfiles || {}) as any[][]) {
    const model = profiles.find(profile => profile?.voiceId === voiceId && profile?.model)?.model;
    if (model) return String(model);
  }
  return undefined;
}
