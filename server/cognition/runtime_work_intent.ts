export type RuntimeWorkIntent = 'none' | 'status' | 'cancel';

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const EXPLICIT_WORK_SCOPE_RE = /(?:\u540e\u53f0(?:\u4efb\u52a1|\u5de5\u4f5c)?|\u5f53\u524d(?:\u4efb\u52a1|\u5de5\u4f5c)|\u6b63\u5728(?:\u6267\u884c|\u5904\u7406|\u505a)\u7684(?:\u4efb\u52a1|\u5de5\u4f5c)?|\u4efb\u52a1(?:\u961f\u5217|\u8fdb\u5ea6|\u72b6\u6001)|\u5de5\u4f5c(?:\u8fdb\u5ea6|\u72b6\u6001)|\b(?:background|current|active|running)\s+(?:task|work|job)s?\b|\btask\s+(?:queue|progress|status)\b)/iu;
const CANCEL_WORK_RE = /(?:\u505c\u6b62|\u53d6\u6d88|\u7ed3\u675f|\u7ec8\u6b62|\u4e0d\u8981\u505a|\u522b\u505a|\u4e0d\u7528\u505a|\u653e\u5f03|\u505c\u4e0b)|\b(?:stop|cancel|abort|end|quit|drop)\b/iu;
const STATUS_WORK_RE = /(?:\u8fdb\u5ea6|\u72b6\u6001|\u600e\u4e48\u6837|\u505a\u5230\u54ea|\u8fd8\u5728(?:\u505a|\u6267\u884c|\u5904\u7406)|\u5728\u5e72\u4ec0\u4e48|\u6b63\u5728\u505a\u4ec0\u4e48|\u6709\u6ca1\u6709\u4efb\u52a1)|\b(?:progress|status|what\s+are\s+you\s+doing|still\s+(?:working|running)|any\s+(?:active\s+)?tasks?)\b/iu;
const STANDALONE_CANCEL_RE = /^(?:\u522b\u505a\u4e86|\u4e0d\u7528\u505a\u4e86|\u505c\u4e0b\u6765|\u53d6\u6d88\u6389|\u7ed3\u675f\u6389|stop\s+it|cancel\s+it)[\u3002\uff01\uff1f.!?]*$/iu;
const VOICE_ONLY_RE = /(?:\u95ed\u5634|\u522b\u8bf4|\u505c\u6b62\u8bf4|\u505c\u6b62\u64ad\u653e|\u5173\u95ed\u8bed\u97f3|\u6302\u65ad\u8bed\u97f3)|\b(?:shut\s+up|stop\s+(?:talking|speaking|audio)|end\s+(?:voice|call))\b/iu;

export function classifyRuntimeWorkIntent(input: string): RuntimeWorkIntent {
  const text = compact(input);
  if (!text || VOICE_ONLY_RE.test(text)) return 'none';
  if (STANDALONE_CANCEL_RE.test(text)) return 'cancel';
  if (!EXPLICIT_WORK_SCOPE_RE.test(text)) return 'none';
  if (CANCEL_WORK_RE.test(text)) return 'cancel';
  if (STATUS_WORK_RE.test(text)) return 'status';
  return 'none';
}
