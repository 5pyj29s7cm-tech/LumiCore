import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { getMemoryAvatar } from './store';
import type { getMemoryAvatarMediaFile } from './media';
import { captureMemoryAvatarAuthorization } from './lifecycle';
import { isStrictPrivacy } from '../config/privacy';
import { runtimeBackgroundWork, runtimeShutdownCancellation } from '../runtime/shutdown_work';
import { DidPortraitProvider, normalizePortraitApiKey, PortraitError, requirePortraitCloud, type PortraitOffer } from './portrait_provider';
import { PortraitRepository, type PortraitSessionRecord, type PortraitUserRecord } from './portrait_repository';
import { getAliyunAvatarSessions } from './aliyun_sessions';

type Scope = { userId: string; avatarId: string; callSessionId: string };
type Authorization = ReturnType<typeof captureMemoryAvatarAuthorization>;
type RuntimeSession = {
  userId: string; record: PortraitSessionRecord; authorization: Authorization;
  generation: number; key: string; controller: AbortController;
  release: () => void; timer?: ReturnType<typeof setTimeout>; creating?: Promise<any>; stopping?: Promise<void>;
};
export interface PortraitStreamView extends PortraitOffer {
  portraitSessionId: string; callSessionId: string; expiresAt: number;
}
export interface PortraitSpeechInput extends Scope {
  requestId: string; audioBuffer: Buffer; format: string; signal?: AbortSignal;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function validId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new PortraitError('portrait_request_invalid', `Invalid ${field}.`, 400);
  return value;
}

