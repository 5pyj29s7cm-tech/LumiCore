export type SystemAppGroupId =
  | 'browser'
  | 'vscode'
  | 'git'
  | 'node'
  | 'python'
  | 'wps'
  | 'wechat'
  | 'cad'
  | 'ai_apps'
  | 'netease';

export interface SystemAppMatcher {
  id: SystemAppGroupId;
  label: string;
  patterns: RegExp[];
}

const CJK_NOISE_PREFIX = /^(?:\u5378\u8f7d|\u5b89\u88c5|\u66f4\u65b0|\u4fee\u590d|\u5e2e\u52a9|\u4f7f\u7528\u8bf4\u660e)/i;
const CJK_CONFIG_TOOL = /^(?:\u8f93\u5165|\u8f93\u51fa).*(?:\u8bbe\u7f6e|\u914d\u7f6e)/i;
const APP_NOISE = /uninstall|uninst|installer|update(?:r)?|upgrade(?:r)?|crashhandler|crashreport|reporter|diagnostic|telemetry|openindesktop/i;

export function isAppDiscoveryNoise(raw: string): boolean {
  const name = String(raw || '').trim();
  if (!name) return true;
  if (/[\u0000\ufffd]/.test(name)) return true;
  return CJK_NOISE_PREFIX.test(name)
    || CJK_CONFIG_TOOL.test(name)
    || APP_NOISE.test(name.replace(/[\s._()[\]{}-]+/g, ''));
}

export const COMMON_APP_MATCHERS: SystemAppMatcher[] = [
  { id: 'browser', label: 'Browser', patterns: [/chrome/i, /edge/i, /firefox/i, /brave/i] },
  { id: 'vscode', label: 'VS Code', patterns: [/visual studio code/i, /\bvs code\b/i, /\bcode(?: - insiders)?\b/i] },
  { id: 'git', label: 'Git', patterns: [/\bgit\b/i] },
  { id: 'node', label: 'Node.js', patterns: [/node\.js/i, /^node$/i] },
  { id: 'python', label: 'Python', patterns: [/python/i] },
  {
    id: 'wps',
    label: 'WPS / Office',
    patterns: [/wps/i, /microsoft office/i, /\bword\b/i, /powerpoint/i, /\bexcel\b/i, /\u91d1\u5c71\u6587\u6863/i],
  },
  {
    id: 'wechat',
    label: 'Messaging Apps',
    patterns: [
      /\u5fae\u4fe1/i,
      /\u98de\u4e66/i,
      /\u9489\u9489/i,
      /\bwechat\b/i,
      /\bweixin\b/i,
      /\bwecom\b/i,
      /\bwxwork\b/i,
      /\bfeishu\b/i,
      /\blark(?:suite)?\b/i,
      /\bdingtalk\b/i,
      /^qq(?:\s*(?:nt|international))?$/i,
      /^tencent\s*qq$/i,
      /^tim$/i,
      /microsoft teams/i,
      /^teams$/i,
      /\bslack\b/i,
      /\btelegram\b/i,
      /\bwhatsapp\b/i,
      /\bdiscord\b/i,
    ],
  },
  {
    id: 'cad',
    label: 'CAD',
    patterns: [
      /autocad/i,
      /\bcad\b/i,
      /zwcad/i,
      /gstarcad/i,
      /\u4e2d\u671b/i,
      /\u6d69\u8fb0/i,
      /\u5929\u6b63/i,
      /solidworks/i,
      /revit/i,
      /rhino/i,
    ],
  },
  {
    id: 'ai_apps',
    label: 'Local AI Apps',
    patterns: [
      /workbuddy/i,
      /codex/i,
      /chatgpt/i,
      /claude/i,
      /gemini/i,
      /deepseek/i,
      /kimi/i,
      /\u8c46\u5305/i,
      /doubao/i,
      /\u901a\u4e49/i,
      /\u5343\u95ee/i,
      /qwen/i,
      /\u6587\u5fc3/i,
      /ernie/i,
      /copilot/i,
      /cursor/i,
      /cherry studio/i,
      /ollama/i,
      /lm studio/i,
      /anythingllm/i,
    ],
  },
  {
    id: 'netease',
    label: 'Music Apps',
    patterns: [
      /\u7f51\u6613\u4e91\u97f3\u4e50/i,
      /\bnetease(?: cloud)? music\b/i,
      /\bcloudmusic\b/i,
      /music\.163/i,
      /qq\s*\u97f3\u4e50/i,
      /\bqqmusic\b/i,
      /\u9177\u72d7\u97f3\u4e50/i,
      /\bkugou\b/i,
      /\u9177\u6211\u97f3\u4e50/i,
      /\bkuwo\b/i,
      /\u6c7d\u6c34\u97f3\u4e50/i,
      /\bspotify\b/i,
      /\bapple music\b/i,
      /\bfoobar(?:2000)?\b/i,
      /\baimp\b/i,
      /\bmusicbee\b/i,
    ],
  },
];

export function findSystemAppMatcher(id: SystemAppGroupId): SystemAppMatcher | undefined {
  return COMMON_APP_MATCHERS.find((matcher) => matcher.id === id);
}

export function getSystemAppMatches(
  apps: string[],
  matcherOrId: SystemAppMatcher | SystemAppGroupId,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const matcher = typeof matcherOrId === 'string' ? findSystemAppMatcher(matcherOrId) : matcherOrId;
  if (!matcher) return [];

  const matches: string[] = [];
  const seen = new Set<string>();
  for (const raw of apps) {
    const app = String(raw || '').trim();
    if (!app || isAppDiscoveryNoise(app) || !matcher.patterns.some((pattern) => pattern.test(app))) continue;
    const key = app.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(app);
    if (matches.length >= limit) break;
  }
  return matches;
}

export function isSystemAppDetected(apps: string[], matcherOrId: SystemAppMatcher | SystemAppGroupId): boolean {
  return getSystemAppMatches(apps, matcherOrId, 1).length > 0;
}
