import type { MessageRecord } from './manager';

// i18n-allow: Chinese summary-grounding recognition pattern; not user-visible copy.
const EXECUTION_OUTCOME_RE = /(?:已(?:经)?(?:完成|执行|检查|测试|切换|生成|打开|发送|读取|确认|配置|注册)|(?:完成了|执行了|进行了).{0,48}(?:检查|测试|诊断|切换|生成|发送|打开|读取)|检查(?:已)?完成|测试(?:已)?通过|执行完毕|运行正常|一切正常|无异常|全部通过|成功切换|(?:检查|测试|结果|状态).{0,24}(?:均|都|全部)?(?:正常|通过|无异常)|(?:检查|测试|诊断).{0,32}(?:确认|判断).{0,32}(?:模型|网络|连接|工具|端口|MCP)|(?:Lumi|助手|系统).{0,20}(?:确认|判断).{0,32}(?:模型|网络|连接|工具|端口|MCP)|\b(?:completed|passed|verified|successfully\s+(?:ran|tested|switched|opened|sent|created)|all\s+checks\s+passed|running\s+normally|no\s+issues)\b)/iu;
// i18n-allow: Chinese summary evidence-marker recognition pattern; not user-visible copy.
const EVIDENCE_MARKER_RE = /(?:经本轮工具回执验证|verified\s+by\s+current-turn\s+tool\s+receipts)/iu;
// i18n-allow: Chinese user-action recognition pattern; not user-visible copy.
const EXPLICIT_USER_OWN_ACTION_RE = /^(?:用户|\buser\b)(?:此前|之前|先前|已经|已|亲自|\s|previously|already){0,4}(?:完成|执行|测试|检查|completed|ran|tested|checked)/iu;

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

function successfulToolNames(value: unknown): string[] {
  return Array.from(new Set(normalizeToolCalls(value)
    .filter(call => call && !String(call.error || '').trim() && String(call.result || '').trim())
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
    const name = String(call?.name || call?.toolName || '').trim().slice(0, 120);
    if (!name) return '';
    const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    const payload = parseToolResult(call?.result);
    const argumentScope = [
      args.role ? `role=${String(args.role).slice(0, 80)}` : '',
      args.target ? `target=${String(args.target).slice(0, 100)}` : '',
      args.path ? `path=${String(args.path).slice(0, 180)}` : '',
    ].filter(Boolean);
    const facts: string[] = [];
    if (payload?.roles && typeof payload.roles === 'object') {
      facts.push(`roles=${Object.keys(payload.roles).slice(0, 20).join('|')}`);
    }
    if (payload?.configuration && typeof payload.configuration === 'object') {
      facts.push(`provider=${String(payload.configuration.provider || '').slice(0, 80)}`);
      facts.push(`model=${String(payload.configuration.model || '').slice(0, 120)}`);
      facts.push(`configured=${String(payload.configuration.configured === true)}`);
    }
    const live = payload?.result && typeof payload.result === 'object' ? payload.result : null;
    if (live) {
      if (live.provider) facts.push(`provider=${String(live.provider).slice(0, 80)}`);
      if (live.model) facts.push(`model=${String(live.model).slice(0, 120)}`);
      if (Number.isFinite(Number(live.latencyMs))) facts.push(`latencyMs=${Number(live.latencyMs)}`);
    }
    if (Array.isArray(payload?.targets)) facts.push(`targets=${payload.targets.length}`);
    if (Array.isArray(payload)) facts.push(`items=${payload.length}`);
    const error = String(call?.error || payload?.error || '').trim().slice(0, 180);
    const status = error
      ? `error=${error}`
      : payload?.ok === false
        ? `returned_failure=${String(payload?.reason || payload?.message || payload?.status || 'true').slice(0, 180)}`
        : `receipt=${String(payload?.status || (String(call?.result || '').trim() ? 'returned' : 'empty')).slice(0, 80)}`;
    return [name, ...argumentScope, status, ...facts.filter(Boolean)].join(' | ');
  }).filter(Boolean);
  return entries.length ? `[Verified tool receipt ledger: ${entries.join(' || ')}]`.slice(0, 1800) : '';
}

export function isUnverifiedExecutionAssistantText(value: unknown): boolean {
  const text = String(value || '').trim();
  return Boolean(text && EXECUTION_OUTCOME_RE.test(text) && !EVIDENCE_MARKER_RE.test(text));
}

export function isUnverifiedExecutionAssistantRecord(message: MessageRecord): boolean {
  if (String(message.role || '').toLowerCase() !== 'assistant') return false;
  if (successfulToolNames(message.toolCalls).length > 0) return false;
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
      const tools = successfulToolNames(message.toolCalls);
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
    if (EVIDENCE_MARKER_RE.test(clause)) return true;
    if (EXPLICIT_USER_OWN_ACTION_RE.test(clause)) return true;
    if (!EXECUTION_OUTCOME_RE.test(clause)) return true;
    return false;
  });
  return clean.join(' ').trim();
}
