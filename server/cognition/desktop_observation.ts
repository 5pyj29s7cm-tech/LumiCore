import type { ToolExecutionRecord } from '../tools/types';
import { CN_RESULT_GROUNDING_MESSAGES } from '../regions/packs/cn/voice_fast_path_messages';
import { formatDesktopProcessCount } from '../i18n/naturalness_messages';

export interface DesktopObservationToolCall {
  name: 'desktop_active_window' | 'desktop_running_processes' | 'desktop_idle_time' | 'desktop_system_info' | 'desktop_list_apps' | 'desktop_list_files';
  arguments: Record<string, any>;
}

export interface DesktopObservationEvidenceEvaluation {
  requested: boolean;
  complete: boolean;
  plannedToolNames: DesktopObservationToolCall['name'][];
  satisfiedToolNames: DesktopObservationToolCall['name'][];
  missingToolNames: DesktopObservationToolCall['name'][];
  text: string | null;
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
  return /\b(?:active|foreground|current)\s+window\b|\bwindow\s+title\b|(?:\u5f53\u524d|\u6d3b\u52a8|\u524d\u53f0)\u7a97\u53e3|\u7a97\u53e3\u6807\u9898|(?:\u8bf4\u660e|\u62a5\u544a|\u56de\u62a5).{0,16}(?:\u5b9e\u9645|\u771f\u5b9e).{0,16}(?:\u8fdb\u7a0b|\u7a97\u53e3)|\b(?:report|show|state)\b.{0,24}\b(?:actual|real)\b.{0,20}\b(?:process|window)\b/iu.test(String(input || ''));
}

export function requiresDesktopFileListingObservation(input: string): boolean {
  const text = String(input || '');
  return /(?:\u5217\u51fa|\u67e5\u770b|\u68c0\u67e5|\u770b\u4e00\u4e0b|\u770b\u4e0b|\u770b\u770b|\u663e\u793a|\u76d8\u70b9|\u7edf\u8ba1|\u6570\u4e00\u4e0b).{0,20}\u684c\u9762(?:\u4e0a|\u91cc|\u4e2d)?(?:\u7684)?(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6761\u76ee)|\u684c\u9762(?:\u4e0a|\u91cc|\u4e2d)?(?:\u7684)?(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6761\u76ee).{0,20}(?:\u5217\u51fa|\u67e5\u770b|\u68c0\u67e5|\u770b\u4e00\u4e0b|\u770b\u4e0b|\u770b\u770b|\u663e\u793a|\u591a\u5c11|\u51e0\u4e2a|\u6570\u91cf|\u7edf\u8ba1)|\b(?:list|show|inspect|check|count)\b.{0,24}\bdesktop\b.{0,16}\b(?:files?|folders?|entries)\b|\bdesktop\b.{0,16}\b(?:files?|folders?|entries)\b.{0,24}\b(?:list|show|inspect|check|count|how\s+many)\b/iu.test(text);
}

