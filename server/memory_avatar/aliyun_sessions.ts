import { createHash, randomUUID } from 'node:crypto';
import { getDataPath } from '../config/data_path';
import { isStrictPrivacy } from '../config/privacy';
import { runtimeBackgroundWork, runtimeShutdownCancellation } from '../runtime/shutdown_work';
import { captureMemoryAvatarAuthorization } from './lifecycle';
import { getMemoryAvatar } from './store';
import { PortraitError, requirePortraitCloud } from './portrait_provider';
import { PortraitRepository } from './portrait_repository';
import { AliyunCreateError, AliyunPortraitProvider, type AliyunCredential } from './aliyun_provider';
import type { AliyunAvatarConfig, AliyunAvatarOffer } from '../../shared/aliyun_avatar';
import type { PortraitSpeechInput } from './portrait_sessions';
import { liveAudioEncoding } from '../../shared/avatar_live';

type Scope = { userId: string; avatarId: string; callSessionId: string };
type Binding = { enabled: boolean; projectId: string; instanceId: string };
type Session = Scope & { id: string; requestId: string; instanceId: string; createdAt: number; expiresAt: number;
  status: 'creating' | 'offered' | 'ready' | 'unknown' | 'stopped' | 'failed'; stopRequested?: boolean;
  credential?: AliyunCredential; remoteId?: string; speeches: string[] };
export type AliyunAvatarRecord = { version: 1; config: { credential?: AliyunCredential; bindings: Record<string, Binding> }; sessions: Session[] };
export const emptyAliyunAvatarRecord = (): AliyunAvatarRecord => ({ version: 1, config: { bindings: {} }, sessions: [] });
type Runtime = { record: Session; authorization: ReturnType<typeof captureMemoryAvatarAuthorization>; controller: AbortController;
  release: () => void; timer?: ReturnType<typeof setTimeout>; creating?: Promise<AliyunAvatarOffer>; stopping?: Promise<void> };
const validId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new PortraitError('portrait_request_invalid', 'Invalid digital human identifier.', 400);
  return value;
};

