import type {
  ConversationTaskReceipt,
  ConversationTaskStatus,
} from '../cognition/task_execution_ledger';
import {
  allowedTaskSearchRoots,
  buildTaskTargetAnchorProjection,
  isUnconfirmedRuntimeCandidate,
  type TaskTargetAnchorSource,
} from './task_target_anchor';

export type TaskCapsuleTargetStatus = 'unresolved' | 'candidate' | 'confirmed' | 'rejected';

export interface TaskCapsuleTargetV1 {
  label: string;
  application: string;
  window: string;
  object: string;
  path: string;
  location: string;
  status: TaskCapsuleTargetStatus;
  source: TaskTargetAnchorSource;
}

export interface TaskCapsuleCorrectionV1 {
  text: string;
  previousTarget: string;
  replacementTarget: string;
  observedAt: string;
  /** Durable identity of the user correction event, when one is available. */
  eventRef?: string;
}

export interface TaskCapsuleCompletedStepV1 {
  receiptId: string;
  toolName: string;
  target: string;
  verification: 'verified' | 'unverified' | 'not_required';
  summary: string;
  recordedAt: string;
}

export interface TaskCapsuleRejectedTargetV1 {
  identity: string;
  reason: string;
  observedAt: string;
}

export interface TaskCapsuleDoNotRetryV1 {
  fingerprint: string;
  reason: string;
  observedAt: string;
}

/**
 * A compact, durable projection of one conversation-scoped task.
 *
 * It intentionally contains no raw tool result. Natural dialogue remains in
 * normal history, while this capsule carries only the minimum execution state
 * needed to keep a task coherent across chat, voice, and history compaction.
 */
export interface TaskCapsuleV1 {
  schemaVersion: 1;
  taskId: string;
  revision: number;
  status: ConversationTaskStatus;
  unfinished: boolean;
  goal: string;
  currentInstruction: string;
  target: TaskCapsuleTargetV1;
  paths: string[];
  allowedSearchRoots: string[];
  analysisReady: boolean;
  nextAction: 'analyze' | 'inspect_active_document' | 'search_bounded_roots' | 'clarify_target';
  latestCorrection: TaskCapsuleCorrectionV1 | null;
  completedSteps: TaskCapsuleCompletedStepV1[];
  blocker: string;
  toolSummaries: string[];
  rejectedTargets: TaskCapsuleRejectedTargetV1[];
  doNotRetry: TaskCapsuleDoNotRetryV1[];
  updatedAt: string;
}

/** Structural input keeps this module independent from action_continuation. */
export interface DurableTaskCapsuleSource {
  taskId?: string;
  revision?: number;
  status?: ConversationTaskStatus;
  goal?: string;
  latestInstruction?: string;
  /** Persisted user message id, falling back to the owning request id. */
  latestInstructionRef?: string;
  appTarget?: string;
  sourcePaths?: string[];
  latestBlocker?: string;
  unfinished?: boolean;
  receipts?: ConversationTaskReceipt[];
  toolSummaries?: string[];
  updatedAt?: string;
}

export interface TaskCapsuleCorrectionUpdateV1 {
  text: string;
  target?: string;
  application?: string;
  path?: string;
  location?: string;
  rejectCurrentTarget?: boolean;
  reason?: string;
  observedAt?: string;
  eventRef?: string;
}

export interface TaskCapsuleUpdateV1 {
  instruction?: string;
  target?: Partial<TaskCapsuleTargetV1>;
  correction?: TaskCapsuleCorrectionUpdateV1;
  rejectedTargets?: TaskCapsuleRejectedTargetV1[];
  doNotRetry?: TaskCapsuleDoNotRetryV1[];
  receipts?: ConversationTaskReceipt[];
  blocker?: string;
  toolSummaries?: string[];
  updatedAt?: string;
}

export interface BuildTaskCapsuleOptions {
  currentTurnText?: string;
  /** Persisted user message id, falling back to the current request id. */
  currentTurnRef?: string;
  previousCapsule?: TaskCapsuleV1 | null;
  observedAt?: string;
}

export type TaskCapsuleTurnKind = 'target_correction' | 'target_detail' | 'none';

const EMPTY_TIMESTAMP = new Date(0).toISOString();
const MAX_COMPLETED_STEPS = 12;
const MAX_TOOL_SUMMARIES = 10;
const MAX_REJECTED_TARGETS = 8;
const MAX_DO_NOT_RETRY = 12;

// Require an artifact/application noun. A bare "不是，我想问……" is ordinary
// conversation and must never be attached to an unfinished task.
// i18n-allow: multilingual task-target correction recognition; not user-visible copy.
const TARGET_CORRECTION_RE = /^(?:(?:不对|错了|搞错了|弄错了)[，,:：\s]*)?(?:(?:不是|并不是|别用|不要用)\s*(?:(?:(?:这|那|刚才|之前|当前)(?:个|份|张|条)?\s*)?(?:文件|文档|PPT|演示文稿|表格|图片|资料|窗口|页面|应用|软件|路径|目录|版本|目标)|[^\r\n，,;；。！？!?]{1,180}\.(?:pptx?|docx?|xlsx?|pdf|txt|md|csv|json|png|jpe?g|gif|svg|dwg|dxf|zip)))[^。！？!?]{0,180}[。！？!?]*$|^(?:(?:no|wrong)[,:\s]+)?(?:not|wrong)\s+(?:(?:(?:this|that|the\s+(?:current|previous|last))\s+)?(?:file|document|presentation|sheet|image|window|app|path|version|target)\b|[^\r\n,;.!?]{1,180}\.(?:pptx?|docx?|xlsx?|pdf|txt|md|csv|json|png|jpe?g|gif|svg|dwg|dxf|zip)\b).{0,180}[.!?]*$/iu;

// Inside an established unfinished file task, this exact deictic rejection is
// target feedback. Keeping it separate from TARGET_CORRECTION_RE prevents a
// conversational “不是，我想问……” from binding to old work.
// i18n-allow: multilingual task-target correction recognition; not user-visible copy.
const TERSE_DEICTIC_TARGET_CORRECTION_RE =
  /^(?:不对[，,:：\s]*)?(?:不是|并不是|别用|不要用)\s*(?:这|那)(?:个|份|张|条)?[啊呀吧嘛呢，,。！？?!\s]*$|^(?:no|wrong|not)\s+(?:this|that)(?:\s+one)?[.!?\s]*$/iu;

