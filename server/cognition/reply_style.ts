export type TextReplyChannel = 'chat' | 'task' | 'voice';

/**
 * Shared presentation contract for user-visible text channels. Execution
 * truth is decided elsewhere; this overlay only prevents a verified result or
 * blocker from being dumped as an internal, unreadable process report.
 */
export function buildTextReplyStyleOverlay(channel: TextReplyChannel = 'chat'): string {
  const voiceLine = channel === 'voice'
    ? '- In voice, default to one short sentence. If the user asks a simple question, answer in under 20 Chinese characters when possible.'
    : '- Default to concise replies. Use detail only when the user asks for analysis, implementation, or a report.';
  return [
    '## Reply Style',
    '- Never reveal hidden reasoning, chain-of-thought, private deliberation, or “I need to think/analyze” narration.',
    '- Give the final answer directly. Do not describe how you are deciding unless the user explicitly asks for reasoning.',
    '- If corrected for being verbose, reply with only the correction or confirmation.',
    '- Make the answer easy to scan: use short paragraphs of 2-4 sentences and put a blank line between paragraphs.',
    '- When the answer has multiple topics, use brief descriptive headings and compact bullet lists. Do not produce a single dense wall of text.',
    '- Every Markdown list marker must start on its own line. Never place “- item” or a second list item inline after a colon or another sentence.',
    '- Keep hierarchy restrained: lead with the outcome, then supporting details, then next actions when needed.',
    '- For task updates, report only the verified outcome, the exact blocker when one exists, and the next action when one is useful. Do not dump tool names, task ids, receipt schemas, internal file paths, or empty execution sections into ordinary chat unless the user explicitly asks for diagnostics.',
    voiceLine,
  ].join('\n');
}

export interface UserVisibleReplyLayoutOptions {
  /** The accepted user turn, used only to honor an explicit line-layout request. */
  task?: string;
}