export function requiresRunningProcessObservation(input: string): boolean {
  const text = String(input || '');
  const conceptual = /\b(?:explain|describe|define|teach|model|transition|lifecycle|theory|concept|operating\s+systems?)\b|(?:\u89e3\u91ca|\u8bf4\u660e|\u5b9a\u4e49|\u6a21\u578b|\u8f6c\u6362|\u751f\u547d\u5468\u671f|\u539f\u7406|\u6982\u5ff5|\u64cd\u4f5c\u7cfb\u7edf)/iu.test(text);
  const explicitLive = /\b(?:running\s+process(?:es)?|process\s+list|runtime\s+state|desktop\s+(?:state|status)|desktop\s+(?:program|app)(?:lication)?\s+check)\b|\b(?:running|active)\s+(?:desktop\s+)?(?:ai\s+)?app(?:lication)?s?\b|(?:\u8fd0\u884c|\u6d3b\u8dc3|\u5f53\u524d)\u8fdb\u7a0b|\u8fdb\u7a0b\u5217\u8868|\u684c\u9762\u8fd0\u884c\u72b6\u6001|(?:\u6b63\u5728\u8fd0\u884c|\u5df2\u8fd0\u884c).{0,16}(?:AI|\u4eba\u5de5\u667a\u80fd)?\u5e94\u7528|(?:\u505a\u4e2a|\u505a\u4e00\u4e2a|\u8fdb\u884c|\u68c0\u67e5|\u67e5\u770b|\u770b\u4e00\u4e0b|\u770b\u4e0b|\u770b\u770b).{0,10}(?:\u684c\u9762)?(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528)(?:\u68c0\u67e5|\u72b6\u6001|\u8fd0\u884c\u60c5\u51b5)|(?:\u540e\u53f0|\u5f53\u524d|\u684c\u9762).{0,12}(?:\u591a\u5c11|\u51e0\u4e2a|\u6709\u54ea\u4e9b|\u770b\u770b|\u770b\u4e00\u4e0b|\u67e5\u770b)?.{0,8}(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u8fdb\u7a0b).{0,12}(?:\u8fd0\u884c|\u8fd0\u884c\u60c5\u51b5|\u72b6\u6001|\u68c0\u67e5)|(?:\u540e\u53f0|\u5f53\u524d).{0,12}(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u8fdb\u7a0b).{0,12}(?:\u591a\u5c11|\u51e0\u4e2a|\u6709\u54ea\u4e9b)/iu.test(text);
  if (explicitLive) return true;
  if (conceptual) return false;
  const localScope = /\b(?:this|my|local|current)\s+(?:computer|pc|machine|system|device)\b|(?:\u672c\u673a|\u8fd9\u53f0\u7535\u8111|\u6211\u7684\u7535\u8111|\u5f53\u524d\u8bbe\u5907)/iu.test(text);
  const observationVerb = /\b(?:check|inspect|show|report|get|list|read|view|monitor)\b|(?:\u67e5\u770b|\u68c0\u67e5|\u663e\u793a|\u62a5\u544a|\u8bfb\u53d6|\u83b7\u53d6|\u5217\u51fa|\u76d1\u63a7)/iu.test(text);
  const ambiguousState = /\bprocess\s+(?:state|status)\b|\u8fdb\u7a0b(?:\u72b6\u6001|\u4fe1\u606f)/iu.test(text);
  return ambiguousState && (localScope || observationVerb);
}

function requiresSystemInfoObservation(input: string): boolean {
  const text = String(input || '');
  const localScope = /\b(?:this|my|local|current)\s+(?:computer|pc|machine|system|device)\b|(?:\u672c\u673a|\u8fd9\u53f0\u7535\u8111|\u6211\u7684\u7535\u8111|\u5f53\u524d\u8bbe\u5907)/iu.test(text);
  const conceptual = /\b(?:explain|summarize|compare|define|teach|model|architecture|algorithm|scheduling|theory|concept|programming|management)\b|(?:\u89e3\u91ca|\u603b\u7ed3|\u5bf9\u6bd4|\u5b9a\u4e49|\u6a21\u578b|\u67b6\u6784|\u7b97\u6cd5|\u8c03\u5ea6|\u539f\u7406|\u6982\u5ff5|\u7f16\u7a0b|\u7ba1\u7406)/iu.test(text);
  const namedSnapshot = /\b(?:system|os)\s+(?:info(?:rmation)?|details?|specs?|status)\b|(?:\u7cfb\u7edf\u4fe1\u606f|\u7cfb\u7edf\u914d\u7f6e|\u7535\u8111\u914d\u7f6e)/iu.test(text);
  if (namedSnapshot) return !conceptual || localScope;

  const mentionsMetric = /\b(?:cpu|memory|disk)\b|CPU|\u5185\u5b58|\u78c1\u76d8/iu.test(text);
  if (!mentionsMetric || (conceptual && !localScope)) return false;

  const observationVerb = /\b(?:check|inspect|show|report|get|read|view|display|measure|monitor)\b|(?:\u67e5\u770b|\u68c0\u67e5|\u663e\u793a|\u62a5\u544a|\u8bfb\u53d6|\u83b7\u53d6|\u76d1\u63a7|\u770b\u4e00\u4e0b|\u770b\u770b)/iu.test(text);
  const liveMetric = /\b(?:usage|utilization|capacity|space|free|available|status|temperature|load)\b|(?:\u4f7f\u7528\u7387|\u5360\u7528|\u5bb9\u91cf|\u7a7a\u95f4|\u5269\u4f59|\u53ef\u7528|\u72b6\u6001|\u6e29\u5ea6|\u8d1f\u8f7d)/iu.test(text);
  return observationVerb || liveMetric || localScope;
}

