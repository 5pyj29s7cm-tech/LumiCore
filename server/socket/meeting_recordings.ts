import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MeetingRecording {
  key: string;
  meetingId: string;
  startedAt: number;
  segments: MeetingCapture[];
  closed: boolean;
  authorizationKey: string;
  isAuthorized: () => boolean;
}
export interface MeetingCapture {
  recording: MeetingRecording;
  path: string;
  bytes: number;
  closed: boolean;
}
const recordings = new Map<string, MeetingRecording>();
const detachedPaths = new Set<string>();
const prefixFor = (id: string) => `meeting_${id.length}_${id}_`;
const manifestFor = (directory: string, id: string) => path.join(directory, `${prefixFor(id)}segments.json`);
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SEGMENTS = 1024;
const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;

function saveManifestAtomically(manifest: string, contents: string): void {
  if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES) throw new Error('Meeting segment metadata is too large.');
  if (fs.existsSync(manifest) && !fs.lstatSync(manifest).isFile()) throw new Error('Invalid meeting manifest.');
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, manifest);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* Renamed or failed before creation. */ }
  }
}

export function normalizeMeetingId(value: unknown): string {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}
function loadRecording(directory: string, meetingId: string, authorizationKey: string, isAuthorized: () => boolean): MeetingRecording | null {
  if (!isAuthorized()) throw new Error('Meeting authorization changed.');
  const key = path.join(directory, meetingId);
  const existing = recordings.get(key);
  if (existing) {
    if (existing.authorizationKey !== authorizationKey || !existing.isAuthorized()) throw new Error('The original meeting authorization changed. Start a new meeting.');
    return existing;
  }
  const manifest = manifestFor(directory, meetingId);
  if (!fs.existsSync(manifest)) {
    // Unowned legacy/crash fragments must never acquire a new membership identity.
    if (fs.readdirSync(directory).some(name => name.startsWith(prefixFor(meetingId)) && name.endsWith('.pcm') && !detachedPaths.has(path.join(directory, name)))) {
      throw new Error('The original recording metadata is unavailable; keeping the live transcript.');
    }
    return null;
  }
  const manifestStat = fs.lstatSync(manifest);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('Invalid meeting manifest.');
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (data.authorizationKey !== authorizationKey || data.meetingId !== meetingId || !Array.isArray(data.segments)) throw new Error('The original meeting authorization changed. Start a new meeting.');
  const recording: MeetingRecording = { key, meetingId, authorizationKey, isAuthorized, startedAt: Number(data.startedAt) || Date.now(), segments: [], closed: false };
  if (data.segments.length > MAX_SEGMENTS || new Set(data.segments).size !== data.segments.length) throw new Error('Invalid meeting segment count.');
  let bytes = 0;
  for (const name of data.segments) {
    if (typeof name !== 'string' || path.basename(name) !== name || !name.startsWith(prefixFor(meetingId)) || !name.endsWith('.pcm')) throw new Error('Invalid meeting segment metadata.');
    const filePath = path.join(directory, name);
    const stat = fs.lstatSync(filePath);
    bytes += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || bytes > MAX_RECORDING_BYTES || detachedPaths.has(filePath)) throw new Error('A meeting segment is unavailable or too large.');
    recording.segments.push({ recording, path: filePath, bytes: stat.size, closed: true });
  }
  recordings.set(key, recording);
  return recording;
}
export function beginMeetingCapture(directory: string, meetingId: string, captureId: string, authorizationKey: string, isAuthorized: () => boolean): MeetingCapture {
  const key = path.join(directory, meetingId);
  const recording = loadRecording(directory, meetingId, authorizationKey, isAuthorized)
    || { key, meetingId, startedAt: Date.now(), segments: [], closed: false, authorizationKey, isAuthorized };
  const capture: MeetingCapture = {
    recording, path: path.join(directory, `${prefixFor(meetingId)}${randomUUID()}_${captureId}.pcm`), bytes: 0, closed: false,
  };
  if (recording.segments.length >= MAX_SEGMENTS) throw new Error('The meeting has too many recording segments.');
  fs.writeFileSync(capture.path, Buffer.alloc(0));
  recording.segments.push(capture);
  try {
    saveManifestAtomically(manifestFor(directory, meetingId), JSON.stringify({ meetingId, authorizationKey, startedAt: recording.startedAt, segments: recording.segments.map(segment => path.basename(segment.path)) }));
  } catch (error) {
    recording.segments.pop();
    try { fs.unlinkSync(capture.path); } catch { /* Preserve the prior manifest and segments. */ }
    throw error;
  }
  recordings.set(key, recording);
  return capture;
}
export function readMeetingPcm(recording: MeetingRecording): Buffer {
  let bytes = 0;
  for (const segment of recording.segments) {
    const stat = fs.lstatSync(segment.path);
    bytes += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || bytes > MAX_RECORDING_BYTES) throw new Error('Meeting recording is unavailable or exceeds the safe transcription size.');
  }
  return Buffer.concat(recording.segments.map(segment => fs.readFileSync(segment.path)));
}
export function appendMeetingAudio(capture: MeetingCapture, data: Buffer): void {
  if (capture.closed || capture.recording.closed || !capture.recording.isAuthorized()) return;
  fs.appendFileSync(capture.path, data);
  capture.bytes += data.length;
}
/** Detach before any await: a later capture can never be deleted by this stop. */
export function takeMeetingRecording(recording: MeetingRecording): MeetingRecording | null {
  if (recording.closed) return null;
  const directory = path.dirname(recording.key);
  const manifest = manifestFor(directory, recording.meetingId);
  if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
  recording.closed = true;
  for (const capture of recording.segments) { capture.closed = true; detachedPaths.add(capture.path); }
  if (recordings.get(recording.key) === recording) recordings.delete(recording.key);
  return recording;
}
export function findPausedMeetingRecording(directory: string, meetingId: string, authorizationKey?: string, isAuthorized?: () => boolean): MeetingRecording | null {
  const recording = authorizationKey && isAuthorized
    ? loadRecording(directory, meetingId, authorizationKey, isAuthorized) : recordings.get(path.join(directory, meetingId));
  return recording && recording.segments.every(segment => segment.closed) ? recording : null;
}
/** Drop only the cache on disconnect; the authorized manifest preserves paused work. */
export function releasePausedMeetingRecording(directory: string, meetingId: string): void {
  const record = recordings.get(path.join(directory, meetingId));
  if (record && record.segments.every(segment => segment.closed)) recordings.delete(record.key);
}
export function removeMeetingRecordingFiles(recording: MeetingRecording): void {
  for (const segment of recording.segments) {
    try { fs.unlinkSync(segment.path); } catch { /* Already removed; never touch a newer capture. */ }
    detachedPaths.delete(segment.path);
  }
}
