import type { MessageRecord } from './manager';
import { toolRecordVerifiedForCompletion } from '../cognition/task_execution_ledger';

// i18n-allow: Chinese summary-grounding recognition pattern; not user-visible copy.
const EXECUTION_OUTCOME_RE = /(?:已(?:经)?(?:完成|执行|检查|测试|切换|生成|打开|启动|运行|播放|保存|创建|写入|发送|读取|关闭|删除|确认|配置|注册)|成功(?:切换|生成|打开|启动|运行|播放|保存|创建|写入|发送|读取|关闭|删除)|(?:完成了|执行了|进行了).{0,48}(?:检查|测试|诊断|切换|生成|发送|打开|读取)|检查(?:已)?完成|测试(?:已)?通过|执行完毕|运行正常|一切正常|无异常|全部通过|(?:检查|测试|结果|状态).{0,24}(?:均|都|全部)?(?:正常|通过|无异常)|(?:检查|测试|诊断).{0,32}(?:确认|判断).{0,32}(?:模型|网络|连接|工具|端口|MCP)|(?:Lumi|助手|系统).{0,20}(?:确认|判断).{0,32}(?:模型|网络|连接|工具|端口|MCP)|\b(?:completed|passed|verified|successfully\s+(?:ran|tested|switched|opened|sent|created)|all\s+checks\s+passed|running\s+normally|no\s+issues)\b)/iu;
// Plans and in-progress assertions are execution claims too. Without a receipt
// they must not be replayed into later prompt history as unfinished commands.
// i18n-allow: Chinese execution-claim recognition; not user-visible copy.
const EXECUTION_ACTIVITY_RE = /(?:(?:我|Lumi|这边)[^。！？!?\n]{0,28}(?:现在|马上|正在|开始|继续|并行)[^。！？!?\n]{0,36}(?:执行|处理|打开|启动|创建|新建|发送|检查|操作)|(?:现在|马上|正在|开始|继续)[^。！？!?\n]{0,24}(?:按顺序|并行)?[^。！？!?\n]{0,24}(?:执行|处理|打开|启动|创建|新建|发送|检查|操作)|工具(?:链|链路)[^。！？!?\n]{0,20}(?:恢复|可用)|\b(?:I(?:'m| am| will)|Lumi is)\b[^.!?\n]{0,48}\b(?:executing|processing|opening|starting|creating|sending|checking|working on)\b)/iu;
// i18n-allow: Chinese user-action recognition pattern; not user-visible copy.
const EXPLICIT_USER_OWN_ACTION_RE = /^(?:用户|\buser\b)(?:此前|之前|先前|已经|已|亲自|\s|previously|already){0,4}(?:完成|执行|测试|检查|completed|ran|tested|checked)/iu;

/** Reserved server-generated marker copied through prompt compaction. */
export const COMPACT_TOOL_EVIDENCE_PREFIX = '[LUMI_INTERNAL_RECEIPT_LEDGER_V1:';
const LEGACY_COMPACT_TOOL_EVIDENCE_PREFIX = '[Verified tool receipt ledger:';
const COMPACT_TOOL_EVIDENCE_MAX_CHARS = 1800;
const COMPACT_TOOL_EVIDENCE_FIELD = 'toolReceiptLedger';
const RECEIPT_LEDGER_OUTCOME_RE = /(?:^| \| )(?:error|returned_failure|outcome|receipt)=[^|\]]+/u;
const RECEIPT_LEDGER_TOOL_RE = /^[A-Za-z0-9_.:/-]{1,160}(?: \| )/u;
const COMPACT_SECRET_ASSIGNMENT_RE = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;|\]]+/giu;
const COMPACT_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu;
const COMPACT_JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g;

function compactEvidenceValue(value: unknown, limit: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\|\s*/g, ' / ')
    .replace(/\s+\|\s+/g, ' / ')
    .replace(COMPACT_SECRET_ASSIGNMENT_RE, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(COMPACT_BEARER_RE, 'Bearer [REDACTED]')
    .replace(COMPACT_JWT_RE, '[REDACTED_JWT]')
    .trim()
    .slice(0, limit);
}

function validateCompactToolEvidenceNote(value: unknown): string {
  const note = String(value || '').trim();
  if (
    !note
    || note.length > COMPACT_TOOL_EVIDENCE_MAX_CHARS
    || !note.endsWith(']')
    || !(
      note.startsWith(COMPACT_TOOL_EVIDENCE_PREFIX)
      || note.startsWith(LEGACY_COMPACT_TOOL_EVIDENCE_PREFIX)
    )
  ) return '';
  const separator = note.indexOf(':');
  const body = note.slice(separator + 1, -1).trim();
  if (!body || /[\r\n]/u.test(body)) return '';
  const entries = body.split(' || ');
  if (entries.length === 0 || entries.length > 12) return '';
  if (entries.some(entry => (
    entry.length > 700
    || !RECEIPT_LEDGER_TOOL_RE.test(entry)
    || !RECEIPT_LEDGER_OUTCOME_RE.test(entry)
  ))) return '';
  return note;
}