export function buildDesktopObservationPlan(input: string): DesktopObservationToolCall[] {
  const text = String(input || '').trim();
  if (!text) return [];

  const wantsActiveWindow = requiresActiveWindowObservation(text);
  const wantsDesktopFiles = requiresDesktopFileListingObservation(text);
  const wantsProcesses = requiresRunningProcessObservation(text);
  const wantsIdle = /\b(?:idle\s+time|away\s+time)\b|\u7a7a\u95f2\u65f6\u95f4|\u591a\u4e45\u6ca1\u64cd\u4f5c/iu.test(text);
  const wantsSystem = requiresSystemInfoObservation(text);
  const wantsAppInventory = /\b(?:(?:installed|launchable|available|local(?:ly)?)\s+(?:desktop\s+)?(?:ai\s+)?app(?:lication)?s?|app(?:lication)?\s+(?:inventory|list))\b|\b(?:inspect|check|list|show|find|detect|inventory)\b.{0,64}\b(?:installed|launchable|available|local|app|application|software|program|launch\s+target)\b|(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u672c\u673a|\u672c\u5730).{0,16}(?:AI|\u4eba\u5de5\u667a\u80fd)?\u5e94\u7528|\u5e94\u7528(?:\u6e05\u5355|\u5217\u8868)|(?:\u68c0\u67e5|\u67e5\u770b|\u5217\u51fa|\u8bc6\u522b|\u68c0\u6d4b|\u76d8\u70b9|\u67e5\u627e).{0,32}(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u5e94\u7528|\u8f6f\u4ef6|\u7a0b\u5e8f|\u542f\u52a8\u5165\u53e3|\u5b89\u88c5\u72b6\u6001)/iu.test(text);
  const wantsDesktopState = /\bdesktop\s+(?:state|status|runtime)\b|\u684c\u9762\u8fd0\u884c\u72b6\u6001|\u684c\u9762\u72b6\u6001/iu.test(text);
  if (!wantsActiveWindow && !wantsDesktopFiles && !wantsProcesses && !wantsIdle && !wantsSystem && !wantsAppInventory && !wantsDesktopState) return [];

  const positiveText = stripNegativeConstraints(text);
  const mutationText = positiveText
    .replace(/\blaunch\s+target\b/giu, ' ')
    // Treat "software/process is running" as observed state, not an instruction to run it.
    // Keeping the noun requirement preserves imperative phrases such as "运行 Photoshop".
    .replace(/(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u8fdb\u7a0b).{0,4}(?:\u6b63\u5728|\u8fd8\u5728|\u5df2\u7ecf|\u5df2|\u5728)?\u8fd0\u884c(?:\u4e2d|\u7740|\u72b6\u6001|\u60c5\u51b5)?/giu, ' ')
    .replace(/\b(?:software|program|app(?:lication)?|process)(?:es)?\s+(?:is|are|currently\s+)?running\b/giu, ' ');
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

function requiresDesktopSoftwareCountObservation(taskText: string): boolean {
  return /(?:\u684c\u9762).{0,24}(?:\u591a\u5c11|\u51e0\u4e2a|\u6570\u91cf).{0,16}(?:\u8f6f\u4ef6|\u5e94\u7528|\u7a0b\u5e8f|\u5feb\u6377\u65b9\u5f0f)|(?:\u684c\u9762).{0,16}(?:\u8f6f\u4ef6|\u5e94\u7528|\u7a0b\u5e8f|\u5feb\u6377\u65b9\u5f0f).{0,16}(?:\u591a\u5c11|\u51e0\u4e2a|\u6570\u91cf)|\bhow\s+many\b.{0,32}\b(?:desktop\s+)?(?:apps?|applications?|programs?|shortcuts?)\b/iu.test(taskText || '');
}

function recordVerificationIsUsable(record: ToolExecutionRecord): boolean {
  const terminalStatus = record.terminalVerification?.status;
  const envelopeStatus = record.envelope?.verification?.status;
  const envelopeBasis = record.envelope?.verification?.basis;
  if (terminalStatus) {
    return terminalStatus === 'verified'
      && (!envelopeStatus || envelopeStatus === 'verified')
      && (!envelopeBasis || envelopeBasis === 'terminal_verification');
  }
  return envelopeStatus === 'verified' && envelopeBasis === 'terminal_verification';
}

function recordHasUsableResult(record: ToolExecutionRecord): boolean {
  return !record.error
    && Boolean(String(record.result || '').trim())
    && recordVerificationIsUsable(record);
}

function recordMatchesProbe(record: ToolExecutionRecord, probe: DesktopObservationToolCall['name']): boolean {
  switch (probe) {
    case 'desktop_active_window': return /^(desktop_active_window|get_active_window_info)$/i.test(record.name);
    case 'desktop_running_processes': return /^(desktop_running_processes|get_running_processes)$/i.test(record.name);
    case 'desktop_system_info': return /^(desktop_system_info|get_system_info)$/i.test(record.name);
    default: return record.name.toLowerCase() === probe;
  }
}

function probeHasStructuredResult(
  records: ToolExecutionRecord[],
  probe: DesktopObservationToolCall['name'],
): boolean {
  return [...records].reverse().some(record => {
    if (!recordMatchesProbe(record, probe)) return false;
    const parsed = parseResult(record);
    switch (probe) {
      case 'desktop_active_window':
      case 'desktop_system_info':
        return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0);
      case 'desktop_running_processes':
        return asProcessItems(parsed) !== null;
      case 'desktop_idle_time':
        return Boolean(parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.idle_seconds)));
      case 'desktop_list_apps':
        return Array.isArray(parsed);
      case 'desktop_list_files':
        return Array.isArray(parsed)
          || Array.isArray(parsed?.files)
          || Array.isArray(parsed?.entries)
          || Array.isArray(parsed?.items);
      default:
        return false;
    }
  });
}

