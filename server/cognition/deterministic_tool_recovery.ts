import path from 'path';
import { normalizeActionIntent } from './normalized_action_intent';
import type { ConversationActionContinuationState } from './action_continuation';
import { normalizeTaskCapsuleV1 } from '../conversation/task_capsule';
import type { ToolContext } from '../tools/types';
import type { PendingToolConfirmation } from '../tools/pending_confirmation';

export interface DeterministicToolRecoveryCall {
  name: string;
  arguments: Record<string, unknown>;
  reason: 'explicit_exact_text_write' | 'durable_task_capsule_exact_text_write';
}

type RuntimeOwnedRecoveryCall = NonNullable<ToolContext['runtimeOwnedDeterministicRecoveryCall']>;

const WINDOWS_TEXT_PATH_RE = /[A-Za-z]:[\\/][^\r\n"'<>|?*]+?\.(?:txt|md)(?=$|[\s,.;:)}\]，。；：）】])/giu; // i18n-allow: Multilingual punctuation boundary; not user-visible copy.
const POSIX_TEXT_PATH_RE = /\/(?:[^/\r\n"'<>|?*]+\/)*[^/\r\n"'<>|?*]+?\.(?:txt|md)(?=$|[\s,.;:)}\]，。；：）】])/gu; // i18n-allow: Multilingual punctuation boundary; not user-visible copy.
const EXACT_CONTENT_MARKER_RE = /\bwith\s+(?:the\s+)?exact\s+content\b/giu;
const WRITE_FILE_DIRECTIVE_RE = /\.\s*(?:call|use|invoke)\s+(?:the\s+)?write_file\b/iu;
const EXPLICIT_WRITE_FILE_RE = /\b(?:call|use|invoke)\s+(?:the\s+)?write_file\b|(?:调用|使用)\s*(?:工具\s*)?write_file\b/iu; // i18n-allow: Multilingual input-recognition pattern; not user-visible copy.
const ZH_EXACT_CONTENT_MARKER_RE = /内容\s*(?:必须|需要|需|严格)?\s*(?:写成|写为|为)/gu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const ZH_WRITE_FILE_DIRECTIVE_RE = /[。.!]\s*(?:必须|需要|需|请|务必)?\s*(?:调用|使用)\s*(?:工具\s*)?write_file\b/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const PRESERVE_CONTENT_RE = /(?:内容\s*(?:保持|仍然|仍|继续)?\s*(?:不变|相同))|(?:(?:same|unchanged)\s+content)|(?:content\s+(?:stays?|remains?)\s+(?:the\s+)?same)/iu; // i18n-allow: Multilingual input-recognition pattern; not user-visible copy.

function uniqueAbsoluteTextPaths(text: string): string[] {
  const matches = [
    ...Array.from(text.matchAll(WINDOWS_TEXT_PATH_RE), match => String(match[0] || '').trim()),
    ...Array.from(text.matchAll(POSIX_TEXT_PATH_RE), match => String(match[0] || '').trim()),
  ].filter(candidate => (
    path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)
  ));
  return Array.from(new Set(matches));
}

function unwrapExactContent(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64_000) return null;
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    '`': '`',
    '\u201c': '\u201d',
    '\u2018': '\u2019',
  };
  const closing = pairs[trimmed[0]];
  if (!closing) return trimmed;
  if (trimmed.length < 2 || trimmed.at(-1) !== closing) return null;
  return trimmed.slice(1, -1);
}

