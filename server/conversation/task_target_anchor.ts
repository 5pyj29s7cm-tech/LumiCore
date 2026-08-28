import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { CN_TASK_TARGET_ANCHOR_MESSAGES } from '../regions/packs/cn/task_target_anchor_messages';

export type TaskTargetAnchorStatus = 'unresolved' | 'candidate' | 'confirmed' | 'rejected';
export type TaskTargetAnchorSource =
  | 'durable_state'
  | 'tool_receipt'
  | 'user_correction'
  | 'active_window'
  | 'running_window'
  | 'document_interface'
  | 'unknown';

export interface TaskTargetAnchorV1 {
  label: string;
  application: string;
  window: string;
  object: string;
  path: string;
  location: string;
  status: TaskTargetAnchorStatus;
  source: TaskTargetAnchorSource;
}

export interface TaskTargetEvidenceRecord {
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  receipt?: unknown;
  error?: string;
  outcome?: 'success' | 'partial' | 'failure';
  terminalVerification?: { status?: string };
}

export interface TaskTargetAnchorProjectionV1 {
  target: TaskTargetAnchorV1;
  allowedSearchRoots: string[];
  /** A trusted foreground or unique background authoring window matches the anchored object. */
  windowVerified: boolean;
  /** The anchored object has one concrete filesystem path. */
  pathResolved: boolean;
  analysisReady: boolean;
  nextAction: 'analyze' | 'inspect_active_document' | 'search_bounded_roots' | 'clarify_target';
  clarification: string;
  ignoredCandidates: string[];
}

export interface BuildTaskTargetAnchorInput {
  taskText: string;
  applicationHint?: string;
  sourcePaths?: string[];
  previousTarget?: Partial<TaskTargetAnchorV1> | null;
  evidence?: TaskTargetEvidenceRecord[];
  rejectedTargets?: string[];
}

export interface TaskTargetToolCallGuardResult {
  allowed: boolean;
  reason: string;
  /** Server-owned arguments completed from one exact trusted task anchor. */
  normalizedArguments?: Record<string, unknown>;
  code?:
    | 'target_unresolved'
    | 'active_document_required'
    | 'search_scope_required'
    | 'search_scope_forbidden'
    | 'runtime_candidate_forbidden'
    | 'target_mismatch'
    | 'rejected_target'
    | 'unstructured_file_access_forbidden';
  status?: 'blocked';
  clarification?: {
    required: true;
    question: string;
  };
  anchor?: TaskTargetAnchorProjectionV1;
}