export class MemoryAvatarPortraitSessions {
  private readonly epoch = randomUUID();
  private readonly records = new Map<string, PortraitUserRecord>();
  private readonly active = new Map<string, RuntimeSession>();
  private readonly provider: DidPortraitProvider;
  private readonly repository: PortraitRepository;
  private readonly now: () => number;
  private readonly readyWaitMs: number;
  private readonly lifetimeMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly avatar: typeof getMemoryAvatar;
  private readonly authorize: typeof captureMemoryAvatarAuthorization;
  private readonly mediaFile?: typeof getMemoryAvatarMediaFile;
  constructor(options: {
    provider?: DidPortraitProvider; repository?: PortraitRepository; now?: () => number;
    readyWaitMs?: number; lifetimeMs?: number; cleanupTimeoutMs?: number; avatar?: typeof getMemoryAvatar;
    authorize?: typeof captureMemoryAvatarAuthorization; mediaFile?: typeof getMemoryAvatarMediaFile;
  } = {}) {
    this.provider = options.provider || new DidPortraitProvider(); this.repository = options.repository || new PortraitRepository();
    this.now = options.now || Date.now; this.readyWaitMs = options.readyWaitMs ?? 20_000; this.lifetimeMs = options.lifetimeMs ?? 300_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    this.avatar = options.avatar || getMemoryAvatar; this.authorize = options.authorize || captureMemoryAvatarAuthorization;
    this.mediaFile = options.mediaFile;
  }
  private user(userId: string): PortraitUserRecord {
    if (!userId) throw new PortraitError('portrait_scope_invalid', 'A personal user session is required.', 403);
    let user = this.records.get(userId);
    if (!user) {
      user = this.repository.read(userId); this.records.set(userId, user);
      // A WebRTC peer cannot survive a backend restart. Recover only cleanup of
      // recorded resources; never recreate an agent/stream or replay speech.
      if (!isStrictPrivacy()) for (const record of user.sessions) {
        if (record.epoch === this.epoch || (!record.agentId && !record.imageId && !record.audioIds.length && !record.stream)) continue;
        if (['creating', 'offered', 'ready'].includes(record.status)) record.status = 'unknown';
        void runtimeBackgroundWork.track(this.stopById({ userId, avatarId: record.avatarId, callSessionId: record.callSessionId }, record.id)).catch(() => {});
      }
    }
    return user;
  }
  private save(userId: string): void { this.repository.write(userId, this.user(userId)); }
  config(userId: string) {
    const config = this.user(userId).config;
    return { provider: 'did' as const, configured: Boolean(config.apiKey), cloudAllowed: !isStrictPrivacy(), consented: config.consent,
      available: Boolean(config.apiKey && config.consent && !isStrictPrivacy()),
      cleanupPending: this.user(userId).sessions.some(record => record.errorCode === 'portrait_cleanup_pending') };
  }
  async configure(userId: string, input: { apiKey?: unknown; clearKey?: unknown; cloudConsent?: unknown }) {
    const user = this.user(userId);
    if (input.clearKey !== true) {
      requirePortraitCloud();
      if (input.cloudConsent !== true) throw new PortraitError('portrait_consent_required', 'Explicit consent is required to send this person’s portrait and generated speech to D-ID.', 400);
    }
    const key = input.clearKey === true ? undefined : input.apiKey === undefined ? user.config.apiKey : normalizePortraitApiKey(input.apiKey);
    // Revoke in-memory admission before waiting on deletion. The old credentials
    // remain captured only by cleanup; they cannot authorize new speech.
    const previous = user.config;
    user.config = { apiKey: key, consent: input.clearKey !== true && input.cloudConsent === true, generation: previous.generation + 1 };
    try { this.save(userId); } catch (error) { user.config = previous; throw error; }
    await Promise.allSettled([...this.active.values()].filter(item => item.userId === userId).map(item => this.stopRecord(item)));
    return this.config(userId);
  }
  private selected(userId: string, avatarId: string): string {
    const avatar = this.avatar(userId, avatarId);
    if (!avatar || avatar.status !== 'active') throw new PortraitError('portrait_person_not_found', 'Memory person not found.', 404);
    if (avatar.presentation?.mode !== 'portrait' || !avatar.presentation.mediaId) throw new PortraitError('portrait_source_required', 'Select an uploaded photo or video for this person’s portrait.', 409);
    return avatar.presentation.mediaId;
  }
  private assertCurrent(runtime: RuntimeSession): void {
    requirePortraitCloud(); runtime.controller.signal.throwIfAborted(); runtime.authorization.assertCurrent();
    if (this.user(runtime.userId).config.generation !== runtime.generation
        || this.selected(runtime.userId, runtime.record.avatarId) !== runtime.record.mediaId
        || runtime.record.stopRequested || runtime.record.expiresAt <= this.now()) {
      throw new PortraitError('portrait_session_expired', 'The portrait session is no longer active.', 409);
    }
  }
  private view(runtime: RuntimeSession): PortraitStreamView {
    this.assertCurrent(runtime);
    const record = runtime.record;
    if (!record.stream || !['offered', 'ready'].includes(record.status)) throw new PortraitError('portrait_session_unavailable', 'The live portrait is not available. Start a new call.', 409);
    return { portraitSessionId: record.id, callSessionId: record.callSessionId, expiresAt: record.expiresAt, offer: record.stream.offer, iceServers: record.stream.iceServers };
  }
  private runtime(scope: Scope, id: string): RuntimeSession {
    const runtime = this.active.get(id);
    if (!runtime || runtime.userId !== scope.userId || runtime.record.avatarId !== scope.avatarId || runtime.record.callSessionId !== scope.callSessionId) throw new PortraitError('portrait_session_not_found', 'Portrait session not found.', 404);
    return runtime;
  }
  private step(runtime: RuntimeSession, name: string): void { this.assertCurrent(runtime); runtime.record.step = name; this.save(runtime.userId); }

