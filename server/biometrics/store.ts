import { readSettingRecord, writeSetting } from "../persistence/settings_repository";

import type {
  VoiceprintTemplate,
  FaceTemplate,
  BiometricStore,
} from './types';

function storeKey(uid: string): string {
  return `biometric_${uid}`;
}

function readStore(uid: string): BiometricStore {
  const row = readSettingRecord(storeKey(uid));
  if (row) {
    try {
      return JSON.parse(row.value);
    } catch {
      return { voiceprints: [], faces: [], tripleLock: null };
    }
  }
  return { voiceprints: [], faces: [], tripleLock: null };
}

function writeStore(uid: string, store: BiometricStore): void {
  writeSetting(storeKey(uid), JSON.stringify(store));
}

// ── Voiceprints ──

export function saveVoiceprint(uid: string, template: Omit<VoiceprintTemplate, 'uid' | 'createdAt' | 'lastMatchedAt'>): VoiceprintTemplate {
  const store = readStore(uid);
  const now = new Date().toISOString();
  const vp: VoiceprintTemplate = { ...template, uid, createdAt: now, lastMatchedAt: now };
  store.voiceprints.push(vp);
  writeStore(uid, store);
  return vp;
}

export function replaceVoiceprints(uid: string, template: Omit<VoiceprintTemplate, 'uid' | 'createdAt' | 'lastMatchedAt'>): VoiceprintTemplate {
  const store = readStore(uid);
  const now = new Date().toISOString();
  const vp: VoiceprintTemplate = { ...template, uid, createdAt: now, lastMatchedAt: now };
  // Replacement happens only after the new template has been fully produced,
  // so a failed enrollment never destroys the user's working biometric data.
  store.voiceprints = [vp];
  writeStore(uid, store);
  return vp;
}

export function getVoiceprints(uid: string): VoiceprintTemplate[] {
  return readStore(uid).voiceprints;
}

export function deleteVoiceprint(uid: string, voiceprintId: string): boolean {
  const store = readStore(uid);
  const idx = store.voiceprints.findIndex(v => v.voiceprintId === voiceprintId);
  if (idx < 0) return false;
  store.voiceprints.splice(idx, 1);
  writeStore(uid, store);
  return true;
}

export function touchVoiceprint(uid: string, voiceprintId: string): void {
  const store = readStore(uid);
  const vp = store.voiceprints.find(v => v.voiceprintId === voiceprintId);
  if (vp) {
    vp.lastMatchedAt = new Date().toISOString();
    writeStore(uid, store);
  }
}

// ── Faces ──

export function saveFace(uid: string, template: Omit<FaceTemplate, 'uid' | 'createdAt' | 'lastMatchedAt'>): FaceTemplate {
  const store = readStore(uid);
  const now = new Date().toISOString();
  const face: FaceTemplate = { ...template, uid, createdAt: now, lastMatchedAt: now };
  store.faces.push(face);
  writeStore(uid, store);
  return face;
}

export function getFaces(uid: string): FaceTemplate[] {
  return readStore(uid).faces;
}

export function deleteFace(uid: string, faceId: string): boolean {
  const store = readStore(uid);
  const idx = store.faces.findIndex(f => f.faceId === faceId);
  if (idx < 0) return false;
  store.faces.splice(idx, 1);
  writeStore(uid, store);
  return true;
}