function exactWriteContent(text: string): string | null {
  const english = Array.from(text.matchAll(EXACT_CONTENT_MARKER_RE)).map(match => ({
    index: match.index || 0,
    length: match[0].length,
    directive: WRITE_FILE_DIRECTIVE_RE,
  }));
  const chinese = Array.from(text.matchAll(ZH_EXACT_CONTENT_MARKER_RE)).map(match => ({
    index: match.index || 0,
    length: match[0].length,
    directive: ZH_WRITE_FILE_DIRECTIVE_RE,
  }));
  const markers = [...english, ...chinese].sort((a, b) => a.index - b.index);
  if (markers.length !== 1) return null;
  const marker = markers[0];
  const contentTail = text.slice(marker.index + marker.length).trimStart();
  const directiveMatches = Array.from(contentTail.matchAll(new RegExp(
    marker.directive.source,
    marker.directive.flags.includes('g') ? marker.directive.flags : `${marker.directive.flags}g`,
  )));
  if (directiveMatches.length !== 1 || directiveMatches[0].index === undefined) return null;
  return unwrapExactContent(contentTail.slice(0, directiveMatches[0].index));
}

function normalizedTargetIdentity(value: string): string {
  return String(value || '').trim().replace(/[\\/]+/g, '/').toLowerCase();
}

function targetFingerprint(value: string): string {
  return `target:${normalizedTargetIdentity(value)}`;
}

function oneAbsoluteTextPath(value: string): string | null {
  const candidate = String(value || '').trim();
  const paths = uniqueAbsoluteTextPaths(candidate);
  if (paths.length !== 1 || paths[0] !== candidate) return null;
  return candidate;
}

/**
 * Convert the server-owned current task projection into one exact recovery
 * candidate. It is intentionally limited to a current-turn target correction
 * whose revoked, integrity-checked confirmation preserves the exact content.
 */
export function buildDurableTaskDeterministicToolRecoveryCall(
  state: ConversationActionContinuationState | null | undefined,
  requestId: string,
  revokedCorrectionBasis: PendingToolConfirmation | null | undefined,
): RuntimeOwnedRecoveryCall | null {
  const currentRequestId = String(requestId || '').trim();
  const taskId = String(state?.taskId || '').trim();
  const activeRequestId = String(state?.activeRequestId || '').trim();
  const capsule = normalizeTaskCapsuleV1(state?.taskCapsule);
  if (
    !currentRequestId
    || !taskId
    || activeRequestId !== currentRequestId
    || !state?.unfinished
    || !capsule?.unfinished
    || capsule.taskId !== taskId
    || capsule.revision !== Math.max(0, Math.trunc(Number(state.revision) || 0))
    || !['planning', 'executing'].includes(String(state.status || ''))
    || capsule.status !== state.status
  ) return null;

  const correction = capsule.latestCorrection;
  const targetPath = oneAbsoluteTextPath(capsule.target.path);
  const basisTaskId = String(revokedCorrectionBasis?.taskId || '').trim();
  const basisToolName = String(revokedCorrectionBasis?.toolName || '').trim();
  const basisOldPath = oneAbsoluteTextPath(String(revokedCorrectionBasis?.exactArgs?.path || ''));
  const basisContent = revokedCorrectionBasis?.exactArgs?.content;
  if (
    !correction
    || !targetPath
    || basisTaskId !== taskId
    || basisToolName !== 'write_file'
    || !basisOldPath
    || typeof basisContent !== 'string'
    || basisContent.length > 64_000
    || capsule.target.status !== 'candidate'
    || capsule.target.source !== 'user_correction'
    || normalizedTargetIdentity(correction.previousTarget) !== normalizedTargetIdentity(basisOldPath)
    || normalizedTargetIdentity(correction.replacementTarget) !== normalizedTargetIdentity(targetPath)
    || normalizedTargetIdentity(correction.previousTarget) === normalizedTargetIdentity(correction.replacementTarget)
    || !PRESERVE_CONTENT_RE.test(correction.text || capsule.currentInstruction)
  ) return null;

  const instructionRef = String(state.latestInstructionRef || '').trim();
  const correctionRef = String(correction.eventRef || '').trim();
  const latestInstruction = String(state.latestInstruction || '').trim();
  if (
    !instructionRef
    || !correctionRef
    || instructionRef !== correctionRef
    || !latestInstruction
    || latestInstruction !== String(capsule.currentInstruction || '').trim()
    || latestInstruction !== String(correction.text || '').trim()
  ) return null;

  const targetIdentity = normalizedTargetIdentity(targetPath);
  const priorTargetIdentity = normalizedTargetIdentity(basisOldPath);
  if (!capsule.rejectedTargets.some(item => (
    normalizedTargetIdentity(item.identity) === priorTargetIdentity
  ))) return null;
  const priorFingerprint = targetFingerprint(basisOldPath);
  if (!capsule.doNotRetry.some(item => normalizedTargetIdentity(item.fingerprint) === priorFingerprint)) {
    return null;
  }
  if (capsule.rejectedTargets.some(item => (
    normalizedTargetIdentity(item.identity) === targetIdentity
  ))) return null;
  const fingerprint = targetFingerprint(targetPath);
  if (capsule.doNotRetry.some(item => normalizedTargetIdentity(item.fingerprint) === fingerprint)) {
    return null;
  }

  return {
    source: 'durable_task_capsule',
    taskId,
    taskRevision: capsule.revision,
    requestId: currentRequestId,
    name: 'write_file',
    arguments: { path: targetPath, content: basisContent },
  };
}

