import path from 'path';
import { normalizeActionIntent } from './normalized_action_intent';

export interface DeterministicToolRecoveryCall {
  name: string;
  arguments: Record<string, unknown>;
  reason: 'explicit_exact_text_write';
}

const WINDOWS_TEXT_PATH_RE = /[A-Za-z]:[\\/][^\r\n"'<>|?*]+?\.(?:txt|md)(?=$|[\s,.;:)}\]])/giu;
const POSIX_TEXT_PATH_RE = /\/(?:[^/\r\n"'<>|?*]+\/)*[^/\r\n"'<>|?*]+?\.(?:txt|md)(?=$|[\s,.;:)}\]])/gu;
const EXACT_CONTENT_MARKER_RE = /\bwith\s+(?:the\s+)?exact\s+content\b/giu;
const WRITE_FILE_DIRECTIVE_RE = /\.\s*(?:call|use|invoke)\s+(?:the\s+)?write_file\b/iu;
const EXPLICIT_WRITE_FILE_RE = /\b(?:call|use|invoke)\s+(?:the\s+)?write_file\b/iu;

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

  const contentMarkers = Array.from(text.matchAll(EXACT_CONTENT_MARKER_RE));
  if (contentMarkers.length !== 1) return null;
  const marker = contentMarkers[0];
  const contentTail = text.slice((marker.index || 0) + marker[0].length).trimStart();
  const directive = contentTail.match(WRITE_FILE_DIRECTIVE_RE);
  if (!directive || directive.index === undefined) return null;
  const content = unwrapExactContent(contentTail.slice(0, directive.index));
  if (content === null) return null;

  return {
    name: 'write_file',
    arguments: { path: targetPath, content },
    reason: 'explicit_exact_text_write',
  };
}