const FILE_EXTENSIONS = '(?:pptx?|docx?|xlsx?|pdf|txt|md|csv|json|png|jpe?g|gif|svg|dwg|dxf|zip)';
const FILE_NAME_RE = new RegExp(`([^\\\\/\\r\\n，,;；"'“”‘’]{1,180}\\.${FILE_EXTENSIONS})`, 'iu');
const ABSOLUTE_FILE_RE = new RegExp(`(?:[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\r\\n，,；;。！？!?"'“”‘’]{1,420}\\.${FILE_EXTENSIONS}`, 'iu');
const POSIX_ABSOLUTE_FILE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.:/\\\\-])/(?:[^/\\\\\\r\\n，,；;。！？!?"'“”‘’]{1,180}/)*[^/\\\\\\r\\n，,；;。！？!?"'“”‘’]{1,180}\\.${FILE_EXTENSIONS}(?![\\p{L}\\p{N}_/\\\\-])`,
  'iu',
);
const POSIX_ABSOLUTE_PATH_RE = /(?<![\p{L}\p{N}_.:/\\-])\/(?:[^/\\\s\r\n，,；;。！？!?"'“”‘’]+\/)*[^/\\\s\r\n，,；;。！？!?"'“”‘’]+(?![\p{L}\p{N}_.\/\\-])/gu;
const POSIX_QUOTED_PATH_RE = /"(\/[^"\\\r\n]{1,498})"|'(\/[^'\\\r\n]{1,498})'|“(\/[^”\\\r\n]{1,498})”|‘(\/[^’\\\r\n]{1,498})’/gu;
// i18n-allow: multilingual file-task intent recognition; not user-visible copy.
const FILE_TASK_RE = /(?:分析|读取|读一下|查看|检查|总结|提取|处理|资料|文件|文档|PPT|演示文稿|表格|图片|图纸|当前打开|正在打开)|\b(?:analy[sz]e|read|inspect|review|summari[sz]e|extract|file|document|presentation|sheet|image|drawing|currently?\s+open)\b/iu;
// i18n-allow: multilingual file action recognition; not user-visible copy.
const FILE_ACTION_RE = /(?:分析|读取|读一下|查看|检查|总结|提取|处理|打开|资料)|\b(?:analy[sz]e|read|inspect|review|summari[sz]e|extract|process|open)\b/iu;
// i18n-allow: multilingual current-document reference recognition; not user-visible copy.
const CURRENT_DOCUMENT_RE = /(?:当前|现在|正在|刚才|刚刚)(?:\s*(?:打开|前台|活动))?(?:\s*的)?(?:\s*(?:这份|这个))?(?:\s*(?:文件|文档|PPT|演示文稿|表格|资料))|(?:当前|活动|前台)窗口|\b(?:current|currently\s+open|active|foreground|opened)\b.{0,24}\b(?:file|document|presentation|sheet|window)\b/iu;
// i18n-allow: deictic current-document input recognition; not user-visible copy.
const IMPLICIT_CURRENT_DOCUMENT_RE = /(?:(?:(?:当前|现在|正在|刚才|刚刚).{0,12}打开(?:着|的)?|打开(?:着|的)).{0,8}(?:这份|这个|该)?(?:文件|文档|PPT|演示文稿|表格|资料)|\b(?:currently?\s+open|opened|active|foreground)\b.{0,24}\b(?:file|document|presentation|sheet)\b)/iu;
// i18n-allow: WPS product/process recognition; not user-visible copy.
const WPS_RE = /(?:^|\b)(?:WPS|wps\.exe|wpp\.exe|et\.exe)(?:\b|$)|金山(?:文字|表格|演示|WPS)/iu;
const AUTHORING_APPLICATION_RE = /(?:^|\b)(?:WPS|wps\.exe|wpp\.exe|et\.exe|Microsoft\s+Word|WINWORD\.EXE|Microsoft\s+Excel|EXCEL\.EXE|Microsoft\s+PowerPoint|POWERPNT\.EXE)(?:\b|$)|金山(?:文字|表格|演示|WPS)/iu;
const ACTIVE_WINDOW_TOOLS = new Set(['desktop_active_window', 'get_active_window_info']);
const RUNNING_PROCESS_TOOLS = new Set(['desktop_running_processes', 'get_running_processes']);
const DISCOVERY_TOOLS = new Set(['search_files', 'desktop_list_files', 'list_directory']);
const DOCUMENT_INTERFACE_RE = /^(?:extract_document_text|read_file|read_files_batch|read_pdf|read_docx|read_xlsx|pdf_to_text|ocr_image_file|(?:desktop_|filesystem_|mcp_[^_]+_)?read_(?:text_)?file|wps_.*(?:read|extract|inspect|analy)|document_.*(?:read|extract|inspect|analy))/i;
const CURRENT_DOCUMENT_INTERFACE_RE = /^wps_.*(?:read|extract|inspect|analy)/i;
const UNSTRUCTURED_FILE_ACCESS_TOOL_RE = /^(?:computer_use|(?:.*_)?(?:run_command|code_execution|python_exec|node_exec|shell_exec|terminal_exec|powershell|execute_script|run_script|script_exec))$/i;
const RUNTIME_BASENAME_RE = /^(?:entry\.cjs|node(?:\.exe)?|electron(?:\.exe)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const RUNTIME_SEGMENT_RE = /(?:^|[\\/])(?:node_modules|dist-server|\.next|\.vite|src-tauri[\\/]target|target[\\/](?:debug|release)|resources[\\/]app\.asar\.unpacked)(?:[\\/]|$)/i;
const STANDARD_ROOT_ALIAS_RE = /^~[\\/](?:Desktop|Documents|Downloads)(?:[\\/]|$)/i;
const TARGET_PATH_KEYS = [
  'path', 'filePath', 'filepath', 'documentPath', 'documentpath', 'targetPath', 'targetpath',
  'sourcePath', 'sourcepath', 'inputPath', 'inputpath', 'outputPath', 'outputpath', 'target', 'file',
];
const TARGET_NAME_KEYS = ['documentName', 'documentname', 'fileName', 'filename', 'name', 'objectName', 'objectname'];
const WINDOW_KEYS = ['windowTitle', 'windowtitle', 'title', 'caption', 'window'];
const APPLICATION_KEYS = ['application', 'applicationName', 'applicationname', 'appName', 'appname', 'processName', 'processname', 'process_name'];

function compact(value: unknown, limit = 500): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseNestedJson(value: unknown): unknown {
  let parsed = value;
  for (let depth = 0; depth < 3 && typeof parsed === 'string'; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = parseNestedJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function firstString(object: Record<string, unknown>, keys: string[], limit = 500): string {
  for (const key of keys) {
    const direct = object[key];
    if (typeof direct === 'string' || typeof direct === 'number') {
      const value = compact(direct, limit);
      if (value) return value;
    }
    const normalizedKey = key.replace(/[_-]/g, '').toLowerCase();
    const entry = Object.entries(object).find(([candidate]) => (
      candidate.replace(/[_-]/g, '').toLowerCase() === normalizedKey
    ));
    if (entry && (typeof entry[1] === 'string' || typeof entry[1] === 'number')) {
      const value = compact(entry[1], limit);
      if (value) return value;
    }
  }
  return '';
}

function normalizedIdentity(value: unknown): string {
  return compact(value, 500)
    .replace(/[\\/]+/g, '/')
    .replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '')
    .toLocaleLowerCase();
}

interface CanonicalPathValue {
  flavor: 'win32' | 'posix';
  normalized: string;
  identity: string;
  absolute: boolean;
}

function canonicalPathValue(value: unknown): CanonicalPathValue | null {
  let clean = compact(value, 500)
    .replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '');
  if (!clean) return null;
  if (/^~[\\/]/u.test(clean)) {
    clean = path.join(os.homedir(), clean.slice(2));
  }
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(clean);
  const posixPath = clean.startsWith('/');
  // Backslashes are valid Windows separators but ambiguous POSIX filename
  // characters. Reject mixed POSIX paths instead of normalizing an attacker-
  // controlled traversal into a trusted search root.
  if (posixPath && clean.includes('\\')) return null;
  clean = windowsPath ? clean.replace(/\//g, '\\') : clean;
  const flavor = windowsPath ? path.win32 : path.posix;
  let normalized = flavor.normalize(clean);
  const absolute = flavor.isAbsolute(normalized);

  // Resolve an existing ancestor so a junction/symlink below an allowed root
  // cannot escape it. Preserve a non-existing suffix for planned output paths.
  const suffix: string[] = [];
  let probe = normalized;
  const nativePathFlavor = windowsPath === (process.platform === 'win32');
  try {
    // Never ask the local filesystem to resolve a foreign-host path. Lexical
    // normalization remains fail-closed; native paths additionally resolve
    // existing ancestors to prevent junction/symlink escapes.
    if (absolute && nativePathFlavor) {
      while (!fs.existsSync(probe)) {
        const parent = flavor.dirname(probe);
        if (!parent || parent === probe) break;
        suffix.unshift(flavor.basename(probe));
        probe = parent;
      }
      if (fs.existsSync(probe)) {
        const realAncestor = fs.realpathSync.native(probe);
        normalized = flavor.resolve(realAncestor, ...suffix);
      }
    }
  } catch {
    // A native path that started resolving but cannot be inspected is not safe
    // to compare lexically: an inaccessible junction/symlink could otherwise
    // escape an allowed root. Foreign-host paths never enter this branch.
    return null;
  }
  const comparisonPath = windowsPath ? normalized.toLocaleLowerCase() : normalized;
  return {
    flavor: windowsPath ? 'win32' : 'posix',
    normalized: comparisonPath,
    identity: comparisonPath.replace(/[\\/]+/g, '/'),
    absolute,
  };
}

function canonicalPathIdentity(value: unknown): string {
  return canonicalPathValue(value)?.identity || '';
}

function explicitPathFlavor(value: unknown): CanonicalPathValue['flavor'] | null {
  const clean = compact(value, 500).replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '');
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(clean)) return 'win32';
  if (/^~[\\/]/u.test(clean)) return process.platform === 'win32' ? 'win32' : 'posix';
  if (clean.startsWith('/') && !clean.includes('\\')) return 'posix';
  return null;
}

function fileNamesMatchByPathFlavor(left: unknown, right: unknown): boolean {
  const leftName = fileName(left);
  const rightName = fileName(right);
  if (!leftName || !rightName) return false;
  const leftFlavor = explicitPathFlavor(left);
  const rightFlavor = explicitPathFlavor(right);
  if (leftFlavor && rightFlavor && leftFlavor !== rightFlavor) return false;
  const flavor = leftFlavor || rightFlavor || (process.platform === 'win32' ? 'win32' : 'posix');
  return flavor === 'win32'
    ? leftName.toLowerCase() === rightName.toLowerCase()
    : leftName === rightName;
}

function targetReferenceMatches(candidate: unknown, expected: unknown): boolean {
  const expectedFlavor = explicitPathFlavor(expected);
  const expectedPath = canonicalPathValue(expected);
  if (expectedFlavor) {
    if (!expectedPath?.absolute || expectedPath.flavor !== expectedFlavor) return false;
    const candidatePath = canonicalPathValue(candidate);
    return Boolean(
      candidatePath?.absolute
      && candidatePath.flavor === expectedPath.flavor
      && candidatePath.identity === expectedPath.identity,
    );
  }
  return fileNamesMatchByPathFlavor(candidate, expected);
}

function fileName(value: unknown): string {
  const clean = compact(value, 500).replace(/[。！？.!?]+$/u, '');
  if (!clean) return '';
  const segments = clean.split(/[\\/]/).filter(Boolean);
  return compact(segments.at(-1) || clean, 220);
}

function displayableFileName(value: unknown): string {
  const clean = fileName(value);
  return new RegExp(`\\.${FILE_EXTENSIONS}$`, 'iu').test(clean) ? clean : '';
}

function concreteTargetPath(value: unknown): boolean {
  const clean = compact(value, 500);
  if (clean.startsWith('/') && clean.includes('\\')) return false;
  return /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/[A-Za-z0-9_.-])/u.test(clean);
}