/**
 * Extract only a trailing, strictly-shaped server receipt ledger. Assistant
 * prose before the marker is deliberately excluded and remains untrusted.
 */
export function extractCompactToolEvidenceNote(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const starts = [
    text.lastIndexOf(COMPACT_TOOL_EVIDENCE_PREFIX),
    text.lastIndexOf(LEGACY_COMPACT_TOOL_EVIDENCE_PREFIX),
  ].filter(index => index >= 0);
  if (starts.length === 0) return '';
  const start = Math.max(...starts);
  if (start > 0 && !/[\r\n]/u.test(text[start - 1])) return '';
  const candidate = text.slice(start).trim();
  return validateCompactToolEvidenceNote(candidate);
}

/** Detect reserved markers in untrusted prose without treating them as evidence. */
export function containsCompactToolEvidenceMarker(value: unknown): boolean {
  const text = String(value || '');
  return text.includes(COMPACT_TOOL_EVIDENCE_PREFIX)
    || text.includes(LEGACY_COMPACT_TOOL_EVIDENCE_PREFIX);
}

/** Read only the server-owned compaction field. Ordinary assistant text is untrusted. */
export function readCompactToolEvidenceNote(
  record: Record<string, unknown> | null | undefined,
): string {
  if (!record) return '';
  return validateCompactToolEvidenceNote(record[COMPACT_TOOL_EVIDENCE_FIELD]);
}

function normalizeToolCalls(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function verifiedToolNames(value: unknown): string[] {
  return Array.from(new Set(normalizeToolCalls(value)
    .filter(call => call && toolRecordVerifiedForCompletion({
      id: String(call.id || ''),
      name: String(call.name || call.toolName || ''),
      arguments: call.arguments || call.args || {},
      result: typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? ''),
      error: String(call.error || '').trim() || undefined,
      terminalVerification: call.terminalVerification,
      capability: call.capability,
    }))
    .map(call => String(call.name || '').trim())
    .filter(Boolean)));
}