interface DesktopObservationCoverage {
  requested: boolean;
  complete: boolean;
  plannedToolNames: DesktopObservationToolCall['name'][];
  satisfiedToolNames: DesktopObservationToolCall['name'][];
  missingToolNames: DesktopObservationToolCall['name'][];
  usableRecords: ToolExecutionRecord[];
}

function evaluateDesktopObservationCoverage(
  records: ToolExecutionRecord[],
  taskText: string,
): DesktopObservationCoverage {
  const plannedToolNames = buildDesktopObservationPlan(taskText).map(call => call.name);
  // The shortcut-count path predates the deterministic planner but still has
  // one exact evidence requirement: a current-turn desktop file listing.
  if (requiresDesktopSoftwareCountObservation(taskText) && !plannedToolNames.includes('desktop_list_files')) {
    plannedToolNames.push('desktop_list_files');
  }
  const usableRecords = records.filter(recordHasUsableResult);
  const satisfiedToolNames = plannedToolNames.filter(probe => probeHasStructuredResult(usableRecords, probe));
  const satisfied = new Set(satisfiedToolNames);
  const missingToolNames = plannedToolNames.filter(probe => !satisfied.has(probe));
  return {
    requested: plannedToolNames.length > 0,
    complete: plannedToolNames.length > 0 && missingToolNames.length === 0,
    plannedToolNames,
    satisfiedToolNames,
    missingToolNames,
    usableRecords,
  };
}

