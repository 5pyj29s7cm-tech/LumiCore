import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDataPath } from '../config/data_path';
import { ensurePrivateRuntimeDirectory } from '../config/runtime_file_security';
import { captureOrganizationMembershipAuthorization, isOrganizationMembershipAuthorizationCurrent, type OrganizationMembershipAuthorization } from '../org/membership_authorization';
import { executionIdempotencyKey, externalCommitInputDigest } from './registry';
import type { ToolContext } from './types';

export interface ImageGenerationTask {
  version: 1;
  recoveryId: string;
  idempotencyKey: string;
  inputDigest: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  ownerTaskId: string;
  membership?: OrganizationMembershipAuthorization;
  provider: 'qwen';
  model: string;
  settings: { size?: string; count: number; hasReference: false };
  providerTaskId: string;
  state: 'submitting' | 'accepted' | 'unknown' | 'rejected' | 'failed' | 'cancelled' | 'completed';
  result?: string;
  updatedAt: string;
}

function directory(): string { return ensurePrivateRuntimeDirectory(getDataPath('media-generation-tasks')); }
function filename(recoveryId: string): string {
  if (!/^[a-f0-9]{64}$/.test(recoveryId)) throw new Error('Invalid media recovery identity.');
  return path.join(directory(), `${recoveryId}.json`);
}
function scope(context?: ToolContext) {
  return { userId: String(context?.userId || ''), domain: context?.domain === 'work' ? 'work' as const : 'personal' as const, orgId: String(context?.orgId || '') };
}
export function assertImageTaskOwner(task: ImageGenerationTask, context?: ToolContext): void {
  const owner = scope(context);
  if (task.userId !== owner.userId || task.domain !== owner.domain || task.orgId !== owner.orgId
    || task.domain === 'work' && !isOrganizationMembershipAuthorizationCurrent(task.membership, task.orgId, task.userId)) {
    throw new Error('The image generation task is unavailable in the current owner scope.');
  }
  if (context?.executionSignal?.aborted) throw context.executionSignal.reason || new Error('Image task cancelled.');
  if (context?.isCancelled?.()) throw new Error('Image task cancelled.');
}
function read(recoveryId: string): ImageGenerationTask | null {
  const file = filename(recoveryId);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid media task journal.');
  const task = JSON.parse(fs.readFileSync(file, 'utf8')) as ImageGenerationTask;
  if (task.version !== 1 || task.recoveryId !== recoveryId || task.provider !== 'qwen') throw new Error('Invalid media task journal.');
  return task;
}
export function readImageGenerationTask(recoveryId: string, context?: ToolContext): ImageGenerationTask | null {
  const task = read(recoveryId);
  if (task) assertImageTaskOwner(task, context);
  return task;
}
/** Synchronous atomic replacement is a strict barrier before polling or reporting acceptance. */
export function saveImageGenerationTask(task: ImageGenerationTask): void {
  const output = filename(task.recoveryId);
  const temporary = `${output}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(task)); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, output);
    if (process.platform !== 'win32') { const parent = fs.openSync(path.dirname(output), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
}
export function imageGenerationRecoveryId(args: Record<string, any>, context?: ToolContext): string {
  return createHash('sha256').update(JSON.stringify([scope(context), executionIdempotencyKey('generate_image', args, context)])).digest('hex');
}
export function prepareImageGenerationTask(args: Record<string, any>, model: string, context?: ToolContext): { task: ImageGenerationTask; created: boolean } {
  const recoveryId = imageGenerationRecoveryId(args, context);
  const inputDigest = externalCommitInputDigest('generate_image', args);
  const existing = readImageGenerationTask(recoveryId, context);
  if (existing) {
    if (existing.inputDigest !== inputDigest) throw new Error('Media task identity is already bound to different arguments.');
    return { task: existing, created: false };
  }
  const owner = scope(context);
  const task: ImageGenerationTask = { version: 1, recoveryId, idempotencyKey: executionIdempotencyKey('generate_image', args, context), inputDigest,
    ...owner, ownerTaskId: String(context?.taskId || ''),
    ...(owner.domain === 'work' ? { membership: captureOrganizationMembershipAuthorization(owner.orgId, owner.userId) } : {}),
    provider: 'qwen', model, settings: { size: typeof args.size === 'string' ? args.size.trim().slice(0, 40) : undefined,
      count: Math.min(4, Math.max(1, Math.floor(Number(args.n) || 1))), hasReference: false },
    providerTaskId: '', state: 'submitting', updatedAt: new Date().toISOString() };
  assertImageTaskOwner(task, context); saveImageGenerationTask(task);
  return { task, created: true };
}
