import type { ToolExecutionRecord } from '../tools/types';
import { CN_RESULT_GROUNDING_MESSAGES } from '../regions/packs/cn/voice_fast_path_messages';

export interface DesktopObservationToolCall {
  name: 'desktop_active_window' | 'desktop_running_processes' | 'desktop_idle_time' | 'desktop_system_info' | 'desktop_list_apps' | 'desktop_list_files';
  arguments: Record<string, any>;
}

const DESKTOP_AI_EVIDENCE_RE = /work\s*buddy|codex|chatgpt|claude|gemini|deep\s*seek|kimi|doubao|tongyi|qwen|wenxin|perplexity|cursor|copilot|lm\s*studio|ollama|cherry\s*studio|anythingllm/i;
const DESKTOP_AI_APP_IDS = new Set([
  'workbuddy',
  'codex',
  'chatgpt',
  'claude',
  'gemini',
  'deepseek',
  'kimi',
  'doubao',
  'tongyi',
  'qwen',
  'wenxin',
  'perplexity',
  'cursor',
  'copilot',
  'lmstudio',
  'ollama',
  'cherry-studio',
  'anythingllm',
]);
const SPECIFIC_APP_QUERY_RE = /\b(?:AutoCAD|WeChat|Weixin|WeCom|Feishu|Lark|DingTalk|WorkBuddy|Codex|ChatGPT|Claude|Cursor|LM\s*Studio|Cherry\s*Studio|AnythingLLM|WPS|Word|Excel|PowerPoint|Chrome|Edge|Revit|Jianying|CapCut)\b/gi;

function uniqueLabels(items: any[], label: (item: any) => string, key: (item: any) => string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of items) {
    const itemKey = key(item).trim().toLowerCase();
    const itemLabel = label(item).trim();
    if (!itemKey || !itemLabel || seen.has(itemKey)) continue;
    seen.add(itemKey);
    labels.push(itemLabel);
  }
  return labels;
}

function isDesktopAiApp(item: any): boolean {
  const appId = String(item?.app_id || '').trim().toLowerCase();
  if (appId) return DESKTOP_AI_APP_IDS.has(appId);
  return DESKTOP_AI_EVIDENCE_RE.test([item?.label, item?.path].filter(Boolean).join(' '));
}