export function formatDesktopObservationResult(
  records: ToolExecutionRecord[],
  taskText: string,
): string | null {
  const coverage = evaluateDesktopObservationCoverage(records, taskText);
  const successful = coverage.usableRecords.filter(record => (
    coverage.plannedToolNames.some(probe => recordMatchesProbe(record, probe))
  ));
  if (!coverage.requested || successful.length === 0) return null;

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
  const plannedToolNames = new Set(coverage.plannedToolNames);
  const failures = records.filter(record => (
    Boolean(record.error)
    && [...plannedToolNames].some(probe => recordMatchesProbe(record, probe))
  ));
  const hasMutation = records.some(record =>
    /^(desktop_open|desktop_show_lumi_window|desktop_run_command|desktop_clipboard_write|desktop_mouse_|desktop_keyboard_|client_action|computer_use)/i.test(record.name)
  );
  const zh = /[\u3400-\u9fff]/u.test(taskText || '');
  const wantsRunningProcessCount = /(?:\u540e\u53f0|\u5f53\u524d|\u684c\u9762).{0,20}(?:\u591a\u5c11|\u51e0\u4e2a).{0,16}(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u8fdb\u7a0b)|(?:\u540e\u53f0|\u5f53\u524d|\u684c\u9762).{0,16}(?:\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u8fdb\u7a0b).{0,16}(?:\u591a\u5c11|\u51e0\u4e2a)|\bhow\s+many\b.{0,32}\b(?:running\s+)?(?:processes|apps?|applications?|programs?)\b/iu.test(taskText || '');
  const wantsDesktopSoftwareCount = requiresDesktopSoftwareCountObservation(taskText);
  if (wantsDesktopSoftwareCount && fileListingAvailable && coverage.complete) {
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
  if (wantsRunningProcessCount && processList && coverage.complete) {
    const names = uniqueLabels(
      processList,
      item => String(item?.name || item?.window_title || ''),
      item => String(item?.name || item?.window_title || ''),
    );
    return formatDesktopProcessCount(taskText, processList.length, names);
  }
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
  if (!hasStructuredObservation) return null;

  if (!zh) {
    const lines = [coverage.complete
      ? 'The desktop-state check completed with fresh evidence from the connected desktop client.'
      : 'The desktop-state check returned partial fresh evidence from the connected desktop client.'];
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
    if (coverage.missingToolNames.length) lines.push(`Incomplete checks: ${coverage.missingToolNames.join(', ')} (no usable current-turn receipt).`);
    if (!hasMutation) lines.push('No click, typing, window switch, app launch, or content modification tool ran in this turn.');
    return lines.join('\n');
  }

  // i18n-allow: reviewed Chinese partial desktop observation result.
  const lines: string[] = [coverage.complete
    ? CN_RESULT_GROUNDING_MESSAGES.desktopSnapshotIntro
    : '\u684c\u9762\u72b6\u6001\u68c0\u67e5\u53ea\u62ff\u5230\u4e86\u90e8\u5206\u672c\u8f6e\u65b0\u9c9c\u56de\u6267\u3002']; // i18n-allow: reviewed Chinese partial desktop observation result.
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
  // i18n-allow: reviewed Chinese incomplete desktop observation detail.
  if (coverage.missingToolNames.length) lines.push(`\u672a\u5b8c\u6210\u7684\u8bfb\u53d6\uff1a${coverage.missingToolNames.join('\u3001')}\uff08\u672c\u8f6e\u6ca1\u6709\u53ef\u7528\u56de\u6267\uff09\u3002`);
  if (!hasMutation) lines.push('\u672c\u8f6e\u6ca1\u6709\u6267\u884c\u70b9\u51fb\u3001\u8f93\u5165\u3001\u5207\u6362\u7a97\u53e3\u3001\u6253\u5f00\u5e94\u7528\u6216\u4fee\u6539\u5185\u5bb9\u3002');
  return lines.join('\n');
}

export function evaluateDesktopObservationEvidence(
  records: ToolExecutionRecord[],
  taskText: string,
): DesktopObservationEvidenceEvaluation {
  const coverage = evaluateDesktopObservationCoverage(records, taskText);
  return {
    requested: coverage.requested,
    complete: coverage.complete,
    plannedToolNames: coverage.plannedToolNames,
    satisfiedToolNames: coverage.satisfiedToolNames,
    missingToolNames: coverage.missingToolNames,
    text: formatDesktopObservationResult(records, taskText),
  };
}
