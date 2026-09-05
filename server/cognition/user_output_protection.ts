import path from 'node:path';
import type { ToolExecutionRecord } from '../tools/types';
import { CN_USER_OUTPUT_PROTECTION_MESSAGES } from '../regions/packs/cn/user_output_protection_messages';
import {
  containsInternalExecutionLanguage,
  sanitizePublicExecutionText,
} from '../../shared/public_execution_language';

export interface UserFacingOutputProtectionOptions {
  task?: string;
  toolRecords?: ToolExecutionRecord[];
  /**
   * Exact output of `formatPendingConfirmationRequest(pending)`. This is an
   * equality-bound envelope, not a reason-based bypass: arbitrary
   * `waiting_confirmation` prose must still pass the ordinary native-output
   * filters. Secrets are redacted again before the trusted text is returned.
   */
  trustedConfirmationRequestText?: string;
}

const MAX_PERSISTED_TOOL_RECORDS = 80;
const MAX_PERSISTED_STRING = 4_000;
const MAX_PERSISTED_COLLECTION = 80;
const MAX_PERSISTED_DESKTOP_ENTRIES = 32;

const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/iu;
const IMAGE_BASE64_FIELD_RE = /["']?image_base64["']?\s*[:=]\s*["'][^"']*["']/iu;
const LARGE_BASE64_RE = /(?:^|["'\s:])(?:[A-Za-z0-9+/]{320,}={0,2})(?=$|["'\s,}])/u;
const INTERNAL_RECEIPT_RE = /(?:terminalVerification|targetIdentity|idempotencyKey|allowedTools|desktop_execution_plan_receipt|execution-status claim|work[_ -]?product[_ -]?guard)/iu;
const RAW_WINDOW_RE = /["']?(?:window_id|process_name|executable_path)["']?\s*[:=]/iu;
const RAW_DIRECTORY_RE = /["']?(?:modifiedMs|isDirectory|fileType)["']?\s*[:=]|(?:["']path["']\s*:\s*["'][A-Za-z]:\\[^"']+["'])/iu;
// i18n-allow -- Chinese task-list header recognition; not user-visible copy.
const RAW_TASKLIST_RE = /(?:Image Name\s+PID\s+Session Name|映像名称\s+PID\s+会话名)|(?:^[^\r\n]{1,80}\.exe\s+\d+\s+(?:Console|Services)\s+\d+\s+[\d,]+\s+K\s*$)/imu;
// i18n-allow -- Chinese internal checkpoint recognition; not user-visible copy.
const VERIFIED_CHECKPOINT_RE = /(?:已核验的执行结果|Verified execution results|immutable tool receipts|terminal=verified|verification=verified)/iu;
const SECRET_DETAIL_RE = /((?:password|passphrase|secret|token|api.?key|authorization|cookie|credential))\s*[:=]\s*\S+/giu;
const STRUCTURED_SECRET_DETAIL_RE = /(["'](?:password|passphrase|secret|token|api.?key|authorization|cookie|credential)["']\s*:\s*["'])[^"']+/giu;
const GENERIC_STRUCTURED_FIELD_RE = /(["']?([A-Za-z][A-Za-z0-9_-]{0,80})["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gu;
const BEARER_SECRET_RE = /\bBearer\s+\S+/giu;
const NOTIFICATION_ABSOLUTE_PATH_RE = /(?:\b[A-Za-z]:[\\/][^\s,;]+|(?<![\p{L}\p{N}_])\/(?:Users|home|root|srv|etc|var|opt|tmp|private)\/[^\s,;]+)/giu;
const NOTIFICATION_RAW_KEY_RE = /^(?:raw|stack|stackTrace|toolRecords?|receipts?|arguments?|exactArgs|ciphertext|debug|diagnostic)$/iu;
const SENSITIVE_URL_PARAMETER_RE = /(?:^|[-_])(?:access[-_]?token|api[-_]?key|auth|authorization|credential|expires?|key|secret|signature|sig|token)(?:$|[-_])/iu;
const MEDIA_SOURCE_FIELD_RE = /^(?:filePath|referencePaths?|first_frame_image|last_frame_image|input_reference|inputPaths?|sourcePaths?|sourceUrl)$/iu;

function isSensitivePersistenceKey(value: string): boolean {
  const key = String(value || '').replace(/[^a-z0-9]/giu, '').toLowerCase();
  if (!key) return false;
  // Token accounting is ordinary telemetry, not a credential.
  if (/^(?:max|total|input|output|prompt|completion|reasoning|cached|estimated)?tokens?(?:count|used|usage|budget|limit)?$/u.test(key)) {
    return false;
  }
  return key === 'authorization'
    || key === 'authheader'
    || key === 'otp'
    || key.endsWith('token')
    || key.endsWith('cookie')
    || key.endsWith('apikey')
    || key.endsWith('privatekey')
    || key.endsWith('credential')
    || key.endsWith('credentials')
    || key.includes('password')
    || key.includes('passwd')
    || key.includes('passphrase')
    || key.includes('passkey')
    || key.includes('secret')
    || key.includes('captcha')
    || key.includes('verificationcode');
}

function redactSignedUrl(value: string): string {
  if (!/^https?:\/\//iu.test(value)) return value;
  try {
    const parsed = new URL(value);
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (!SENSITIVE_URL_PARAMETER_RE.test(key)) continue;
      parsed.searchParams.set(key, '[redacted]');
      changed = true;
    }
    return changed ? parsed.toString() : value;
  } catch {
    return value;
  }
}

function redactEmbeddedSignedUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/giu, candidate => redactSignedUrl(candidate));
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ''); }
}

function parseJson(value: unknown): unknown {
  if (value && typeof value === 'object') return value;
  const raw = String(value || '').trim();
  if (!raw || (!raw.startsWith('{') && !raw.startsWith('['))) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function isChinese(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function hasHighStructuredDensity(value: string): boolean {
  if (value.length < 8_000) return false;
  const structural = (value.match(/[{}\[\]":,]/g) || []).length;
  return structural / value.length > 0.035;
}

export function containsUnsafeToolPayload(value: unknown): boolean {
  const raw = stringify(value);
  if (!raw) return false;
  return containsInternalExecutionLanguage(raw)
    || DATA_URL_RE.test(raw)
    || IMAGE_BASE64_FIELD_RE.test(raw)
    || LARGE_BASE64_RE.test(raw)
    || INTERNAL_RECEIPT_RE.test(raw)
    || RAW_WINDOW_RE.test(raw)
    || RAW_DIRECTORY_RE.test(raw)
    || RAW_TASKLIST_RE.test(raw)
    || VERIFIED_CHECKPOINT_RE.test(raw)
    || hasHighStructuredDensity(raw);
}

function redactSensitive(value: string): string {
  return redactEmbeddedSignedUrls(value)
    .replace(GENERIC_STRUCTURED_FIELD_RE, (match, prefix: string, key: string, secretValue: string) => {
      if (!isSensitivePersistenceKey(key)) return match;
      const quote = secretValue.startsWith('"')
        ? '"'
        : secretValue.startsWith("'")
          ? "'"
          : '';
      return `${prefix}${quote}[redacted]${quote}`;
    })
    .replace(STRUCTURED_SECRET_DETAIL_RE, '$1[redacted]')
    .replace(SECRET_DETAIL_RE, '$1=[redacted]')
    .replace(BEARER_SECRET_RE, 'Bearer [redacted]')
    // API-key prefixes must begin at a token boundary. Without the left
    // boundary, ordinary names such as "lumi-task-regression" contain the
    // substring "sk-regression" and their exact confirmation target is
    // silently corrupted.
    .replace(/(?<![A-Za-z0-9])(?:sk|key)-[A-Za-z0-9_-]{8,}/giu, '[redacted]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/giu, '[image omitted]')
    .replace(/(["']?image_base64["']?\s*[:=]\s*["'])[^"']+(["'])/giu, '$1[image omitted]$2');
}

function compactMediaValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[nested value omitted]';
  if (key && MEDIA_SOURCE_FIELD_RE.test(key)) return '[media source omitted]';
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map(item => compactMediaValue(item, key, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([nestedKey]) => !MEDIA_SOURCE_FIELD_RE.test(nestedKey))
      .map(([nestedKey, nested]) => [nestedKey, compactMediaValue(nested, nestedKey, depth + 1)]),
  );
}

function compactMediaToolRecordForPersistence(candidate: Record<string, any>, toolName: string): Record<string, any> {
  const rawArgs = candidate.arguments && typeof candidate.arguments === 'object'
    ? candidate.arguments as Record<string, unknown>
    : {};
  const operation = toolName === 'ai_edit_image'
    ? 'image_edit'
    : toolName === 'generate_video'
      ? (String(rawArgs.first_frame_image || '').trim() ? 'image_to_video' : 'text_to_video')
      : 'text_to_image';
  const safeArguments = compactMediaValue({
    operation,
    ...(rawArgs.prompt !== undefined ? { prompt: rawArgs.prompt } : {}),
    ...(rawArgs.size !== undefined ? { size: rawArgs.size } : {}),
    ...(rawArgs.n !== undefined ? { n: rawArgs.n } : {}),
    ...(rawArgs.duration !== undefined ? { duration: rawArgs.duration } : {}),
    ...(rawArgs.model !== undefined ? { model: rawArgs.model } : {}),
    ...(rawArgs.seed !== undefined ? { seed: rawArgs.seed } : {}),
    ...(rawArgs.negative_prompt !== undefined ? { negative_prompt: rawArgs.negative_prompt } : {}),
    hasSource: toolName === 'ai_edit_image' && Boolean(String(rawArgs.filePath || '').trim()),
    hasReference: toolName === 'generate_video'
      ? Boolean(String(rawArgs.first_frame_image || '').trim())
      : Array.isArray(rawArgs.referencePaths) && rawArgs.referencePaths.length > 0,
    ...(Array.isArray(rawArgs.referencePaths) ? { referenceCount: rawArgs.referencePaths.length } : {}),
  }) as Record<string, unknown>;
  const parsedResult = parseJson(candidate.result);
  const compactedResult = parsedResult === null
    ? compactMediaValue(candidate.result)
    : JSON.stringify(compactMediaValue(parsedResult));
  const envelope = candidate.envelope && typeof candidate.envelope === 'object'
    ? compactMediaValue(candidate.envelope)
    : candidate.envelope;
  const receipt = candidate.receipt && typeof candidate.receipt === 'object'
    ? compactMediaValue(candidate.receipt)
    : candidate.receipt;
  return {
    ...candidate,
    arguments: safeArguments,
    result: compactedResult,
    ...(envelope !== undefined ? { envelope } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
  };
}

function looksLikeLargeBase64(value: string): boolean {
  if (/[ \t]/u.test(value)) return false;
  const compacted = value.replace(/\s+/g, '');
  return compacted.length > 512
    && /^[A-Za-z0-9+/]+={0,2}$/u.test(compacted);
}

function compactPersistedToolValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[nested value omitted]';
  if (key && isSensitivePersistenceKey(key)) return '[redacted]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (/(?:image_base64|base64_image|screenshot_base64|imageData|dataUrl)/iu.test(key)) {
      return `[binary image omitted: ${value.length} chars]`;
    }
    if (DATA_URL_RE.test(value) || looksLikeLargeBase64(value)) {
      return `[binary payload omitted: ${value.length} chars]`;
    }
    const redacted = redactSensitive(value);
    if (redacted.length <= MAX_PERSISTED_STRING) return redacted;
    const parsed = parseJson(redacted);
    if (parsed !== null) {
      const compacted = compactPersistedToolValue(parsed, key, depth + 1);
      const serialized = JSON.stringify(compacted);
      if (serialized.length <= MAX_PERSISTED_STRING) return serialized;
      return JSON.stringify({
        kind: 'structured_result_summary',
        originalChars: redacted.length,
        resultOmitted: true,
      });
    }
    const tailLength = 400;
    return `${redacted.slice(0, MAX_PERSISTED_STRING - tailLength - 48)}\n[stored result truncated: ${redacted.length} chars]\n${redacted.slice(-tailLength)}`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_PERSISTED_COLLECTION)
      .map(item => compactPersistedToolValue(item, key, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, MAX_PERSISTED_STRING);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_PERSISTED_COLLECTION)
      .map(([nestedKey, nested]) => [
        nestedKey,
        compactPersistedToolValue(nested, nestedKey, depth + 1),
      ]),
  );
}

const DESKTOP_FILE_COLLECTION_KEYS = ['files', 'entries', 'items', 'children', 'results'] as const;
const DESKTOP_PROCESS_COLLECTION_KEYS = ['processes', 'items', 'results', 'windows'] as const;
const TARGET_DOCUMENT_RE = /\.(?:docx?|xlsx?|pptx?|pdf|wps|et|dps|txt|md|rtf|csv)(?:$|[\s"'])/iu;
const AUTHORING_PROCESS_RE = /(?:^|[\\/])(?:wps|wpp|et|wpsoffice|winword|excel|powerpnt)(?:\.exe)?$/iu;

function parseNestedJson(value: unknown): unknown {
  let parsed = value;
  for (let depth = 0; depth < 3 && typeof parsed === 'string'; depth += 1) {
    const next = parseJson(parsed);
    if (next === null) break;
    parsed = next;
  }
  return parsed;
}

function compactEvidenceString(value: unknown, limit = 600): string {
  return redactSensitive(String(value || ''))
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function compactDesktopEntry(value: unknown, kind: 'files' | 'processes'): unknown {
  if (typeof value === 'string') return compactEvidenceString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const allowed = kind === 'files'
    ? ['name', 'fileName', 'path', 'fullPath', 'type', 'fileType', 'isDirectory', 'size', 'modifiedMs']
    : ['pid', 'name', 'process_name', 'processName', 'executable', 'executable_path', 'window_title', 'windowTitle', 'window_titles', 'windowTitles'];
  return Object.fromEntries(allowed.flatMap(key => {
    if (source[key] === undefined) return [];
    const raw = source[key];
    if (Array.isArray(raw)) {
      return [[key, raw.slice(0, 12).map(item => compactEvidenceString(item, 300))]];
    }
    if (typeof raw === 'string') return [[key, compactEvidenceString(raw, key.includes('path') ? 600 : 300)]];
    return [[key, raw]];
  }));
}

function desktopEntrySearchText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  return [
    item.name,
    item.fileName,
    item.path,
    item.fullPath,
    item.process_name,
    item.processName,
    item.executable,
    item.window_title,
    item.windowTitle,
    ...(Array.isArray(item.window_titles) ? item.window_titles : []),
    ...(Array.isArray(item.windowTitles) ? item.windowTitles : []),
  ].map(entry => String(entry || '')).join(' ');
}

function selectDesktopEvidenceEntries(
  entries: unknown[],
  kind: 'files' | 'processes',
): unknown[] {
  const ranked = entries.map((entry, index) => {
    const text = desktopEntrySearchText(entry);
    const isTarget = kind === 'files'
      ? TARGET_DOCUMENT_RE.test(text)
      : AUTHORING_PROCESS_RE.test(String((entry as any)?.name || (entry as any)?.process_name || (entry as any)?.processName || ''))
        || TARGET_DOCUMENT_RE.test(text);
    const hasWindow = kind === 'processes'
      && /\S/u.test(String((entry as any)?.window_title || (entry as any)?.windowTitle || ''));
    return { entry, index, score: (isTarget ? 100 : 0) + (hasWindow ? 30 : 0) + (index < 8 ? 10 : 0) + (index >= entries.length - 4 ? 5 : 0) };
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked.slice(0, MAX_PERSISTED_DESKTOP_ENTRIES)
    .map(({ entry }) => compactDesktopEntry(entry, kind));
}

function desktopCollection(value: unknown, keys: readonly string[]): { entries: unknown[]; key: string } | null {
  const parsed = parseNestedJson(value);
  if (Array.isArray(parsed)) return { entries: parsed, key: '' };
  if (!parsed || typeof parsed !== 'object') return null;
  const object = parsed as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(object[key])) return { entries: object[key] as unknown[], key };
  }
  return null;
}

function compactDesktopCollectionResult(
  value: unknown,
  toolName: string,
): { text: string; payload: Record<string, unknown> } | null {
  const kind = /running_processes|get_running_processes/iu.test(toolName) ? 'processes' : 'files';
  const collection = desktopCollection(
    value,
    kind === 'processes' ? DESKTOP_PROCESS_COLLECTION_KEYS : DESKTOP_FILE_COLLECTION_KEYS,
  );
  if (!collection) return null;
  let entries = selectDesktopEvidenceEntries(collection.entries, kind);
  const makePayload = (): Record<string, unknown> => ({
    kind: kind === 'processes' ? 'running_processes_summary' : 'desktop_files_summary',
    originalCount: collection.entries.length,
    truncated: entries.length < collection.entries.length,
    [kind === 'processes' ? 'processes' : 'entries']: entries,
  });
  let payload = makePayload();
  let text = JSON.stringify(payload);
  while (text.length > MAX_PERSISTED_STRING && entries.length > 1) {
    entries = entries.slice(0, -1);
    payload = makePayload();
    text = JSON.stringify(payload);
  }
  if (text.length > MAX_PERSISTED_STRING) {
    entries = [];
    payload = makePayload();
    text = JSON.stringify(payload);
  }
  return { text, payload };
}

function compactClientStateResult(value: unknown): string | null {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, any>;
  const state = payload.state && typeof payload.state === 'object' ? payload.state : null;
  const health = payload.health && typeof payload.health === 'object' ? payload.health : null;
  const capabilityRuntime = payload.capabilityRuntime && typeof payload.capabilityRuntime === 'object'
    ? payload.capabilityRuntime
    : null;
  const summary = {
    kind: 'client_state_summary',
    detail: payload.detail || 'summary',
    stateDigest: payload.stateDigest || null,
    state: state ? {
      updatedAt: state.updatedAt,
      platform: state.platform,
      mode: state.mode,
      activeTab: state.activeTab,
      viewMode: state.viewMode,
      workDomain: state.workDomain,
      settingsSection: state.settings?.activeSection,
      focusedWindow: state.windows?.focused,
      openWindows: Array.isArray(state.windows?.open) ? state.windows.open.slice(0, 12) : [],
      surfaces: state.surfaces ? {
        wallpaperMode: state.surfaces.wallpaperMode,
        widgetMode: state.surfaces.widgetMode,
        meetingOpen: state.surfaces.meetingOpen,
        nexusOpen: state.surfaces.nexusOpen,
        commandCenterOpen: state.surfaces.commandCenterOpen,
      } : undefined,
      runtime: state.runtime ? {
        backendNodeRunning: state.runtime.backendNodeRunning,
        backendPythonRunning: state.runtime.backendPythonRunning,
        closeToBackground: state.runtime.closeToBackground,
        autostartEnabled: state.runtime.autostartEnabled,
        lastError: state.runtime.lastError,
      } : undefined,
    } : null,
    health: health ? {
      level: health.level,
      stateAgeSeconds: health.stateAgeSeconds,
      findings: Array.isArray(health.findings) ? health.findings.slice(0, 6) : [],
    } : null,
    capabilityRuntime,
    scope: payload.scope || null,
    fullDiagnosticsOmittedFromConversation: true,
  };
  return JSON.stringify(summary);
}

function compactToolRecordForPersistence(record: unknown): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const candidate = record as Record<string, any>;
  const toolName = String(candidate.name || candidate.toolName || '');
  if (/^(?:generate_image|ai_edit_image|generate_video)$/iu.test(toolName)) {
    return compactMediaToolRecordForPersistence(candidate, toolName);
  }
  if (/^(?:desktop_list_files|search_files|list_directory|desktop_running_processes|get_running_processes)$/iu.test(toolName)) {
    const compactResult = compactDesktopCollectionResult(candidate.result, toolName);
    if (!compactResult) return candidate;
    const envelope = candidate.envelope && typeof candidate.envelope === 'object'
      ? { ...candidate.envelope, result: compactResult.payload }
      : candidate.envelope;
    return {
      ...candidate,
      result: compactResult.text,
      ...(envelope !== undefined ? { envelope } : {}),
    };
  }
  if (toolName !== 'client_get_state') return candidate;
  const compactResult = compactClientStateResult(candidate.result);
  if (!compactResult) return candidate;
  const envelope = candidate.envelope && typeof candidate.envelope === 'object'
    ? {
        ...candidate.envelope,
        result: compactResult,
        receipt: {
          kind: 'client_state_summary',
          status: candidate.terminalVerification?.status || candidate.envelope?.status || 'succeeded',
          fullDiagnosticsOmittedFromConversation: true,
        },
      }
    : candidate.envelope;
  return {
    ...candidate,
    result: compactResult,
    ...(candidate.receipt !== undefined ? {
      receipt: {
        kind: 'client_state_summary',
        status: candidate.terminalVerification?.status || 'succeeded',
        fullDiagnosticsOmittedFromConversation: true,
      },
    } : {}),
    ...(envelope !== undefined ? { envelope } : {}),
  };
}

/**
 * Tool receipts remain useful across turns, but binary screenshots, secrets,
 * and unbounded adapter returns must never be copied into conversation rows.
 */
export function sanitizeToolRecordsForPersistence(value: unknown): any[] | undefined {
  let records = value;
  for (let depth = 0; depth < 2 && typeof records === 'string' && records.trim(); depth += 1) {
    try { records = JSON.parse(records); } catch { return undefined; }
  }
  if (!Array.isArray(records) || records.length === 0) return undefined;
  return records.slice(-MAX_PERSISTED_TOOL_RECORDS)
    .map(record => compactPersistedToolValue(compactToolRecordForPersistence(record)));
}

function boundedLabel(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const base = path.win32.basename(raw.replace(/["']/g, '')) || raw;
  return redactSensitive(base).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
}

function collectDirectoryEntries(value: unknown, output: string[], depth = 0): void {
  if (depth > 4 || output.length >= 20 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectDirectoryEntries(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const candidate = record.name || record.fileName || record.path || record.fullPath;
  const label = boundedLabel(candidate);
  if (label && !output.includes(label)) output.push(label);
  for (const [key, nested] of Object.entries(record)) {
    if (/^(?:files|entries|items|children|results)$/iu.test(key)) {
      collectDirectoryEntries(nested, output, depth + 1);
    }
  }
}

function collectProcessNames(value: unknown, output: string[], depth = 0): void {
  if (depth > 4 || output.length >= 30 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectProcessNames(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const candidate = record.process_name || record.processName || record.name || record.executable;
  const label = boundedLabel(candidate);
  if (label && /(?:\.exe$|^[\p{L}\p{N} ._-]{2,80}$)/iu.test(label) && !output.includes(label)) {
    output.push(label);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (/^(?:processes|items|results|windows)$/iu.test(key)) {
      collectProcessNames(nested, output, depth + 1);
    }
  }
}

function resultValues(records: ToolExecutionRecord[]): unknown[] {
  return records.map(record => parseJson(record.receipt) || parseJson(record.result)).filter(Boolean);
}

function humanSummary(
  raw: string,
  options: UserFacingOutputProtectionOptions,
): string {
  const records = options.toolRecords || [];
  const names = records.map(record => String(record.name || ''));
  const combined = `${options.task || ''}\n${names.join('\n')}\n${raw}`;
  const zh = isChinese(combined);
  const failed = records.some(record => Boolean(record.error)
    || record.terminalVerification?.status === 'failed'
    || record.envelope?.status === 'failed');
  const rawValue = parseJson(raw);
  const values = [
    ...resultValues(records),
    ...(rawValue ? [rawValue] : []),
  ];

  // i18n-allow -- Chinese screen-tool intent recognition; not user-visible copy.
  const screen = /(?:screen|capture|screenshot|ocr|vision|屏幕|截图)/iu.test(combined)
    || DATA_URL_RE.test(raw)
    || IMAGE_BASE64_FIELD_RE.test(raw);
  if (screen) {
    // i18n-allow -- Chinese vision failure recognition; not user-visible copy.
    const visionIncomplete = failed || /(?:ocr|vision|视觉|识别).{0,40}(?:failed|error|unavailable|未完成|失败|不可用)/iu.test(combined);
    if (zh) {
      return visionIncomplete
        ? CN_USER_OUTPUT_PROTECTION_MESSAGES.screenVisionIncomplete
        : CN_USER_OUTPUT_PROTECTION_MESSAGES.screenCaptured;
    }
    return visionIncomplete
      ? 'The screen image was captured, but visual recognition did not finish, so I cannot reliably describe it yet. Raw image data was omitted.'
      : 'The screen image was captured. Raw image data was omitted; I will report only the relevant visible details.';
  }

  const directory = names.some(name => /(?:list_files|list_directory|directory|desktop_files)/iu.test(name))
    || RAW_DIRECTORY_RE.test(raw);
  if (directory) {
    const entries: string[] = [];
    for (const value of values) collectDirectoryEntries(value, entries);
    const visible = entries.slice(0, 5);
    const count = entries.length;
    if (zh) {
      return visible.length > 0
        ? CN_USER_OUTPUT_PROTECTION_MESSAGES.directoryExamples(count, visible)
        : CN_USER_OUTPUT_PROTECTION_MESSAGES.directoryRead;
    }
    return visible.length > 0
      ? `The directory was read${count ? ` (${count} item(s))` : ''}. Examples: ${visible.join(', ')}. Raw paths and system fields were omitted.`
      : 'The directory was read. Raw paths and system fields were omitted; I can organize the result by name or type.';
  }

  const processList = names.some(name => /(?:running_processes|process_list|tasklist)/iu.test(name))
    || RAW_TASKLIST_RE.test(raw);
  if (processList) {
    const processes: string[] = [];
    for (const value of values) collectProcessNames(value, processes);
    for (const match of raw.matchAll(/^\s*([^\s]+\.exe)\s+\d+\s+/gimu)) {
      const label = boundedLabel(match[1]);
      if (label && !processes.includes(label)) processes.push(label);
      if (processes.length >= 30) break;
    }
    const visible = processes.slice(0, 6);
    if (zh) {
      return visible.length > 0
        ? CN_USER_OUTPUT_PROTECTION_MESSAGES.processExamples(visible)
        : CN_USER_OUTPUT_PROTECTION_MESSAGES.processesChecked;
    }
    return visible.length > 0
      ? `Running programs were checked. Examples: ${visible.join(', ')}. The raw process table and system fields were omitted.`
      : 'Running programs were checked. The raw process table and system fields were omitted; I can list only the relevant programs.';
  }

  return zh
    ? CN_USER_OUTPUT_PROTECTION_MESSAGES.genericSummary
    : 'The execution result was received. Raw system data was omitted for readability and privacy; only task-relevant conclusions and exceptions will be reported.';
}

/**
 * Last-mile protection for assistant prose. It deliberately targets native
 * tool payloads and internal receipt protocol, not ordinary user-requested
 * JSON or code.
 */
export function sanitizeUserFacingExecutionOutput(
  value: unknown,
  options: UserFacingOutputProtectionOptions = {},
): string {
  const raw = stringify(value).trim();
  if (!raw) return '';
  const redacted = redactSensitive(raw);
  const trustedConfirmationRequestText = String(
    options.trustedConfirmationRequestText || '',
  ).trim();
  if (trustedConfirmationRequestText && raw === trustedConfirmationRequestText) {
    return redacted;
  }
  if (containsInternalExecutionLanguage(redacted)) {
    return sanitizePublicExecutionText(redacted, isChinese(redacted) ? 'zh' : 'en');
  }
  const oversizedToolOutput = raw.length > 8_000 && (options.toolRecords || []).length > 0;
  const oversizedUnscopedOutput = raw.length > 50_000;
  if (!containsUnsafeToolPayload(raw) && !oversizedToolOutput && !oversizedUnscopedOutput) return redacted;
  return humanSummary(redacted, options).slice(0, 1_200);
}

function sanitizeNotificationValue(
  value: unknown,
  options: UserFacingOutputProtectionOptions,
  key = '',
  depth = 0,
): unknown {
  if (depth > 5) return '[nested value omitted]';
  if (key && isSensitivePersistenceKey(key)) return '[redacted]';
  if (key && NOTIFICATION_RAW_KEY_RE.test(key)) return '[internal detail omitted]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeUserFacingExecutionOutput(value, options)
      .replace(NOTIFICATION_ABSOLUTE_PATH_RE, '[path omitted]')
      .slice(0, 1_200);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeNotificationValue(item, options, key, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, 200);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([nestedKey, nested]) => [
        nestedKey,
        sanitizeNotificationValue(nested, options, nestedKey, depth + 1),
      ]),
  );
}

/** Recursively sanitize every independently emitted user notification. */
export function sanitizeUserFacingNotification(
  value: unknown,
  options: UserFacingOutputProtectionOptions = {},
): unknown {
  return sanitizeNotificationValue(value, options);
}