function explicitFile(text: string): string {
  const clean = primaryTaskText(text);
  // i18n-allow: multilingual user target-correction recognition; not user-visible copy.
  const replacement = clean.match(/(?:而是|应该是|改成|换成|(?<!不)要用|请用|instead(?:\s+use)?|replace(?:\s+it)?\s+with)\s*([^\r\n]{1,240})/iu)?.[1];
  const targetClause = compact(replacement || clean, 500);
  // i18n-allow: multilingual explicit filename recognition; not user-visible copy.
  const named = targetClause.match(new RegExp(
    `(?:\u51c6\u786e\u6587\u4ef6\u540d\u662f|\u6587\u4ef6\u540d(?:\u79f0)?\u662f|\u53eb|\u540d\u4e3a|\u540d\u79f0\u662f|(?:exact\\s+)?file\\s*name\\s+is|named|called)\\s*["'“”‘’]?([^"'“”‘’\\r\\n，,；;。！？!?]{1,200}\\.${FILE_EXTENSIONS})`,
    'iu',
  ))?.[1];
  return compact(
    targetClause.match(ABSOLUTE_FILE_RE)?.[0]
      || targetClause.match(POSIX_ABSOLUTE_FILE_RE)?.[0]
      || named
      || targetClause.match(FILE_NAME_RE)?.[1],
    500,
  );
}

function explicitAbsolutePaths(text: string): string[] {
  const clean = primaryTaskText(text);
  const windowsMatches = clean.match(/(?:[A-Za-z]:[\\/]|~[\\/]|\\\\)[^\r\n，,；;。！？!?"'“”‘’]{1,420}/gu) || [];
  const quotedPosixMatches = [...clean.matchAll(POSIX_QUOTED_PATH_RE)]
    .map(match => match.slice(1).find(Boolean) || '')
    // compact() deliberately collapses whitespace, so reject quoted paths
    // whose filesystem identity could change during normalization.
    .filter(value => !/\s{2,}|[^\S ]/u.test(value));
  const unquotedPosixMatches = [...clean.matchAll(POSIX_ABSOLUTE_PATH_RE)].flatMap(match => {
    const value = match[0];
    const suffix = clean.slice((match.index || 0) + value.length);
    if (!suffix) return [value];
    if (/^[，,；;。！？!?"'”’\)\]}]/u.test(suffix)) return [value];
    if (!/^\s/u.test(suffix)) return [];
    const continuation = suffix.replace(/^\s+/u, '');
    if (!continuation) return [value];
    // An unquoted space may be prose or part of a POSIX filename. Only retain
    // the token when a conservative clause boundary makes that unambiguous.
    // i18n-allow: multilingual path-clause boundary recognition; not user-visible copy.
    return /^(?:(?:for|to|from|in|under|with|using|and|then|please)(?=$|\s|[，,；;。！？!?"'“”‘’\)\]}])|(?:中|里|下|内)(?=$|\s|[，,；;。！？!?"'“”‘’\)\]}]|查找|搜索|寻找|检索|读取)|(?:用于|然后|请)(?=$|\s|[，,；;。！？!?"'“”‘’\)\]}]))/iu.test(continuation)
      ? [value]
      : [];
  });
  return unique([...windowsMatches, ...quotedPosixMatches, ...unquotedPosixMatches], 12);
}

function unique(values: unknown[], limit = 12): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const clean = compact(value, 500);
    const key = normalizedIdentity(clean);
    if (!clean || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output.slice(-limit);
}

export function primaryTaskText(text: string): string {
  return String(text || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
}

function capsuleTaskText(text: string): string {
  const raw = String(text || '');
  if (!/Current task capsule \(TaskCapsuleV1\):/i.test(raw)) return '';
  return ['goal', 'currentInstruction', 'target', 'targetApplication', 'targetObject', 'targetPath']
    .map(name => compact(raw.match(new RegExp(`(?:^|\\n)- ${name}:\\s*(.+)`, 'i'))?.[1], 700))
    .filter(Boolean)
    .join(' ');
}

export function isFileTargetTask(text: string): boolean {
  const clean = `${primaryTaskText(text)} ${capsuleTaskText(text)}`.trim();
  return FILE_TASK_RE.test(clean) && FILE_ACTION_RE.test(clean);
}

export function prefersCurrentWpsDocument(text: string, applicationHint = ''): boolean {
  const clean = `${primaryTaskText(text)} ${capsuleTaskText(text)} ${compact(applicationHint, 160)}`;
  return WPS_RE.test(clean) && CURRENT_DOCUMENT_RE.test(clean);
}

export function prefersCurrentAuthoringDocument(text: string, applicationHint = ''): boolean {
  const task = `${primaryTaskText(text)} ${capsuleTaskText(text)}`;
  const clean = `${task} ${compact(applicationHint, 160)}`;
  return (CURRENT_DOCUMENT_RE.test(task) || IMPLICIT_CURRENT_DOCUMENT_RE.test(task))
    && (AUTHORING_APPLICATION_RE.test(clean) || IMPLICIT_CURRENT_DOCUMENT_RE.test(task));
}

function pathMentionedByUser(candidate: string, taskText: string): boolean {
  const target = normalizedIdentity(candidate);
  if (!target) return false;
  const primary = normalizedIdentity(primaryTaskText(taskText));
  if (primary.includes(target)) return true;
  const base = normalizedIdentity(displayableFileName(candidate));
  return Boolean(base && primary.includes(base));
}

function runtimeRoots(): string[] {
  return unique([
    process.cwd(),
    path.dirname(process.execPath || ''),
  ], 4).filter(root => normalizedIdentity(root) !== normalizedIdentity(path.parse(root).root));
}

/** Runtime/project artifacts are never inferred as user material. An exact user path remains valid. */
export function isUnconfirmedRuntimeCandidate(candidate: string, taskText: string): boolean {
  const clean = compact(candidate, 500);
  if (!clean || pathMentionedByUser(clean, taskText)) return false;
  if (RUNTIME_BASENAME_RE.test(fileName(clean)) || RUNTIME_SEGMENT_RE.test(clean)) return true;
  const normalized = normalizedIdentity(clean);
  return runtimeRoots().some(root => {
    const runtime = normalizedIdentity(root).replace(/\/$/, '');
    return Boolean(runtime && (normalized === runtime || normalized.startsWith(`${runtime}/`)));
  });
}

function explicitDirectory(pathValue: string): string {
  const clean = compact(pathValue, 500).replace(/[\\/]+$/, '');
  if (!clean) return '';
  if (displayableFileName(clean)) {
    const separatorIndex = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
    return separatorIndex > 1 ? clean.slice(0, separatorIndex) : '';
  }
  return clean;
}

export function allowedTaskSearchRoots(taskText: string, sourcePaths: string[] = []): string[] {
  const explicit = explicitAbsolutePaths(taskText).map(explicitDirectory).filter(Boolean);
  const safeSourceRoots = sourcePaths
    .filter(value => !isUnconfirmedRuntimeCandidate(value, taskText))
    .filter(value => pathMentionedByUser(value, taskText))
    .map(explicitDirectory)
    .filter(Boolean);
  return unique(['~/Desktop', '~/Documents', '~/Downloads', ...explicit, ...safeSourceRoots], 12);
}

function directoryWithin(candidate: string, root: string): boolean {
  const child = canonicalPathValue(candidate);
  const parent = canonicalPathValue(root);
  if (!child?.absolute || !parent?.absolute || child.flavor !== parent.flavor) return false;
  const flavor = child.flavor === 'win32' ? path.win32 : path.posix;
  const relative = flavor.relative(parent.normalized, child.normalized);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative));
}