function stripNegativeConstraints(value: string): string {
  return String(value || '')
    .replace(/(?:\u7981\u6b62|\u4e0d\u8981|\u4e0d\u51c6|\u4e0d\u5f97|\u4e0d\u7528|\u65e0\u9700|\u907f\u514d|\u52ff|\u522b)[^\u3002\uFF1B;.!?\n\r]*/giu, ' ')
    .replace(/\b(?:do\s+not|don't|never|must\s+not|without)\b[^.;!?\n\r]*/giu, ' ');
}

export function requiresActiveWindowObservation(input: string): boolean {
  return /\b(?:active|foreground|current)\s+window\b|\bwindow\s+title\b|(?:\u5f53\u524d|\u6d3b\u52a8|\u524d\u53f0)\u7a97\u53e3|\u7a97\u53e3\u6807\u9898/iu.test(String(input || ''));
}

export function requiresDesktopFileListingObservation(input: string): boolean {
  const text = String(input || '');
  return /(?:\u5217\u51fa|\u67e5\u770b|\u663e\u793a|\u76d8\u70b9|\u7edf\u8ba1|\u6570\u4e00\u4e0b).{0,20}\u684c\u9762(?:\u4e0a|\u91cc|\u4e2d)?(?:\u7684)?(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6761\u76ee)|\u684c\u9762(?:\u4e0a|\u91cc|\u4e2d)?(?:\u7684)?(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6761\u76ee).{0,20}(?:\u5217\u51fa|\u67e5\u770b|\u663e\u793a|\u591a\u5c11|\u51e0\u4e2a|\u6570\u91cf|\u7edf\u8ba1)|\b(?:list|show|inspect|count)\b.{0,24}\bdesktop\b.{0,16}\b(?:files?|folders?|entries)\b|\bdesktop\b.{0,16}\b(?:files?|folders?|entries)\b.{0,24}\b(?:list|show|count|how\s+many)\b/iu.test(text);
}

export function buildDesktopObservationPlan(input: string): DesktopObservationToolCall[] {
  const text = String(input || '').trim();
  if (!text) return [];

  const wantsActiveWindow = requiresActiveWindowObservation(text);
  const wantsDesktopFiles = requiresDesktopFileListingObservation(text);
  const wantsProcesses = /\b(?:running\s+process(?:es)?|process\s+(?:list|state|status)|runtime\s+state|desktop\s+(?:state|status)|desktop\s+(?:program|app)(?:lication)?\s+check)\b|\b(?:running|active)\s+(?:desktop\s+)?(?:ai\s+)?app(?:lication)?s?\b|(?:\u8fd0\u884c|\u6d3b\u8dc3|\u5f53\u524d)\u8fdb\u7a0b|\u8fdb\u7a0b(?:\u5217\u8868|\u72b6\u6001|\u4fe1\u606f)|\u684c\u9762\u8fd0\u884c\u72b6\u6001|(?:\u6b63\u5728\u8fd0\u884c|\u5df2\u8fd0\u884c).{0,16}(?:AI|\u4eba\u5de5\u667a\u80fd)?\u5e94\u7528|(?:\u505a\u4e2a|\u505a\u4e00\u4e2a|\u8fdb\u884c|\u68c0\u67e5|\u67e5\u770b|\u770b\u4e00\u4e0b).{0,10}(?:\u684c\u9762)?(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528)(?:\u68c0\u67e5|\u72b6\u6001|\u8fd0\u884c\u60c5\u51b5)|(?:\u540e\u53f0|\u684c\u9762).{0,8}(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u8fdb\u7a0b).{0,8}(?:\u8fd0\u884c\u60c5\u51b5|\u72b6\u6001|\u68c0\u67e5)/iu.test(text);
  const wantsIdle = /\b(?:idle\s+time|away\s+time)\b|\u7a7a\u95f2\u65f6\u95f4|\u591a\u4e45\u6ca1\u64cd\u4f5c/iu.test(text);
  const wantsSystem = /\b(?:system\s+info|os\s+info|cpu|memory|disk)\b|\u7cfb\u7edf\u4fe1\u606f|CPU|\u5185\u5b58|\u78c1\u76d8/iu.test(text);
  const wantsAppInventory = /\b(?:(?:installed|launchable|available|local(?:ly)?)\s+(?:desktop\s+)?(?:ai\s+)?app(?:lication)?s?|app(?:lication)?\s+(?:inventory|list))\b|\b(?:inspect|check|list|show|find|detect|inventory)\b.{0,64}\b(?:installed|launchable|available|local|app|application|software|program|launch\s+target)\b|(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u672c\u673a|\u672c\u5730).{0,16}(?:AI|\u4eba\u5de5\u667a\u80fd)?\u5e94\u7528|\u5e94\u7528(?:\u6e05\u5355|\u5217\u8868)|(?:\u68c0\u67e5|\u67e5\u770b|\u5217\u51fa|\u8bc6\u522b|\u68c0\u6d4b|\u76d8\u70b9|\u67e5\u627e).{0,32}(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u5e94\u7528|\u8f6f\u4ef6|\u7a0b\u5e8f|\u542f\u52a8\u5165\u53e3|\u5b89\u88c5\u72b6\u6001)/iu.test(text);
  const wantsDesktopState = /\bdesktop\s+(?:state|status|runtime)\b|\u684c\u9762\u8fd0\u884c\u72b6\u6001|\u684c\u9762\u72b6\u6001/iu.test(text);
  if (!wantsActiveWindow && !wantsDesktopFiles && !wantsProcesses && !wantsIdle && !wantsSystem && !wantsAppInventory && !wantsDesktopState) return [];

  const positiveText = stripNegativeConstraints(text);
  const mutationText = positiveText.replace(/\blaunch\s+target\b/giu, ' ');
  const hasPositiveMutation = /\b(?:open|launch|start|click|type|switch|close|send|post|write|change|modify|run)\b|(?:\u6253\u5f00|\u542f\u52a8|\u70b9\u51fb|\u8f93\u5165|\u5207\u6362|\u5173\u95ed|\u53d1\u9001|\u53d1\u5e03|\u5199\u5165|\u4fee\u6539|\u8fd0\u884c)(?!\u72b6\u6001|\u60c5\u51b5)/iu.test(mutationText);
  if (hasPositiveMutation) return [];

  const calls: DesktopObservationToolCall[] = [];
  if (wantsActiveWindow || wantsDesktopState) calls.push({ name: 'desktop_active_window', arguments: {} });
  if (wantsDesktopFiles) calls.push({ name: 'desktop_list_files', arguments: { path: '~/Desktop', limit: 1000 } });
  if (wantsProcesses || wantsDesktopState) calls.push({ name: 'desktop_running_processes', arguments: { top: 20 } });
  if (wantsIdle || wantsDesktopState) calls.push({ name: 'desktop_idle_time', arguments: {} });
  if (wantsSystem) calls.push({ name: 'desktop_system_info', arguments: {} });
  if (wantsAppInventory) {
    const appNames = Array.from(new Set(Array.from(text.matchAll(SPECIFIC_APP_QUERY_RE), match => match[0])));
    const query = appNames.length === 1 ? appNames[0] : '';
    calls.push({
      name: 'desktop_list_apps',
      arguments: query ? { query, limit: 30 } : { limit: 200 },
    });
  }
  return calls;
}

function parseResult(record: ToolExecutionRecord | undefined): any {
  if (!record) return null;
  try {
    return JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
}

function asFileItems(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.files)) return value.files;
  if (Array.isArray(value?.entries)) return value.entries;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function asProcessItems(value: any): any[] | null {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.processes)) return value.processes;
  if (Array.isArray(value?.items)) return value.items;
  return null;
}

