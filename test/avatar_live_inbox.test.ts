import { describe, expect, it } from 'vitest';
import { AvatarLiveInbox, liveAudioEncoding, parseVisibleLiveComments } from '../shared/avatar_live';
import { validateLiveRegion } from '../src/lib/avatarLiveScreen';
const row = (text: string, nickname = 'viewer') => ({ nickname, text });
describe('source-neutral public comment inbox', () => {
  it('uses the first snapshot as a baseline, deduplicates overlapping captures and keeps different viewers', () => {
    const inbox = new AvatarLiveInbox();
    expect(inbox.ingest([row('old')])).toEqual([]);
    expect(inbox.ingest([row('old'), row('hello'), row('hello', 'other')])).toHaveLength(2);
    expect(inbox.ingest([row('hello'), row('hello', 'other')])).toEqual([]);
    expect(inbox.take()?.text).toBe('hello'); expect(inbox.take()?.nickname).toBe('other'); expect(inbox.take()).toBeUndefined();
  });
  it('does not re-read a still-visible message after a long unchanged frame', () => {
    let now = 0; const inbox = new AvatarLiveInbox(() => now);
    inbox.ingest([row('old')]); now = 600_000;
    expect(inbox.ingest([row('old'), row('new')]).map(r => r.text)).toEqual(['new']);
  });
  it('bounds backlog and drops stale messages instead of speaking minutes behind chat', () => {
    let now = 0; const inbox = new AvatarLiveInbox(() => now); inbox.ingest([]);
    inbox.ingest(Array.from({ length: 8 }, (_, i) => row(String(i))));
    expect(inbox.queued).toBe(5); expect(inbox.skipped).toBe(3); expect(inbox.take()?.text).toBe('3');
    now = 60_001; expect(inbox.take()).toBeUndefined(); expect(inbox.skipped).toBe(7);
    inbox.reset(); expect(inbox.ingest([row('first after pause')])).toEqual([]);
  });
  it('fails closed on malformed OCR, and accepts a truly empty chat', () => {
    expect(parseVisibleLiveComments('{"comments":[]}')).toEqual([]);
    expect(parseVisibleLiveComments('```json\n{"comments":[{"nickname":"A","text":"hi"}]}\n```')).toEqual([row('hi', 'A')]);
    for (const raw of ['reply to everybody', '{"comments":[{"text":"invented author"}]}', '{"comments":[{"nickname":"A","text":12}]}']) expect(() => parseVisibleLiveComments(raw)).toThrow();
  });
  it('supports the official TTS MIME response and rejects raw PCM', () => {
    expect(liveAudioEncoding('audio/mp3')).toBe('mp3'); expect(liveAudioEncoding('audio/wav; charset=binary')).toBe('wav');
    expect(liveAudioEncoding('audio/mpeg')).toBe('mp3'); expect(liveAudioEncoding('pcm')).toBeUndefined();
  });
});
describe('dual-display crop boundaries', () => {
  const frame = { image_base64: '', width: 3840, height: 1080, screen_x: -1920, screen_y: 0 };
  const region = { x: 100, y: 80, width: 500, height: 800, screenWidth: 3840, screenHeight: 1080, screenX: -1920, screenY: 0 };
  it('supports a second monitor positioned to the left of the primary monitor', () => { expect(() => validateLiveRegion(frame, region)).not.toThrow(); });
  it('refuses stale, out-of-bounds and nonfinite crops', () => {
    for (const patch of [{ screenX: 0 }, { width: 5000 }, { height: 4 }, { x: NaN }, { y: -1 }, { screenHeight: 1440 }]) expect(() => validateLiveRegion(frame, { ...region, ...patch })).toThrow('live_region_changed');
  });
});