function userProfileRoots(): string[] {
  const envHome = compact(process.env.USERPROFILE, 500);
  const driveHome = compact(`${process.env.HOMEDRIVE || ''}${process.env.HOMEPATH || ''}`, 500);
  const homes = unique([os.homedir(), envHome, driveHome], 4);
  return unique(homes.flatMap(home => [
    path.resolve(home, 'Desktop'),
    path.resolve(home, 'Documents'),
    path.resolve(home, 'Downloads'),
  ]), 12);
}

function isStandardUserDirectory(candidate: string): boolean {
  const clean = compact(candidate, 500);
  if (!clean) return false;
  const standardRoots = [
    ...(STANDARD_ROOT_ALIAS_RE.test(clean) ? ['~/Desktop', '~/Documents', '~/Downloads'] : []),
    ...userProfileRoots(),
  ];
  return standardRoots.some(root => directoryWithin(clean, root));
}

export function isAllowedTaskSearchDirectory(
  directory: string,
  taskText: string,
  sourcePaths: string[] = [],
): boolean {
  const clean = compact(directory, 500);
  if (!clean || isUnconfirmedRuntimeCandidate(clean, taskText)) return false;
  if (isStandardUserDirectory(clean)) return true;
  return allowedTaskSearchRoots(taskText, sourcePaths).some(root => directoryWithin(clean, root));
}

function recordSucceeded(record: TaskTargetEvidenceRecord): boolean {
  if (!record || compact(record.error, 300)) return false;
  if (record.outcome && record.outcome !== 'success') return false;
  if (record.terminalVerification?.status === 'failed') return false;
  const payload = objectValue(record.receipt ?? record.result);
  const status = compact(payload.status, 80).toLowerCase();
  return payload.ok !== false
    && payload.success !== false
    && !/^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|not_found)$/.test(status);
}

interface EvidenceCandidate extends TaskTargetAnchorV1 {
  kind: 'active_window' | 'running_window' | 'document_interface' | 'tool_receipt' | 'discovery';
}

function activeWindowCandidate(record: TaskTargetEvidenceRecord): EvidenceCandidate | null {
  const name = compact(record.name, 160).toLowerCase();
  if (!ACTIVE_WINDOW_TOOLS.has(name) || !recordSucceeded(record)) return null;
  const payload = objectValue(record.receipt ?? record.result);
  const window = firstString(payload, WINDOW_KEYS, 300);
  const applicationValue = firstString(payload, APPLICATION_KEYS, 160);
  const signature = `${applicationValue} ${window}`;
  const application = WPS_RE.test(signature) ? 'WPS' : compact(applicationValue, 160);
  const object = displayableFileName(window.match(FILE_NAME_RE)?.[1] || firstString(payload, TARGET_NAME_KEYS, 220));
  const pathValue = firstString(payload, TARGET_PATH_KEYS, 500);
  const candidatePath = displayableFileName(pathValue) ? pathValue : '';
  const label = object || displayableFileName(candidatePath);
  return {
    label,
    application,
    window,
    object: label,
    path: candidatePath,
    location: '',
    status: label ? 'confirmed' : 'unresolved',
    source: 'active_window',
    kind: 'active_window',
  };
}

type SupportedAuthoringApplication = 'WPS' | 'Microsoft Word' | 'Microsoft Excel' | 'Microsoft PowerPoint';

function supportedAuthoringApplication(processName: string): SupportedAuthoringApplication | '' {
  const executable = compact(processName, 160).split(/[\\/]/).pop()?.trim() || '';
  if (/^(?:wps|wpp|et|wpsoffice)(?:\.exe)?$/i.test(executable) || /^WPS Office$/i.test(executable)) return 'WPS';
  if (/^(?:winword(?:\.exe)?|Microsoft Word)$/i.test(executable)) return 'Microsoft Word';
  if (/^(?:excel(?:\.exe)?|Microsoft Excel)$/i.test(executable)) return 'Microsoft Excel';
  if (/^(?:powerpnt(?:\.exe)?|Microsoft PowerPoint)$/i.test(executable)) return 'Microsoft PowerPoint';
  return '';
}

function requestedAuthoringApplication(taskText: string, applicationHint = ''): SupportedAuthoringApplication | 'any' {
  const task = `${primaryTaskText(taskText)} ${capsuleTaskText(taskText)} ${compact(applicationHint, 160)}`;
  if (WPS_RE.test(task)) return 'WPS';
  if (/(?:Microsoft\s+)?PowerPoint|POWERPNT\.EXE/iu.test(task)) return 'Microsoft PowerPoint';
  if (/(?:Microsoft\s+)?Excel|EXCEL\.EXE/iu.test(task)) return 'Microsoft Excel';
  if (/(?:Microsoft\s+)?Word|WINWORD\.EXE/iu.test(task)) return 'Microsoft Word';
  return 'any';
}

function candidateMatchesRequestedAuthoringApplication(
  candidate: EvidenceCandidate,
  taskText: string,
  applicationHint = '',
): boolean {
  const actual = supportedAuthoringApplication(candidate.application);
  if (!actual) return false;
  const requested = requestedAuthoringApplication(taskText, applicationHint);
  return requested === 'any' || actual === requested;
}

