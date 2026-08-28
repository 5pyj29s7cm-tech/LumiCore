import {
  resolvePendingRuntimeCleanupOffer,
  type PendingAssistantOfferContext,
} from './pending_assistant_offer';

export type RuntimeWorkIntent = 'none' | 'status' | 'cancel';

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const EXPLICIT_WORK_SCOPE_RE = /(?:\u540e\u53f0(?:\u4efb\u52a1|\u5de5\u4f5c)?|\u5f53\u524d(?:\u4efb\u52a1|\u5de5\u4f5c)|(?:\u6709\s*)?(?:\u5728|\u6b63\u5728)(?:\u6267\u884c|\u5904\u7406|\u8fd0\u884c|\u505a)\u7684(?:\u4efb\u52a1|\u5de5\u4f5c)?|\u4efb\u52a1(?:\u961f\u5217|\u8fdb\u5ea6|\u72b6\u6001)|\u5de5\u4f5c(?:\u8fdb\u5ea6|\u72b6\u6001)|\b(?:background|current|active|running)\s+(?:task|work|job)s?\b|\btask\s+(?:queue|progress|status)\b)/iu;
const CANCEL_WORK_RE = /(?:\u505c\u6b62|\u53d6\u6d88|\u7ed3\u675f|\u7ec8\u6b62|\u4e0d\u8981\u505a|\u522b\u505a|\u4e0d\u7528\u505a|\u653e\u5f03|\u505c\u4e0b)|\b(?:stop|cancel|abort|end|quit|drop)\b/iu;
const STATUS_WORK_RE = /(?:\u8fdb\u5ea6|\u72b6\u6001|\u600e\u4e48\u6837|\u505a\u5230\u54ea|\u8fd8\u5728(?:\u505a|\u6267\u884c|\u5904\u7406)|\u5728\u5e72\u4ec0\u4e48|\u6b63\u5728\u505a\u4ec0\u4e48|\u6709\u6ca1\u6709\u4efb\u52a1|\u6709(?:\u5728|\u6b63\u5728)(?:\u6267\u884c|\u5904\u7406|\u8fd0\u884c)\u7684(?:\u4efb\u52a1|\u5de5\u4f5c))|\b(?:progress|status|what\s+are\s+you\s+doing|still\s+(?:working|running)|any\s+(?:active\s+)?tasks?)\b/iu;
const EXECUTION_QUERY_STATUS_RE = /(?:\u5728|\u6b63\u5728)(?:\u6267\u884c|\u5904\u7406|\u8fd0\u884c)(?:\u4ec0\u4e48|\u54ea\u4e9b|\u54ea\u4e2a|\u5565)/u;
const REPORTED_ACTIVE_COUNT_RE = /^(?:\u754c\u9762|\u8fd9\u91cc)?(?:\u663e\u793a|\u63d0\u793a|\u8bf4|\u770b\u5230)(?:\u4f60|Lumi)?(?:\u6709|\u5b58\u5728)(?:\u7ea6|\u5927\u6982)?(?:\d+|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u51e0\u4e24]+)(?:\u4e2a)?(?:\u4efb\u52a1|\u5de5\u4f5c)?(?:\u5728|\u6b63\u5728)(?:\u6267\u884c|\u5904\u7406|\u8fd0\u884c)(?:\u4e2d)?[\u3002\uff01\uff1f.!?]*$/iu;
const STANDALONE_CANCEL_RE = /^(?:\u522b\u505a\u4e86|\u4e0d\u7528\u505a\u4e86|\u505c\u4e0b\u6765|\u53d6\u6d88\u6389|\u7ed3\u675f\u6389|stop\s+it|cancel\s+it)[\u3002\uff01\uff1f.!?]*$/iu;
const VOICE_ONLY_RE = /(?:\u95ed\u5634|\u522b\u8bf4|\u505c\u6b62\u8bf4|\u505c\u6b62\u64ad\u653e|\u5173\u95ed\u8bed\u97f3|\u6302\u65ad\u8bed\u97f3)|\b(?:shut\s+up|stop\s+(?:talking|speaking|audio)|end\s+(?:voice|call))\b/iu;

const NEGATED_STATUS_REPORT_CLAUSE_RE = /(?:\u4e0d\u8981|\u522b|\u4e0d\u7528|\u65e0\u9700|\u52ff|\u7981\u6b62).{0,24}(?:\u6c47\u62a5|\u62a5\u544a|\u663e\u793a|\u8fd4\u56de|\u56de\u7b54|\u67e5\u8be2|\u67e5\u770b|\u63d0\u53ca).{0,24}(?:\u4efb\u52a1|\u5de5\u4f5c|\u8fdb\u5ea6|\u72b6\u6001)|\b(?:do\s+not|don't|never|without)\b.{0,40}\b(?:report|show|return|answer|check|query|mention)\b.{0,32}\b(?:(?:task|work|job)\s+)?(?:status|progress)\b/iu;

/**
 * Status vocabulary inside a negative output constraint is not a status
 * command. Strip only that clause before classifying the remaining request so
 * a compound instruction such as "do not report status; cancel the current
 * task" still reaches the explicit cancellation path.
 */
function stripNegatedStatusReportClauses(value: string): string {
  return value
    .split(/[\uFF0C,\u3002\uFF1B;\uFF01!\uFF1F?\n\r]+/u)
    .filter(clause => !NEGATED_STATUS_REPORT_CLAUSE_RE.test(clause))
    .join(' ');
}

export function classifyRuntimeWorkIntent(
  input: string,
  assistantOfferContext?: PendingAssistantOfferContext,
): RuntimeWorkIntent {
  const text = compact(stripNegatedStatusReportClauses(input));
  if (!text || VOICE_ONLY_RE.test(text)) return 'none';
  if (resolvePendingRuntimeCleanupOffer(text, assistantOfferContext)) return 'cancel';
  if (STANDALONE_CANCEL_RE.test(text)) return 'cancel';
  if (REPORTED_ACTIVE_COUNT_RE.test(text)) return 'status';
  if (!EXPLICIT_WORK_SCOPE_RE.test(text)) return 'none';
  if (CANCEL_WORK_RE.test(text)) return 'cancel';
  if (STATUS_WORK_RE.test(text) || EXECUTION_QUERY_STATUS_RE.test(text)) return 'status';
  return 'none';
}