function parseToolResult(value: unknown): any {
  let current: any = value;
  for (let depth = 0; depth < 3 && typeof current === 'string' && current.trim(); depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  return current && typeof current === 'object' ? current : null;
}

/**
 * Keep a small receipt ledger in prompt history without replaying provider
 * tool-call protocol or large/sensitive payloads.
 */
export function buildCompactToolEvidenceNote(value: unknown): string {
  const calls = normalizeToolCalls(value).slice(-12);
  if (calls.length === 0) return '';
  const entries = calls.map(call => {
    const name = compactEvidenceValue(call?.name || call?.toolName, 120)
      .replace(/[^A-Za-z0-9_.:/-]/g, '_');
    if (!name) return '';
    const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    const payload = parseToolResult(call?.result);
    const envelope = payload?.envelope && typeof payload.envelope === 'object'
      ? payload.envelope
      : payload;
    const result = envelope?.result && typeof envelope.result === 'object'
      ? envelope.result
      : payload;
    const argumentScope = [
      args.role ? `role=${compactEvidenceValue(args.role, 80)}` : '',
      args.action ? `action=${compactEvidenceValue(args.action, 100)}` : '',
      args.target ? `target=${compactEvidenceValue(args.target, 100)}` : '',
      args.section ? `section=${compactEvidenceValue(args.section, 100)}` : '',
      args.mode ? `mode=${compactEvidenceValue(args.mode, 80)}` : '',
      args.path ? `path=${compactEvidenceValue(args.path, 180)}` : '',
    ].filter(Boolean);
    const facts: string[] = [];
    if (payload?.roles && typeof payload.roles === 'object') {
      facts.push(`roles=${Object.keys(payload.roles).slice(0, 20).join('|')}`);
    }
    if (payload?.configuration && typeof payload.configuration === 'object') {
      facts.push(`provider=${compactEvidenceValue(payload.configuration.provider, 80)}`);
      facts.push(`model=${compactEvidenceValue(payload.configuration.model, 120)}`);
      facts.push(`configured=${String(payload.configuration.configured === true)}`);
    }
    const live = result && typeof result === 'object' ? result : null;
    if (live) {
      if (live.provider) facts.push(`provider=${compactEvidenceValue(live.provider, 80)}`);
      if (live.model) facts.push(`model=${compactEvidenceValue(live.model, 120)}`);
      if (Number.isFinite(Number(live.latencyMs))) facts.push(`latencyMs=${Number(live.latencyMs)}`);
      if (live.action && !args.action) facts.push(`action=${compactEvidenceValue(live.action, 100)}`);
      if (live.target && !args.target) facts.push(`target=${compactEvidenceValue(live.target, 100)}`);
      if (live.section && !args.section) facts.push(`section=${compactEvidenceValue(live.section, 100)}`);
      if (live.mode && !args.mode) facts.push(`mode=${compactEvidenceValue(live.mode, 80)}`);
    }
    const verification = live?.verification && typeof live.verification === 'object'
      ? live.verification
      : envelope?.verification && typeof envelope.verification === 'object'
        ? envelope.verification
        : {};
    const verificationStatus = compactEvidenceValue(
      call?.terminalVerification?.status || verification.status || '',
      80,
    );
    if (verificationStatus) facts.push(`verification=${verificationStatus}`);
    if (Array.isArray(verification.matched) && verification.matched.length) {
      facts.push(`matched=${verification.matched.map((item: unknown) => compactEvidenceValue(item, 100)).filter(Boolean).slice(0, 6).join('|')}`);
    }
    if (Array.isArray(payload?.targets)) facts.push(`targets=${payload.targets.length}`);
    if (Array.isArray(payload)) facts.push(`items=${payload.length}`);
    const error = compactEvidenceValue(call?.error || payload?.error, 180);
    const envelopeStatus = compactEvidenceValue(envelope?.status, 80);
    const status = error
      ? `error=${error}`
      : payload?.ok === false
        ? `returned_failure=${compactEvidenceValue(payload?.reason || payload?.message || payload?.status || 'true', 180)}`
        : envelopeStatus
          ? `outcome=${envelopeStatus}`
          : verificationStatus === 'verified'
            ? 'outcome=verified_success'
            : `receipt=${compactEvidenceValue(payload?.status || (String(call?.result || '').trim() ? 'returned' : 'empty'), 80)}`;
    // Put terminal outcome before optional scope/facts so a bounded entry can
    // never be truncated into an identity-only statement that looks proven.
    return [name, status, ...argumentScope, ...facts.filter(Boolean)].join(' | ').slice(0, 700);
  }).filter(Boolean);
  if (entries.length === 0) return '';
  const selected: string[] = [];
  const fixedLength = COMPACT_TOOL_EVIDENCE_PREFIX.length + 2;
  let bodyLength = 0;
  for (const entry of entries) {
    const nextLength = bodyLength + (selected.length > 0 ? 4 : 0) + entry.length;
    if (fixedLength + nextLength > COMPACT_TOOL_EVIDENCE_MAX_CHARS) break;
    selected.push(entry);
    bodyLength = nextLength;
  }
  return selected.length > 0
    ? `${COMPACT_TOOL_EVIDENCE_PREFIX} ${selected.join(' || ')}]`
    : '';
}

export function isUnverifiedExecutionAssistantText(value: unknown): boolean {
  const text = String(value || '').trim();
  return Boolean(
    text
    && (EXECUTION_OUTCOME_RE.test(text) || EXECUTION_ACTIVITY_RE.test(text)),
  );
}

export function isUnverifiedExecutionAssistantRecord(message: MessageRecord): boolean {
  if (String(message.role || '').toLowerCase() !== 'assistant') return false;
  if (verifiedToolNames(message.toolCalls).length > 0) return false;
  return isUnverifiedExecutionAssistantText(message.message || message.response || '');
}

/** Keep outcomes only when the same record carries successful tool receipts. */
export function buildEvidenceGroundedSummaryTranscript(messages: MessageRecord[]): string {
  return messages
    .slice(-30)
    .filter(message => String(message.role || '').toLowerCase() !== 'tool')
    .filter(message => !isUnverifiedExecutionAssistantRecord(message))
    .map(message => {
      const role = String(message.role || 'user').toLowerCase();
      const content = String(message.message || '').slice(0, 260);
      if (role !== 'assistant') return `${role}: ${content}`;
      const tools = verifiedToolNames(message.toolCalls);
      return tools.length
        ? `assistant [verified current-turn tools: ${tools.join(', ')}]: ${content}`
        : `assistant: ${content}`;
    })
    .join('\n')
    .trim();
}

/** Remove unsupported execution facts from summaries created by older builds. */
export function sanitizeSummaryForPrompt(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const clauses = text
    // i18n-allow: Chinese sentence-boundary recognition; not user-visible copy.
    .split(/(?<=[。！？.!?;；])|\s*\|\s*|\n+/u)
    .map(clause => clause.trim())
    .filter(Boolean);
  const clean = clauses.filter(clause => {
    if (EXPLICIT_USER_OWN_ACTION_RE.test(clause)) return true;
    if (!EXECUTION_OUTCOME_RE.test(clause)) return true;
    return false;
  });
  return clean.join(' ').trim();
}
