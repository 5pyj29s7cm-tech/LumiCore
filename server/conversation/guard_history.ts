/**
 * Text emitted by the execution/completion guard is a system verification
 * result, not a factual assistant answer. It stays visible in the transcript,
 * but must not be learned, summarized, or fed back as conversational truth.
 */
const GUARDED_ASSISTANT_TEXT_RE =
  /我还没有真正开始读取或审查|我还没有真正操作客户端|我还没有拿到可确认的桌面动作结果|我还不能说客户端动作已经完成|我还不能说这件事已经完成|我还不能说正在执行|我已经开始处理了，但卡在一个需要确认的本地动作上|我已经开始处理，但还不能说完成|这一轮没有记录到成功的工具执行|没有记录到成功的真实工具执行|真正读取时|尚未开始实际读取文件|I have not actually started that action yet|I have not actually operated the Lumi client yet|I have not verified the desktop action yet|I did start the workflow, but it is blocked at a confirmation step|I started the workflow, but cannot mark it complete yet|I cannot honestly say I am executing this yet|I cannot honestly mark this complete yet|Completion claim blocked/i; // i18n-allow: Chinese guard-output recognition pattern; not user-visible copy.

export function isGuardGeneratedAssistantText(value: unknown): boolean {
  return GUARDED_ASSISTANT_TEXT_RE.test(String(value || ''));
}

export function isGuardGeneratedConversationRecord(value: {
  role?: string;
  type?: string;
  cognitiveIntent?: string;
  message?: string;
  content?: string;
  text?: string;
  response?: string;
} | null | undefined): boolean {
  if (!value) return false;
  const role = String(value.role || value.type || '').toLowerCase();
  if (role !== 'assistant' && role !== 'agent') return false;
  if (String(value.cognitiveIntent || '').toLowerCase() === 'work_product_guard') return true;
  return isGuardGeneratedAssistantText(
    value.response || value.message || value.content || value.text || '',
  );
}

export interface LegacyGuardSummaryState {
  summary?: unknown;
  summaryChain?: unknown;
  lastSummaryMessageCount?: unknown;
}

export interface IsolatedLegacyGuardSummaryState {
  summary: string;
  summaryChain: string[];
  lastSummaryMessageCount: number;
  changed: boolean;
}

function normalizeSummaryChain(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

/**
 * Quarantine summaries written before the durable summary marker existed.
 *
 * The negative marker is deliberately required. A newer, successfully
 * generated summary may legitimately discuss a historical guard failure and
 * must not be removed merely because it quotes the old wording. For a legacy
 * row, only the entries that contain a known guard fingerprint are removed;
 * clean summary-chain entries remain available for continuity.
 */
export function isolateLegacyGuardSummaryState(
  value: LegacyGuardSummaryState,
): IsolatedLegacyGuardSummaryState {
  const summary = String(value.summary || '').trim();
  const summaryChain = normalizeSummaryChain(value.summaryChain);
  const storedMarker = Number(value.lastSummaryMessageCount);
  const marker = Number.isFinite(storedMarker) ? Math.floor(storedMarker) : -1;

  if (marker >= 0) {
    return {
      summary,
      summaryChain,
      lastSummaryMessageCount: marker,
      changed: false,
    };
  }

  const summaryIsContaminated = Boolean(summary && isGuardGeneratedAssistantText(summary));
  const cleanSummaryChain = summaryChain.filter(item => !isGuardGeneratedAssistantText(item));
  const changed = summaryIsContaminated || cleanSummaryChain.length !== summaryChain.length;

  return {
    summary: summaryIsContaminated ? '' : summary,
    summaryChain: cleanSummaryChain,
    // A quarantined current summary did not safely cover any messages. Mark it
    // as an explicit zero baseline so no prompt consumer can resurrect it and
    // the next eligible summary can rebuild from clean interaction records.
    lastSummaryMessageCount: summaryIsContaminated ? 0 : marker,
    changed,
  };
}