function runningAuthoringWindowCandidates(
  record: TaskTargetEvidenceRecord,
  taskText: string,
  applicationHint = '',
): EvidenceCandidate[] {
  const name = compact(record.name, 160).toLowerCase();
  if (
    !RUNNING_PROCESS_TOOLS.has(name)
    || !recordSucceeded(record)
    || record.terminalVerification?.status !== 'verified'
  ) return [];
  const parsed = parseNestedJson(record.receipt ?? record.result);
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (['processes', 'items', 'results']
          .map(key => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray) as unknown[] | undefined) || []
      : [];
  const candidates: EvidenceCandidate[] = [];
  const seen = new Set<string>();
  for (const rawItem of items.slice(0, 100)) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    const processName = firstString(item, ['name', ...APPLICATION_KEYS], 160);
    const application = supportedAuthoringApplication(processName);
    if (!application) continue;
    const requested = requestedAuthoringApplication(taskText, applicationHint);
    if (requested !== 'any' && requested !== application) continue;
    const rawTitles = Array.isArray(item.window_titles)
      ? item.window_titles
      : Array.isArray(item.windowTitles)
        ? item.windowTitles
        : [];
    const titles = [
      ...rawTitles,
      firstString(item, ['window_title', 'windowTitle'], 300),
    ];
    for (const rawTitle of titles) {
      if (typeof rawTitle !== 'string') continue;
      const window = compact(rawTitle, 300);
      const object = displayableFileName(window.match(FILE_NAME_RE)?.[1]);
      if (!window || !object) continue;
      const identity = normalizedIdentity(`${application}|${object}`);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({
        label: object,
        application,
        window,
        object,
        path: '',
        location: '',
        status: 'confirmed',
        source: 'running_window',
        kind: 'running_window',
      });
      if (candidates.length >= 16) return candidates;
    }
  }
  return candidates;
}

function documentCandidate(record: TaskTargetEvidenceRecord): EvidenceCandidate | null {
  const name = compact(record.name, 160);
  const documentInterface = DOCUMENT_INTERFACE_RE.test(name);
  const verifiedArtifactMutation = /^(?:write_file|desktop_write_text_file|create_docx|create_xlsx|create_ppt|create_pdf)$/i.test(name)
    && record.terminalVerification?.status === 'verified';
  if ((!documentInterface && !verifiedArtifactMutation) || !recordSucceeded(record)) return null;
  const args = objectValue(record.arguments);
  const payload = objectValue(record.receipt ?? record.result);
  const pathValue = firstString(args, TARGET_PATH_KEYS, 500) || firstString(payload, TARGET_PATH_KEYS, 500);
  const object = displayableFileName(
    firstString(payload, TARGET_NAME_KEYS, 220)
      || firstString(args, TARGET_NAME_KEYS, 220)
      || pathValue,
  );
  const applicationValue = firstString(payload, APPLICATION_KEYS, 160);
  const application = WPS_RE.test(`${name} ${applicationValue}`) ? 'WPS' : compact(applicationValue, 160);
  const window = firstString(payload, WINDOW_KEYS, 300);
  if (!object && !pathValue && !window) return null;
  return {
    label: object || displayableFileName(pathValue),
    application,
    window,
    object,
    path: displayableFileName(pathValue) ? pathValue : '',
    location: '',
    status: object || displayableFileName(pathValue) ? 'confirmed' : 'unresolved',
    source: documentInterface ? 'document_interface' : 'tool_receipt',
    kind: documentInterface ? 'document_interface' : 'tool_receipt',
  };
}

function resultItems(value: unknown): Record<string, unknown>[] {
  const parsed = parseNestedJson(value);
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (['files', 'entries', 'items', 'results']
          .map(key => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray) as unknown[] | undefined) || []
      : [];
  return raw.slice(0, 100).flatMap(item => {
    if (typeof item === 'string') return [{ path: item }];
    return item && typeof item === 'object' && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : [];
  });
}

function discoveryCandidate(
  record: TaskTargetEvidenceRecord,
  taskText: string,
  preferredName: string,
  preferredReference: string,
  sourcePaths: string[],
): EvidenceCandidate | null {
  const name = compact(record.name, 160).toLowerCase();
  if (!DISCOVERY_TOOLS.has(name) || !recordSucceeded(record) || !preferredName) return null;
  const args = objectValue(record.arguments);
  const directory = firstString(args, ['directory', 'path'], 500);
  if (!isAllowedTaskSearchDirectory(directory, taskText, sourcePaths)) return null;
  const matches = resultItems(record.receipt ?? record.result).flatMap(item => {
    const candidatePath = firstString(item, TARGET_PATH_KEYS, 500) || firstString(item, TARGET_NAME_KEYS, 220);
    if (!candidatePath || isUnconfirmedRuntimeCandidate(candidatePath, taskText)) return [];
    const resolvedCandidate = concreteTargetPath(candidatePath)
      ? candidatePath
      : `${directory.replace(/[\\/]+$/, '')}/${candidatePath}`;
    if (!directoryWithin(resolvedCandidate, directory)) return [];
    return targetReferenceMatches(resolvedCandidate, preferredReference || preferredName)
      ? [resolvedCandidate]
      : [];
  });
  const exact = unique(matches, 3);
  if (exact.length !== 1) return null;
  const resolvedPath = exact[0];
  return {
    label: fileName(resolvedPath),
    application: '',
    window: '',
    object: fileName(resolvedPath),
    path: resolvedPath,
    location: isStandardUserDirectory(resolvedPath) ? 'bounded_user_files' : '',
    status: 'confirmed',
    source: 'tool_receipt',
    kind: 'discovery',
  };
}

