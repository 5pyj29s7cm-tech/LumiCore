export function normalizeDesktopTarget(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\\/]+/g, ' ')
    .replace(/\.(?:exe|lnk|appref-ms|url)$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function requestedDesktopTargetAliases(target: string): string[] {
  const normalized = normalizeDesktopTarget(target);
  const aliases = new Set<string>([normalized]);
  // i18n-allow: Spoken desktop location and object-kind labels qualify the requested name.
  if (!/^(?:[A-Za-z]:[\\/]|https?:|\\\\)/u.test(target)) {
    const named = target.replace(/^桌面(?:上)?(?:的)?/u, '').replace(/(?:文件|文档|程序|应用|软件|快捷方式)$/u, '');
    if (named.trim()) aliases.add(normalizeDesktopTarget(named));
  }
  const add = (...values: string[]) => values.forEach(value => aliases.add(normalizeDesktopTarget(value)));

  if (/^(?:autocad|acad|cad)$/.test(normalized) || normalized.includes('autocad')) {
    add('AutoCAD', 'acad', 'acad.exe', 'Autodesk AutoCAD', 'CAD');
  }
  if (/(?:wps|\u91d1\u5c71)/u.test(normalized)) {
    add('WPS', 'WPS Office', 'wps.exe', 'wpp.exe', 'et.exe', 'Kingsoft Office', '\u91d1\u5c71 WPS'); // i18n-allow: Application alias used only for evidence matching.
  }
  if (/(?:wechat|weixin|\u5fae\u4fe1)/u.test(normalized)) {
    add('WeChat', 'Weixin', 'wechat.exe', 'weixin.exe', '\u5fae\u4fe1'); // i18n-allow: Application alias used only for evidence matching.
  }
  if (/(?:mspaint|microsoftpaint|paint|\u753b\u56fe)/u.test(normalized)) {
    add('mspaint', 'mspaint.exe', 'Microsoft Paint', 'Paint', '\u753b\u56fe'); // i18n-allow: Application alias used only for evidence matching.
  }
  if (/(?:notepad|\u8bb0\u4e8b\u672c)/u.test(normalized)) {
    add('notepad', 'notepad.exe', 'Microsoft Notepad', '\u8bb0\u4e8b\u672c'); // i18n-allow: Application alias used only for evidence matching.
  }
  if (/(?:calculator|calculatorapp|windows\u8ba1\u7b97\u5668|\u8ba1\u7b97\u5668)/u.test(normalized)) {
    add('calculator', 'calc', 'calc.exe', 'CalculatorApp.exe', 'Windows Calculator', '\u8ba1\u7b97\u5668'); // i18n-allow: Application alias used only for evidence matching.
  }
  if (/(?:googlechrome|chrome|\u8c37\u6b4c\u6d4f\u89c8\u5668)/u.test(normalized)) {
    add('Google Chrome', 'chrome', 'chrome.exe', '\u8c37\u6b4c\u6d4f\u89c8\u5668'); // i18n-allow: Application alias used only for evidence matching.
  }
  if (/^(?:浏览器|默认浏览器|browser|defaultbrowser)$/iu.test(normalized)) { // i18n-allow: Generic browser evidence aliases; named browsers keep exact matching.
    add('chrome.exe', 'msedge.exe', 'firefox.exe', 'Google Chrome', 'Microsoft Edge', 'Mozilla Firefox');
  }
  if (/(?:\u7f51\u6613\u4e91|netease|cloudmusic)/u.test(normalized)) {
    add('\u7f51\u6613\u4e91', '\u7f51\u6613\u4e91\u97f3\u4e50', 'NetEase Cloud Music', 'cloudmusic', 'cloudmusic.exe'); // i18n-allow: Application aliases used only for evidence matching.
  }
  if (/(?:\u963f\u91cc\u4e91|aliyun)/u.test(normalized)) {
    add('\u963f\u91cc\u4e91', '\u963f\u91cc\u4e91\u5b98\u7f51', 'Aliyun', 'aliyun.com', 'www.aliyun.com'); // i18n-allow: Public-site aliases used only for evidence matching.
  }

  return Array.from(aliases).filter(Boolean);
}

export function matchesRequestedDesktopTarget(value: unknown, aliases: string[]): boolean {
  const normalized = normalizeDesktopTarget(value);
  if (!normalized) return false;
  return aliases.some(alias => alias.length >= 2 && (
    normalized === alias
    || normalized.includes(alias)
    || alias.includes(normalized)
  ));
}

export function collectStructuredDesktopTargets(
  value: unknown,
  output: string[],
  depth = 0,
): void {
  if (!value || typeof value !== 'object' || depth > 3 || output.length >= 16) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof nested === 'string'
      && /^(?:actualTarget|openedTarget|resolvedTarget|appTarget|applicationTarget|appName|applicationName|processName|executable|title|windowTitle|target|app|application|process|path)$/i.test(key)
    ) {
      output.push(nested);
    }
    if (nested && typeof nested === 'object') collectStructuredDesktopTargets(nested, output, depth + 1);
  }
}

export function requestedBrowserTargetAliases(target: string): string[] {
  const aliases = new Set(requestedDesktopTargetAliases(target));
  const add = (...values: string[]) => values.forEach(value => aliases.add(normalizeDesktopTarget(value)));
  try {
    const parsed = new URL(String(target || '').trim());
    const hostname = parsed.hostname.replace(/^www\./i, '');
    add(parsed.hostname, hostname, hostname.split('.')[0]);
  } catch {}
  // i18n-allow: Named public-site alias used only to match a page title with
  // the exact URL/site requested by the user.
  if (/(?:\u963f\u91cc\u4e91|aliyun)/iu.test(target)) add('\u963f\u91cc\u4e91', 'aliyun.com', 'aliyun');
  // i18n-allow: Named public-site aliases are used only to match tool evidence.
  if (/(?:中国)?裁判文书网/u.test(target)) add('wenshu.court.gov.cn');
  // i18n-allow: Named public-site aliases are used only to match tool evidence.
  if (/人民法院案例库/u.test(target)) add('rmfyalk.court.gov.cn');
  // i18n-allow: Named public-site aliases are used only to match tool evidence.
  if (/人民法院在线服务/u.test(target)) add('zxfw.court.gov.cn');
  return Array.from(aliases).filter(Boolean);
}

/** Compare an adapter-supplied launch target with the exact target named by
 * the current user/task. Pre-execution guards and terminal evidence use the
 * same alias rules so a wrong target cannot be executed and later legitimized
 * by its own successful receipt. */
export function matchesRequestedDesktopActionTarget(
  value: unknown,
  requestedTarget: string,
  browser = false,
): boolean {
  const aliases = browser
    ? requestedBrowserTargetAliases(requestedTarget)
    : requestedDesktopTargetAliases(requestedTarget);
  return aliases.length > 0 && matchesRequestedDesktopTarget(value, aliases);
}
