import { matchesCnActionContinuation } from '../regions/packs/cn/action_continuation';

export interface ActionContinuationHistoryItem {
  role?: string;
  type?: string;
  message?: string;
  content?: string;
  text?: string;
  response?: string;
  toolCalls?: unknown;
}

const ENGLISH_SHORT_CONTINUATION_RE =
  /^(?:(?:continue|resume|proceed)(?: this| that| it| the task)?|next(?: step)?|run it|execute it|start it|try again|retry|draw it|open it|save it|export it|send it|submit it|do it|what happened|status|(?:continue|run|execute|handle|do)(?: this| that| it| the task)? in (?:the )?background)[.!?]*$/i;

const ENGLISH_REFERENTIAL_ACTION_RE =
  /(?:according to|based on|use)(?: what is| what's)? (?:inside|above|before|previous|earlier)|(?:run|execute|open|process|draw|save|export|send|submit|continue) (?:it|that|this|the previous one)/i;

function compact(value: unknown, limit = 700): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function recordRole(item: ActionContinuationHistoryItem): string {
  return String(item.role || item.type || '').toLowerCase();
}

function recordText(item: ActionContinuationHistoryItem): string {
  const role = recordRole(item);
  if (role === 'assistant' || role === 'agent') {
    return compact(item.response || item.message || item.content || item.text);
  }
  return compact(item.message || item.content || item.text || item.response);
}

function parseNestedJson(value: unknown): unknown {
  let parsed = value;
  for (let index = 0; index < 3 && typeof parsed === 'string'; index += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

function collectPathValues(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 4 || paths.size >= 5 || value == null) return;
  if (typeof value === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(value.trim())) paths.add(value.trim().slice(0, 500));
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 12).forEach(item => collectPathValues(item, paths, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>)
      .slice(0, 24)
      .forEach(item => collectPathValues(item, paths, depth + 1));
  }
}

function summarizeToolCalls(history: ActionContinuationHistoryItem[]): string[] {
  const summaries: string[] = [];
  const seen = new Set<string>();
  for (const item of history.slice(-12)) {
    const parsed = parseNestedJson(item.toolCalls);
    if (!Array.isArray(parsed)) continue;
    for (const call of parsed.slice(-10)) {
      const name = compact(call?.name || call?.toolName, 120);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const result = parseNestedJson(call?.result);
      const status = compact(call?.error || (result as any)?.status || call?.status || '', 120);
      const paths = new Set<string>();
      collectPathValues(call?.arguments || call?.args, paths);
      collectPathValues(result, paths);
      summaries.push([
        name,
        status ? `status=${status}` : '',
        paths.size ? `paths=${Array.from(paths).slice(0, 3).join(' | ')}` : '',
      ].filter(Boolean).join(' | '));
    }
  }
  return summaries.slice(-8);
}

export function needsRecentActionContinuationContext(userText: string): boolean {
  const clean = compact(userText, 500);
  if (!clean || clean.length > 180) return false;
  return matchesCnActionContinuation(clean)
    || ENGLISH_SHORT_CONTINUATION_RE.test(clean)
    || ENGLISH_REFERENTIAL_ACTION_RE.test(clean);
}

export function buildRecentActionContinuationBridge(
  userText: string,
  history: ActionContinuationHistoryItem[] | undefined,
): string {
  if (!needsRecentActionContinuationContext(userText) || !Array.isArray(history) || history.length === 0) {
    return '';
  }

  const currentText = compact(userText, 700);
  const recent = history
    .slice(-18)
    .filter(item => ['user', 'assistant', 'agent'].includes(recordRole(item)) && recordText(item))
    .filter(item => !(recordRole(item) === 'user' && recordText(item) === currentText));
  const deduplicate = (items: ActionContinuationHistoryItem[]) => items.filter((item, index, candidates) => {
    const roleGroup = recordRole(item) === 'user' ? 'user' : 'assistant';
    const key = `${roleGroup}:${recordText(item)}`;
    return candidates.findIndex(candidate => {
      const candidateRoleGroup = recordRole(candidate) === 'user' ? 'user' : 'assistant';
      return `${candidateRoleGroup}:${recordText(candidate)}` === key;
    }) === index;
  });
  const deduplicated = deduplicate(recent);
  const lastUserIndex = recent.map(recordRole).lastIndexOf('user');
  const executionTail = lastUserIndex >= 0 ? recent.slice(lastUserIndex + 1) : recent;
  const userTurns = deduplicated
    .filter(item => recordRole(item) === 'user')
    .map(recordText)
    .slice(-4);
  const assistantTurns = deduplicate(executionTail)
    .filter(item => ['assistant', 'agent'].includes(recordRole(item)))
    .map(recordText)
    .slice(-3);
  const toolSummaries = summarizeToolCalls(executionTail);

  if (userTurns.length === 0 && assistantTurns.length === 0 && toolSummaries.length === 0) return '';

  return [
    '## Recent action continuation context',
    'The current message is referential or underspecified. Resolve it against the recent task below before routing, delegating, or choosing tools.',
    userTurns.length ? 'Recent user task context:' : '',
    ...userTurns.map(turn => `- ${turn}`),
    assistantTurns.length ? 'Recent Lumi execution state:' : '',
    ...assistantTurns.map(turn => `- ${turn}`),
    toolSummaries.length ? 'Recent tool evidence:' : '',
    ...toolSummaries.map(summary => `- ${summary}`),
    'Rules:',
    '- Continue the same target, application, files, and acceptance criteria unless the user clearly starts a new task.',
    '- Do not reinterpret an underspecified verb such as draw, run, send, open, or continue into another domain.',
    '- Preparation is not completion. Preserve the latest blocker and require evidence for the original task contract.',
    '- Historical attachments are not current inputs; reuse only explicit local paths or artifacts shown in this context.',
  ].filter(Boolean).join('\n');
}
