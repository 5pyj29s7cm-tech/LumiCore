/**
 * True when the user asks for knowledge-base inventory/indexing evidence rather
 * than asking Lumi to open the knowledge-base screen or mutate its contents.
 */
export function isReadOnlyKnowledgeBaseInspectionRequest(input: string): boolean {
  const text = String(input || '').trim();
  if (!/(?:\u77e5\u8bc6\u5e93|\u77e5\u8bc6\u6587\u4ef6|knowledge\s*(?:base|files?))/iu.test(text)) return false;
  // Capability questions about whether a file can later be sent/exported are
  // conversational. They do not authorize an inventory read or a transfer.
  if (/(?:\u6587\u4ef6|\u6587\u6863).{0,24}(?:\u53ef\u4ee5|\u80fd\u5426|\u80fd\u4e0d\u80fd|\u80fd).{0,24}(?:\u53d1\u7ed9|\u53d1\u9001\u7ed9|\u5bfc\u51fa|\u63d0\u4f9b).{0,12}(?:\u6211)?(?:\u5417|\u4e48|[\uff1f?])|\bcan\b.{0,32}\b(?:send|export|provide)\b/iu.test(text)) return false; // i18n-allow: Input-recognition only.
  if (/(?:\u6253\u5f00|\u8fdb\u5165|\u5207\u6362\u5230|\u5207\u5230|\u663e\u793a|\u5c55\u5f00|\u5173\u95ed|\u6536\u8d77).{0,20}(?:\u77e5\u8bc6\u5e93)|\b(?:open|enter|switch|expand|close)\b.{0,24}\bknowledge\s*base\b/iu.test(text)) {
    return false;
  }
  const positiveText = text
    .replace(/(?:\u4e0d|\u4e0d\u8981|\u4e0d\u51c6|\u4e0d\u5f97|\u522b|\u7981\u6b62).{0,32}(?:\u5bfc\u5165|\u4fee\u6539|\u5199\u5165|\u5220\u9664|\u6e05\u7a7a|\u66f4\u65b0)/gu, ' ')
    .replace(/\b(?:do\s+not|don't|never|without)\b.{0,48}\b(?:import|modify|write|delete|clear|update)\b/giu, ' ');
  if (/(?:\u5bfc\u5165|\u6536\u5f55|\u5b58\u5165|\u8bb0\u5230|\u4fee\u6539|\u5199\u5165|\u5220\u9664|\u6e05\u7a7a|\u66f4\u65b0)|\b(?:import|ingest|store|modify|write|delete|clear|update)\b/iu.test(positiveText)) {
    return false;
  }
  // File mentions, source filenames and prices do not request an inventory.
  return /(?:\u591a\u5c11(?:\u7684|\u4e2a|\u4efd)?|\u54ea\u4e9b)(?:\u77e5\u8bc6)?(?:\u6587\u4ef6|\u6587\u6863)|(?:\u6587\u4ef6|\u6587\u6863).{0,4}(?:\u6570\u91cf|\u603b\u6570|\u6570\u76ee|\u5217\u8868|\u6e05\u5355|\u7d22\u5f15|\u5438\u6536\u72b6\u6001)|(?:\u77e5\u8bc6\u5e93|\u77e5\u8bc6\u6587\u4ef6)(?:\u7684|\u76ee\u524d|\u73b0\u5728|\u5f53\u524d|\u603b\u4f53|\u6574\u4f53)?(?:\u7d22\u5f15|\u5438\u6536(?:\u72b6\u6001|\u60c5\u51b5|\u8fdb\u5ea6|\u5b8c)|\u8986\u76d6\u7387|\u9519\u8bef|\u5f02\u5e38|\u963b\u585e|\u72b6\u6001|\u662f\u5426\u53ef\u7528)|(?:\u67e5\u770b|\u770b\u770b|\u770b\u4e00\u4e0b|\u67e5\u4e00\u4e0b|\u67e5\u8be2|\u7edf\u8ba1|\u76d8\u70b9|\u5217\u51fa).{0,12}(?:\u77e5\u8bc6\u5e93|\u77e5\u8bc6\u6587\u4ef6).{0,6}(?:\u6587\u4ef6|\u6587\u6863)[\u3002.!\uff01?\uff1f\s]*$|\b(?:how\s+many|which)\s+(?:files?|documents?)\b|\bknowledge\s*(?:base|files?)\s+(?:index(?:ing)?|coverage|errors?|failures?|blockers?|status|availability)\b|\b(?:show|list|count|inspect)\b.{0,16}\bknowledge\s*base\s+(?:files?|documents?)[.!?\s]*$/iu.test(text);
}
