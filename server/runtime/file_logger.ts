import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { getDataRoot } from '../config/data_path';
import { redactDiagnosticSecrets } from '../client/diagnostic_sanitizer';

const MAX_LOG_LINE_CHARS = 12_000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETAINED_LOG_FILES = 12;
const RUNTIME_LOG_FILE_RE = /^server-(\d{8})(?:-(\d{3}))?\.log$/i;
const IMAGE_DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi;
const IMAGE_FIELD_RE = /((?:image_base64|base64_image|screenshot_base64)["']?\s*[:=]\s*["']?)[a-z0-9+/=\r\n]{128,}/gi;
const IMAGE_VALUE_RE = /(?:data:image\/[a-z0-9.+-]+;base64,|(?:image_base64|base64_image|screenshot_base64)["']?\s*[:=])/i;
const SECRET_FIELD_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|token|secret|password|passwd|credential|authorization|cookie)$/i;
const CONTENT_FIELD_RE = /^(?:content|contents|text|message|messages|prompt|prompts|response|responses|result|results|body|document|documents|transcript|transcription|query|input|output|payload|data|arguments|args|usertext|assistanttext|rawtext|rawcontent)$/i;
const CONTENT_FIELD_SUFFIX_RE = /(?:^|[_-])(?:content|contents|text|message|messages|prompt|response|result|body|document|transcript|transcription|payload|base64)$/i;
const SAFE_METADATA_FIELD_RE = /(?:^|[_-])(?:id|uid|role|status|state|provider|model|name|type|code|category|source|domain|orgid|count|size|length|duration|durationms|timestamp|time|date|path|filename|extension|version|mode|operation|lane|reason)$/i;
const ERROR_FIELD_RE = /^(?:error|err|exception|failure|warning|warn|reason|stack)$/i;
const SENSITIVE_INLINE_LABEL_RE = /((?:received(?:\s+(?:message|payload))?|response(?:\s*text)?|assistant(?:\s*text)?|user(?:\s*text)?|message|content|prompt|result|body|document|transcript|transcription|query|input|output|payload|arguments|args|task)\s*[:=]\s*).*/i;

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface RuntimeFileSinkOptions {
  runtimeDir: string;
  now?: () => Date;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  retainedFiles?: number;
}

let installed = false;
let activeLogPath = '';
let runtimeSink: RuntimeFileSink | null = null;

function dateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

function boundedPositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanDiagnosticText(value: unknown, limit = 600): string {
  try {
    return redactDiagnosticSecrets(String(value ?? ''))
      .replace(IMAGE_DATA_URL_RE, '[image data omitted]')
      .replace(IMAGE_FIELD_RE, '$1[image data omitted]')
      .replace(SENSITIVE_INLINE_LABEL_RE, '$1[content omitted]')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, limit);
  } catch {
    return '[unreadable diagnostic]';
  }
}

function omittedText(value: unknown): string {
  try {
    const text = String(value ?? '');
    if (IMAGE_VALUE_RE.test(text)) return '[image data omitted]';
    return `[text omitted; chars=${text.length}]`;
  } catch {
    return '[text omitted]';
  }
}

function omittedContent(value: unknown): string {
  try {
    if (typeof value === 'string') return `[content omitted; chars=${value.length}]`;
    if (Array.isArray(value)) return `[content omitted; items=${value.length}]`;
  } catch {
    return '[content omitted]';
  }
  return '[content omitted]';
}

function isSecretField(key: string): boolean {
  return SECRET_FIELD_RE.test(key.replace(/([a-z])([A-Z])/g, '$1_$2'));
}

function isContentField(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return CONTENT_FIELD_RE.test(normalized) || CONTENT_FIELD_SUFFIX_RE.test(normalized);
}

function isSafeMetadataField(key: string): boolean {
  return SAFE_METADATA_FIELD_RE.test(key.replace(/([a-z])([A-Z])/g, '$1_$2'));
}

function safeErrorRecord(value: unknown): Record<string, unknown> {
  try {
    const error = value as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
    return {
      name: cleanDiagnosticText(error?.name || 'Error', 120),
      message: cleanDiagnosticText(error?.message || String(value), 600),
      ...(error?.code ? { code: cleanDiagnosticText(error.code, 120) } : {}),
      ...(error?.stack ? { stack: cleanDiagnosticText(error.stack, 1_200) } : {}),
    };
  } catch {
    return { name: 'Error', message: '[unreadable diagnostic]' };
  }
}

/**
 * Clone only diagnostic metadata. Free-form content is represented by length,
 * while credentials, chat text, prompts, tool arguments and document bodies
 * are never copied into the runtime log.
 */
function sanitizeStructuredDiagnostic(
  value: unknown,
  fieldName = '',
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  try {
    if (fieldName && isSecretField(fieldName)) return '[redacted]';
    if (fieldName && isContentField(fieldName)) return omittedContent(value);
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return value;
    }
    if (typeof value === 'string') {
      if (ERROR_FIELD_RE.test(fieldName)) return cleanDiagnosticText(value);
      return isSafeMetadataField(fieldName) ? cleanDiagnosticText(value, 300) : omittedText(value);
    }
    if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value} omitted]`;

    let nativeError = false;
    try { nativeError = util.types.isNativeError(value); } catch { nativeError = false; }
    if (nativeError) return safeErrorRecord(value);
    if (typeof value !== 'object') return omittedText(value);
    if (seen.has(value)) return '[circular reference]';
    if (depth >= 4) return '[nested diagnostic omitted]';
    seen.add(value);

    let arrayValue = false;
    try { arrayValue = Array.isArray(value); } catch { return '[uninspectable diagnostic]'; }
    if (arrayValue) {
      const output: unknown[] = [];
      let length = 0;
      try { length = Math.min(Number((value as unknown[]).length) || 0, 40); } catch { return '[uninspectable diagnostic]'; }
      for (let index = 0; index < length; index += 1) {
        try {
          output.push(sanitizeStructuredDiagnostic((value as unknown[])[index], '', depth + 1, seen));
        } catch {
          output.push('[unreadable item]');
        }
      }
      return output;
    }

    let keys: string[];
    try { keys = Object.keys(value as object).slice(0, 60); } catch { return '[uninspectable diagnostic]'; }
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      try {
        output[key] = sanitizeStructuredDiagnostic(
          (value as Record<string, unknown>)[key],
          key,
          depth + 1,
          seen,
        );
      } catch {
        output[key] = '[unreadable field]';
      }
    }
    return output;
  } catch {
    return '[uninspectable diagnostic]';
  }
}

function summarizePrimaryDiagnostic(value: string): string {
  try {
    const clean = cleanDiagnosticText(value, 1_000);
    const tagged = clean.match(/^\[([^\]]{1,80})\]\s*(.*)$/);
    if (tagged) {
      const component = cleanDiagnosticText(tagged[1], 80);
      const event = cleanDiagnosticText(tagged[2], 600)
        .replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '"[content omitted]"')
        .replace(/[\[{].*[\]}]/g, '[structured payload omitted]')
        .trim();
      return `component=${JSON.stringify(component)}${event ? ` event=${JSON.stringify(event)}` : ''}`;
    }
    if (/^(?:fatal|error|warning|warn)\s*:/i.test(clean)) {
      const [kind] = clean.split(':', 1);
      return `severity=${JSON.stringify(kind.toLowerCase())} detail=${JSON.stringify(cleanDiagnosticText(clean.slice(kind.length + 1)))}`;
    }
    return `event=${JSON.stringify(omittedText(value))}`;
  } catch {
    return 'event="[unreadable diagnostic]"';
  }
}

function renderArgument(value: unknown, index: number, primaryText: string): string {
  try {
    if (typeof value === 'string') {
      if (index === 0) return summarizePrimaryDiagnostic(value);
      if (/^[A-Za-z][A-Za-z0-9_. -]{0,40}:$/.test(value.trim())) return `label=${JSON.stringify(value.trim())}`;
      if (/(?:failed|failure|error|warning|warn|fatal|timeout|unavailable)/i.test(primaryText)) {
        return `detail=${JSON.stringify(cleanDiagnosticText(value))}`;
      }
      return `detail=${JSON.stringify(omittedText(value))}`;
    }
    const sanitized = sanitizeStructuredDiagnostic(value);
    return util.inspect(sanitized, {
      depth: 5,
      maxArrayLength: 40,
      maxStringLength: 2_000,
      breakLength: 180,
      compact: true,
      getters: false,
      customInspect: false,
    });
  } catch {
    return '[uninspectable diagnostic]';
  }
}

/** A bounded, credential-safe and content-minimized local diagnostic line. */
export function sanitizeRuntimeLogLine(values: unknown[]): string {
  try {
    const primaryText = typeof values?.[0] === 'string' ? values[0] : '';
    const rendered = Array.from(values || [], (value, index) => renderArgument(value, index, primaryText)).join(' ')
      .replace(IMAGE_DATA_URL_RE, '[image data omitted]')
      .replace(IMAGE_FIELD_RE, '$1[image data omitted]')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (rendered.length <= MAX_LOG_LINE_CHARS) return rendered;
    return `${rendered.slice(0, MAX_LOG_LINE_CHARS)} [truncated]`;
  } catch {
    return 'event="[runtime log sanitization failed]"';
  }
}

type RuntimeLogFile = {
  filePath: string;
  modifiedAt: number;
  size: number;
};

function listRuntimeLogFiles(runtimeDir: string): RuntimeLogFile[] {
  try {
    return fs.readdirSync(runtimeDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && RUNTIME_LOG_FILE_RE.test(entry.name))
      .map(entry => {
        const filePath = path.join(runtimeDir, entry.name);
        const stat = fs.statSync(filePath);
        return { filePath, modifiedAt: stat.mtimeMs, size: stat.size };
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt || right.filePath.localeCompare(left.filePath));
  } catch {
    return [];
  }
}

export function pruneRuntimeLogFiles(
  runtimeDir: string,
  options: { retainedFiles?: number; maxTotalBytes?: number; excludePath?: string } = {},
): void {
  const retainedFiles = boundedPositiveInt(options.retainedFiles, DEFAULT_RETAINED_LOG_FILES);
  const maxTotalBytes = boundedPositiveInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const excluded = options.excludePath ? path.resolve(options.excludePath) : '';
  let retained = 0;
  let retainedBytes = 0;
  for (const file of listRuntimeLogFiles(runtimeDir)) {
    const isActive = Boolean(excluded) && path.resolve(file.filePath) === excluded;
    const withinCount = retained < retainedFiles;
    const withinBytes = retained === 0 || retainedBytes + file.size <= maxTotalBytes;
    if (isActive || (withinCount && withinBytes)) {
      retained += 1;
      retainedBytes += file.size;
      continue;
    }
    try { fs.unlinkSync(file.filePath); } catch { /* Logging cleanup is best effort. */ }
  }
}

function segmentIndex(filePath: string): number {
  const match = path.basename(filePath).match(RUNTIME_LOG_FILE_RE);
  return match?.[2] ? Number(match[2]) : 0;
}

/** Date- and size-rotating sink. All public methods are fail-safe. */
export class RuntimeFileSink {
  private readonly runtimeDir: string;
  private readonly now: () => Date;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retainedFiles: number;
  private stream: fs.WriteStream | null = null;
  private activeDate = '';
  private activeBytes = 0;
  private currentPath = '';
  private readonly pendingClosures = new Set<Promise<void>>();

  constructor(options: RuntimeFileSinkOptions) {
    this.runtimeDir = options.runtimeDir;
    this.now = options.now || (() => new Date());
    this.maxFileBytes = boundedPositiveInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.maxTotalBytes = boundedPositiveInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.retainedFiles = boundedPositiveInt(options.retainedFiles, DEFAULT_RETAINED_LOG_FILES);
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    pruneRuntimeLogFiles(this.runtimeDir, {
      retainedFiles: this.retainedFiles,
      maxTotalBytes: this.maxTotalBytes,
    });
    this.openStream(this.now(), false);
  }

  get path(): string {
    return this.currentPath;
  }

  private choosePath(stamp: string, forceNewSegment: boolean): string {
    const sameDate = listRuntimeLogFiles(this.runtimeDir)
      .filter(file => path.basename(file.filePath).startsWith(`server-${stamp}`))
      .sort((left, right) => segmentIndex(left.filePath) - segmentIndex(right.filePath));
    const latest = sameDate.at(-1);
    if (!forceNewSegment && latest && latest.size < this.maxFileBytes) return latest.filePath;
    // createWriteStream opens asynchronously. During a burst, the segment we
    // just selected may not be visible to readdir yet, so include the in-memory
    // path when choosing the next suffix and never reopen the same segment.
    const currentIndex = this.activeDate === stamp && this.currentPath
      ? segmentIndex(this.currentPath)
      : -1;
    const latestIndex = latest ? segmentIndex(latest.filePath) : -1;
    const index = Math.max(currentIndex, latestIndex) + 1;
    return path.join(this.runtimeDir, index === 0
      ? `server-${stamp}.log`
      : `server-${stamp}-${String(index).padStart(3, '0')}.log`);
  }

  private closeActiveStream(): void {
    const closing = this.stream;
    this.stream = null;
    if (!closing) return;
    const completion = new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      closing.once('close', finish);
      closing.once('error', finish);
      try { closing.end(); } catch { finish(); }
    });
    this.pendingClosures.add(completion);
    void completion.finally(() => {
      this.pendingClosures.delete(completion);
      pruneRuntimeLogFiles(this.runtimeDir, {
        retainedFiles: this.retainedFiles,
        maxTotalBytes: this.maxTotalBytes,
        excludePath: this.stream ? this.currentPath : undefined,
      });
    });
  }

  private openStream(now: Date, forceNewSegment: boolean): void {
    const stamp = dateStamp(now);
    this.currentPath = this.choosePath(stamp, forceNewSegment);
    this.activeDate = stamp;
    try { this.activeBytes = fs.statSync(this.currentPath).size; } catch { this.activeBytes = 0; }
    const nextStream = fs.createWriteStream(this.currentPath, { flags: 'a', encoding: 'utf8', mode: 0o600 });
    this.stream = nextStream;
    nextStream.on('error', () => {
      if (this.stream === nextStream) this.stream = null;
    });
    pruneRuntimeLogFiles(this.runtimeDir, {
      retainedFiles: this.retainedFiles,
      maxTotalBytes: this.maxTotalBytes,
      excludePath: this.currentPath,
    });
  }

  write(level: ConsoleLevel, line: string): void {
    try {
      if (!line) return;
      const now = this.now();
      const entry = `${now.toISOString()} ${level.toUpperCase()} pid=${process.pid} ${line}\n`;
      const bytes = Buffer.byteLength(entry, 'utf8');
      const stamp = dateStamp(now);
      const dateChanged = stamp !== this.activeDate;
      const sizeExceeded = this.activeBytes > 0 && this.activeBytes + bytes > this.maxFileBytes;
      if (!this.stream || dateChanged || sizeExceeded) {
        this.closeActiveStream();
        this.openStream(now, sizeExceeded && !dateChanged);
      }
      try {
        this.stream?.write(entry);
        this.activeBytes += bytes;
      } catch {
        this.closeActiveStream();
      }
    } catch {
      // Diagnostics must never affect the application path that emitted them.
    }
  }

  async close(): Promise<void> {
    try {
      this.closeActiveStream();
      while (this.pendingClosures.size > 0) {
        await Promise.allSettled([...this.pendingClosures]);
      }
      pruneRuntimeLogFiles(this.runtimeDir, {
        retainedFiles: this.retainedFiles,
        maxTotalBytes: this.maxTotalBytes,
      });
    } catch {
      // Closing diagnostics is best effort.
    }
  }
}

export function createSafeConsoleMirror(
  original: (...values: unknown[]) => void,
  level: ConsoleLevel,
  writeLine: (level: ConsoleLevel, line: string) => void,
): (...values: unknown[]) => void {
  return (...values: unknown[]) => {
    try { original(...values); } catch { /* A diagnostic console must not be a failure boundary. */ }
    try {
      const line = sanitizeRuntimeLogLine(values);
      if (line) writeLine(level, line);
    } catch {
      // Logging is deliberately isolated from the caller.
    }
  };
}

/** Mirror content-minimized console diagnostics into the formal Lumi data root. */
export function installRuntimeFileLogger(now = new Date()): string {
  if (installed) return activeLogPath;
  installed = true;
  try {
    let initialNow: Date | null = now;
    const clock = () => {
      if (initialNow) {
        const value = initialNow;
        initialNow = null;
        return value;
      }
      return new Date();
    };
    runtimeSink = new RuntimeFileSink({
      runtimeDir: path.join(getDataRoot(), 'runtime'),
      now: clock,
    });
    activeLogPath = runtimeSink.path;

    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[level].bind(console);
      console[level] = createSafeConsoleMirror(
        original,
        level,
        (entryLevel, line) => {
          runtimeSink?.write(entryLevel, line);
          if (runtimeSink?.path) activeLogPath = runtimeSink.path;
        },
      ) as typeof console[typeof level];
    }
    process.once('beforeExit', () => { void runtimeSink?.close(); });
  } catch {
    activeLogPath = '';
    runtimeSink = null;
  }
  return activeLogPath;
}
