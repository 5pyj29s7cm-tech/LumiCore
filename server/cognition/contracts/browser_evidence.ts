import type { ToolExecutionRecord } from "../../tools/types";
import { compact, parseRecordJson, terminalPayloadText } from "../action_contract_support";
import { extractPrimaryTaskText, isBrowserSessionInspection } from "../action_request";

/** A login-state check can finish with a verified logged-out observation too. */
export function browserSessionObservation(records: ToolExecutionRecord[], task: string): string | null {
  if (!isBrowserSessionInspection(task)) return null;
  const url = extractPrimaryTaskText(task).match(/https?:\/\/[^\s，。；;<>"'）)]+/iu)?.[0];
  if (!url) return null;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./u, ''); } catch { return null; }
  const reverseLaunchIndex = [...records].reverse().findIndex(record => {
    if (!['browser_open_task', 'desktop_open'].includes(record.name) || record.error || record.terminalVerification?.status !== 'verified') return false;
    const payload = parseRecordJson(record);
    if (payload?.target !== url) return false;
    if (record.name === 'browser_open_task') return record.arguments?.url === url && payload?.opened === true;
    return record.arguments?.target === url && payload?.targetMatched === true
      && /^(?:chrome|msedge|firefox|brave|opera)\.exe$/iu.test(String(payload?.actualTarget?.processName || ''));
  });
  if (reverseLaunchIndex < 0) return null;
  const launchIndex = records.length - reverseLaunchIndex - 1;
  for (const record of records.slice(launchIndex + 1).reverse()) {
    if (!/^(?:ocr_screen|ocr_region|desktop_ui_snapshot)$/u.test(record.name) || record.error || record.terminalVerification?.status !== 'verified') continue;
    const payload = parseRecordJson(record);
    const observed = payload ? String(payload.description || payload.text || payload.analysis || '') : terminalPayloadText(record);
    // Bind visible state to the requested site, not a generic Login button on
    // a different monitor or an unrelated profile store.
    if (!observed.toLowerCase().includes(host)) continue;
    if (!/(?:未登录|已登录|登录状态|登录按钮|登录入口|扫码|验证码)|\b(?:logged (?:in|out)|login (?:button|form)|sign.in|captcha)\b/iu.test(observed)) continue; // i18n-allow: directly observed browser session state.
    // Deliver the login finding, not unrelated tabs, bookmarks or feed text
    // that a broad screen OCR response may also have transcribed.
    const findings = observed.split(/\n+/u).map(line => line.trim())
      .filter(paragraph => !/^\s*#{1,6}\s+[^\n]+\s*$/u.test(paragraph))
      .filter(paragraph => /(?:未登录|已登录|登录状态|登录按钮|登录入口|右上角|扫码|验证码|需要登录)|\b(?:logged (?:in|out)|login (?:button|form)|sign.in|captcha)\b/iu.test(paragraph)); // i18n-allow: relevant observed login facts.
    // Preserve the actual conclusion before broad header/navigation OCR. A
    // section heading alone cannot answer whether the saved session survived.
    const conclusions = findings.filter(paragraph => /(?:未登录|已登录|需要登录)|\b(?:logged (?:in|out))\b/iu.test(paragraph)); // i18n-allow: directly observed session conclusions.
    return [...conclusions, ...findings.filter(paragraph => !conclusions.includes(paragraph))]
      .slice(0, 2).join('\n\n').slice(0, 1200) || null;
  }
  return null;
}

export function hasAuthenticatedWebResultEvidence(records: ToolExecutionRecord[] = [], text = ''): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;
  const task = compact(text);
  const searchIntent = /\u67e5|\u627e|\u641c|\u68c0\u7d22|find|search|query|look\s*up/i.test(task);
  // i18n-allow: Extract requested case/search terms from multilingual input.
  const targetTerms = Array.from(new Set((task.match(/[\u4e00-\u9fff]{2,8}(?:省|市|自治区|案件|案号|法院|裁判|文书)?/g) || [])
    .filter(term => !/打开|登录|账号|自动登录|浏览器|网站|一下|这个|那个|案件$|裁判$|文书$/.test(term))
    .slice(0, 6)));

  const loggedIn = successful.some(record => {
    if (!/^web_login_run$/i.test(record.name)) return false;
    const result = String(record.result || '');
    const payload = parseRecordJson(record);
    return payload?.status === 'logged_in' || /"status"\s*:\s*"logged_in"|Login\/session is available/i.test(result);
  });

  if (!searchIntent) return loggedIn;

  return successful.some(record => {
    if (!/^(url_fetch_logged_in|mcp_playwright_browser_snapshot|mcp_playwright_browser_navigate|mcp_playwright_browser_evaluate|browser_open_task)$/i.test(record.name)) return false;
    const result = String(record.result || '');
    // i18n-allow: Recognize login blockers in external page evidence.
    if (/open=login|登录\/注册|登录链接|please\s+login|requires authentication|captcha|验证码|2FA|manual_required/i.test(result)) return false;
    const hasTargetTerm = targetTerms.length === 0 || targetTerms.some(term => result.includes(term));
    // i18n-allow: Recognize result content in external page evidence.
    return hasTargetTerm && /结果|列表|案件|裁判|文书|法院|Page URL|title|content|result|case|search/i.test(result);
  });
}