/** Revalidate a runtime-owned candidate at the exact model/tool boundary. */
export function validateRuntimeOwnedDeterministicToolRecoveryCall(
  candidate: ToolContext['runtimeOwnedDeterministicRecoveryCall'],
  context: Pick<ToolContext, 'taskId' | 'taskRevision' | 'requestId'> | undefined,
  exposedToolNames: Iterable<string>,
): DeterministicToolRecoveryCall | null {
  if (
    !candidate
    || candidate.source !== 'durable_task_capsule'
    || candidate.name !== 'write_file'
    || !candidate.taskId
    || candidate.taskId !== String(context?.taskId || '').trim()
    || !candidate.requestId
    || candidate.requestId !== String(context?.requestId || '').trim()
    || !Number.isSafeInteger(candidate.taskRevision)
    || candidate.taskRevision < 0
    || !Number.isSafeInteger(context?.taskRevision)
    || candidate.taskRevision !== context?.taskRevision
    || !new Set(Array.from(exposedToolNames)).has('write_file')
  ) return null;
  const targetPath = oneAbsoluteTextPath(candidate.arguments?.path);
  const content = candidate.arguments?.content;
  if (!targetPath || typeof content !== 'string' || content.length > 64_000) return null;
  return {
    name: 'write_file',
    arguments: { path: targetPath, content },
    reason: 'durable_task_capsule_exact_text_write',
  };
}

/**
 * Recover only a fully specified tool request that a model failed to emit.
 * This function never executes the call. The ordinary executor remains the
 * sole authorization, confirmation, lifecycle and receipt boundary.
 */
export function buildDeterministicExplicitToolRecoveryCall(
  task: string,
  exposedToolNames: Iterable<string>,
): DeterministicToolRecoveryCall | null {
  const text = String(task || '').trim();
  const exposed = new Set(Array.from(exposedToolNames, name => String(name || '').trim()));
  if (!text || !exposed.has('write_file') || !EXPLICIT_WRITE_FILE_RE.test(text)) return null;

  const intent = normalizeActionIntent(text);
  if (
    intent.kind !== 'desktop_operation'
    || intent.operation !== 'create'
    || intent.relation !== 'new'
    || intent.sideEffectClass !== 'local_write'
  ) return null;

  const paths = uniqueAbsoluteTextPaths(text);
  if (paths.length !== 1) return null;
  const targetPath = paths[0];
  if (intent.target && path.win32.normalize(intent.target) !== path.win32.normalize(targetPath)) {
    return null;
  }

  const content = exactWriteContent(text);
  if (content === null) return null;

  return {
    name: 'write_file',
    arguments: { path: targetPath, content },
    reason: 'explicit_exact_text_write',
  };
}
