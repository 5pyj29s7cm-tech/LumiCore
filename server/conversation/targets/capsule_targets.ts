import type { TaskTargetAnchorV1, TaskTargetAnchorStatus, TaskTargetAnchorSource } from './contracts';
import { compact, normalizedIdentity } from './values';
import { displayableFileName, fileName } from './paths';

export function mergeTarget(
  primary: Partial<TaskTargetAnchorV1>,
  fallback?: Partial<TaskTargetAnchorV1> | null,
): TaskTargetAnchorV1 {
  const pathValue = compact(primary.path || fallback?.path, 500);
  const object = compact(primary.object || fallback?.object || displayableFileName(pathValue), 220);
  return {
    label: compact(primary.label || object || fallback?.label, 220),
    application: compact(primary.application || fallback?.application, 160),
    window: compact(primary.window || fallback?.window, 300),
    object,
    path: pathValue,
    location: compact(primary.location || fallback?.location, 120),
    status: primary.status || fallback?.status || 'unresolved',
    source: primary.source || fallback?.source || 'unknown',
  };
}

export function rejectedByIdentity(target: TaskTargetAnchorV1, rejectedTargets: string[]): boolean {
  const identities = [target.path, target.object, target.label]
    .map(normalizedIdentity)
    .filter(Boolean);
  return rejectedTargets.some(rejected => {
    const normalized = normalizedIdentity(rejected);
    const base = normalizedIdentity(fileName(rejected));
    return identities.some(identity => identity === normalized || identity === base);
  });
}

export function capsuleRejectedTargets(taskText: string): string[] {
  const marker = String(taskText || '').split(/\n- rejectedTargets:\s*\n/i)[1];
  if (!marker) return [];
  return marker
    .split(/\n(?=- |Capsule rules:|Recent |Rules:)/i, 1)[0]
    .split(/\n/)
    .map(line => compact(line.replace(/^\s*-\s*/, '').split(/\s+\|\s+/, 1)[0], 500))
    .filter(Boolean)
    .slice(0, 8);
}

export function capsuleTarget(taskText: string): Partial<TaskTargetAnchorV1> | null {
  const text = String(taskText || '');
  if (!/Current task capsule \(TaskCapsuleV1\):/i.test(text)) return null;
  const field = (name: string) => compact(text.match(new RegExp(`(?:^|\\n)- ${name}:\\s*(.+)`, 'i'))?.[1], 500);
  const status = field('targetStatus') as TaskTargetAnchorStatus;
  const source = field('targetSource') as TaskTargetAnchorSource;
  return {
    label: field('target').replace(/^\(unresolved\)$/i, ''),
    application: field('targetApplication') || field('app'),
    window: field('targetWindow'),
    object: field('targetObject'),
    path: field('targetPath') || field('path'),
    location: field('targetLocation') || field('location'),
    status: ['unresolved', 'candidate', 'confirmed', 'rejected'].includes(status) ? status : undefined,
    source: [
      'durable_state', 'tool_receipt', 'user_correction', 'active_window', 'running_window', 'document_interface', 'unknown',
    ].includes(source) ? source : undefined,
  };
}
