import { toolCallSucceeded } from './tool_receipts';
import { toolCallName, toolCallArguments, toolCallResult, normalizeApplicationTarget, looksLikeApplicationTarget, compact } from './history_values';

export function successfulApplicationTarget(call: any): string {
  if (!toolCallSucceeded(call)) return '';
  const name = toolCallName(call);
  const args = toolCallArguments(call);
  const result = toolCallResult(call);
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, any>
    : {};

  if (name === 'desktop_open' || /(?:wps|wechat|weixin|autocad|cad.*playback|computer_use)/i.test(name)) {
    const candidates = [
      args.appTarget,
      args.applicationTarget,
      args.target,
      payload.appTarget,
      payload.applicationTarget,
      payload.target,
      payload.resolvedTarget,
    ].map(normalizeApplicationTarget).filter(Boolean);
    const explicitTarget = candidates.find(looksLikeApplicationTarget);
    if (explicitTarget) return explicitTarget;
  }

  const signature = [
    name,
    payload.processName,
    payload.applicationName,
    payload.appName,
    payload.windowTitle,
  ].map(value => compact(value, 180)).join(' ');
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:^|\b)(?:wps|wps\.exe|et\.exe|wpp\.exe)(?:\b|$)|金山(?:文字|表格|演示|WPS)/iu.test(signature)) return 'WPS';
  if (/(?:acad\.exe|\bAutoCAD\b|mcp_cad-drafting_autocad)/i.test(signature)) return 'AutoCAD';
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:WeChat\.exe|Weixin\.exe|\bWeChat\b|微信)/iu.test(signature)) return 'WeChat';
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:mspaint\.exe|Microsoft Paint|\bPaint\b|画图)/iu.test(signature)) return 'Paint';
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:notepad\.exe|\bNotepad\b|记事本)/iu.test(signature)) return 'Notepad';
  return '';
}