function mergeTarget(
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

function rejectedByIdentity(target: TaskTargetAnchorV1, rejectedTargets: string[]): boolean {
  const identities = [target.path, target.object, target.label]
    .map(normalizedIdentity)
    .filter(Boolean);
  return rejectedTargets.some(rejected => {
    const normalized = normalizedIdentity(rejected);
    const base = normalizedIdentity(fileName(rejected));
    return identities.some(identity => identity === normalized || identity === base);
  });
}

function capsuleRejectedTargets(taskText: string): string[] {
  const marker = String(taskText || '').split(/\n- rejectedTargets:\s*\n/i)[1];
  if (!marker) return [];
  return marker
    .split(/\n(?=- |Capsule rules:|Recent |Rules:)/i, 1)[0]
    .split(/\n/)
    .map(line => compact(line.replace(/^\s*-\s*/, '').split(/\s+\|\s+/, 1)[0], 500))
    .filter(Boolean)
    .slice(0, 8);
}

function capsuleTarget(taskText: string): Partial<TaskTargetAnchorV1> | null {
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

export function buildTaskTargetAnchorProjection(
  input: BuildTaskTargetAnchorInput,
): TaskTargetAnchorProjectionV1 {
  const taskText = String(input.taskText || '');
  const sourcePaths = unique(input.sourcePaths || [], 8);
  const ignoredCandidates = sourcePaths.filter(candidate => isUnconfirmedRuntimeCandidate(candidate, taskText));
  const safePaths = sourcePaths.filter(candidate => !ignoredCandidates.includes(candidate));
  const evidence = (input.evidence || []).filter(recordSucceeded);
  const activeCandidates = evidence.map(activeWindowCandidate).filter((item): item is EvidenceCandidate => Boolean(item));
  const documentCandidates = evidence.map(documentCandidate).filter((item): item is EvidenceCandidate => Boolean(item));
  const previous = input.previousTarget || capsuleTarget(taskText);
  const userFile = explicitFile(taskText);
  const currentWps = prefersCurrentWpsDocument(taskText, input.applicationHint || previous?.application || '');
  const currentAuthoringDocument = prefersCurrentAuthoringDocument(
    taskText,
    input.applicationHint || previous?.application || '',
  );
  const verifiedActiveCandidates = evidence
    .filter(record => record.terminalVerification?.status === 'verified')
    .map(activeWindowCandidate)
    .filter((item): item is EvidenceCandidate => Boolean(item));
  const latestActive = currentAuthoringDocument
    ? [...verifiedActiveCandidates].reverse().find(candidate => (
        Boolean(candidate.object)
        && candidateMatchesRequestedAuthoringApplication(
          candidate,
          taskText,
          input.applicationHint || previous?.application || '',
        )
      ))
    : [...activeCandidates].reverse().find(candidate => (
        !currentWps || WPS_RE.test(`${candidate.application} ${candidate.window}`)
      ));
  const backgroundCandidates = evidence
    .flatMap(record => runningAuthoringWindowCandidates(
      record,
      taskText,
      input.applicationHint || previous?.application || '',
    ))
    .filter((candidate, index, all) => all.findIndex(item => (
      normalizedIdentity(`${item.application}|${item.object}`)
      === normalizedIdentity(`${candidate.application}|${candidate.object}`)
    )) === index);
  // The actual foreground authoring document is authoritative when present.
  // Background enumeration is a fallback and must yield exactly one distinct
  // supported document; choosing from two visible documents would guess.
  const backgroundCandidate = !latestActive && backgroundCandidates.length === 1
    ? backgroundCandidates[0]
    : null;
  const currentWindowCandidate = latestActive || backgroundCandidate;
  const ambiguousBackgroundCandidates = Boolean(
    currentAuthoringDocument
    && !latestActive
    && backgroundCandidates.length > 1,
  );
  const preferredName = displayableFileName(userFile)
    || displayableFileName(previous?.object || previous?.label || previous?.path)
    || displayableFileName(currentWindowCandidate?.object || currentWindowCandidate?.label)
    || displayableFileName(safePaths.at(-1));
  const preferredReference = userFile
    || previous?.path
    || previous?.object
    || previous?.label
    || currentWindowCandidate?.path
    || currentWindowCandidate?.object
    || currentWindowCandidate?.label
    || safePaths.at(-1)
    || preferredName;
  const discoveryCandidates = evidence
    .map(record => discoveryCandidate(record, taskText, preferredName, preferredReference, sourcePaths))
    .filter((item): item is EvidenceCandidate => Boolean(item));
  const distinctDiscoveryCandidates = discoveryCandidates.filter((candidate, index, all) => all.findIndex(item => (
    canonicalPathIdentity(item.path) === canonicalPathIdentity(candidate.path)
  )) === index);
  const latestDiscovery = distinctDiscoveryCandidates.length === 1
    ? distinctDiscoveryCandidates[0]
    : undefined;
  const ambiguousDiscoveryCandidates = distinctDiscoveryCandidates.length > 1;
  const latestDocument = [...documentCandidates].reverse().find(candidate => (
    !preferredName
    || !candidate.object
    || targetReferenceMatches(candidate.path || candidate.object, preferredReference)
  ));

  let target: TaskTargetAnchorV1;
  const priorCorrection = previous?.source === 'user_correction' ? previous : null;
  const authoritativeCorrection = userFile
    ? mergeTarget({
        label: fileName(userFile),
        object: fileName(userFile),
        path: concreteTargetPath(userFile) ? userFile : '',
        application: input.applicationHint || previous?.application || '',
        status: 'candidate',
        source: 'user_correction',
      }, previous)
    : priorCorrection
      ? mergeTarget(priorCorrection)
      : null;
  const windowMatchesCorrection = Boolean(
    authoritativeCorrection
    && currentWindowCandidate?.object
    && targetReferenceMatches(
      currentWindowCandidate.path || currentWindowCandidate.object,
      authoritativeCorrection.path || authoritativeCorrection.object || authoritativeCorrection.label,
    ),
  );
  if (authoritativeCorrection) {
    const matchingReceipt = latestDiscovery || latestDocument || (windowMatchesCorrection ? currentWindowCandidate : null);
    target = matchingReceipt
      ? mergeTarget(matchingReceipt, authoritativeCorrection)
      : authoritativeCorrection;
    target.application = target.application || (currentWps ? 'WPS' : '');
    if (windowMatchesCorrection && currentWindowCandidate) target.window = currentWindowCandidate.window;
  } else if (currentAuthoringDocument && currentWindowCandidate) {
    const durableExactTarget = previous
      && concreteTargetPath(previous.path || '')
      && targetReferenceMatches(
        previous.path || previous.object || previous.label || '',
        currentWindowCandidate.object,
      )
      ? previous
      : null;
    target = mergeTarget(
      latestDiscovery || latestDocument || durableExactTarget || currentWindowCandidate,
      currentWindowCandidate,
    );
    target.application = currentWindowCandidate.application;
    target.window = currentWindowCandidate.window || target.window;
    target.source = latestDiscovery?.source || latestDocument?.source || currentWindowCandidate.source;
  } else if (
    currentAuthoringDocument
    && previous
    && concreteTargetPath(previous.path || '')
    && !isUnconfirmedRuntimeCandidate(previous.path || previous.label || '', taskText)
  ) {
    target = mergeTarget(previous);
  } else if (currentAuthoringDocument) {
    const requestedApplication = requestedAuthoringApplication(
      taskText,
      input.applicationHint || previous?.application || '',
    );
    target = mergeTarget({
      application: requestedApplication === 'any'
        ? input.applicationHint || previous?.application || ''
        : requestedApplication,
      status: 'unresolved',
      source: 'unknown',
    });
  } else if (latestDiscovery || latestDocument) {
    target = mergeTarget(latestDiscovery || latestDocument!, previous);
  } else if (previous && !isUnconfirmedRuntimeCandidate(previous.path || previous.label || '', taskText)) {
    target = mergeTarget(previous);
  } else if (safePaths.length) {
    const sourcePath = safePaths.at(-1)!;
    target = mergeTarget({
      label: displayableFileName(sourcePath),
      object: displayableFileName(sourcePath),
      path: sourcePath,
      application: input.applicationHint || '',
      status: displayableFileName(sourcePath) ? 'confirmed' : 'unresolved',
      source: 'durable_state',
    });
  } else {
    target = mergeTarget({
      application: input.applicationHint || previous?.application || (currentWps ? 'WPS' : ''),
      status: 'unresolved',
      source: 'unknown',
    });
  }

  const rejectedTargets = unique([...(input.rejectedTargets || []), ...capsuleRejectedTargets(taskText)], 12);
  if (rejectedByIdentity(target, rejectedTargets)) target.status = 'rejected';
  if (isUnconfirmedRuntimeCandidate(target.path || target.object || target.label, taskText)) {
    ignoredCandidates.push(target.path || target.object || target.label);
    target = mergeTarget({
      application: target.application || (currentWps ? 'WPS' : ''),
      window: currentWindowCandidate?.window || '',
      status: 'unresolved',
      source: 'unknown',
    });
  }

  const finalName = displayableFileName(target.object || target.label || target.path);
  if (!finalName && target.status !== 'rejected' && isFileTargetTask(taskText)) {
    target.status = 'unresolved';
  }
  // Window provenance and path provenance are independent. Once bounded
  // discovery resolves a path, target.source legitimately changes to the
  // discovery receipt; that must not erase the already verified native
  // window. Conversely, a concrete path alone cannot prove that it is the
  // document currently open in the requested authoring application.
  const windowVerified = Boolean(
    currentAuthoringDocument
    && currentWindowCandidate
    && supportedAuthoringApplication(currentWindowCandidate.application)
    && supportedAuthoringApplication(target.application) === supportedAuthoringApplication(currentWindowCandidate.application)
    && targetReferenceMatches(
      target.path || target.object || target.label,
      currentWindowCandidate.object || currentWindowCandidate.label,
    )
    && !ambiguousDiscoveryCandidates
    && !(currentWindowCandidate.source === 'running_window' && ambiguousBackgroundCandidates)
    && target.status !== 'rejected',
  );
  const pathResolved = Boolean(
    target.status !== 'rejected'
    && concreteTargetPath(target.path)
    && !ambiguousDiscoveryCandidates,
  );
  const analysisReady = target.status !== 'rejected'
    && Boolean(finalName)
    && !ambiguousDiscoveryCandidates
    && Boolean(pathResolved || target.source === 'document_interface');
  const nextAction: TaskTargetAnchorProjectionV1['nextAction'] = analysisReady
    ? 'analyze'
    : windowVerified
      ? 'search_bounded_roots'
      : finalName && target.source === 'user_correction'
        ? 'search_bounded_roots'
      : currentAuthoringDocument
        ? 'inspect_active_document'
        : finalName
          ? 'search_bounded_roots'
          : 'clarify_target';
  // This is returned as structured preflight data; channels may localize it later.
  const clarification = nextAction === 'inspect_active_document'
    ? CN_TASK_TARGET_ANCHOR_MESSAGES.inspectActiveDocument
    : finalName
      ? CN_TASK_TARGET_ANCHOR_MESSAGES.locateNamedFile(finalName)
      : CN_TASK_TARGET_ANCHOR_MESSAGES.unresolvedTarget;

  return {
    target: { ...target, label: finalName || target.label, object: finalName || target.object },
    allowedSearchRoots: allowedTaskSearchRoots(taskText, sourcePaths),
    windowVerified,
    pathResolved,
    analysisReady,
    nextAction,
    clarification,
    ignoredCandidates: unique(ignoredCandidates, 8),
  };
}

function callTarget(args: Record<string, unknown>): string {
  return firstString(objectValue(args), [
    ...TARGET_PATH_KEYS,
    'directory',
  ], 500);
}

function argumentsWithAnchoredDocumentPath(
  toolName: string,
  args: Record<string, unknown>,
  anchoredPath: string,
): Record<string, unknown> | null {
  const name = toolName.toLowerCase();
  if (name === 'read_file') return { ...args, path: anchoredPath };
  if (name === 'read_files_batch') return { ...args, paths: [anchoredPath] };
  if (name === 'ocr_image_file') return { ...args, imagePath: anchoredPath };
  if (/^(?:read_docx|read_xlsx|read_pdf|pdf_to_text|extract_document_text)$/i.test(name)) {
    return { ...args, filePath: anchoredPath };
  }
  for (const key of [
    'path', 'filePath', 'filepath', 'documentPath', 'documentpath',
    'sourcePath', 'sourcepath', 'inputPath', 'inputpath', 'targetPath', 'targetpath',
    'imagePath', 'imagepath', 'target', 'file',
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return { ...args, [key]: anchoredPath };
    }
  }
  return null;
}

function targetMatchesAnchor(candidate: string, anchor: TaskTargetAnchorV1): boolean {
  const anchoredPath = canonicalPathIdentity(anchor.path);
  if (anchoredPath && concreteTargetPath(anchor.path)) {
    return concreteTargetPath(candidate)
      && canonicalPathIdentity(candidate) === anchoredPath;
  }
  return [anchor.path, anchor.object, anchor.label]
    .filter(Boolean)
    .some(value => targetReferenceMatches(candidate, value));
}

function targetKeepsAnchoredObjectIdentity(candidate: string, anchor: TaskTargetAnchorV1): boolean {
  if (!candidate) return true;
  const anchoredReference = anchor.path || anchor.object || anchor.label;
  return Boolean(
    anchoredReference
    && fileNamesMatchByPathFlavor(candidate, anchoredReference),
  );
}

function blocked(
  code: NonNullable<TaskTargetToolCallGuardResult['code']>,
  reason: string,
  anchor: TaskTargetAnchorProjectionV1,
  question?: string,
): TaskTargetToolCallGuardResult {
  return {
    allowed: false,
    status: 'blocked',
    code,
    reason,
    ...(question ? { clarification: { required: true, question } } : {}),
    anchor,
  };
}

/**
 * Shared chat/voice/task preflight for real file targets. It uses only the
 * current user contract and server-owned tool records; assistant prose is not
 * target evidence.
 */
export function guardTaskTargetToolCall(input: {
  taskText: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  toolRecords?: TaskTargetEvidenceRecord[];
  /** Registry-owned capability metadata says this call can read a local file. */
  enforceStructuredFileRead?: boolean;
  /** Registry-owned capability metadata says this call can execute a process. */
  forbidUnstructuredExecution?: boolean;
}): TaskTargetToolCallGuardResult {
  if (!isFileTargetTask(input.taskText)) return { allowed: true, reason: '' };
  const toolName = compact(input.toolName, 160);
  const args = input.arguments || {};
  const projection = buildTaskTargetAnchorProjection({
    taskText: input.taskText,
    evidence: input.toolRecords || [],
  });
  const target = callTarget(args);
  const currentWps = prefersCurrentWpsDocument(input.taskText, projection.target.application);
  const currentAuthoringDocument = prefersCurrentAuthoringDocument(
    input.taskText,
    projection.target.application,
  );
  const hasVerifiedActiveAuthoringDocument = (input.toolRecords || [])
    .filter(record => record.terminalVerification?.status === 'verified')
    .map(activeWindowCandidate)
    .some(candidate => Boolean(
      candidate
      && candidate.object
      && candidateMatchesRequestedAuthoringApplication(
        candidate,
        input.taskText,
        projection.target.application,
      ),
    ));
  const hasVerifiedAuthoringDocumentWindow = projection.windowVerified;
  const hasTrustedCurrentAuthoringPath = Boolean(
    currentAuthoringDocument
    && projection.windowVerified
    && projection.pathResolved
    && projection.analysisReady
    && concreteTargetPath(projection.target.path),
  );

  if (input.forbidUnstructuredExecution || UNSTRUCTURED_FILE_ACCESS_TOOL_RE.test(toolName)) {
    return blocked(
      'unstructured_file_access_forbidden',
      `Target anchor blocked ${toolName}: file-target work cannot use a general command, script, interpreter, or unstructured desktop executor. Use a structured file/document capability bound to the canonical target.`,
      projection,
      projection.clarification,
    );
  }

  if (DISCOVERY_TOOLS.has(toolName.toLowerCase())) {
    if (currentAuthoringDocument && !hasVerifiedAuthoringDocumentWindow) {
      return blocked(
        'active_document_required',
        `Target anchor blocked ${toolName}: verify exactly one supported WPS/Office document window with desktop_running_processes or desktop_active_window before searching for a file described as the current document.`,
        projection,
        projection.clarification,
      );
    }
    if (!target) {
      return blocked(
        'search_scope_required',
        `${toolName} requires an explicit bounded directory. The process working directory is never an implicit user-material source.`,
        projection,
        projection.clarification,
      );
    }
    if (!isAllowedTaskSearchDirectory(target, input.taskText)) {
      return blocked(
        isUnconfirmedRuntimeCandidate(target, input.taskText)
          ? 'runtime_candidate_forbidden'
          : 'search_scope_forbidden',
        `${toolName} is limited to Desktop, Documents, Downloads, or a directory explicitly named by the user. Rejected directory: ${target}`,
        projection,
        projection.clarification,
      );
    }
    return { allowed: true, reason: '', anchor: projection };
  }

  if (toolName === 'desktop_capture_screen' && currentWps && !hasVerifiedActiveAuthoringDocument) {
    return blocked(
      'active_document_required',
      'Observe desktop_active_window and verify the current WPS document before capturing or interpreting its screen.',
      projection,
      projection.clarification,
    );
  }

  if (toolName === 'desktop_path_info' && currentAuthoringDocument) {
    const anchoredPath = projection.target.path;
    if (!concreteTargetPath(anchoredPath)) {
      return blocked(
        'target_unresolved',
        'Path verification is blocked until bounded discovery resolves the one anchored WPS/Office document to an exact path.',
        projection,
        projection.clarification,
      );
    }
    if (target && !targetMatchesAnchor(target, projection.target) && !(
      hasTrustedCurrentAuthoringPath
      && targetKeepsAnchoredObjectIdentity(target, projection.target)
    )) {
      return blocked(
        'target_mismatch',
        `Path verification target does not match the anchored file ${projection.target.object}: ${target}`,
        projection,
        projection.clarification,
      );
    }
    return {
      allowed: true,
      reason: '',
      normalizedArguments: { ...args, target: anchoredPath },
      anchor: projection,
    };
  }

  if (input.enforceStructuredFileRead || DOCUMENT_INTERFACE_RE.test(toolName)) {
    const directVerifiedWpsDocumentRead = Boolean(
      currentWps
      && projection.target.source === 'active_window'
      && projection.target.object
      && CURRENT_DOCUMENT_INTERFACE_RE.test(toolName),
    );
    if (!projection.analysisReady && !directVerifiedWpsDocumentRead) {
      return blocked(
        projection.nextAction === 'inspect_active_document' ? 'active_document_required' : 'target_unresolved',
        `Document analysis is blocked until the target has a displayable final filename and trusted application/window/object/path anchor. ${projection.clarification}`,
        projection,
        projection.clarification,
      );
    }
    const trustedAnchoredArguments = hasTrustedCurrentAuthoringPath
      && targetKeepsAnchoredObjectIdentity(target, projection.target)
      ? argumentsWithAnchoredDocumentPath(toolName, args, projection.target.path)
      : null;
    if (trustedAnchoredArguments) {
      return {
        allowed: true,
        reason: '',
        normalizedArguments: trustedAnchoredArguments,
        anchor: projection,
      };
    }
    if (target) {
      if (isUnconfirmedRuntimeCandidate(target, input.taskText)) {
        return blocked(
          'runtime_candidate_forbidden',
          `Document analysis rejected an inferred runtime/project artifact: ${target}`,
          projection,
          projection.clarification,
        );
      }
      if (!targetMatchesAnchor(target, projection.target)) {
        return blocked(
          'target_mismatch',
          `Document analysis target does not match the anchored file ${projection.target.object || projection.target.label}: ${target}`,
          projection,
          projection.clarification,
        );
      }
      const anchoredPath = projection.target.path;
      const normalizedArguments = concreteTargetPath(anchoredPath)
        ? argumentsWithAnchoredDocumentPath(toolName, args, anchoredPath)
        : null;
      if (normalizedArguments) {
        return {
          allowed: true,
          reason: '',
          normalizedArguments,
          anchor: projection,
        };
      }
    } else {
      const anchoredPath = projection.target.path;
      const normalizedArguments = concreteTargetPath(anchoredPath)
        ? argumentsWithAnchoredDocumentPath(toolName, args, anchoredPath)
        : null;
      if (normalizedArguments) {
        return {
          allowed: true,
          reason: '',
          normalizedArguments,
          anchor: projection,
        };
      }
      if (!directVerifiedWpsDocumentRead) {
        return blocked(
          'target_unresolved',
          `Document analysis requires the anchored path ${projection.target.path || projection.target.object || projection.target.label}.`,
          projection,
          projection.clarification,
        );
      }
    }
  }

  if (toolName === 'desktop_open' && target && displayableFileName(target)) {
    const rejected = capsuleRejectedTargets(input.taskText);
    if (rejected.some(item => normalizedIdentity(item) === normalizedIdentity(target)
      || normalizedIdentity(fileName(item)) === normalizedIdentity(fileName(target)))) {
      return blocked(
        'rejected_target',
        `The user already rejected this exact file target; do not open it again: ${target}`,
        projection,
        projection.clarification,
      );
    }
    if (projection.target.object && !targetMatchesAnchor(target, projection.target)) {
      return blocked(
        'target_mismatch',
        `The requested open target does not match the anchored file ${projection.target.object}: ${target}`,
        projection,
        projection.clarification,
      );
    }
  }

  return { allowed: true, reason: '', anchor: projection };
}
