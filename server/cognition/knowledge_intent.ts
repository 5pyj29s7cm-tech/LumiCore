/**
 * True when the user asks for knowledge-base inventory/indexing evidence rather
 * than asking Lumi to open the knowledge-base screen or mutate its contents.
 */
export function isReadOnlyKnowledgeBaseInspectionRequest(input: string): boolean {
  const text = String(input || '').trim();
  if (!/(?:\u77e5\u8bc6\u5e93|knowledge\s*base)/iu.test(text)) return false;
  if (/(?:\u6253\u5f00|\u8fdb\u5165|\u5207\u6362\u5230|\u5207\u5230|\u663e\u793a|\u5c55\u5f00|\u5173\u95ed|\u6536\u8d77).{0,20}(?:\u77e5\u8bc6\u5e93)|\b(?:open|enter|switch|show|expand|close)\b.{0,24}\bknowledge\s*base\b/iu.test(text)) {
    return false;
  }
  const positiveText = text
    .replace(/(?:\u4e0d|\u4e0d\u8981|\u4e0d\u51c6|\u4e0d\u5f97|\u522b|\u7981\u6b62).{0,32}(?:\u5bfc\u5165|\u4fee\u6539|\u5199\u5165|\u5220\u9664|\u6e05\u7a7a|\u66f4\u65b0)/gu, ' ')
    .replace(/\b(?:do\s+not|don't|never|without)\b.{0,48}\b(?:import|modify|write|delete|clear|update)\b/giu, ' ');
  if (/(?:\u5bfc\u5165|\u6536\u5f55|\u5b58\u5165|\u8bb0\u5230|\u4fee\u6539|\u5199\u5165|\u5220\u9664|\u6e05\u7a7a|\u66f4\u65b0)|\b(?:import|ingest|store|modify|write|delete|clear|update)\b/iu.test(positiveText)) {
    return false;
  }
  return /(?:\u68c0\u67e5|\u67e5\u770b|\u76d8\u70b9|\u62a5\u544a|\u591a\u5c11|\u6570\u91cf|\u6587\u4ef6|\u6587\u6863|\u7d22\u5f15|\u9519\u8bef|\u5f02\u5e38|\u963b\u585e|\u72b6\u6001|\u53ef\u7528)|\b(?:check|inspect|report|count|files?|documents?|index|errors?|failures?|blockers?|status|available)\b/iu.test(text);
}