const PROTECTED_REPLY_SPAN_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]*`/gu;
// i18n-allow: user-authored layout intent recognition; not user-visible copy.
const EXPLICIT_LINE_LAYOUT_RE = /(?:分(?:成|为)?|拆成|写成|按)\s*(?:[一二三四五六七八九十\d]+\s*)?行|逐行|每(?:项|个|条|一项|一个|一条)[^。！？!?\n]{0,12}(?:一行|单独一行)|\b(?:separate\s+lines?|one\s+per\s+line|each\s+(?:item|field).{0,12}\bline)\b/iu;
// i18n-allow: field labels in model output; not user-visible copy.
const NAMED_SHORT_FIELD_RE = /(?:项目名称|版本号|路径|文件|名称|版本|\b(?:path|file|name|version)\b)(?:\s*[（(][^）)\r\n]{0,48}[）)])?\s*(?:是|为|[:：])/iu;
// i18n-allow: exact path/name/version line-layout request recognition; not user-visible copy.
const PATH_NAME_VERSION_LAYOUT_RE = /(?:路径|path).{0,24}(?:name|名称).{0,24}(?:version|版本)|(?:version|版本).{0,24}(?:name|名称).{0,24}(?:路径|path)/iu;

function isCompleteJsonDocument(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[{[]/u.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function maskProtectedReplySpans(value: string): {
  text: string;
  restore: (formatted: string) => string;
} {
  const protectedSpans: string[] = [];
  const text = value.replace(PROTECTED_REPLY_SPAN_RE, span => {
    const index = protectedSpans.push(span) - 1;
    return `\uE000LUMI_REPLY_${index}\uE001`;
  });
  return {
    text,
    restore: formatted => formatted.replace(/\uE000LUMI_REPLY_(\d+)\uE001/gu, (_match, rawIndex) => (
      protectedSpans[Number(rawIndex)] ?? _match
    )),
  };
}

function formatInlineMarkdownLists(value: string): { text: string; changed: boolean } {
  // A marker directly after a colon or after two horizontal spaces is an
  // unmistakable attempted Markdown list. A marker touching sentence
  // punctuation is accepted only for Markdown-strong/check-list items, so
  // ordinary ranges and prose dashes stay untouched.
  const unmistakableList = /(?:[：:]\s*|[\t ]{2,})-\s+\S/u.test(value)
    || /[。；;！？!?][\t ]*-\s+(?:\*\*|__|\[[ xX]\])/u.test(value);
  if (!unmistakableList) return { text: value, changed: false };

  const formatted = value
    .replace(/([：:])[\t ]*-\s+(?=\S)/gu, '$1\n\n- ')
    .replace(/([。；;！？!?])[\t ]*-\s+(?=(?:\*\*|__|\[[ xX]\]))/gu, '$1\n- ')
    .replace(/[\t ]{2,}-\s+(?=\S)/gu, '\n- ')
    .replace(/[\t ]+-\s+(?=(?:\*\*|__|\[[ xX]\]))/gu, '\n- ');
  if (formatted === value) return { text: value, changed: false };

  return {
    text: formatted
      // Keep a warning/follow-up from becoming part of the preceding bullet.
      // i18n-allow: common user-facing warning-heading recognition.
      .replace(/([。！？!?])(?=\s*⚠️\s*(?:注意|Note))/giu, '$1\n\n')
      // i18n-allow: common user-facing follow-up question recognition.
      .replace(/([。！？!?])(?=\s*(?:需要我|要不要我|是否需要我|如果你愿意|Would you like|Do you want))/giu, '$1\n\n'),
    changed: true,
  };
}

function isSafeShortLayoutPart(value: string): boolean {
  const part = value.trim();
  return Boolean(part) && part.length <= 180 && !/[。！？!?]\s+\S.{80,}/u.test(part);
}

function formatShortStructuredFields(value: string, task: string): string {
  const explicitLineLayout = EXPLICIT_LINE_LAYOUT_RE.test(task);
  return value.split('\n').map(line => {
    if (!/[\t ]{2,}/u.test(line) || /^\s*(?:[-*+]\s|\d+[.)]\s)/u.test(line)) return line;
    const indentation = line.match(/^\s*/u)?.[0] || '';
    const parts = line.trim().split(/[\t ]{2,}/u).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 8 || !parts.every(isSafeShortLayoutPart)) return line;
    const allNamedFields = parts.every(part => NAMED_SHORT_FIELD_RE.test(part));
    if (!explicitLineLayout && !allNamedFields) return line;
    return `${indentation}${parts.join(`\n${indentation}`)}`;
  }).join('\n');
}

function formatExplicitBarePathTriplet(value: string, task: string): string {
  if (!EXPLICIT_LINE_LAYOUT_RE.test(task) || !PATH_NAME_VERSION_LAYOUT_RE.test(task)) return value;
  return value.split('\n').map(line => {
    const match = line.match(/^\s*([A-Za-z]:\\.+?\.[A-Za-z0-9]{1,12})\s+([A-Za-z0-9@._/-]+)\s+(v?\d+(?:\.\d+){1,4}(?:[-+][A-Za-z0-9._-]+)?)\s*$/u);
    if (!match) return line;
    return `${match[1]}\n${match[2]}\n${match[3]}`;
  }).join('\n');
}

/**
 * Conservative final presentation pass for user-visible text.
 *
 * This owns layout only, never execution truth. It repairs unmistakable
 * inline Markdown lists and compact structured fields while preserving JSON,
 * fenced/inline code, URLs and Windows paths byte-for-byte.
 */
export function formatUserVisibleReplyForReadability(
  value: string,
  options: UserVisibleReplyLayoutOptions = {},
): string {
  const text = String(value || '');
  if (!text.trim() || isCompleteJsonDocument(text)) return text;
  const masked = maskProtectedReplySpans(text);
  const listResult = formatInlineMarkdownLists(masked.text);
  const structured = formatShortStructuredFields(listResult.text, String(options.task || ''));
  const explicitTriplet = formatExplicitBarePathTriplet(structured, String(options.task || ''));
  return masked.restore(explicitTriplet);
}

/** Backward-compatible name for grounded task-result callers. */
export function formatVerifiedTaskResultForReadability(value: string): string {
  return formatUserVisibleReplyForReadability(value);
}