// i18n-allow: multilingual task-target detail recognition; not user-visible copy.
const TARGET_DETAIL_RE = /^(?:(?:(?:准确|正确|具体|完整)?(?:文件名|文档名|PPT名|演示文稿名|表格名|图片名|资料名)|(?:文件|文档|PPT|演示文稿|表格|图片|资料|目标|路径|目录))(?:在|位于|是|为|叫|名为|名称是)|(?:在|位于)(?:桌面|下载|文档|当前窗口)|[A-Za-z]:[\\/]|\\\\).{1,420}$|^(?:(?:the\s+)?(?:file|document|presentation|sheet|image|target|path)(?:\s+is|\s+is\s+named|\s+is\s+on)|it(?:'s| is)\s+(?:on|in|named|called))\b.{1,420}$/iu;

const EXPLICIT_FILE_NAME_RE = /(?:^|[\\/\s，,:："'“”‘’])([^\\/\r\n，,;；"'“”‘’]{1,180}\.(?:pptx?|docx?|xlsx?|pdf|txt|md|csv|json|png|jpe?g|gif|svg|dwg|dxf|zip))[。！？.!?]*$/iu;
// i18n-allow: multilingual file-task context recognition; not user-visible copy.
const FILE_TASK_CONTEXT_RE = /(?:文件|文档|PPT|演示文稿|表格|图片|资料|路径|目录|桌面|下载|WPS|PowerPoint|Word|Excel|file|document|presentation|sheet|image|path|desktop|download)/iu;
const SECRET_ASSIGNMENT_RE = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g;

const TARGET_ARGUMENT_KEYS = new Set([
  'app',
  'application',
  'applicationtarget',
  'apptarget',
  'document',
  'documentname',
  'documentpath',
  'file',
  'filename',
  'filepath',
  'inputpath',
  'outputpath',
  'path',
  'source',
  'sourcename',
  'sourcepath',
  'target',
  'targetpath',
]);

function compact(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function redactSecrets(value: unknown, limit: number): string {
  return compact(value, limit * 2)
    .replace(SECRET_ASSIGNMENT_RE, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(JWT_RE, '[REDACTED_JWT]')
    .slice(0, limit);
}

function timestamp(value: unknown): string {
  const clean = compact(value, 80);
  return Number.isFinite(new Date(clean).getTime()) ? clean : EMPTY_TIMESTAMP;
}

function uniqueStrings(values: unknown[], limit: number, itemLimit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const clean = redactSecrets(value, itemLimit);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    output.push(clean);
  }
  return output.slice(-limit);
}

function targetIdentity(target: Pick<TaskCapsuleTargetV1, 'path' | 'label' | 'application'>): string {
  return compact(target.path || target.label || target.application, 500);
}

function targetFingerprint(identity: string): string {
  return `target:${compact(identity, 500).replace(/[\\/]+/g, '/').toLowerCase()}`;
}

/**
 * A parsed correction is the authoritative target event for its turn.  The
 * generic target-anchor projection still scans the full instruction so it can
 * reconcile receipts and active-document evidence, but an instruction such as
 * "reject OLD; final target is NEW" contains both paths.  If that weaker scan
 * selects OLD, preserve the structured replacement produced by
 * targetUpdateFromTurn.  A projection that resolves the same replacement is
 * retained so verified evidence can still promote it from candidate to
 * confirmed.
 */
function preserveStructuredCorrectionTarget(
  projected: TaskCapsuleTargetV1,
  structured: TaskCapsuleTargetV1,
  correction: TaskCapsuleCorrectionV1 | null,
): TaskCapsuleTargetV1 {
  const replacement = compact(correction?.replacementTarget, 500);
  if (!replacement) return projected;
  const replacementFingerprint = targetFingerprint(replacement);
  if (targetFingerprint(targetIdentity(structured)) !== replacementFingerprint) return projected;
  return targetFingerprint(targetIdentity(projected)) === replacementFingerprint
    ? projected
    : structured;
}

function fileNameFromPath(value: string): string {
  return compact(value.split(/[\\/]/).filter(Boolean).pop() || value, 180);
}

function hasFileTaskContext(source: DurableTaskCapsuleSource | undefined): boolean {
  if (!source?.unfinished) return false;
  if ((source.sourcePaths || []).some(Boolean)) return true;
  return FILE_TASK_CONTEXT_RE.test([
    source.goal,
    source.latestInstruction,
    source.appTarget,
  ].map(value => compact(value, 500)).join(' '));
}

function explicitFileName(text: string): string {
  const clean = compact(text, 500);
  const absolutePath = clean.match(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n，,；;。！？!?]{1,420}/u)?.[0];
  if (absolutePath) return compact(absolutePath, 500);
  // i18n-allow: multilingual explicit filename recognition; not user-visible copy.
  const named = clean.match(/(?:(?:准确|正确|具体|完整)?(?:文件名|文档名|PPT名|演示文稿名|表格名|图片名|资料名)\s*(?:是|为|叫|名为|名称是)|叫|名为|名称是|named|called)\s*["'“”‘’]?([^"'“”‘’\r\n，,；;。！？!?]{1,200}\.(?:pptx?|docx?|xlsx?|pdf|txt|md|csv|json|png|jpe?g|gif|svg|dwg|dxf|zip))/iu)?.[1];
  if (named) return compact(named, 220);
  return compact(clean.match(EXPLICIT_FILE_NAME_RE)?.[1], 220);
}

function locationFromText(text: string): string {
  const clean = compact(text, 500);
  // i18n-allow: recognized user location vocabulary; not user-visible copy.
  if (/(?:桌面|desktop)/iu.test(clean)) return 'desktop';
  if (/(?:下载|downloads?)/iu.test(clean)) return 'downloads';
  // i18n-allow: multilingual document-folder recognition; not user-visible copy.
  if (/(?:文档目录|documents?\s+(?:folder|directory))/iu.test(clean)) return 'documents';
  return '';
}

function applicationFromText(text: string): string {
  const clean = compact(text, 500);
  const match = clean.match(/\b(?:WPS|PowerPoint|Microsoft\s+PowerPoint|Word|Microsoft\s+Word|Excel|Microsoft\s+Excel|AutoCAD|CAD|Photoshop|Notepad|LM\s+Studio)\b/iu);
  return compact(match?.[0], 160);
}

function replacementClause(text: string): string {
  const clean = compact(text, 500).replace(/[。！？!?]+$/u, '');
  // i18n-allow: multilingual target-replacement recognition; not user-visible copy.
  const replacement = clean.match(/(?:而是|应该是|最终目标(?:是|改为)|改成|换成|(?<!不)要用|请用|(?<!不要)(?<!别)用)\s*["'“”‘’]?(.{1,420})$/u)?.[1]
    || clean.match(/\b(?:instead(?:\s+use)?|use|replace(?:\s+it)?\s+with)\s+["']?(.{1,420})$/iu)?.[1];
  return compact(replacement?.replace(/["'“”‘’]+$/u, ''), 500);
}

function explicitTargetReplacement(text: string): string {
  const clean = compact(text, 500);
  // Long absolute paths can make the legacy whole-sentence correction regex
  // exceed its bounded branches. Bind only an explicit replacement clause
  // whose replacement itself names a file/path/application; conversational
  // "use a warmer tone" wording must not become task-target feedback.
  // i18n-allow: multilingual target-replacement recognition; not user-visible copy.
  const hasReplacementCue = /(?:而是|应该是|最终目标(?:是|改为)|改成|换成)/u.test(clean)
    || /(?:不是|并不是|别用|不要用).*(?:请用|(?<!不)要用)/u.test(clean)
    || /\b(?:instead(?:\s+use)?|replace(?:\s+it)?\s+with)\b/iu.test(clean);
  if (!hasReplacementCue) return '';
  const replacement = replacementClause(clean);
  if (!replacement) return '';
  return explicitFileName(replacement) || applicationFromText(replacement)
    ? replacement
    : '';
}

function targetUpdateFromTurn(text: string): {
  kind: Exclude<TaskCapsuleTurnKind, 'none'>;
  target: string;
  path: string;
  application: string;
  location: string;
  rejectCurrentTarget: boolean;
} | null {
  const clean = compact(text, 500);
  if (!clean) return null;
  const boundedReplacement = explicitTargetReplacement(clean);
  const correction = TARGET_CORRECTION_RE.test(clean)
    || TERSE_DEICTIC_TARGET_CORRECTION_RE.test(clean)
    || Boolean(boundedReplacement);
  const detail = TARGET_DETAIL_RE.test(clean);
  const fileName = explicitFileName(clean);
  if (!correction && !detail && !fileName) return null;

  const replacement = correction ? (boundedReplacement || replacementClause(clean)) : '';
  const replacementFile = explicitFileName(replacement);
  const path = compact(replacementFile || fileName, 500);
  const application = applicationFromText(replacement || clean);
  const target = compact(path || replacement, 500);
  return {
    kind: correction ? 'target_correction' : 'target_detail',
    target,
    path,
    application,
    location: locationFromText(replacement || clean),
    rejectCurrentTarget: correction,
  };
}

/**
 * Classify only target-bearing follow-ups. It is deliberately narrower than a
 * general correction classifier so conversational negation cannot hijack an
 * unfinished task. A bare filename is accepted only in an established file
 * task.
 */
export function classifyTaskCapsuleTurn(
  text: string,
  source?: DurableTaskCapsuleSource | null,
): TaskCapsuleTurnKind {
  if (!source?.unfinished) return 'none';
  const clean = compact(text, 500);
  if (!clean) return 'none';
  if (TARGET_CORRECTION_RE.test(clean)) return 'target_correction';
  if (explicitTargetReplacement(clean)) return 'target_correction';
  if (TERSE_DEICTIC_TARGET_CORRECTION_RE.test(clean) && hasFileTaskContext(source)) {
    return 'target_correction';
  }
  if (TARGET_DETAIL_RE.test(clean)) return 'target_detail';
  if (explicitFileName(clean) && hasFileTaskContext(source)) return 'target_detail';
  return 'none';
}

export function isTaskCapsuleTargetContinuation(
  text: string,
  source?: DurableTaskCapsuleSource | null,
): boolean {
  return classifyTaskCapsuleTurn(text, source) !== 'none';
}

function collectTargetArgumentValues(value: unknown, depth = 0): string[] {
  if (!value || depth > 3) return [];
  if (Array.isArray(value)) {
    return value.slice(0, 8).flatMap(item => collectTargetArgumentValues(item, depth + 1));
  }
  if (typeof value !== 'object') return [];
  const output: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    const normalizedKey = key.replace(/[_-]/g, '').toLocaleLowerCase();
    if (TARGET_ARGUMENT_KEYS.has(normalizedKey) && ['string', 'number'].includes(typeof child)) {
      const clean = redactSecrets(child, 500);
      if (clean) output.push(clean);
      continue;
    }
    if (child && typeof child === 'object') output.push(...collectTargetArgumentValues(child, depth + 1));
  }
  return output;
}

function receiptTarget(receipt: ConversationTaskReceipt): string {
  return uniqueStrings(collectTargetArgumentValues(receipt.arguments), 4, 500).at(-1) || '';
}

function receiptSummary(receipt: ConversationTaskReceipt): string {
  const target = receiptTarget(receipt);
  const verification = receipt.terminalVerification?.status;
  const reason = receipt.outcome === 'success'
    ? ''
    : redactSecrets(receipt.error || receipt.terminalVerification?.reason, 220);
  return redactSecrets([
    receipt.name,
    `outcome=${receipt.outcome}`,
    verification ? `verification=${verification}` : '',
    target ? `target=${target}` : '',
    reason ? `reason=${reason}` : '',
  ].filter(Boolean).join(' | '), 520);
}

function completedStepsFromReceipts(receipts: ConversationTaskReceipt[] = []): TaskCapsuleCompletedStepV1[] {
  return receipts
    .filter(receipt => receipt?.outcome === 'success' && receipt.terminalVerification?.status !== 'failed')
    .slice(-MAX_COMPLETED_STEPS)
    .map(receipt => {
      const target = receiptTarget(receipt);
      const verification = receipt.terminalVerification?.status === 'verified'
        ? 'verified' as const
        : receipt.terminalVerification?.status === 'unverified'
          ? 'unverified' as const
          : 'not_required' as const;
      return {
        receiptId: compact(receipt.id || receipt.key, 180),
        toolName: compact(receipt.name, 160),
        target,
        verification,
        summary: redactSecrets([
          compact(receipt.name, 160),
          target ? `target=${target}` : '',
          `verification=${verification}`,
        ].filter(Boolean).join(' | '), 420),
        recordedAt: timestamp(receipt.recordedAt),
      };
    });
}

function deterministicReceiptExclusions(receipts: ConversationTaskReceipt[] = []): TaskCapsuleDoNotRetryV1[] {
  return receipts.flatMap(receipt => {
    if (receipt.outcome === 'success') return [];
    const reason = redactSecrets(receipt.error || receipt.terminalVerification?.reason, 300);
    // Transient timeouts, network failures, and confirmation waits must remain
    // retryable. Only a demonstrated target/path mismatch forbids replaying the
    // exact same target automatically.
    // i18n-allow: multilingual deterministic target-failure recognition; not user-visible copy.
    if (!/(?:target\s*mismatch|wrong\s+(?:target|file|document|path)|目标不匹配|目标错误|文件不对|文档不对|路径不对)/iu.test(reason)) {
      return [];
    }
    return [{
      fingerprint: compact(receipt.key || `${receipt.name}:${receiptTarget(receipt)}`, 1000),
      reason,
      observedAt: timestamp(receipt.recordedAt),
    }];
  });
}

function mergeRejectedTargets(
  previous: TaskCapsuleRejectedTargetV1[],
  additions: TaskCapsuleRejectedTargetV1[],
): TaskCapsuleRejectedTargetV1[] {
  const merged = new Map<string, TaskCapsuleRejectedTargetV1>();
  for (const item of [...previous, ...additions]) {
    const identity = compact(item?.identity, 500);
    if (!identity) continue;
    merged.set(targetFingerprint(identity), {
      identity,
      reason: redactSecrets(item.reason, 300),
      observedAt: timestamp(item.observedAt),
    });
  }
  return [...merged.values()].slice(-MAX_REJECTED_TARGETS);
}

function mergeDoNotRetry(
  previous: TaskCapsuleDoNotRetryV1[],
  additions: TaskCapsuleDoNotRetryV1[],
): TaskCapsuleDoNotRetryV1[] {
  const merged = new Map<string, TaskCapsuleDoNotRetryV1>();
  for (const item of [...previous, ...additions]) {
    const fingerprint = compact(item?.fingerprint, 1000);
    if (!fingerprint) continue;
    merged.set(fingerprint, {
      fingerprint,
      reason: redactSecrets(item.reason, 300),
      observedAt: timestamp(item.observedAt),
    });
  }
  return [...merged.values()].slice(-MAX_DO_NOT_RETRY);
}

function normalizeTarget(
  value: Partial<TaskCapsuleTargetV1> | undefined,
  fallback?: TaskCapsuleTargetV1,
): TaskCapsuleTargetV1 {
  const path = compact(value?.path ?? fallback?.path, 500);
  const object = compact(value?.object ?? fallback?.object, 220) || fileNameFromPath(path);
  const label = compact(value?.label ?? fallback?.label, 220) || object;
  const application = compact(value?.application ?? fallback?.application, 160);
  const window = compact(value?.window ?? fallback?.window, 300);
  const location = compact(value?.location ?? fallback?.location, 120);
  const status = value?.status || fallback?.status || (path || label || object ? 'candidate' : 'unresolved');
  const source = value?.source || fallback?.source || 'unknown';
  return { label, application, window, object, path, location, status, source };
}

function normalizeCapsule(capsule: TaskCapsuleV1): TaskCapsuleV1 {
  const rejectedTargets = mergeRejectedTargets([], capsule.rejectedTargets || []);
  const rejectedFingerprints = new Set(rejectedTargets.map(item => targetFingerprint(item.identity)));
  const completedByReceipt = new Map<string, TaskCapsuleCompletedStepV1>();
  for (const step of capsule.completedSteps || []) {
    const receiptId = compact(step.receiptId, 180);
    const toolName = compact(step.toolName, 160);
    const target = compact(step.target, 500);
    const key = receiptId || `${toolName}:${target}`;
    if (!key || (target && rejectedFingerprints.has(targetFingerprint(target)))) continue;
    completedByReceipt.set(key, {
      receiptId,
      toolName,
      target,
      verification: step.verification,
      summary: redactSecrets(step.summary, 420),
      recordedAt: timestamp(step.recordedAt),
    });
  }
  return {
    schemaVersion: 1,
    taskId: compact(capsule.taskId, 180),
    revision: Math.max(0, Math.trunc(Number(capsule.revision) || 0)),
    status: capsule.status || 'planning',
    unfinished: Boolean(capsule.unfinished),
    goal: redactSecrets(capsule.goal, 700),
    currentInstruction: redactSecrets(capsule.currentInstruction || capsule.goal, 700),
    target: normalizeTarget(capsule.target),
    paths: uniqueStrings(capsule.paths || [], 8, 500),
    allowedSearchRoots: uniqueStrings(capsule.allowedSearchRoots || [], 12, 500),
    analysisReady: Boolean(capsule.analysisReady),
    nextAction: ['analyze', 'inspect_active_document', 'search_bounded_roots', 'clarify_target'].includes(capsule.nextAction)
      ? capsule.nextAction
      : 'clarify_target',
    latestCorrection: capsule.latestCorrection
      ? {
          text: redactSecrets(capsule.latestCorrection.text, 500),
          previousTarget: compact(capsule.latestCorrection.previousTarget, 500),
          replacementTarget: compact(capsule.latestCorrection.replacementTarget, 500),
          observedAt: timestamp(capsule.latestCorrection.observedAt),
          ...(compact(capsule.latestCorrection.eventRef, 180)
            ? { eventRef: compact(capsule.latestCorrection.eventRef, 180) }
            : {}),
        }
      : null,
    completedSteps: [...completedByReceipt.values()].slice(-MAX_COMPLETED_STEPS),
    blocker: redactSecrets(capsule.blocker, 500),
    toolSummaries: uniqueStrings(capsule.toolSummaries || [], MAX_TOOL_SUMMARIES, 520),
    rejectedTargets,
    doNotRetry: mergeDoNotRetry([], capsule.doNotRetry || []),
    updatedAt: timestamp(capsule.updatedAt),
  };
}

/** Normalize an untrusted JSON projection loaded from the durable ledger. */
export function normalizeTaskCapsuleV1(value: unknown): TaskCapsuleV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, any>;
  if (Number(candidate.schemaVersion) !== 1) return null;
  const goal = redactSecrets(candidate.goal, 700);
  if (!goal) return null;
  const targetValue = candidate.target && typeof candidate.target === 'object' && !Array.isArray(candidate.target)
    ? candidate.target as Record<string, any>
    : {};
  const targetStatuses = new Set<TaskCapsuleTargetStatus>(['unresolved', 'candidate', 'confirmed', 'rejected']);
  const targetSources = new Set<TaskCapsuleTargetV1['source']>([
    'durable_state',
    'tool_receipt',
    'user_correction',
    'active_window',
    'running_window',
    'document_interface',
    'unknown',
  ]);
  const statuses = new Set<ConversationTaskStatus>([
    'created',
    'planning',
    'executing',
    'waiting_confirmation',
    'verifying',
    'blocked',
    'completed',
    'failed',
    'cancelled',
  ]);
  const rawCorrection = candidate.latestCorrection
    && typeof candidate.latestCorrection === 'object'
    && !Array.isArray(candidate.latestCorrection)
    ? candidate.latestCorrection as Record<string, any>
    : null;
  const objectItems = (input: unknown): Record<string, any>[] => (
    Array.isArray(input)
      ? input.filter(item => item && typeof item === 'object' && !Array.isArray(item))
      : []
  );
  return normalizeCapsule({
    schemaVersion: 1,
    taskId: compact(candidate.taskId, 180),
    revision: Math.max(0, Math.trunc(Number(candidate.revision) || 0)),
    status: statuses.has(candidate.status)
      ? candidate.status
      : candidate.unfinished
        ? 'blocked'
        : 'completed',
    unfinished: Boolean(candidate.unfinished),
    goal,
    currentInstruction: redactSecrets(candidate.currentInstruction || goal, 700),
    target: {
      label: compact(targetValue.label, 220),
      application: compact(targetValue.application, 160),
      window: compact(targetValue.window, 300),
      object: compact(targetValue.object, 220),
      path: compact(targetValue.path, 500),
      location: compact(targetValue.location, 120),
      status: targetStatuses.has(targetValue.status) ? targetValue.status : 'unresolved',
      source: targetSources.has(targetValue.source) ? targetValue.source : 'unknown',
    },
    paths: Array.isArray(candidate.paths) ? candidate.paths : [],
    allowedSearchRoots: Array.isArray(candidate.allowedSearchRoots) ? candidate.allowedSearchRoots : [],
    analysisReady: candidate.analysisReady === true,
    nextAction: ['analyze', 'inspect_active_document', 'search_bounded_roots', 'clarify_target'].includes(candidate.nextAction)
      ? candidate.nextAction
      : 'clarify_target',
    latestCorrection: rawCorrection
      ? {
          text: redactSecrets(rawCorrection.text, 500),
          previousTarget: compact(rawCorrection.previousTarget, 500),
          replacementTarget: compact(rawCorrection.replacementTarget, 500),
          observedAt: timestamp(rawCorrection.observedAt),
          ...(compact(rawCorrection.eventRef, 180)
            ? { eventRef: compact(rawCorrection.eventRef, 180) }
            : {}),
        }
      : null,
    completedSteps: objectItems(candidate.completedSteps).map(step => ({
      receiptId: compact(step.receiptId, 180),
      toolName: compact(step.toolName, 160),
      target: compact(step.target, 500),
      verification: ['verified', 'unverified', 'not_required'].includes(step.verification)
        ? step.verification
        : 'unverified',
      summary: redactSecrets(step.summary, 420),
      recordedAt: timestamp(step.recordedAt),
    })),
    blocker: redactSecrets(candidate.blocker, 500),
    toolSummaries: Array.isArray(candidate.toolSummaries) ? candidate.toolSummaries : [],
    rejectedTargets: objectItems(candidate.rejectedTargets).map(item => ({
      identity: compact(item.identity, 500),
      reason: redactSecrets(item.reason, 300),
      observedAt: timestamp(item.observedAt),
    })),
    doNotRetry: objectItems(candidate.doNotRetry).map(item => ({
      fingerprint: compact(item.fingerprint, 1000),
      reason: redactSecrets(item.reason, 300),
      observedAt: timestamp(item.observedAt),
    })),
    updatedAt: timestamp(candidate.updatedAt),
  });
}

export function updateTaskCapsuleV1(
  capsule: TaskCapsuleV1,
  update: TaskCapsuleUpdateV1,
): TaskCapsuleV1 {
  const current = normalizeCapsule(capsule);
  const observedAt = timestamp(update.updatedAt || update.correction?.observedAt || current.updatedAt);
  let target = normalizeTarget(update.target, current.target);
  let latestCorrection = current.latestCorrection;
  let rejectedTargets = current.rejectedTargets;
  let doNotRetry = mergeDoNotRetry(
    current.doNotRetry,
    deterministicReceiptExclusions(update.receipts || []),
  );

  if (update.correction) {
    const previousTarget = targetIdentity(current.target);
    const replacementTarget = compact(
      update.correction.path || update.correction.target || update.correction.application,
      500,
    );
    if (update.correction.rejectCurrentTarget && previousTarget) {
      const reason = redactSecrets(
        update.correction.reason || `Rejected by user correction: ${update.correction.text}`,
        300,
      );
      rejectedTargets = mergeRejectedTargets(rejectedTargets, [{
        identity: previousTarget,
        reason,
        observedAt,
      }]);
      doNotRetry = mergeDoNotRetry(doNotRetry, [{
        fingerprint: targetFingerprint(previousTarget),
        reason,
        observedAt,
      }]);
    }
    target = replacementTarget
      ? normalizeTarget({
          label: update.correction.target
            || (update.correction.path ? fileNameFromPath(update.correction.path) : '')
            || update.correction.application
            || fileNameFromPath(replacementTarget),
          application: update.correction.application || current.target.application,
          window: '',
          object: update.correction.path
            ? fileNameFromPath(update.correction.path)
            : update.correction.target || fileNameFromPath(replacementTarget),
          path: update.correction.path || '',
          location: update.correction.location || '',
          status: 'candidate',
          source: 'user_correction',
        }, current.target)
      : normalizeTarget({
          status: 'rejected',
          source: 'user_correction',
        }, current.target);
    latestCorrection = {
      text: redactSecrets(update.correction.text, 500),
      previousTarget,
      replacementTarget,
      observedAt,
      ...(compact(update.correction.eventRef, 180)
        ? { eventRef: compact(update.correction.eventRef, 180) }
        : {}),
    };
  }

  const receiptSteps = completedStepsFromReceipts(update.receipts || []);
  const completedByReceipt = new Map<string, TaskCapsuleCompletedStepV1>();
  for (const step of [...current.completedSteps, ...receiptSteps]) {
    const key = compact(step.receiptId, 180) || `${step.toolName}:${step.target}`;
    if (key) completedByReceipt.set(key, step);
  }

  const next = normalizeCapsule({
    ...current,
    currentInstruction: update.instruction !== undefined
      ? redactSecrets(update.instruction, 700)
      : current.currentInstruction,
    target,
    paths: uniqueStrings([
      ...current.paths,
      update.target?.path,
      update.correction?.path,
    ], 8, 500),
    latestCorrection,
    completedSteps: [...completedByReceipt.values()],
    blocker: update.blocker !== undefined ? redactSecrets(update.blocker, 500) : current.blocker,
    toolSummaries: uniqueStrings([
      ...current.toolSummaries,
      ...(update.toolSummaries || []),
      ...(update.receipts || []).map(receiptSummary),
    ], MAX_TOOL_SUMMARIES, 520),
    rejectedTargets: mergeRejectedTargets(rejectedTargets, update.rejectedTargets || []),
    doNotRetry: mergeDoNotRetry(doNotRetry, update.doNotRetry || []),
    updatedAt: observedAt,
  });
  const projection = buildTaskTargetAnchorProjection({
    taskText: update.instruction || next.currentInstruction || next.goal,
    applicationHint: next.target.application,
    sourcePaths: next.paths,
    previousTarget: next.target,
    evidence: update.receipts || [],
    rejectedTargets: next.rejectedTargets.map(item => item.identity),
  });
  return normalizeCapsule({
    ...next,
    target: preserveStructuredCorrectionTarget(
      projection.target,
      next.target,
      next.latestCorrection,
    ),
    paths: uniqueStrings(
      next.paths.filter(candidate => !isUnconfirmedRuntimeCandidate(candidate, update.instruction || next.goal)),
      8,
      500,
    ),
    allowedSearchRoots: projection.allowedSearchRoots,
    analysisReady: projection.analysisReady,
    nextAction: projection.nextAction,
  });
}

function correctionPostStateMatches(
  capsule: TaskCapsuleV1,
  correction: TaskCapsuleCorrectionV1,
  text: string,
  replacementIdentity: string,
): boolean {
  if (correction.text !== redactSecrets(text, 500)) return false;
  if (targetFingerprint(replacementIdentity) !== targetFingerprint(correction.replacementTarget)) {
    return false;
  }

  const currentIdentity = targetIdentity(capsule.target);
  const expectedIdentity = correction.replacementTarget || correction.previousTarget;
  if (!expectedIdentity
    || targetFingerprint(currentIdentity) !== targetFingerprint(expectedIdentity)) return false;
  if (!correction.replacementTarget && capsule.target.status !== 'rejected') return false;

  if (correction.previousTarget) {
    const rejectedFingerprint = targetFingerprint(correction.previousTarget);
    if (!capsule.rejectedTargets.some(item => (
      targetFingerprint(item.identity) === rejectedFingerprint
    ))) return false;
    if (!capsule.doNotRetry.some(item => item.fingerprint === rejectedFingerprint)) return false;
  }
  return true;
}

function bindCorrectionEventRef(
  capsule: TaskCapsuleV1,
  eventRef: string,
): TaskCapsuleV1 {
  if (!capsule.latestCorrection) return capsule;
  return normalizeCapsule({
    ...capsule,
    latestCorrection: {
      ...capsule.latestCorrection,
      eventRef,
    },
  });
}

function recordRepeatedCorrectionEvent(
  capsule: TaskCapsuleV1,
  text: string,
  eventRef: string,
  observedAt: string,
): TaskCapsuleV1 {
  if (!capsule.latestCorrection) return capsule;
  return normalizeCapsule({
    ...capsule,
    currentInstruction: redactSecrets(text, 700),
    latestCorrection: {
      ...capsule.latestCorrection,
      text: redactSecrets(text, 500),
      observedAt,
      eventRef,
    },
    updatedAt: observedAt,
  });
}

function applyTargetTurn(
  capsule: TaskCapsuleV1,
  text: string,
  source: DurableTaskCapsuleSource,
  observedAt: string,
  eventRef?: string,
): TaskCapsuleV1 {
  const kind = classifyTaskCapsuleTurn(text, source);
  if (kind === 'none') return capsule;
  const parsed = targetUpdateFromTurn(text);
  if (!parsed) return capsule;
  const currentIdentity = targetIdentity(capsule.target);
  const replacementIdentity = compact(parsed.path || parsed.target || parsed.application, 500);
  const changedTarget = Boolean(
    replacementIdentity
    && targetFingerprint(replacementIdentity) !== targetFingerprint(currentIdentity),
  );
  const previousCorrection = capsule.latestCorrection;
  const normalizedEventRef = compact(eventRef, 180);
  const previousEventRef = compact(previousCorrection?.eventRef, 180);
  const expectedPostState = Boolean(
    previousCorrection
    && correctionPostStateMatches(capsule, previousCorrection, text, replacementIdentity),
  );

  if (previousCorrection && normalizedEventRef && previousEventRef === normalizedEventRef) {
    // An immutable event id is a replay only while every correction side
    // effect is still in its expected post-state.
    if (expectedPostState) return capsule;
    // A same-id/state conflict is not classified as replay. It is fail-closed:
    // preserve the observed current state instead of rolling an older event
    // over a newer or otherwise inconsistent target.
    return capsule;
  }
  if (previousCorrection && expectedPostState) {
    if (!previousEventRef && normalizedEventRef) {
      // Legacy capsules did not retain a stable event id. Once the owning
      // persisted row/request is available, bind it without rewriting any
      // correction, rejection, or do-not-retry timestamp.
      return bindCorrectionEventRef(capsule, normalizedEventRef);
    }
    if (previousEventRef && normalizedEventRef && previousEventRef !== normalizedEventRef) {
      // The same words in another durable user event are not a replay. Record
      // the new event identity, while preserving the already-correct target
      // and avoiding a false rejection of that target.
      return recordRepeatedCorrectionEvent(capsule, text, normalizedEventRef, observedAt);
    }
    // With no stable incoming identity, legacy hydration can only preserve an
    // already-complete exact post-state; it must not fabricate replay proof.
    return capsule;
  }
  return updateTaskCapsuleV1(capsule, {
    instruction: text,
    correction: {
      text,
      target: parsed.target,
      path: parsed.path,
      application: parsed.application,
      location: parsed.location,
      rejectCurrentTarget: parsed.rejectCurrentTarget || changedTarget,
      reason: parsed.rejectCurrentTarget
        ? 'The user explicitly rejected the previous target.'
        : 'The user supplied a more specific target for the active task.',
      observedAt,
      eventRef: normalizedEventRef || undefined,
    },
    updatedAt: observedAt,
  });
}

export function buildTaskCapsuleV1(
  source: DurableTaskCapsuleSource | null | undefined,
  options: BuildTaskCapsuleOptions = {},
): TaskCapsuleV1 | null {
  if (!source) return null;
  const goal = redactSecrets(source.goal, 700);
  const taskId = compact(source.taskId, 180);
  if (!goal && !taskId) return null;

  const updatedAt = timestamp(options.observedAt || source.updatedAt);
  const previous = options.previousCapsule
    && compact(options.previousCapsule.taskId, 180) === taskId
    ? normalizeCapsule(options.previousCapsule)
    : null;
  const targetContext = [
    options.currentTurnText,
    source.latestInstruction,
    goal,
  ].map(value => compact(value, 700)).filter(Boolean).join('\n');
  const paths = uniqueStrings(source.sourcePaths || [], 8, 500)
    .filter(candidate => !isUnconfirmedRuntimeCandidate(candidate, targetContext));
  const successfulReceiptTarget = [...(source.receipts || [])]
    .reverse()
    .find(receipt => receipt.outcome === 'success' && receiptTarget(receipt));
  const receiptPathCandidate = successfulReceiptTarget ? receiptTarget(successfulReceiptTarget) : '';
  const receiptPath = isUnconfirmedRuntimeCandidate(receiptPathCandidate, targetContext)
    ? ''
    : receiptPathCandidate;
  const explicitStatePath = paths.at(-1) || '';
  const statePath = explicitStatePath || receiptPath;
  const stateApplication = compact(source.appTarget, 160);
  const initialTarget = normalizeTarget({
    label: fileNameFromPath(statePath) || stateApplication,
    application: stateApplication,
    window: '',
    object: fileNameFromPath(statePath),
    path: statePath,
    location: '',
    status: statePath || stateApplication ? 'confirmed' : 'unresolved',
    source: explicitStatePath || stateApplication
      ? 'durable_state'
      : receiptPath
        ? 'tool_receipt'
        : 'unknown',
  });
  const previousCorrectionTarget = previous?.target.source === 'user_correction'
    && ['candidate', 'rejected'].includes(previous.target.status)
    ? previous.target
    : null;
  const receiptConfirmsPreviousCorrection = Boolean(
    previousCorrectionTarget
    && receiptPath
    && targetFingerprint(receiptPath) === targetFingerprint(targetIdentity(previousCorrectionTarget)),
  );
  const baseTarget = receiptConfirmsPreviousCorrection
    ? normalizeTarget({
        ...previousCorrectionTarget,
        path: receiptPath,
        status: 'confirmed',
        source: 'tool_receipt',
      })
    : previousCorrectionTarget
      // A durable active-window/document candidate from the previous revision
      // is more specific than the generic appTarget rebuilt on every
      // normalization pass. Replacing "Draft.pptx" with "WPS" here made a
      // following "not this file" correction reject the application instead
      // of the exact observed document. Fresh receipt evidence is reconciled by
      // the target-anchor projection below and may still advance this target.
      || previous?.target
      || (initialTarget.status !== 'unresolved' ? initialTarget : null)
      || initialTarget;

  let capsule = normalizeCapsule({
    schemaVersion: 1,
    taskId,
    revision: Math.max(0, Math.trunc(Number(source.revision) || 0)),
    status: source.status || (source.unfinished ? 'blocked' : 'completed'),
    unfinished: Boolean(source.unfinished),
    goal,
    currentInstruction: redactSecrets(source.latestInstruction || goal, 700),
    target: baseTarget,
    paths: uniqueStrings([...(previous?.paths || []), ...paths], 8, 500),
    allowedSearchRoots: allowedTaskSearchRoots(targetContext, paths),
    analysisReady: false,
    nextAction: 'clarify_target',
    latestCorrection: previous?.latestCorrection || null,
    completedSteps: [
      ...(previous?.completedSteps || []),
      ...completedStepsFromReceipts(source.receipts || []),
    ],
    blocker: redactSecrets(source.latestBlocker, 500),
    toolSummaries: uniqueStrings([
      ...(previous?.toolSummaries || []),
      ...(source.toolSummaries || []),
      ...(source.receipts || []).map(receiptSummary),
    ], MAX_TOOL_SUMMARIES, 520),
    rejectedTargets: previous?.rejectedTargets || [],
    doNotRetry: mergeDoNotRetry(
      previous?.doNotRetry || [],
      deterministicReceiptExclusions(source.receipts || []),
    ),
    updatedAt,
  });

  // Rebuild correction state from the durable latest instruction. This keeps
  // the capsule stable even before a dedicated persisted capsule column exists.
  const latestInstruction = compact(source.latestInstruction, 700);
  const latestInstructionRef = compact(source.latestInstructionRef, 180);
  if (latestInstruction && latestInstruction !== goal) {
    capsule = applyTargetTurn(
      capsule,
      latestInstruction,
      source,
      timestamp(source.updatedAt),
      latestInstructionRef,
    );
  }

  const currentTurn = compact(options.currentTurnText, 700);
  const currentTurnRef = compact(options.currentTurnRef, 180);
  if (currentTurn && (
    currentTurn !== latestInstruction
    || Boolean(currentTurnRef && currentTurnRef !== latestInstructionRef)
  )) {
    capsule = applyTargetTurn(capsule, currentTurn, source, updatedAt, currentTurnRef);
  }
  const projection = buildTaskTargetAnchorProjection({
    taskText: targetContext,
    applicationHint: capsule.target.application || stateApplication,
    sourcePaths: capsule.paths,
    previousTarget: capsule.target,
    evidence: source.receipts || [],
    rejectedTargets: capsule.rejectedTargets.map(item => item.identity),
  });
  return normalizeCapsule({
    ...capsule,
    target: preserveStructuredCorrectionTarget(
      projection.target,
      capsule.target,
      capsule.latestCorrection,
    ),
    paths: capsule.paths.filter(candidate => !isUnconfirmedRuntimeCandidate(candidate, targetContext)),
    allowedSearchRoots: projection.allowedSearchRoots,
    analysisReady: projection.analysisReady,
    nextAction: projection.nextAction,
  });
}

export function formatTaskCapsuleForPrompt(capsule: TaskCapsuleV1): string {
  const normalized = normalizeCapsule(capsule);
  const target = normalized.target;
  const promptPaths = normalized.paths.slice(-4).map(path => redactSecrets(path, 240));
  const promptCompletedSteps = normalized.completedSteps.slice(-6);
  const promptRejectedTargets = normalized.rejectedTargets.slice(-4);
  const promptDoNotRetry = normalized.doNotRetry.slice(-4);
  const promptToolSummaries = normalized.toolSummaries.slice(-5);
  return [
    'Current task capsule (TaskCapsuleV1):',
    `- taskId: ${normalized.taskId || '(conversation scoped)'}`,
    `- revision: ${normalized.revision}`,
    `- status: ${normalized.status}`,
    `- unfinished: ${normalized.unfinished ? 'yes' : 'no'}`,
    `- goal: ${normalized.goal}`,
    `- currentInstruction: ${normalized.currentInstruction}`,
    `- target: ${target.label || '(unresolved)'}`,
    `- targetStatus: ${target.status}`,
    `- targetSource: ${target.source}`,
    target.application ? `- targetApplication: ${target.application}` : '',
    target.window ? `- targetWindow: ${target.window}` : '',
    target.object ? `- targetObject: ${target.object}` : '',
    target.path ? `- targetPath: ${target.path}` : '',
    target.location ? `- targetLocation: ${target.location}` : '',
    `- analysisReady: ${normalized.analysisReady ? 'yes' : 'no'}`,
    `- nextAction: ${normalized.nextAction}`,
    normalized.allowedSearchRoots.length
      ? `- allowedSearchRoots: ${normalized.allowedSearchRoots.join(' | ')}`
      : '',
    promptPaths.length ? `- knownPaths: ${promptPaths.join(' | ')}` : '',
    normalized.latestCorrection ? '- latestCorrection:' : '',
    normalized.latestCorrection
      ? `  - text: ${normalized.latestCorrection.text}`
      : '',
    normalized.latestCorrection?.previousTarget
      ? `  - rejectedPreviousTarget: ${normalized.latestCorrection.previousTarget}`
      : '',
    normalized.latestCorrection?.replacementTarget
      ? `  - replacementTarget: ${normalized.latestCorrection.replacementTarget}`
      : '',
    promptCompletedSteps.length ? '- completedSteps (receipt-backed only):' : '',
    ...promptCompletedSteps.map(step => `  - ${redactSecrets(step.summary, 300)}`),
    normalized.blocker ? `- blocker: ${redactSecrets(normalized.blocker, 380)}` : '',
    promptRejectedTargets.length ? '- rejectedTargets:' : '',
    ...promptRejectedTargets.map(item => `  - ${redactSecrets(item.identity, 220)} | ${redactSecrets(item.reason, 140)}`),
    promptDoNotRetry.length ? '- doNotRetry:' : '',
    ...promptDoNotRetry.map(item => `  - ${redactSecrets(item.fingerprint, 220)} | ${redactSecrets(item.reason, 140)}`),
    promptToolSummaries.length ? '- boundedToolReceiptSummaries:' : '',
    ...promptToolSummaries.map(summary => `  - ${redactSecrets(summary, 320)}`),
    'Capsule rules:',
    '- The latest correction overrides an older target; never retry a rejected target or exact doNotRetry fingerprint automatically.',
    '- For a current WPS document, observe the active window/document interface first. Do not infer the target from the process working directory.',
    '- File discovery is limited to allowedSearchRoots. entry.cjs, node_modules, and runtime/project paths are not user material unless the user explicitly named that exact path.',
    '- Do not analyze file contents while analysisReady=no. Ask the clarification implied by nextAction if observation and bounded discovery cannot produce a displayable final filename.',
    '- completedSteps are receipt-backed. A plan, assistant claim, or raw historical message is not completion evidence.',
    '- Keep ordinary conversation in natural history. This capsule carries execution state only and contains no raw tool result.',
  ].filter(Boolean).join('\n');
}