function isDesktopSoftwareShortcut(item: any): boolean {
  if (String(item?.type || '').toLowerCase() === 'directory') return false;
  const value = `${String(item?.name || '')}\n${String(item?.path || '')}`;
  return /\.(?:lnk|url|appref-ms|exe)$/i.test(value);
}

export function formatDesktopObservationResult(
  records: ToolExecutionRecord[],
  taskText: string,
): string | null {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return null;

  const active = parseResult([...successful].reverse().find(record => /^(desktop_active_window|get_active_window_info)$/i.test(record.name)));
  const processes = parseResult([...successful].reverse().find(record => /^(desktop_running_processes|get_running_processes)$/i.test(record.name)));
  const idle = parseResult([...successful].reverse().find(record => /^desktop_idle_time$/i.test(record.name)));
  const system = parseResult([...successful].reverse().find(record => /^(desktop_system_info|get_system_info)$/i.test(record.name)));
  const apps = parseResult([...successful].reverse().find(record => /^desktop_list_apps$/i.test(record.name)));
  const fileRecord = [...successful].reverse().find(record => /^desktop_list_files$/i.test(record.name));
  const parsedFiles = parseResult(fileRecord);
  const files = asFileItems(parsedFiles);
  const processList = asProcessItems(processes);
  const fileListingAvailable = Boolean(fileRecord) && (
    Array.isArray(parsedFiles)
    || Array.isArray(parsedFiles?.files)
    || Array.isArray(parsedFiles?.entries)
    || Array.isArray(parsedFiles?.items)
  );
  const plannedToolNames = new Set(buildDesktopObservationPlan(taskText).map(call => call.name));
  const failures = records.filter(record => record.error && plannedToolNames.has(record.name as DesktopObservationToolCall['name']));
  const hasMutation = successful.some(record =>
    /^(desktop_open|desktop_show_lumi_window|desktop_run_command|desktop_clipboard_write|desktop_mouse_|desktop_keyboard_|client_action|computer_use)/i.test(record.name)
  );
  const zh = /[\u3400-\u9fff]/u.test(taskText || '');
  const wantsDesktopSoftwareCount = /(?:\u684c\u9762).{0,24}(?:\u591a\u5c11|\u51e0\u4e2a|\u6570\u91cf).{0,16}(?:\u8f6f\u4ef6|\u5e94\u7528|\u7a0b\u5e8f|\u5feb\u6377\u65b9\u5f0f)|(?:\u684c\u9762).{0,16}(?:\u8f6f\u4ef6|\u5e94\u7528|\u7a0b\u5e8f|\u5feb\u6377\u65b9\u5f0f).{0,16}(?:\u591a\u5c11|\u51e0\u4e2a|\u6570\u91cf)|\bhow\s+many\b.{0,32}\b(?:desktop\s+)?(?:apps?|applications?|programs?|shortcuts?)\b/iu.test(taskText || '');
  const observationRequested = wantsDesktopSoftwareCount || buildDesktopObservationPlan(taskText).length > 0;
  if (!observationRequested) return null;
  if (wantsDesktopSoftwareCount && fileListingAvailable) {
    const shortcutCount = files.filter(isDesktopSoftwareShortcut).length;
    return zh
      ? CN_RESULT_GROUNDING_MESSAGES.desktopSoftwareShortcutCount(shortcutCount)
      : `There are ${shortcutCount} software shortcuts on the desktop.`;
  }
  const wantsDesktopAi = /(?:desktop\s+AI|AI\s+app|\u684c\u9762\s*AI|AI\s*\u5e94\u7528)/iu.test(taskText || '');
  const wantsDesktopFiles = requiresDesktopFileListingObservation(taskText);
  const desktopFileCount = files.filter(item => String(item?.type || '').toLowerCase() !== 'directory').length;
  const desktopFolderCount = files.filter(item => String(item?.type || '').toLowerCase() === 'directory').length;
  const processItems = processList
    ? (wantsDesktopAi ? processList.filter(item => DESKTOP_AI_EVIDENCE_RE.test(String(item?.name || item?.window_title || ''))) : processList)
    : [];
  const appItems = Array.isArray(apps)
    ? (wantsDesktopAi ? apps.filter(isDesktopAiApp) : apps)
    : [];

  const hasStructuredObservation = Boolean(
    active
    || Boolean(processList)
    || Array.isArray(apps)
    || (idle && typeof idle === 'object')
    || (system && typeof system === 'object')
    || fileListingAvailable
  );
  if (!hasStructuredObservation && failures.length === 0) return null;

  if (!zh) {
    const lines = ['The desktop-state check completed with fresh evidence from the connected desktop client.'];
    if (active && typeof active === 'object') {
      const processLabel = active.process_name ? ` (${active.process_name}${active.pid ? `, PID ${active.pid}` : ''})` : '';
      const sizeLabel = Number(active.width) > 0 && Number(active.height) > 0 ? `, ${active.width}x${active.height}` : '';
      lines.push(`Active window: ${active.title || 'unknown'}${processLabel}${sizeLabel}.`);
    }
    if (wantsDesktopFiles && fileListingAvailable) {
      lines.push(`Desktop entries read this turn: ${files.length}; ${desktopFileCount} files and ${desktopFolderCount} folders.`);
    }
    if (processList) {
      const names = uniqueLabels(
        processItems,
        item => String(item?.name || item?.window_title || ''),
        item => String(item?.name || item?.window_title || ''),
      ).slice(0, 12);
      lines.push(wantsDesktopAi
        ? `Running desktop AI evidence: ${names.length ? names.join(', ') : 'none detected'}.`
        : `Runtime snapshot: ${processList.length} process entries were read${names.length ? `; leading entries: ${names.slice(0, 5).join(', ')}` : ''}.`);
      if (!wantsDesktopAi) lines.push('This is a point-in-time sample; it does not by itself prove a memory leak, a hang, or long-term stability.');
    }
    if (Array.isArray(apps)) {
      const names = uniqueLabels(
        appItems,
        item => String(item?.label || item?.app_id || item?.path || ''),
        item => String(item?.app_id || item?.label || item?.path || ''),
      ).slice(0, 12);
      lines.push(wantsDesktopAi
        ? `Launchable desktop AI evidence: ${names.length ? names.join(', ') : 'none detected'}.`
        : `Launchable local apps: ${apps.length} entries were read${names.length ? `; leading entries: ${names.slice(0, 8).join(', ')}` : ''}.`);
    }
    if (idle && Number.isFinite(Number(idle.idle_seconds))) lines.push(`Desktop idle time: about ${Math.round(Number(idle.idle_seconds))} seconds.`);
    if (system && typeof system === 'object') lines.push('System information was refreshed successfully.');
    if (failures.length) lines.push(`Unavailable checks: ${failures.map(record => `${record.name}: ${record.error}`).join('; ')}.`);
    if (!hasMutation) lines.push('No click, typing, window switch, app launch, or content modification tool ran in this turn.');
    return lines.join('\n');
  }

  const lines: string[] = [CN_RESULT_GROUNDING_MESSAGES.desktopSnapshotIntro];
  if (active && typeof active === 'object') {
    const processLabel = active.process_name ? `\uff08${active.process_name}${active.pid ? `\uff0cPID ${active.pid}` : ''}\uff09` : '';
    const sizeLabel = Number(active.width) > 0 && Number(active.height) > 0 ? `\uff0c\u7a97\u53e3 ${active.width}x${active.height}` : '';
    lines.push(`\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1a${active.title || '\u672a\u77e5'}${processLabel}${sizeLabel}\u3002`);
  }
  if (wantsDesktopFiles && fileListingAvailable) {
    // i18n-allow: reviewed Chinese desktop observation result.
    lines.push(`\u684c\u9762\u6761\u76ee\uff1a\u672c\u6b21\u8bfb\u53d6\u5230 ${files.length} \u4e2a\uff0c\u5176\u4e2d\u6587\u4ef6 ${desktopFileCount} \u4e2a\u3001\u6587\u4ef6\u5939 ${desktopFolderCount} \u4e2a\u3002`);
  }
  if (processList) {
    const names = uniqueLabels(
      processItems,
      item => String(item?.name || item?.window_title || ''),
      item => String(item?.name || item?.window_title || ''),
    ).slice(0, 12);
    lines.push(wantsDesktopAi
      ? `\u6b63\u5728\u8fd0\u884c\u7684\u684c\u9762 AI \u8bc1\u636e\uff1a${names.length ? names.join('\u3001') : '\u672a\u68c0\u6d4b\u5230'}\u3002`
      : CN_RESULT_GROUNDING_MESSAGES.processSnapshot(processList.length, names.slice(0, 5)));
    if (!wantsDesktopAi) lines.push(CN_RESULT_GROUNDING_MESSAGES.processSnapshotCaveat);
  }
  if (Array.isArray(apps)) {
    const names = uniqueLabels(
      appItems,
      item => String(item?.label || item?.app_id || item?.path || ''),
      item => String(item?.app_id || item?.label || item?.path || ''),
    ).slice(0, 12);
    lines.push(wantsDesktopAi
      ? `\u53ef\u542f\u52a8\u7684\u684c\u9762 AI \u8bc1\u636e\uff1a${names.length ? names.join('\u3001') : '\u672a\u68c0\u6d4b\u5230'}\u3002`
      : `\u53ef\u542f\u52a8\u7684\u672c\u673a\u5e94\u7528\uff1a\u5df2\u8bfb\u53d6 ${apps.length} \u6761${names.length ? `\uff0c\u524d\u51e0\u9879\u4e3a ${names.slice(0, 8).join('\u3001')}` : ''}\u3002`);
  }
  if (idle && Number.isFinite(Number(idle.idle_seconds))) lines.push(`\u684c\u9762\u7a7a\u95f2\u65f6\u95f4\uff1a\u7ea6 ${Math.round(Number(idle.idle_seconds))} \u79d2\u3002`);
  if (system && typeof system === 'object') lines.push('\u7cfb\u7edf\u4fe1\u606f\u5df2\u5b8c\u6210\u5237\u65b0\u3002');
  if (failures.length) lines.push(`\u672a\u5b8c\u6210\u7684\u8bfb\u53d6\uff1a${failures.map(record => `${record.name}: ${record.error}`).join('\uff1b')}\u3002`);
  if (!hasMutation) lines.push('\u672c\u8f6e\u6ca1\u6709\u6267\u884c\u70b9\u51fb\u3001\u8f93\u5165\u3001\u5207\u6362\u7a97\u53e3\u3001\u6253\u5f00\u5e94\u7528\u6216\u4fee\u6539\u5185\u5bb9\u3002');
  return lines.join('\n');
}