  create(scope: Scope & { clientRequestId: string; cloudConsent: boolean }): Promise<PortraitStreamView> {
    try {
      requirePortraitCloud(); validId(scope.callSessionId, 'callSessionId'); validId(scope.clientRequestId, 'clientRequestId');
      if (scope.cloudConsent !== true) throw new PortraitError('portrait_consent_required', 'Confirm cloud portrait rendering for this call.', 400);
      const mediaId = this.selected(scope.userId, scope.avatarId); const user = this.user(scope.userId);
      if (!user.config.apiKey || !user.config.consent) throw new PortraitError('portrait_not_configured', 'Configure a D-ID account and allow cloud portrait rendering first.', 409);
      const prior = user.sessions.find(item => item.clientRequestId === scope.clientRequestId);
      if (prior) {
        if (prior.avatarId !== scope.avatarId || prior.callSessionId !== scope.callSessionId || prior.mediaId !== mediaId) throw new PortraitError('portrait_request_conflict', 'The portrait request identifier belongs to a different input.', 409);
        const running = this.active.get(prior.id);
        if (running && !prior.stopRequested) return running.creating || Promise.resolve(this.view(running));
        throw new PortraitError('portrait_request_ended', 'This portrait request has ended or its outcome is unknown. It will not be created again.', 409, prior.status === 'unknown' || prior.status === 'creating');
      }
      if (user.sessions.some(item => item.avatarId === scope.avatarId && !item.stopRequested && item.expiresAt > this.now() && ['creating', 'offered', 'ready', 'unknown'].includes(item.status))) {
        throw new PortraitError('portrait_session_busy', 'Close the previous portrait call before starting another.', 409);
      }
      // Bounded recovery tombstones. A request older than two days is not a live
      // stream; clients must generate fresh request IDs for new calls.
      user.sessions = user.sessions.filter(item => item.createdAt > this.now() - 48 * 60 * 60 * 1000 || item.expiresAt > this.now() || item.agentId || item.imageId || item.audioIds.length || item.stream);
      if (user.sessions.length >= 500) throw new PortraitError('portrait_session_limit', 'The portrait recovery log is full. Try again later.', 429);
      const record: PortraitSessionRecord = { id: randomUUID(), avatarId: scope.avatarId, callSessionId: scope.callSessionId,
        clientRequestId: scope.clientRequestId, mediaId, createdAt: this.now(), expiresAt: this.now() + this.lifetimeMs, epoch: this.epoch,
        status: 'creating', credential: user.config.apiKey, audioIds: [], speeches: {} };
      user.sessions.push(record); this.save(scope.userId); // Durable reservation before any upload or paid request.
      const controller = new AbortController(); const authorization = this.authorize(scope.userId, scope.avatarId);
      const releases = [authorization.watch(controller), runtimeShutdownCancellation.register(controller)];
      const runtime: RuntimeSession = { userId: scope.userId, record, authorization, controller, key: user.config.apiKey,
        generation: user.config.generation, release: () => releases.forEach(release => release()) };
      this.active.set(record.id, runtime);
      controller.signal.addEventListener('abort', () => { void runtimeBackgroundWork.track(this.stopRecord(runtime)).catch(() => {}); }, { once: true });
      runtime.timer = setTimeout(() => { void runtimeBackgroundWork.track(this.stopRecord(runtime)).catch(() => {}); }, this.lifetimeMs);
      runtime.timer.unref?.();
      runtime.creating = runtimeBackgroundWork.track(this.runCreate(runtime));
      return runtime.creating;
    } catch (error) { return Promise.reject(error); }
  }
  private async runCreate(runtime: RuntimeSession): Promise<PortraitStreamView> {
    const record = runtime.record;
    try {
      this.assertCurrent(runtime);
      const mediaFile = this.mediaFile || (await import('./media')).getMemoryAvatarMediaFile;
      this.assertCurrent(runtime);
      const original = mediaFile(runtime.userId, record.avatarId, record.mediaId);
      if (!['image', 'video'].includes(original.media.kind)) throw new PortraitError('portrait_source_invalid', 'Choose a photo or video, not an audio recording.', 400);
      const source = mediaFile(runtime.userId, record.avatarId, record.mediaId, original.media.kind === 'video' ? 'poster' : 'thumbnail');
      if (source.sizeBytes > 10 * 1024 * 1024) throw new PortraitError('portrait_source_invalid', 'The portrait preview is too large.', 400);
      const bytes = await fs.readFile(source.path); this.assertCurrent(runtime);
      this.step(runtime, 'upload_image');
      const image = await this.provider.uploadImage(runtime.key, bytes, source.mimeType, runtime.controller.signal);
      record.imageId = image.id;
      if (!image.id) record.unlocatedUploads = (record.unlocatedUploads || 0) + 1;
      record.credential = runtime.key; this.save(runtime.userId); this.assertCurrent(runtime);
      this.step(runtime, 'create_agent');
      record.agentId = await this.provider.createAgent(runtime.key, image.url, runtime.controller.signal);
      record.credential = runtime.key;
      this.save(runtime.userId); this.assertCurrent(runtime);
      this.step(runtime, 'create_stream');
      const agentId = record.agentId;
      record.stream = await this.provider.createStream(runtime.key, agentId, runtime.controller.signal);
      // Cancellation may already have deleted/cleared the agent while an
      // accepted stream response was in flight. Keep its parent for exact DELETE.
      record.agentId = agentId; record.credential = runtime.key;
      this.save(runtime.userId); this.assertCurrent(runtime);
      record.status = 'offered'; this.save(runtime.userId); return this.view(runtime);
    } catch (error) {
      if (error instanceof PortraitError && error.outcomeUnknown) {
        if (record.step === 'upload_image' && !record.imageId) record.unlocatedUploads = (record.unlocatedUploads || 0) + 1;
        if (record.step === 'create_agent' && !record.agentId) record.unlocatedCreation = 'agent';
        if (record.step === 'create_stream' && !record.stream) record.unlocatedCreation = 'stream';
      }
      record.status = error instanceof PortraitError && error.outcomeUnknown || record.step && (error as any)?.code === 'portrait_save_failed' ? 'unknown' : 'failed';
      record.errorCode = error instanceof PortraitError ? error.code : 'portrait_cancelled';
      try { this.save(runtime.userId); } catch { /* The earlier started barrier still forbids replay after reopening. */ }
      // A stop may have finished its resource scan while this request was still
      // returning an accepted ID. Join that cleanup, then collect late resources.
      await this.stopRecord(runtime).catch(() => {});
      await this.stopRecord(runtime).catch(() => {});
      throw error;
    }
  }
  async answer(scope: Scope, id: string, answer: { type: 'answer'; sdp: string }) {
    if (!answer || answer.type !== 'answer' || typeof answer.sdp !== 'string' || !answer.sdp.startsWith('v=0') || answer.sdp.length > 256_000) throw new PortraitError('portrait_answer_invalid', 'Invalid WebRTC answer.', 400);
    const runtime = this.runtime(scope, id); this.assertCurrent(runtime); const hash = digest(answer.sdp);
    if (runtime.record.answerHash) {
      if (runtime.record.answerHash === hash && runtime.record.status === 'ready') return { ok: true };
      throw new PortraitError('portrait_answer_conflict', 'The WebRTC answer was already submitted.', 409);
    }
    if (!runtime.record.stream || runtime.record.status !== 'offered') throw new PortraitError('portrait_session_unavailable', 'The portrait offer is unavailable.', 409);
    runtime.record.answerHash = hash; this.step(runtime, 'answer');
    try {
      await this.provider.answer(runtime.key, runtime.record.agentId!, runtime.record.stream, answer, runtime.controller.signal);
      this.assertCurrent(runtime); runtime.record.status = 'ready'; this.save(scope.userId); return { ok: true };
    } catch (error) { await this.stopRecord(runtime).catch(() => {}); throw error; }
  }
  async ice(scope: Scope, id: string, candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null) {
    const runtime = this.runtime(scope, id); this.assertCurrent(runtime);
    if (candidate !== null && (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 8192
        || (candidate.sdpMid !== null && candidate.sdpMid !== undefined && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 256))
        || (candidate.sdpMLineIndex !== null && candidate.sdpMLineIndex !== undefined && (!Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0)))) throw new PortraitError('portrait_ice_invalid', 'Invalid ICE candidate.', 400);
    if (!runtime.record.stream) throw new PortraitError('portrait_session_unavailable', 'The portrait offer is unavailable.', 409);
    const projected = candidate ? { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? '0', sdpMLineIndex: candidate.sdpMLineIndex ?? 0 } : null;
    await this.provider.ice(runtime.key, runtime.record.agentId!, runtime.record.stream, projected, runtime.controller.signal);
    this.assertCurrent(runtime); return { ok: true };
  }
  ready(scope: Scope): boolean {
    return [...this.active.values()].some(runtime => {
      if (runtime.userId !== scope.userId || runtime.record.avatarId !== scope.avatarId || runtime.record.callSessionId !== scope.callSessionId || runtime.record.status !== 'ready') return false;
      try { this.assertCurrent(runtime); return true; } catch { return false; }
    });
  }
  private async waitForReady(scope: Scope, signal?: AbortSignal): Promise<RuntimeSession> {
    const deadline = Date.now() + this.readyWaitMs;
    while (true) {
      signal?.throwIfAborted(); requirePortraitCloud(); this.selected(scope.userId, scope.avatarId);
      const runtime = [...this.active.values()].find(item => item.userId === scope.userId && item.record.avatarId === scope.avatarId && item.record.callSessionId === scope.callSessionId && item.record.status === 'ready' && !item.record.stopRequested);
      if (runtime) { this.assertCurrent(runtime); return runtime; }
      if (Date.now() >= deadline) throw new PortraitError('portrait_not_ready', 'The live portrait did not become ready in time. The text reply is retained.', 409);
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, 25);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason || new DOMException('Cancelled.', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  async speak(input: PortraitSpeechInput): Promise<{ status: 'accepted'; portraitSessionId: string; requestId: string }> {
    validId(input.requestId, 'requestId'); input.signal?.throwIfAborted();
    const runtime = await this.waitForReady(input, input.signal); const record = runtime.record;
    const hash = digest(Buffer.concat([Buffer.from(input.format), input.audioBuffer]));
    const previous = this.user(input.userId).sessions.filter(item => item.avatarId === input.avatarId && item.callSessionId === input.callSessionId).find(item => Object.hasOwn(item.speeches, input.requestId));
    if (previous) {
      const speech = previous.speeches[input.requestId];
      if (speech.hash === hash && speech.status === 'accepted' && previous.id === record.id) return { status: 'accepted', portraitSessionId: record.id, requestId: input.requestId };
      throw new PortraitError('portrait_speech_not_replayed', 'This reply was already submitted or has an unknown result. It will not be rendered twice.', 409, speech.status === 'unknown' || speech.status === 'started');
    }
    if (Object.keys(record.speeches).length >= 200) throw new PortraitError('portrait_reply_limit', 'Start a new call to continue.', 409);
    const onAbort = () => { void runtimeBackgroundWork.track(this.stopRecord(runtime)).catch(() => {}); };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const speech = { hash, status: 'started' as 'started' | 'accepted' | 'unknown' | 'failed' };
    Object.defineProperty(record.speeches, input.requestId, { value: speech, writable: true, enumerable: true, configurable: true });
    try {
      input.signal?.throwIfAborted(); this.step(runtime, 'upload_audio');
      const audio = await this.provider.uploadAudio(runtime.key, input.audioBuffer, input.format, runtime.controller.signal);
      if (audio.id) record.audioIds.push(audio.id);
      else record.unlocatedUploads = (record.unlocatedUploads || 0) + 1;
      record.credential = runtime.key;
      this.save(input.userId); this.assertCurrent(runtime); input.signal?.throwIfAborted();
      this.step(runtime, 'speak');
      await this.provider.speak(runtime.key, record.agentId!, record.stream!, audio.url, runtime.controller.signal);
      this.assertCurrent(runtime); input.signal?.throwIfAborted(); speech.status = 'accepted'; this.save(input.userId);
      return { status: 'accepted', portraitSessionId: record.id, requestId: input.requestId };
    } catch (error) {
      if (error instanceof PortraitError && error.outcomeUnknown && record.step === 'upload_audio') {
        record.unlocatedUploads = (record.unlocatedUploads || 0) + 1;
      }
      speech.status = error instanceof PortraitError && !error.outcomeUnknown && error.code !== 'portrait_save_failed' ? 'failed' : 'unknown';
      try { this.save(input.userId); } catch { /* Started is already durable before any upload. */ }
      await this.stopRecord(runtime).catch(() => {});
      await this.stopRecord(runtime).catch(() => {}); throw error;
    } finally { input.signal?.removeEventListener('abort', onAbort); }
  }
  private stopRecord(runtime: RuntimeSession): Promise<void> {
    runtime.record.stopRequested = true;
    if (runtime.record.status !== 'unknown' && runtime.record.status !== 'failed') runtime.record.status = 'stopped';
    // Capture this record before network I/O; an interrupt may already be
    // establishing a replacement stream for the same callSessionId.
    if (runtime.stopping) return runtime.stopping;
    const work = Promise.resolve().then(async () => {
      let failed = false;
      try { this.save(runtime.userId); } catch { failed = true; }
      const record = runtime.record;
      const cleanup = new AbortController();
      const deadline = setTimeout(() => cleanup.abort(new Error('Portrait cleanup deadline exceeded.')), this.cleanupTimeoutMs);
      deadline.unref?.();
      try {
        if (record.stream && record.agentId) {
          try { await this.provider.deleteStream(runtime.key, record.agentId, record.stream, cleanup.signal); record.stream = undefined; } catch { failed = true; }
        }
        // Keep the parent ID when exact stream deletion is still unknown so a
        // later retry can address the same stream, even after a process restart.
        if (record.agentId && !record.stream) {
          try { await this.provider.deleteAgent(runtime.key, record.agentId, cleanup.signal); record.agentId = undefined; } catch { failed = true; }
        }
        const uploads = [...record.audioIds];
        await Promise.all(Array.from({ length: Math.min(4, uploads.length) }, async () => {
          while (uploads.length) {
            const id = uploads.shift()!;
            try { await this.provider.deleteUpload(runtime.key, 'audios', id, cleanup.signal); record.audioIds = record.audioIds.filter(value => value !== id); } catch { failed = true; }
          }
        }));
        if (record.imageId) {
          try { await this.provider.deleteUpload(runtime.key, 'images', record.imageId, cleanup.signal); record.imageId = undefined; } catch { failed = true; }
        }
      } finally { clearTimeout(deadline); }
      if (record.unlocatedUploads || record.unlocatedCreation) failed = true;
      if (failed) record.errorCode = 'portrait_cleanup_pending';
      else if (record.errorCode === 'portrait_cleanup_pending') record.errorCode = undefined;
      if (!failed && !record.agentId && !record.imageId && !record.audioIds.length && !record.stream) record.credential = undefined;
      this.save(runtime.userId);
      if (failed) throw new PortraitError('portrait_cleanup_pending', record.unlocatedCreation
        ? 'Local playback is stopped, but D-ID did not return an identifier for a possibly accepted creation. Its remote cleanup cannot be confirmed; check the D-ID account before retrying.'
        : record.unlocatedUploads
        ? 'Local playback is stopped. D-ID did not return deletion IDs for some temporary uploads; their deletion cannot be confirmed. D-ID documents temporary storage for 24–48 hours.'
        : 'Local playback is stopped; remote cleanup could not be fully confirmed. It can be retried.', 503, true);
    });
    runtime.stopping = work.finally(() => {
      runtime.stopping = undefined;
      if (this.active.get(runtime.record.id) === runtime) this.active.delete(runtime.record.id);
    });
    runtime.controller.abort(new DOMException('Portrait session stopped.', 'AbortError'));
    clearTimeout(runtime.timer); runtime.release();
    return runtime.stopping;
  }
  stop(scope: Scope): Promise<void> {
    const selected = [...this.active.values()].filter(item => item.userId === scope.userId && item.record.avatarId === scope.avatarId && item.record.callSessionId === scope.callSessionId && !item.record.stopRequested);
    return Promise.all(selected.map(runtime => this.stopRecord(runtime))).then(() => {});
  }
  async stopById(scope: Scope, id: string, byRequest = false): Promise<void> {
    const user = this.user(scope.userId);
    const record = user.sessions.find(item => item.avatarId === scope.avatarId && item.callSessionId === scope.callSessionId && (byRequest ? item.clientRequestId === id : item.id === id));
    if (!record) {
      if (!byRequest) throw new PortraitError('portrait_session_not_found', 'Portrait session not found.', 404);
      validId(id, 'clientRequestId'); validId(scope.callSessionId, 'callSessionId');
      // Cancel-before-create is an owner-scoped durable tombstone.
      user.sessions.push({ id: randomUUID(), avatarId: scope.avatarId, callSessionId: scope.callSessionId, clientRequestId: id,
        mediaId: this.selected(scope.userId, scope.avatarId), createdAt: this.now(), expiresAt: this.now(), epoch: this.epoch,
        status: 'stopped', stopRequested: true, audioIds: [], speeches: {} });
      this.save(scope.userId); return;
    }
    const runtime = this.active.get(record.id);
    if (runtime) return this.stopRecord(runtime);
    record.stopRequested = true; this.save(scope.userId);
    // After process restart, never resume creation/speech. Only delete known
    // provider resources using the same owner's configured credential.
    const controller = new AbortController();
    const recovery: RuntimeSession = { userId: scope.userId, record, controller, key: record.credential || user.config.apiKey || '',
      generation: user.config.generation, authorization: this.authorize(scope.userId, scope.avatarId), release: () => {} };
    this.active.set(record.id, recovery);
    return this.stopRecord(recovery);
  }
}

let singleton: MemoryAvatarPortraitSessions | undefined;
export function getMemoryAvatarPortraitSessions(): MemoryAvatarPortraitSessions { return singleton ??= new MemoryAvatarPortraitSessions(); }
export function speakMemoryAvatarPortrait(input: PortraitSpeechInput) {
  return runtimeBackgroundWork.track(Promise.resolve().then(() => getAliyunAvatarSessions().selected(input.userId, input.avatarId)
    ? getAliyunAvatarSessions().speak(input) : getMemoryAvatarPortraitSessions().speak(input)));
}
export function isMemoryAvatarPortraitReady(scope: Scope): boolean {
  return getAliyunAvatarSessions().selected(scope.userId, scope.avatarId) ? getAliyunAvatarSessions().ready(scope) : getMemoryAvatarPortraitSessions().ready(scope);
}
export function stopMemoryAvatarPortrait(scope: Scope): Promise<void>;
export function stopMemoryAvatarPortrait(userId: string, avatarId: string, callSessionId: string): Promise<void>;
export function stopMemoryAvatarPortrait(scopeOrUser: Scope | string, avatarId?: string, callSessionId?: string): Promise<void> {
  const scope = typeof scopeOrUser === 'string' ? { userId: scopeOrUser, avatarId: avatarId!, callSessionId: callSessionId! } : scopeOrUser;
  return runtimeBackgroundWork.track(Promise.all([getMemoryAvatarPortraitSessions().stop(scope), getAliyunAvatarSessions().stop(scope)]).then(() => {}));
}