/** Aliyun only renders Lumi's speech. It never receives private memory or microphone input. */
export class AliyunAvatarSessions {
  private records = new Map<string, AliyunAvatarRecord>();
  private active = new Map<string, Runtime>();
  constructor(private options: { repository?: Pick<PortraitRepository<AliyunAvatarRecord>, 'read' | 'write'>;
    provider?: AliyunPortraitProvider; avatar?: typeof getMemoryAvatar; authorize?: typeof captureMemoryAvatarAuthorization;
    lifetimeMs?: number } = {}) {}
  private repository = this.options.repository || new PortraitRepository<AliyunAvatarRecord>({ directory: getDataPath('memory-avatar-aliyun'), initial: emptyAliyunAvatarRecord });
  private provider = this.options.provider || new AliyunPortraitProvider();
  private user(userId: string) {
    if (!userId) throw new PortraitError('portrait_scope_invalid', 'A personal session is required.', 403);
    let record = this.records.get(userId);
    if (!record) {
      record = this.repository.read(userId); this.records.set(userId, record);
      // Process restarts invalidate RTC clients; only clean up recorded sessions, never recreate them.
      for (const session of record.sessions) if (['creating', 'offered', 'ready'].includes(session.status)) session.status = 'unknown';
      if (!isStrictPrivacy()) for (const session of record.sessions.filter(item => item.remoteId && item.status !== 'stopped')) {
        void runtimeBackgroundWork.track(this.stopByRequest(session, session.requestId)).catch(() => {});
      }
    }
    return record;
  }
  private save(userId: string) { this.repository.write(userId, this.user(userId)); }
  private person(userId: string, avatarId: string) {
    const avatar = (this.options.avatar || getMemoryAvatar)(userId, avatarId);
    if (!avatar || avatar.status !== 'active') throw new PortraitError('portrait_person_not_found', 'Memory person not found.', 404);
  }
  selected(userId: string, avatarId: string): boolean { return Boolean(this.user(userId).config.bindings[avatarId]?.enabled); }
  config(userId: string, avatarId: string): AliyunAvatarConfig {
    this.person(userId, avatarId);
    const user = this.user(userId), binding = user.config.bindings[avatarId];
    const configured = Boolean(user.config.credential), enabled = Boolean(binding?.enabled), cloudAllowed = !isStrictPrivacy();
    return { provider: 'aliyun', configured, enabled, cloudAllowed, available: configured && enabled && cloudAllowed,
      projectId: binding?.projectId || '', instanceId: binding?.instanceId || '',
      cleanupPending: user.sessions.some(item => item.avatarId === avatarId && item.status === 'unknown') };
  }
  async configure(userId: string, avatarId: string, input: any) {
    this.person(userId, avatarId); const user = this.user(userId);
    if (typeof input.enabled !== 'boolean') throw new PortraitError('portrait_request_invalid', 'Choose whether Aliyun is enabled.', 400);
    let credential = user.config.credential;
    if (input.clearKey === true) credential = undefined;
    else if (input.accessKeyId !== undefined || input.accessKeySecret !== undefined) {
      const accessKeyId = String(input.accessKeyId || '').trim(), accessKeySecret = String(input.accessKeySecret || '').trim();
      if (!/^[A-Za-z0-9]{8,128}$/.test(accessKeyId) || !/^[A-Za-z0-9+/=_-]{8,256}$/.test(accessKeySecret)) throw new PortraitError('portrait_request_invalid', 'Both Aliyun AccessKey fields are required.', 400);
      credential = { accessKeyId, accessKeySecret };
    }
    if (input.enabled) {
      requirePortraitCloud();
      if (input.cloudConsent !== true || !credential) throw new PortraitError('portrait_consent_required', 'Configure credentials and confirm Aliyun cloud rendering.', 400);
    }
    const previous = user.config;
    const old = previous.bindings[avatarId];
    const binding = { enabled: input.enabled && !!credential,
      projectId: input.enabled ? validId(input.projectId) : old?.projectId || '',
      instanceId: input.enabled ? validId(input.instanceId) : old?.instanceId || '' };
    user.config = { credential, bindings: { ...previous.bindings, [avatarId]: binding } };
    if (!credential) for (const id of Object.keys(user.config.bindings)) user.config.bindings[id] = { ...user.config.bindings[id], enabled: false };
    try { this.save(userId); } catch (error) { user.config = previous; throw error; }
    // Updating credentials affects all this owner's connections. Cleanup keeps captured old keys.
    await Promise.allSettled([...this.active.values()].filter(item => item.record.userId === userId).map(item => this.stopByRequest(item.record, item.record.requestId)));
    return this.config(userId, avatarId);
  }
  async create(scope: Scope, requestId: string, consent: boolean): Promise<AliyunAvatarOffer> {
    requirePortraitCloud(); this.person(scope.userId, scope.avatarId); validId(scope.callSessionId); validId(requestId);
    const user = this.user(scope.userId), binding = user.config.bindings[scope.avatarId];
    if (!consent || !binding?.enabled || !user.config.credential) throw new PortraitError('portrait_not_configured', 'Configure and enable Aliyun for this person first.', 409);
    if (user.sessions.some(item => item.requestId === requestId)) throw new PortraitError('portrait_request_ended', 'This creation request has already been used. It will not be replayed.', 409);
    if (user.sessions.some(item => item.instanceId === binding.instanceId && !['stopped', 'failed'].includes(item.status))) throw new PortraitError('aliyun_cleanup_pending', 'Close or check the previous Aliyun session before starting another.', 409);
    user.sessions = user.sessions.filter(item => !['stopped', 'failed'].includes(item.status) || item.createdAt > Date.now() - 172800000);
    if (user.sessions.length >= 500) throw new PortraitError('portrait_session_limit', 'The session recovery log is full.', 429);
    const record: Session = { ...scope, id: randomUUID(), requestId, instanceId: binding.instanceId, credential: { ...user.config.credential },
      createdAt: Date.now(), expiresAt: Date.now() + (this.options.lifetimeMs || 300_000), status: 'creating', speeches: [] };
    user.sessions.push(record);
    try { this.save(scope.userId); } catch (error) { record.status = 'failed'; throw error; }
    const controller = new AbortController(), authorization = (this.options.authorize || captureMemoryAvatarAuthorization)(scope.userId, scope.avatarId);
    const releases = [authorization.watch(controller), runtimeShutdownCancellation.register(controller)];
    const runtime: Runtime = { record, controller, authorization, release: () => releases.forEach(release => release()) };
    this.active.set(record.id, runtime);
    controller.signal.addEventListener('abort', () => { void runtimeBackgroundWork.track(this.stopByRequest(record, requestId)).catch(() => {}); }, { once: true });
    runtime.timer = setTimeout(() => { void runtimeBackgroundWork.track(this.stopByRequest(record, requestId)).catch(() => {}); }, record.expiresAt - Date.now()); runtime.timer.unref?.();
    runtime.creating = (async () => {
      try {
        authorization.assertCurrent(); controller.signal.throwIfAborted(); requirePortraitCloud();
        const result = await this.provider.create(record.credential!, binding.projectId, binding.instanceId);
        record.remoteId = result.sessionId; this.save(scope.userId);
        authorization.assertCurrent(); controller.signal.throwIfAborted(); requirePortraitCloud();
        if (record.stopRequested) throw new DOMException('Stopped', 'AbortError');
        record.status = 'offered'; this.save(scope.userId);
        return { provider: 'aliyun' as const, portraitSessionId: record.id, callSessionId: scope.callSessionId,
          sessionId: result.sessionId, rtc: result.rtc, expiresAt: record.expiresAt };
      } catch (error) {
        if (error instanceof AliyunCreateError && error.remoteId) record.remoteId = error.remoteId;
        record.status = record.remoteId || (error instanceof PortraitError && error.outcomeUnknown) ? 'unknown' : 'failed';
        try { this.save(scope.userId); } catch { /* The durable creation barrier remains. */ }
        queueMicrotask(() => { void runtimeBackgroundWork.track(this.stopByRequest(record, requestId)).catch(() => {}); });
        throw error;
      }
    })();
    return runtime.creating;
  }
  private find(scope: Scope) {
    return [...this.active.values()].find(item => item.record.userId === scope.userId && item.record.avatarId === scope.avatarId
      && item.record.callSessionId === scope.callSessionId && !item.record.stopRequested);
  }
  ready(scope: Scope): boolean {
    const runtime = this.find(scope);
    return Boolean(runtime && runtime.record.status === 'ready' && runtime.record.expiresAt > Date.now()
      && !runtime.controller.signal.aborted && runtime.authorization.isCurrent() && !isStrictPrivacy());
  }
  markReady(scope: Scope, id: string) {
    const runtime = this.find(scope); requirePortraitCloud();
    if (!runtime || runtime.record.id !== id || runtime.record.expiresAt <= Date.now() || runtime.controller.signal.aborted) throw new PortraitError('portrait_session_not_found', 'Session not found.', 404);
    runtime.authorization.assertCurrent();
    if (runtime.record.status !== 'offered') throw new PortraitError('portrait_session_unavailable', 'Session is not awaiting a renderer.', 409);
    runtime.record.status = 'ready'; this.save(scope.userId); return this.heartbeat(scope, id);
  }
  heartbeat(scope: Scope, id: string) {
    const runtime = this.find(scope);
    if (!runtime || runtime.record.id !== id || !this.ready(scope)) throw new PortraitError('portrait_session_unavailable', 'The Aliyun session expired.', 409);
    runtime.record.expiresAt = Date.now() + 90_000; this.save(scope.userId);
    clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => { void runtimeBackgroundWork.track(this.stopByRequest(runtime.record, runtime.record.requestId)).catch(() => {}); }, 90_000);
    runtime.timer.unref?.(); return { ok: true };
  }
  speak(input: PortraitSpeechInput) {
    requirePortraitCloud(); input.signal?.throwIfAborted(); validId(input.requestId);
    if (!this.ready(input)) throw new PortraitError('portrait_session_unavailable', 'Aliyun renderer is not ready.', 409);
    if (!liveAudioEncoding(input.format) || !input.audioBuffer.length || input.audioBuffer.length > 6_000_000) throw new PortraitError('portrait_request_invalid', 'Unsupported audio.', 400);
    const runtime = this.find(input)!;
    const digest = createHash('sha256').update(input.requestId).digest('hex');
    if (runtime.record.speeches.includes(digest)) throw new PortraitError('portrait_request_ended', 'Speech was already handed to the renderer; it will not be replayed.', 409);
    if (runtime.record.speeches.length >= 200) throw new PortraitError('portrait_session_limit', 'Start a new call.', 429);
    runtime.record.speeches.push(digest); this.save(input.userId);
    return { ok: true as const, status: 'accepted' as const, portraitSessionId: runtime.record.id, requestId: input.requestId, browserAudio: true as const };
  }
  async retryCleanup(userId: string, avatarId: string) {
    this.person(userId, avatarId);
    await Promise.allSettled(this.user(userId).sessions.filter(item => item.avatarId === avatarId && item.status === 'unknown')
      .map(item => this.stopByRequest(item, item.requestId)));
    return this.config(userId, avatarId);
  }
  async stop(scope: Scope) {
    await Promise.all([...this.active.values()].filter(item => item.record.userId === scope.userId && item.record.avatarId === scope.avatarId && item.record.callSessionId === scope.callSessionId)
      .map(item => this.stopByRequest(scope, item.record.requestId)));
  }
  async stopByRequest(scope: Scope, requestId: string): Promise<void> {
    validId(requestId); validId(scope.callSessionId); const user = this.user(scope.userId);
    const record = user.sessions.find(item => item.requestId === requestId && item.avatarId === scope.avatarId && item.callSessionId === scope.callSessionId);
    if (!record) {
      this.person(scope.userId, scope.avatarId);
      if (user.sessions.length >= 500) throw new PortraitError('portrait_session_limit', 'The recovery log is full.', 429);
      user.sessions.push({ ...scope, id: randomUUID(), requestId, instanceId: '', status: 'stopped', stopRequested: true,
        createdAt: Date.now(), expiresAt: Date.now(), speeches: [] }); this.save(scope.userId); return;
    }
    const runtime = this.active.get(record.id);
    if (runtime?.stopping) return runtime.stopping;
    record.stopRequested = true; this.save(scope.userId);
    const work = Promise.resolve().then(async () => {
      if (runtime?.creating) await runtime.creating.catch(() => {});
      try {
        if (record.remoteId && record.status !== 'stopped') { requirePortraitCloud(); await this.provider.close(record.credential!, record.instanceId, record.remoteId); }
        else if (record.status === 'unknown' || record.status === 'creating') throw new PortraitError('aliyun_cleanup_pending', 'A possibly created session has no identifier. Check the Aliyun instance.', 503, true);
        record.status = 'stopped'; record.credential = undefined; this.save(scope.userId);
      } catch (error) { record.status = 'unknown'; this.save(scope.userId); throw error; }
      finally { this.active.delete(record.id); }
    });
    if (runtime) { runtime.stopping = work; clearTimeout(runtime.timer); runtime.release(); runtime.controller.abort(); }
    return work;
  }
}
let singleton: AliyunAvatarSessions | undefined;
export const getAliyunAvatarSessions = () => singleton ??= new AliyunAvatarSessions();
