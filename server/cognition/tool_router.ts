import { ToolPolicy } from '../personality/types';
import {
  ToolRegistry,
} from '../tools/registry';
import {
  projectToolDeclarationForRouting,
  selectCapabilityRoutingProjections,
  type CapabilityRoutingProjection,
} from '../tools/capability_projection';
import type { CapabilityLane, CapabilityManifestEntry } from '../tools/types';
import {
  getRegisteredMCPToolOwner,
  mcpManager,
  requireSafeMCPServerName,
} from '../mcp';
import {
  buildActionContract,
  extractDesktopLaunchTarget,
  isSimpleDesktopOpenRequest,
  requestsBlankAutoCadDocument,
  requiresExternalAiHistory,
  requiresCurrentAuthoringDocumentInspection,
  requiresCurrentAppUiMutation,
  requiresCadGeometryExtractionOnly,
  requiresVisibleAutoCadExecution,
} from './action_contract';
import {
  isRecoveredCurrentAppEditingContinuation,
  type ConversationActionContinuationState,
} from './action_continuation';
import { detectRequestedOperationMode, isPureOperationModeSwitchRequest } from './operation_modes';
import { buildDesktopObservationPlan } from './desktop_observation';
import {
  BASELINE_TOOLS,
  ROUTES,
  type RouteDefinition,
} from '../regions/packs/cn/tool_route_definitions';
import {
  isExplicitArtifactCreationText,
  isExternalCommitConfirmationOnlyRequest,
} from './normalized_action_intent';
import { isReadOnlyKnowledgeBaseInspectionRequest } from './knowledge_intent';
import { classifyRuntimeWorkIntent } from './runtime_work_intent';
import {
  isRuntimeCleanupOfferAcceptanceText,
  type PendingAssistantOfferContext,
} from './pending_assistant_offer';
import { toolRecordTerminalPayload } from '../tools/receipt_payload';

type ToolDeclaration = ReturnType<ToolRegistry['getToolDeclarations']>[number];

export interface ToolRoute {
  toolNames: string[];
  categories: string[];
  reasons: string[];
  totalAvailable: number;
  maxTools: number;
  truncated: boolean;
  unavailableMcpServers?: string[];
  hardAllowlist?: boolean;
  forbiddenToolNames?: string[];
  maxIterations?: number;
}

export interface ToolRouteOptions {
  maxTools?: number;
  connectedMcpServers?: string[];
  enableMcpHealthGate?: boolean;
  capabilityManifest?: CapabilityManifestEntry[];
  /**
   * An already validated, immediately preceding assistant offer. Socket and
   * conversation layers may persist and supply it later; the router itself
   * remains transport-independent.
   */
  pendingAssistantOfferContext?: PendingAssistantOfferContext;
  /** Trusted server-owned durable task state for terse continuation turns. */
  actionTaskState?: ConversationActionContinuationState | null;
  /** True only when the transport bound this turn to that exact durable task. */
  trustedActionContinuation?: boolean;
}

type AuthoringApplication = 'wps' | 'word' | 'excel' | 'powerpoint';

function authoringApplication(value: unknown): AuthoringApplication | null {
  const text = String(value || '');
  // i18n-allow: Product/process recognition for trusted machine receipts; not user-visible copy.
  if (/(?:^|\b)(?:WPS|wps\.exe|wpp\.exe|et\.exe)(?:\b|$)|金山(?:文字|表格|演示|WPS)/iu.test(text)) return 'wps';
  if (/(?:Microsoft\s+Word|WINWORD\.EXE)/iu.test(text)) return 'word';
  if (/(?:Microsoft\s+Excel|EXCEL\.EXE)/iu.test(text)) return 'excel';
  if (/(?:Microsoft\s+PowerPoint|POWERPNT\.EXE)/iu.test(text)) return 'powerpoint';
  return null;
}

/**
 * File discovery for a deictic "current document" request is a second-stage
 * capability.  It may only be exposed after the server-owned task capsule has
 * retained an authoring-window target and advanced past active-window
 * inspection.  Assistant prose and injected continuation text are not enough
 * to widen the route.
 */
function hasTrustedCurrentDocumentReadAnchor(
  state: ConversationActionContinuationState | null | undefined,
): boolean {
  if (!state?.unfinished || !state.taskCapsule) return false;
  const target = state.taskCapsule.target;
  const nextAction = String(state.taskCapsule.nextAction || '');
  if (!['search_bounded_roots', 'analyze'].includes(nextAction)) return false;
  const targetApplication = authoringApplication([
    state.appTarget,
    target.application,
    target.window,
  ].filter(Boolean).join(' '));
  if (!targetApplication) return false;
  return Boolean(state.receipts?.some(receipt => {
    if (!['desktop_active_window', 'get_active_window_info'].includes(receipt.name)) return false;
    if (receipt.outcome !== 'success' || receipt.error) return false;
    if (receipt.terminalVerification?.status !== 'verified') return false;
    const observedApplication = authoringApplication(JSON.stringify(toolRecordTerminalPayload(receipt)));
    return observedApplication === targetApplication;
  }));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

const INJECTED_ROUTING_CONTEXT_RE = /(?:^|\r?\n)\s*##\s+(?:Current Turn Attachments|Recent action continuation context|Internal client-surface continuation context)\b/i;

/**
 * Capability intent comes from the user's instruction, never from text
 * extracted from an attachment or a server-owned continuation block. The
 * complete text remains available only to bounded target resolvers.
 */
function primaryRoutingInstruction(input: string): string {
  const raw = String(input || '').trim();
  const marker = INJECTED_ROUTING_CONTEXT_RE.exec(raw);
  if (!marker) return raw;
  return raw.slice(0, marker.index).trim();
}

function routeMatches(route: RouteDefinition, text: string): boolean {
  return route.patterns.some(pattern => pattern.test(text));
}

function addIfAvailable(out: Set<string>, available: Set<string>, name: string): void {
  if (available.has(name)) out.add(name);
}

/**
 * A correction/retry is allowed to keep the exact capabilities that already
 * produced evidence for the same durable task.  The current wording may name
 * only a replacement path (and therefore match an unrelated route), so retain
 * the prior receipt tools as a narrow, server-owned continuation envelope.
 * Never use the personality wildcard to restore the whole registry: when the
 * snapshot is wildcarded, the observed receipt names are the least-privilege
 * capability set we can prove belongs to this task.
 */
export function trustedContinuationEvidenceTools(
  options: ToolRouteOptions | undefined,
  available: Set<string>,
): string[] {
  const state = options?.actionTaskState;
  if (!options?.trustedActionContinuation || !state?.unfinished) return [];
  const snapshot = state.policySnapshot;
  const allowed = new Set(snapshot?.allowedTools || []);
  const forbidden = new Set(snapshot?.forbiddenTools || []);
  const wildcard = allowed.has('*');
  const names = [
    ...(state.evidenceTools || []),
    ...((state.receipts || []).map(receipt => receipt.name)),
  ];
  return unique(names)
    .filter(name => available.has(name))
    .filter(name => !forbidden.has('*') && !forbidden.has(name))
    .filter(name => !snapshot || wildcard || allowed.has(name))
    .slice(-16);
}

const MANIFEST_LANES_BY_GROUP: Record<string, CapabilityLane[]> = {
  currentAppControl: ['desktop'],
  files: ['files'],
  documents: ['office'],
  audioTranscription: ['media'],
  knowledge: ['knowledge'],
  web: ['web'],
  authenticatedWeb: ['web'],
  publicPost: ['web', 'desktop'],
  legal: ['industry'],
  music: ['desktop'],
  design: ['cad', 'media'],
  code: ['files', 'system'],
  system: ['system', 'client', 'desktop'],
  skills: ['system', 'client', 'agents'],
  externalControl: ['desktop', 'web', 'agents'],
  messaging: ['messaging', 'desktop'],
  workTakeover: ['agents'],
  autonomy: ['agents', 'system'],
  sleepDream: ['memory'],
  calendar: ['messaging'],
};

const MANIFEST_TERMS_BY_GROUP: Partial<Record<string, RegExp>> = {
  currentAppControl: /active.window|window.control|native.ui|ui.snapshot|ui.focus|ui.click|ui.invoke|ui.type|capture.screen|ocr.screen|clipboard|keyboard.press|desktop.open/i,
  authenticatedWeb: /login|account|auth|session|credential|playwright/i,
  publicPost: /post|publish|comment|reply|playwright|browser|desktop|clipboard|keyboard|native.ui|ui.snapshot|ui.focus|ui.click|ui.type|ui.invoke/i,
  audioTranscription: /transcrib|speech.?to.?text|audio.?to.?text|recording.?to.?text/i,
  legal: /legal|law|court|case|citation|authority/i,
  design: /cad|autocad|dxf|dwg|floorplan|design|image|video|ocr|drawing|render/i,
  code: /code|git|test|type.?check|command|python/i,
  skills: /skill|mcp|agent|adapter|capability|client.*state|manifest|external.control/i,
  externalControl: /desktop|computer|browser|playwright|external.control|external.?ai|collaboration|native.ui|accessibility|adapter/i,
  workTakeover: /work.?takeover|task|self.?extension|capability/i,
  autonomy: /autonomy|workflow/i,
  sleepDream: /sleep|dream|memory/i,
  calendar: /calendar|event|email|mail/i,
};

function addGroup(
  out: Set<string>,
  available: Set<string>,
  group: string,
  manifest: CapabilityRoutingProjection[],
): string[] {
  const lanes = new Set(MANIFEST_LANES_BY_GROUP[group] || []);
  const terms = MANIFEST_TERMS_BY_GROUP[group];
  const matched = selectCapabilityRoutingProjections(manifest, {
    availableToolNames: available,
    lanes: Array.from(lanes),
    terms,
  });
  for (const entry of matched) out.add(entry.toolName);
  return matched.map(entry => entry.toolName);
}

function addActionContractCapabilities(
  out: Set<string>,
  available: Set<string>,
  contract: ReturnType<typeof buildActionContract>,
  manifest: CapabilityRoutingProjection[],
): string[] {
  const selected: string[] = [];
  for (const requirement of contract.preferredCapabilities || []) {
    const termPattern = requirement.terms.length
      ? new RegExp(requirement.terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      : undefined;
    const matches = selectCapabilityRoutingProjections(manifest, {
      availableToolNames: available,
      lanes: requirement.lanes,
      terms: termPattern,
    }).filter(entry => (
      !requirement.operations?.length || requirement.operations.includes(entry.operation)
    ));
    for (const entry of matches) {
      out.add(entry.toolName);
      selected.push(entry.toolName);
    }
  }
  return selected;
}

function addPrefix(out: Set<string>, names: string[], prefix: string): void {
  for (const name of names) {
    if (name.startsWith(prefix)) out.add(name);
  }
}

function addNamePattern(out: Set<string>, names: string[], pattern: RegExp): void {
  for (const name of names) {
    if (pattern.test(name)) out.add(name);
  }
}

function isDirectMessagingSend(text: string): boolean {
  return /(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1\u4e00\u4e0b|\u53d1\u4e00\u6761|\b(?:send|message)\b|(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:(?:\u95ee\u4e00\u4e0b|\u95ee\u95ee|\u8be2\u95ee|\u95ee)\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u5728\u5e72\u561b|\u5728\u505a\u4ec0\u4e48|\u5e72\u561b|\u505a\u4ec0\u4e48|\u5fd9\u4ec0\u4e48|\u73b0\u5728\u600e\u4e48\u6837|\u6709\u6ca1\u6709\u7a7a)))/iu.test(text)
    && !hasNegatedMessagingSendIntent(text)
    && !/(?:\u8349\u7a3f|\u7f16\u8f91\u4e00\u4e0b|\u5148\u5199|\u4e0d\u8981\u53d1|\bdraft\b)/iu.test(text);
}

function hasNegatedMessagingSendIntent(text: string): boolean {
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/^(?:\u6211)?(?:\u6ca1\u6709|\u6ca1|\u5e76\u672a|\u4ece\u672a|\u4e0d\u662f|\u5e76\u4e0d\u662f).{0,100}(?:\u53d1\u7ed9|\u53d1\u9001\u7ed9|\u7ed9.{0,24}\u53d1|\u8ba9\u4f60.{0,24}(?:\u53d1|\u56de\u590d|\u544a\u8bc9))/u.test(text)) return true;
  return /(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u7981\u6b62).{0,32}(?:\u53d1\u9001|\u53d1\u6d88\u606f|\u56de\u590d|\u53d1\u51fa)|\b(?:do\s+not|don't|dont|never)\b.{0,64}\b(?:send|message|reply)\b|\bwithout\b.{0,40}\b(?:sending|messaging|replying)\b/iu.test(text);
}

function hasNamedMessagingSurface(text: string): boolean {
  return /(?:\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u4f01\u5fae|\u98de\u4e66|\u9489\u9489|\bwechat\b|\bweixin\b|\bwecom\b|\bfeishu\b|\blark\b|\bdingtalk\b)/iu.test(text);
}

function isMessagingRead(text: string): boolean {
  if (isDirectMessagingSend(text)) return false;
  return /(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f).*(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3)|(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3).*(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f)/iu.test(text);
}

function isDesktopAiRequest(text: string): boolean {
  if (requiresExternalAiHistory(text)) return false;
  return /(?:WorkBuddy|Codex|ChatGPT|Claude|Gemini|DeepSeek|Kimi|豆包|通义|文心|Perplexity|Cursor|Copilot|Ollama|LM Studio|Cherry Studio|AnythingLLM|外部AI|外部 AI|桌面AI|桌面 AI|其它AI|其他AI|AI工具|AI客户端|AI\s*app)/iu.test(text)
    || /(?:问|发给|发送给|交给|询问)[\s\S]{0,80}(?:AI|模型|agent|智能体)/iu.test(text)
    || /(?:AI|模型|agent|智能体)[\s\S]{0,80}(?:回答|结果|总结|对比|汇总)/iu.test(text);
}

function isLocalCadSourceRequest(text: string): boolean {
  const raw = String(text || '');
  const hasLocalSource =
    /\b(?:desktop|local|folder|directory|path|files?)\b/i.test(raw)
    || /(?:\u684c\u9762|\u672c\u5730|\u6587\u4ef6\u5939|\u76ee\u5f55|\u8def\u5f84|\u91cc\u9762|\u5185\u5bb9|\u8d44\u6599)/u.test(raw);
  const hasSourceReading =
    /\b(?:read|scan|inspect|according\s+to|based\s+on|from)\b/i.test(raw)
    || /(?:\u8bfb\u53d6|\u8bfb|\u626b\u63cf|\u67e5\u770b|\u6574\u7406|\u6309\u7167|\u6839\u636e|\u4f9d\u636e|\u91cc\u9762\u7684|\u5185\u5bb9)/u.test(raw);
  const hasImageSource =
    /\.(?:png|jpe?g|webp|bmp)\b/i.test(raw)
    || /(?:\u56fe\u7247|\u7167\u7247|\u8349\u7a3f\u56fe|\u6237\u578b\u56fe|\u5e73\u9762\u56fe|\u56fe\u7eb8)/u.test(raw);
  const hasCadTarget =
    /\b(?:cad|dxf|dwg|autocad|draw|draft|floor\s*plan)\b/i.test(raw)
    || /(?:\u56fe\u7eb8|\u753b\u56fe|\u753b\u51fa\u6765|\u7ed8\u5236|\u5b9e\u64cd|\u5b9e\u9645\u753b|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe)/u.test(raw);
  return hasLocalSource && (hasSourceReading || hasImageSource) && hasCadTarget;
}

function isLocalCadImageSourceRequest(text: string): boolean {
  const raw = String(text || '');
  const hasLocalSource =
    /\b(?:desktop|local|path|file)\b/i.test(raw)
    || /(?:\u684c\u9762|\u672c\u5730|\u4e0b\u8f7d|\u8def\u5f84)/u.test(raw);
  const hasFolderSource = /\b(?:folder|directory)\b/i.test(raw)
    || /(?:\u6587\u4ef6\u5939|\u76ee\u5f55)/u.test(raw);
  const hasExplicitImageFile = /\.(?:png|jpe?g|webp|bmp)\b/i.test(raw);
  const hasImageNoun = /(?:\u56fe\u7247|\u7167\u7247|\u8349\u7a3f\u56fe|\u6237\u578b\u56fe|\u5e73\u9762\u56fe|\u56fe\u7eb8)/u.test(raw);
  const hasCadTarget = /\b(?:cad|autocad|dxf|dwg|draw|draft)\b/i.test(raw)
    || /(?:\u753b\u5230|\u753b\u8fdb|\u7ed8\u5236|\u753b\u56fe|\u5b9e\u9645\u753b)/u.test(raw);
  return hasLocalSource
    && hasCadTarget
    && (hasExplicitImageFile || (hasImageNoun && !hasFolderSource));
}

function isRecoveredApplicationContinuation(text: string): boolean {
  return /Recovered structured action state:[\s\S]{0,900}- appTarget:\s*[^\n]+/i.test(String(text || ''));
}

function hasPersistentTaskCenterEvidence(text: string): boolean {
  // i18n-allow: Chinese task-center marker recognition; not user-visible copy.
  return /(?:work_takeover_task_|Latest task id:|任务中心\s+工作接管|task[_ -]?id\s*[:=])/i.test(String(text || ''));
}

const LOCAL_CAD_SOURCE_FORBIDDEN_TOOL_RE =
  /^(?:mcp_filesystem_|run_command|desktop_run_command|code_execution|python_exec|powershell|shell_exec|terminal_exec)/i;

const LOCAL_CAD_GENERIC_READER_TOOLS = [
  'read_file',
  'read_files_batch',
  'list_directory',
  'search_files',
  'grep_files',
  'extract_document_text',
  'read_docx',
  'read_pdf',
  'pdf_to_text',
];

export const CAD_GEOMETRY_EXTRACTION_ALLOWED_TOOLS = [
  'desktop_list_files',
  'desktop_path_info',
  'desktop_system_info',
  'floorplan_extract_geometry',
  'ocr_image_file',
  'desktop_capture_screen',
  'ocr_screen',
] as const;

const CAD_GEOMETRY_EXTRACTION_FORBIDDEN_TOOL_RE =
  /^(?:mcp_filesystem_.*|run_command|desktop_run_command|code_execution|python_exec|powershell|shell_exec|terminal_exec|cad_generate_dxf|cad_prepare_autocad_operations|mcp_cad-drafting_(?:.*autocad.*|.*renovation.*)|write_file|create_(?:docx|pdf|ppt|pptx))$/i;

function isCadGeometryExtractionAllowedTool(name: string): boolean {
  return (CAD_GEOMETRY_EXTRACTION_ALLOWED_TOOLS as readonly string[]).includes(name);
}

const STRICT_DESKTOP_OBSERVATION_TOOLS = new Set([
  'desktop_active_window',
  'desktop_running_processes',
  'desktop_idle_time',
  'desktop_system_info',
  'desktop_list_apps',
  'desktop_list_files',
]);

const DESKTOP_OBSERVATION_ADDITIONAL_WORK_RE =
  // i18n-allow: Chinese phrases here are input-intent recognizers, not user-visible UI copy.
  /(?:分析|总结|提取|识别|生成|创建|新建|写入|修改|删除|移动|复制|重命名|搜索|检索|发送|上传|下载|OCR|AutoCAD|\bCAD\b)|(?:读取|阅读).{0,16}(?:内容|正文|文档)|\b(?:analy[sz]e|summari[sz]e|extract|generate|create|write|modify|delete|move|copy|rename|search|grep|send|upload|download|ocr|autocad|cad)\b|\bread\b.{0,20}\b(?:content|document|file)\b/iu;

function strictDesktopObservationToolNames(
  text: string,
  actionContractKind: string,
): string[] {
  if (actionContractKind !== 'desktop_operation') return [];
  if (DESKTOP_OBSERVATION_ADDITIONAL_WORK_RE.test(text)) return [];
  const plan = buildDesktopObservationPlan(text);
  if (
    plan.length === 0
    || plan.some(call => !STRICT_DESKTOP_OBSERVATION_TOOLS.has(call.name))
  ) return [];
  return unique(plan.map(call => call.name));
}

function isDocumentOpenAndReviewRequest(text: string): boolean {
  // i18n-allow: Reviewed multilingual negative open/launch input recognition; not user-visible copy.
  if (/(?:不要|别|禁止|无需).{0,18}(?:打开|启动)|\b(?:do\s+not|don't|never|without)\b.{0,28}\b(?:open|launch)\b/iu.test(text)) return false;
  // Ignore exact-target exclusion clauses such as "do not substitute a
  // same-named file". Their incidental "file"/"read" words describe what
  // must not be used, not a document the user wants reviewed.
  const candidate = text
    // i18n-allow: Reviewed Chinese exact-target exclusion recognition; not user-visible copy.
    .replace(/(?:不能|不要|别|禁止|不可).{0,64}(?:替代|冒充|代替)/gu, ' ')
    .replace(/\b(?:do\s+not|don't|never)\b.{0,80}\b(?:substitute|replace|use\s+instead)\b/giu, ' ');
  // i18n-allow: Reviewed multilingual open/launch input recognition; not user-visible copy.
  const wantsOpen = /(?:打开|启动)|\b(?:open|launch)\b/iu.test(candidate);
  // i18n-allow: Reviewed multilingual document-type input recognition; not user-visible copy.
  const hasDocument = /(?:PDF|DOCX|PPTX?|XLSX?|文件|文档)|\b(?:pdf|docx?|pptx?|xlsx?|file|document)\b/iu.test(candidate)
    // i18n-allow: Reviewed Chinese report/document input recognition; not user-visible copy.
    || /(?:打开|启动|阅读|读取).{0,24}(?:报告|介绍)|(?:报告|介绍)(?:文件|文档)/u.test(candidate)
    || /\b(?:open|launch|read|review).{0,32}\breport\b/iu.test(candidate);
  // i18n-allow: Reviewed multilingual review/read input recognition; not user-visible copy.
  const wantsReview = /(?:分析|总结|介绍|讲解|读取|阅读|逐页|一页一页|看一下|看看)|\b(?:analy[sz]e|summari[sz]e|review|read|present|walk\s+through)\b/iu.test(candidate);
  return wantsOpen && hasDocument && wantsReview;
}

function isDirectAutocadOperationsPlayback(text: string): boolean {
  const raw = String(text || '');
  const hasOperations = /(?:_operations\.json\b|operationsPath|AutoCAD\s+operations)/i.test(raw);
  const hasAutocadTarget = /\b(?:autocad|acad|mcp_cad-drafting_autocad_playback_file)\b/i.test(raw);
  const hasRunIntent = /\b(?:run|execute|launch|playback|acceptance|verify)\b/i.test(raw)
    || /(?:\u8fd0\u884c|\u6267\u884c|\u542f\u52a8|\u56de\u653e|\u9a8c\u6536|\u6821\u9a8c)/u.test(raw);
  return hasOperations && hasAutocadTarget && hasRunIntent;
}

function requestsExplicitCadFileExport(text: string): boolean {
  const raw = String(text || '');
  return /(?:\u5bfc\u51fa|\u751f\u6210|\u4fdd\u5b58|\u4ea4\u4ed8).{0,24}(?:DXF|DWG)|(?:DXF|DWG).{0,24}(?:\u5bfc\u51fa|\u751f\u6210|\u4fdd\u5b58|\u4ea4\u4ed8)/iu.test(raw)
    || /\b(?:export|generate|save|deliver)\b.{0,24}\b(?:DXF|DWG)\b|\b(?:DXF|DWG)\b.{0,24}\b(?:export|generate|save|deliver)\b/i.test(raw);
}

function priorityToolsForRoute(categories: string[], text: string): string[] {
  const priorities: string[] = [];
  const instructionText = primaryRoutingInstruction(text);
  if (requestsBlankAutoCadDocument(instructionText)) {
    priorities.push('mcp_cad-drafting_autocad_new_document');
  }
  if (categories.includes('desktop_observation')) {
    priorities.push(...buildDesktopObservationPlan(instructionText).map(call => call.name));
  }
  if (
    isRecoveredCurrentAppEditingContinuation(instructionText)
    || requiresCurrentAppUiMutation(instructionText)
  ) {
    priorities.push(
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_invoke',
      'desktop_ui_click',
      'desktop_ui_type',
      'write_clipboard',
      'keyboard_press',
      'desktop_keyboard_press',
      'desktop_capture_screen',
      'ocr_screen',
      'desktop_open',
    );
  }
  if (isDirectAutocadOperationsPlayback(instructionText)) {
    priorities.push('mcp_cad-drafting_autocad_playback_file');
  }
  if (isDesktopAiRequest(instructionText)) {
    priorities.push(
      'desktop_ai_ask',
      'desktop_ai_collect_answer',
      'desktop_ai_list_targets',
      'desktop_ai_discovery_plan',
      'desktop_ai_register_target',
      'desktop_open',
      'desktop_active_window',
      'desktop_capture_screen',
      'ocr_screen',
      'computer_use',
    );
  }
  if (categories.includes('messaging')) {
    const isFileTransfer = /(?:文件|附件|材料|文书|图纸|file|attachment).*(?:发送|发给|转发|传到|传给|send|forward|transfer)|(?:发送|发给|转发|传到|传给|send|forward|transfer).*(?:文件|附件|材料|文书|图纸|file|attachment)/iu.test(instructionText);
    if (isFileTransfer) {
      priorities.push(
        'messaging_list_file_targets',
        'feishu_send_file',
        'wechat_send_file',
        'desktop_open',
        'desktop_active_window',
      );
    } else if (isMessagingRead(instructionText)) {
      priorities.push(
        'wechat_read_recent_chat',
        'desktop_open',
        'desktop_active_window',
        'desktop_ui_snapshot',
        'desktop_capture_screen',
        'ocr_screen',
      );
    } else if (isDirectMessagingSend(instructionText)) {
      priorities.push(
        'wechat_send_message',
        'desktop_open',
        'desktop_active_window',
        'desktop_mouse_click_at',
        'desktop_cursor_glow_show',
        'desktop_cursor_glow_update',
        'desktop_cursor_glow_click',
        'desktop_cursor_glow_hide',
        'desktop_keyboard_press',
      );
    } else {
      priorities.push(
        'wechat_prepare_reply',
        'wechat_copy_reply_draft',
        'desktop_open',
        'desktop_active_window',
        'desktop_ui_snapshot',
      );
    }
  }
  if (categories.includes('customer_operations')) {
    priorities.push(
      'mcp_sales-customer-ops_lead_score',
      'mcp_sales-customer-ops_customer_health_review',
      'mcp_sales-customer-ops_support_ticket_triage',
      'mcp_sales-customer-ops_objection_response_builder',
      'mcp_sales-customer-ops_sales_followup_draft',
      'work_takeover_task_create',
      'work_takeover_task_orchestrate',
      'work_takeover_task_run_suggested_tool',
      'wechat_send_message',
      'create_docx',
      'create_pdf',
      'work_product_verify',
    );
  }
  if (categories.includes('ecommerce_operations')) {
    priorities.push(
      'mcp_ecommerce-ops_product_listing_optimizer',
      'mcp_ecommerce-ops_ecommerce_order_profit',
      'mcp_ecommerce-ops_inventory_restock_plan',
      'mcp_ecommerce-ops_platform_settlement_reconcile',
      'mcp_ecommerce-ops_campaign_roi_analyzer',
      'mcp_ecommerce-ops_after_sales_risk_report',
      'mcp_content-ops_short_video_script',
      'mcp_content-ops_content_calendar',
      'generate_image',
      'ai_edit_image',
      'generate_video',
      'web_login_run',
      'mcp_playwright_browser_snapshot',
      'mcp_playwright_browser_navigate',
      'mcp_playwright_browser_click',
      'create_xlsx',
      'create_docx',
      'work_product_verify',
    );
  }
  if (categories.includes('public_post')) {
    priorities.push(
      'browser_open_task',
      'mcp_playwright_browser_snapshot',
      'mcp_playwright_browser_navigate',
      'mcp_playwright_browser_click',
      'mcp_playwright_browser_fill_form',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_capture_screen',
      'write_clipboard',
    );
  }
  if (categories.includes('authenticated_web')) {
    priorities.push(
      'web_login_profile_list',
      'web_login_profile_save_from_preset',
      'web_login_run',
      'url_fetch_logged_in',
      'browser_open_task',
      'mcp_playwright_browser_snapshot',
      'mcp_playwright_browser_navigate',
      'mcp_playwright_browser_click',
      'mcp_playwright_browser_fill_form',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_capture_screen',
    );
  }
  if (categories.includes('market_finance')) {
    priorities.push(
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_kline',
      'mcp_stockbot_market_index',
      'mcp_stockbot_hot_sectors',
      'mcp_stockbot_stock_news',
      'autonomy_get_policy',
      'autonomy_list_workflows',
      'autonomy_register_workflow',
      'mcp_stockbot_stock_trade_plan',
      'mcp_stockbot_paper_portfolio',
      'browser_open_task',
      'mcp_playwright_browser_snapshot',
    );
  }
  if (categories.includes('music')) {
    priorities.push(
      'desktop_list_apps',
      'desktop_open',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_invoke',
      'desktop_ui_click',
      'desktop_ui_type',
      'desktop_keyboard_press',
      'desktop_capture_screen',
      'computer_use',
    );
  }
  if (categories.includes('cad_design')) {
    if (isLocalCadSourceRequest(instructionText)) {
      const localCadSourceTools = requiresVisibleAutoCadExecution(instructionText)
        ? [
            'desktop_list_files',
            'desktop_path_info',
            'floorplan_extract_geometry',
            'ocr_image_file',
            'desktop_list_apps',
            'cad_prepare_autocad_operations',
            'mcp_cad-drafting_autocad_playback_file',
            'desktop_capture_screen',
          ]
        : [
            'desktop_list_files',
            'desktop_path_info',
            'floorplan_extract_geometry',
            'ocr_image_file',
            'desktop_list_apps',
            'mcp_cad-drafting_cad_renovation_folder_workflow',
            'cad_generate_dxf',
            'desktop_capture_screen',
          ];
      priorities.push(...localCadSourceTools);
    } else {
      priorities.push(
        'desktop_list_apps',
        'cad_prepare_autocad_operations',
        'mcp_cad-drafting_autocad_playback_file',
        'cad_generate_dxf',
        'mcp_cad-drafting_cad_space_program',
        'mcp_cad-drafting_cad_renovation_folder_workflow',
        'desktop_capture_screen',
      );
    }
  }
  if (categories.includes('sleep_dream')) {
    priorities.push(
      'lumi_sleep_status',
      'lumi_sleep_cycle',
    );
  }
  if (categories.includes('legal')) {
    if (/(?:\u7c7b\u6848|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93|\u88c1\u5224\u6587\u4e66\u7f51|\u6cd5\u8749|\bAlpha\b|\bexternal\s+authorit)/i.test(instructionText)) {
      priorities.push(
        'legal_extract_dispute_focus',
        'legal_external_research_plan',
        'legal_search_external_authorities',
        'legal_prepare_external_browser_workspace',
      );
    }
    if (/现行有效|法源|法条核验|引用核验|法律版本|司法解释版本|current\s+law|authority\s+source|citation\s+verification/i.test(instructionText)) {
      priorities.push(
        'legal_authority_source_status',
        'legal_refresh_authoritative_sources',
        'legal_verify_citation',
        'legal_generate_citation_verification_report',
        'legal_finalize_delivery_package',
      );
    }
    if (/案件文件夹|材料文件夹|文件夹.*(?:代理词|证据目录|委托书|起诉状|答辩状)|读取.*(?:案件|材料).*文件夹|case\s*folder|legal\s*folder/i.test(instructionText)) {
      priorities.push(
        'mcp_legal-casework_legal_case_folder_workflow',
        'legal_analyze_folder_and_draft_argument',
        'read_file',
        'extract_document_text',
        'web_login_run',
        'url_fetch_logged_in',
      );
    }
    if (/(?:飞书|微信|企业微信|企微|短信|远程消息|Lumi\s*bot|机器人).*(?:入案|归档|保存|案件|案号|材料|法院|通知|短信链接|通知链接|链接)|(?:入案|归档|保存).*(?:飞书|微信|企业微信|企微|短信|远程消息|案件材料|法院通知|短信链接|通知链接)|(?:court\s+notice|notice\s+link|sms\s+link|message\s+intake)/i.test(instructionText)) {
      priorities.push(
        'legal_message_intake_to_case',
        'legal_process_notice_link',
        'legal_download_and_extract_document',
        'legal_case_workflow_status',
        'legal_case_workspace',
        'legal_import_materials_to_kb',
      );
    }
    if (/合同审查|合同模板|合同起草|审查合同|起草合同|标书|投标|招标|bid|tender|contract\s+(review|draft)/i.test(instructionText)) {
      priorities.push(
        'legal_review_contract',
        'legal_draft_contract',
        'legal_generate_bid',
      );
    }
    if (/财产线索|被执行人|执行线索|财产保全|诉前保全|股权穿透|实际控制人|关联企业|失信|限制消费|asset|enforcement|equity|shareholder/i.test(instructionText)) {
      priorities.push(
        'legal_trace_assets',
        'legal_equity_penetration',
        'legal_company_database_lookup',
      );
    }
    if (/下一步|下.?一步|缺什么|还缺|完成度|闭环|状态|进度|能不能.*(交付|立案|起草)|case\s*(status|progress|next)|what.*next/i.test(instructionText)) {
      priorities.push(
        'legal_case_workflow_status',
        'legal_case_workspace',
      );
    }
    if (/\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1|\u6cd5\u5f8b\u610f\u89c1|\u8bc9\u72b6|\u6587\u4e66|\u8bc9\u8bbc\u6750\u6599|argument|opinion|complaint|defense|pleading/i.test(instructionText)) {
      priorities.push(
        'legal_analyze_folder_and_draft_argument',
        'legal_generate_argument_or_opinion',
        'legal_case_reasoning_matrix',
        'legal_generate_citation_verification_report',
        'read_docx',
        'read_pdf',
        'create_docx',
      );
    }
    priorities.push(
      'legal_case_workspace',
      'legal_case_workflow_status',
      'legal_message_intake_to_case',
      'legal_process_notice_link',
      'legal_download_and_extract_document',
      'legal_import_materials_to_kb',
      'legal_meeting_minutes_to_case',
      'legal_case_reasoning_matrix',
      'legal_external_research_plan',
      'legal_search_external_authorities',
      'legal_company_database_lookup',
      'legal_analyze_folder_and_draft_argument',
      'legal_generate_argument_or_opinion',
      'legal_extract_dispute_focus',
      'legal_generate_litigation_packet',
      'legal_prepare_filing_handoff',
      'legal_finalize_delivery_package',
      'legal_case_strategy',
      'legal_search_case',
      'legal_search_statute',
      'read_docx',
      'read_pdf',
      'create_docx',
    );
  }
  return unique(priorities);
}

function applyRoutePriority(ordered: string[], priorities: string[]): string[] {
  if (!priorities.length) return ordered;
  const available = new Set(ordered);
  const prioritySet = new Set(priorities);
  return [
    ...priorities.filter(name => available.has(name)),
    ...ordered.filter(name => !prioritySet.has(name)),
  ];
}

function getMcpServerName(
  toolName: string,
  capabilityManifest?: CapabilityManifestEntry[],
): string | null {
  const manifestEntry = capabilityManifest?.find(entry => entry.toolName === toolName);
  if (manifestEntry) {
    const manifestProvider = manifestEntry.provenance?.provider || manifestEntry.provider;
    if (
      manifestProvider
      && (
        manifestEntry.source === 'mcp'
        || manifestEntry.source === 'skill'
        || manifestEntry.provenance?.kind === 'mcp'
        || manifestEntry.provenance?.kind === 'skill'
      )
    ) {
      try {
        return requireSafeMCPServerName(manifestProvider);
      } catch {
        return null;
      }
    }
    // The manifest passed to this route belongs to the exact ToolRegistry
    // being planned. An explicit builtin/adapter entry is authoritative; a
    // same-named owner cached in another (usually the process-global) MCP
    // registry must never make this tool subject to an unrelated health gate.
    return null;
  }
  return getRegisteredMCPToolOwner(toolName);
}

function getConnectedMcpGate(options?: {
  connectedMcpServers?: string[];
  enableMcpHealthGate?: boolean;
}): Set<string> | null {
  if (options?.enableMcpHealthGate === false) return null;
  if (options?.connectedMcpServers) return new Set(options.connectedMcpServers);
  try {
    const connected = mcpManager.getRoutableServers();
    // An empty runtime inventory is still a real health signal. Synthetic test
    // declarations without MCP provenance remain unaffected, while registered
    // MCP/Skill tools fail closed until their exact owner is routable.
    return new Set(connected);
  } catch {
    return null;
  }
}

function scoreDeclaration(text: string, declaration: ToolDeclaration): number {
  const needle = `${declaration.function.name} ${declaration.function.description || ''}`.toLowerCase();
  const lower = text.toLowerCase();
  const tokens = unique(lower.match(/[a-z0-9_]{3,}|[\u4e00-\u9fa5]{2,}/gi) || []);
  let score = 0;
  for (const token of tokens) {
    if (needle.includes(token.toLowerCase())) score += token.length > 4 ? 2 : 1;
  }
  if (needle.includes(lower) || lower.includes(declaration.function.name.toLowerCase())) score += 4;
  return score;
}

export function routeToolsForTurn(
  userText: string,
  declarations: ToolDeclaration[],
  options?: ToolRouteOptions,
): ToolRoute {
  const maxTools = Math.max(8, Math.min(options?.maxTools ?? 64, 80));
  const text = String(userText || '').trim();
  const primaryInstructionText = primaryRoutingInstruction(text);
  const currentInstructionContract = buildActionContract(primaryInstructionText);
  const trustedTaskGoal = options?.trustedActionContinuation
    && options.actionTaskState?.unfinished
    ? primaryRoutingInstruction(String(options.actionTaskState.goal || ''))
    : '';
  // Terse continuation words do not name a capability family. Restore that
  // family from the server-bound root goal, never from an injected prose
  // block. A self-contained correction/new action remains authoritative.
  const restoredTrustedTaskRoute = Boolean(
    trustedTaskGoal
    && (!currentInstructionContract.applies || currentInstructionContract.kind === 'none'),
  );
  const instructionText = restoredTrustedTaskRoute
    ? trustedTaskGoal
    : primaryInstructionText;
  const hasCurrentTurnAttachments = /(?:^|\r?\n)\s*##\s+Current Turn Attachments\b/i.test(text);
  const availableNames = declarations.map(d => d.function.name);
  const available = new Set(
    availableNames.filter(name => !name.startsWith('mcp_filesystem_')),
  );
  const routingManifest: CapabilityRoutingProjection[] = options?.capabilityManifest?.length
    ? options.capabilityManifest
    : declarations.map(projectToolDeclarationForRouting);
  const selected = new Set<string>();
  const categories: string[] = [];
  const reasons: string[] = [];
  if (restoredTrustedTaskRoute) {
    reasons.push('the exact server-bound durable task restored its original capability family for this terse continuation');
  }
  const continuationEvidenceTools = trustedContinuationEvidenceTools(options, available);
  if (continuationEvidenceTools.length) {
    reasons.push('the exact server-bound task retained tools that already produced receipts for its unfinished step');
  }
  const manifestPriorities: string[] = [];
  const runtimeWorkIntent = classifyRuntimeWorkIntent(
    instructionText,
    options?.pendingAssistantOfferContext,
  );
  const actionContract = buildActionContract(instructionText);
  const explicitArtifactCreation = isExplicitArtifactCreationText(instructionText);
  const readOnlyKnowledgeInspection = isReadOnlyKnowledgeBaseInspectionRequest(instructionText);
  const confirmationOnlyExternalCommit = actionContract.kind === 'messaging_send'
    && isExternalCommitConfirmationOnlyRequest(instructionText);
  const recoveredApplicationContinuation = isRecoveredApplicationContinuation(instructionText);
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(instructionText);
  const currentAppEdit = recoveredCurrentAppEdit
    || (actionContract.kind === 'desktop_operation' && requiresCurrentAppUiMutation(instructionText));
  const requestedMode = detectRequestedOperationMode(instructionText);
  const compoundModeAction = Boolean(
    requestedMode && !isPureOperationModeSwitchRequest(instructionText, requestedMode),
  );
  const directCadCapabilityRequested = ROUTES.some(route => (
    route.category === 'cad_design' && routeMatches(route, instructionText)
  )) || ['cad_document', 'design_delivery'].includes(actionContract.kind);
  const trustedCadContinuation = Boolean(
    options?.actionTaskState?.unfinished
    && ROUTES.some(route => (
      route.category === 'cad_design'
      && routeMatches(route, String(options.actionTaskState?.goal || ''))
    )),
  );
  const cadCapabilityRequested = directCadCapabilityRequested || trustedCadContinuation;
  // Attachment metadata may identify a local image/path after the user has
  // explicitly requested CAD work, but it may never grant CAD capability by
  // itself.
  const localCadSourceRequest = cadCapabilityRequested && isLocalCadSourceRequest(text);
  const localCadImageSourceRequest = cadCapabilityRequested && isLocalCadImageSourceRequest(text);
  const cadGeometryExtractionOnly = requiresCadGeometryExtractionOnly(instructionText);
  const currentAuthoringDocumentInspection = (!hasCurrentTurnAttachments
    && requiresCurrentAuthoringDocumentInspection(instructionText))
    || Boolean(
      instructionText
      && options?.actionTaskState?.unfinished
      && requiresCurrentAuthoringDocumentInspection(options.actionTaskState.goal)
      && ['inspect_active_document', 'search_bounded_roots', 'analyze', 'clarify_target'].includes(
        String(options.actionTaskState.taskCapsule?.nextAction || ''),
      ),
    );
  const trustedCurrentDocumentReadAnchor = currentAuthoringDocumentInspection
    && hasTrustedCurrentDocumentReadAnchor(options?.actionTaskState);
  const documentOpenAndReview = !currentAuthoringDocumentInspection
    && !localCadSourceRequest
    && actionContract.kind !== 'design_delivery'
    && isDocumentOpenAndReviewRequest(instructionText);
  const desktopObservationToolNames = currentAppEdit
    ? []
    : strictDesktopObservationToolNames(instructionText, actionContract.kind);
  const desktopObservationOnly = desktopObservationToolNames.length > 0;
  const desktopLaunchRequest =
    actionContract.kind === 'desktop_operation'
    && Boolean(extractDesktopLaunchTarget(text))
    && !documentOpenAndReview
    && !isDirectAutocadOperationsPlayback(instructionText);
  const extensionRegistryOnly = actionContract.kind === 'extension_registry';
  const forbiddenToolNames = new Set<string>();
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const structuredMediaCategory = /^(?:生成|创建|制作)图片\s*(?:\r?\n|$)/u.test(instructionText)
    || /^(?:generate|create|make) (?:an? |some )?images?\s*(?:\r?\n|$)/iu.test(instructionText)
    ? 'image_generation'
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    : /^(?:生成|创建|制作)视频\s*(?:\r?\n|$)/u.test(instructionText)
      || /^(?:generate|create|make) (?:a )?video\s*(?:\r?\n|$)/iu.test(instructionText)
      ? 'video_generation'
      : null;
  const mediaGenerationExplicitlyNegated = !structuredMediaCategory && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /(?:不要|别|无需|不用|不需要|禁止)[\s\S]{0,18}(?:实际)?(?:生成|创建|制作|产出|做)[\s\S]{0,28}(?:图片|图像|插画|海报|视频|短视频|短片|动画|成片)/u.test(instructionText)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /(?:不要|别|无需|不用|不需要)[\s\S]{0,8}(?:实际)?(?:生成|创建|制作|产出)/u.test(instructionText)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /(?:不是|并非)(?:想|要)?[\s\S]{0,8}(?:生成|创建|制作|产出)/u.test(instructionText)
    || /\b(?:do\s+not|don't|never)\b[\s\S]{0,28}\b(?:generate|create|make|produce|render)\b[\s\S]{0,36}\b(?:image|picture|poster|video|clip|animation|movie|short\s+film|reel)\b/i.test(instructionText)
    || /\bwithout\b[\s\S]{0,20}\b(?:generating|creating|making|producing|rendering)\b[\s\S]{0,36}\b(?:image|picture|poster|video|clip|animation|movie|short\s+film|reel)\b/i.test(instructionText)
  );
  const mediaGenerationMetaQuestion = !structuredMediaCategory && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:为什么|怎么|如何|是否|能否|图片生成|图像生成|视频生成|短视频生成)[\s\S]{0,80}(?:图片生成|图像生成|视频生成|短视频生成|模型|配置|失败|可用|费用|价格|多少钱|前端|容器|怎么|如何|为什么|是否|能否|吗|？|\?)/u.test(instructionText)
    || /^\s*(?:why|how|what|which|is|are|can|could|does|did)\b[\s\S]{0,100}\b(?:image|video)\s+generation\b/i.test(instructionText)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /^(?:介绍|说明|解释|讲讲|告诉我)[\s\S]{0,60}(?:图片|图像|视频|短视频)生成(?:功能|能力|模型)?/u.test(instructionText)
    || /^\s*(?:image|video)\s+generation\b[\s\S]{0,100}\b(?:model|configure|configuration|fail|available|cost|price|pricing|frontend|container|why|how)\b/i.test(instructionText)
    || /^\s*(?:explain|describe|introduce|tell\s+me\s+about)\b[\s\S]{0,80}\b(?:image|video)\s+generation\b/i.test(instructionText)
  );
  const existingMediaArtifactAction = !structuredMediaCategory && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:请|麻烦)?(?:帮我)?(?:查看|打开|删除|分析|检查|编辑|修改|发布|上传|发送|保存|下载|分享|播放)[\s\S]{0,32}(?:刚|已|已经|先前|之前)?(?:生成|创建|制作|产出)(?:的)?[\s\S]{0,20}(?:图|图片|图像|视频|短视频|短片|动画|成片)/u.test(instructionText)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /^(?:请|麻烦)?(?:帮我)?(?:把|将)[\s\S]{0,20}(?:刚|已|已经|先前|之前)?(?:生成|创建|制作|产出)[\s\S]{0,20}(?:图片|图像|视频|短视频|短片|动画|成片)[\s\S]{0,24}(?:查看|打开|删除|分析|检查|编辑|修改|发布|上传|发送|保存|下载|分享|播放)/u.test(instructionText)
    || /^\s*(?:please\s+)?(?:view|open|delete|analy[sz]e|inspect|check|edit|modify|publish|upload|send|save|download|share|play)\b[\s\S]{0,48}\b(?:generated|created|rendered)\b[\s\S]{0,24}\b(?:image|picture|video|clip|animation|movie)\b/i.test(instructionText)
  );
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const requestsCombinedVideoArtifact = /(?:脚本[\s\S]{0,40}(?:再|然后|并|以及|同时)[\s\S]{0,30}(?:生成|创建|制作|产出)[\s\S]{0,24}(?:视频|短视频|成片)|脚本[\s\S]{0,24}(?:和|并|以及|同时)[\s\S]{0,16}(?:视频|短视频|成片))/u.test(instructionText)
    || /\b(?:script|copy|outline|prompt)\b[\s\S]{0,48}\b(?:and\s+then|then|and)\b[\s\S]{0,32}\b(?:generate|create|make|produce|render)\b[\s\S]{0,24}\b(?:video|clip|movie)\b/i.test(instructionText);
  const mediaTextDeliverableOnly = !structuredMediaCategory && !requestsCombinedVideoArtifact && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:请|麻烦)?(?:帮我)?(?:生成|创建|制作|编写|写)[\s\S]{0,40}(?:图片|图像|海报|封面|视频|短视频|动画)[\s\S]{0,16}(?:提示词|文案|脚本|大纲|方案|字幕|标题|文字|旁白|分镜)/u.test(instructionText)
    || /^\s*(?:please\s+)?(?:generate|create|make|produce|write)\b[\s\S]{0,52}\b(?:copy|brief|prompt|script|outline|plan|subtitles?|titles?|caption|text|narration|storyboard)\b[\s\S]{0,52}\b(?:image|picture|poster|cover|thumbnail|video|clip|movie|animation|short\s+film|reel)\b/i.test(instructionText)
    || /^\s*(?:please\s+)?(?:generate|create|make|produce|write)\b[\s\S]{0,52}\b(?:image|picture|poster|cover|thumbnail|video|clip|movie|animation|short\s+film|reel)\b[\s\S]{0,32}\b(?:copy|brief|prompt|script|outline|plan|subtitles?|titles?|caption|text|narration|storyboard)\b/i.test(instructionText)
  );
  const mediaCodeOrOfficeDeliverable = !structuredMediaCategory
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    && /(?:CSS|HTML|JavaScript|TypeScript|React|Vue|PPT|PowerPoint|组件|网页|页面|幻灯片|演示文稿|播放器|画廊|上传组件)/iu.test(instructionText)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    && /(?:图片|图像|视频|动画|image|video|animation|gallery|player)/iu.test(instructionText);
  const mediaGenerationShouldBeForbidden = mediaGenerationExplicitlyNegated
    || mediaGenerationMetaQuestion
    || existingMediaArtifactAction
    || mediaTextDeliverableOnly
    || mediaCodeOrOfficeDeliverable;

  if (!currentAppEdit) {
    for (const name of BASELINE_TOOLS) addIfAvailable(selected, available, name);
  }

  for (const route of ROUTES) {
    if (currentAppEdit) continue;
    // The media workbench emits a structured first line. Treat that explicit
    // envelope as authoritative even when the creative brief mentions CAD,
    // music, legal work, or another broad domain keyword.
    if (structuredMediaCategory && route.category !== structuredMediaCategory) continue;
    const matchesTrustedCadContinuation = route.category === 'cad_design'
      && trustedCadContinuation;
    if (!routeMatches(route, instructionText) && !matchesTrustedCadContinuation) continue;
    if (
      explicitArtifactCreation
      && ['messaging', 'client_surface', 'desktop_launch'].includes(route.category)
    ) continue;
    if (
      route.category === 'work_takeover'
      && recoveredApplicationContinuation
      && !hasPersistentTaskCenterEvidence(instructionText)
    ) continue;
    if (
      route.category === 'messaging' &&
      !hasNamedMessagingSurface(instructionText) &&
      !['messaging_read', 'messaging_send'].includes(actionContract.kind)
    ) continue;
    if (route.category === 'messaging' && hasNegatedMessagingSendIntent(instructionText) && !hasNamedMessagingSurface(instructionText) && !confirmationOnlyExternalCommit) continue;
    if (route.category === 'messaging' && isDesktopAiRequest(instructionText) && !hasNamedMessagingSurface(instructionText)) continue;
    if (
      route.category === 'documents' &&
      isDesktopAiRequest(instructionText) &&
      !/(?:文件|文档|表格|幻灯片|导出|保存|PPT|PDF|DOCX|XLSX|document|file|spreadsheet|presentation|export|save)/iu.test(instructionText)
    ) continue;
    if (route.category === 'documents' && isDirectAutocadOperationsPlayback(instructionText)) continue;
    if (
      route.category === 'video_generation'
      && categories.includes('image_generation')
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      && /(?:视频|短视频|video|clip|movie)[\s\S]{0,36}(?:封面|主图|缩略图|海报|图片|图像|cover|thumbnail|poster|image|picture)|(?:封面|主图|缩略图|海报|图片|图像|cover|thumbnail|poster|image|picture)[\s\S]{0,36}(?:来自|根据|用于|for|from)[\s\S]{0,20}(?:视频|短视频|video|clip|movie)/iu.test(instructionText)
    ) continue;
    if (route.category === 'image_generation' || route.category === 'video_generation') {
      if (mediaGenerationShouldBeForbidden) continue;
      // The studio's structured envelope deliberately exposes one generator.
      // Natural compound instructions retain later document/upload routes.
      if (structuredMediaCategory) {
        selected.clear();
        for (const name of BASELINE_TOOLS) addIfAvailable(selected, available, name);
        categories.splice(0, categories.length);
        reasons.splice(0, reasons.length);
        manifestPriorities.splice(0, manifestPriorities.length);
      }
    }
    if (
      route.category === 'cad_design'
      && !structuredMediaCategory
      && (categories.includes('image_generation') || categories.includes('video_generation'))
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      && !/(?:CAD|DXF|DWG|AutoCAD|平面图|户型|施工图|水电|布置图|工程图|图纸|蓝图|立面图|剖面图|零件图|电气原理图|结构详图|管线图|\b(?:cad|dxf|dwg|autocad|floor\s*plan|blueprint|construction\s+drawing|elevation\s+drawing|section\s+drawing|mechanical\s+(?:part\s+)?drawing|electrical\s+schematic|structural\s+detail|piping\s+diagram)\b)/iu.test(instructionText)
    ) continue;
    categories.push(route.category);
    reasons.push(route.reason);

    for (const group of route.groups || []) {
      manifestPriorities.push(...addGroup(selected, available, group, routingManifest));
    }
    for (const name of route.exact || []) addIfAvailable(selected, available, name);
    for (const prefix of route.prefixes || []) addPrefix(selected, availableNames, prefix);
    for (const pattern of route.namePatterns || []) addNamePattern(selected, availableNames, pattern);
  }

  const directMediaGeneration = categories.includes('image_generation')
    || categories.includes('video_generation');
  if (actionContract.applies && !currentAppEdit && !directMediaGeneration) {
    manifestPriorities.push(...addActionContractCapabilities(
      selected,
      available,
      actionContract,
      routingManifest,
    ));
  } else if (directMediaGeneration) {
    reasons.push('direct media generation keeps the tool envelope on the selected image or video generator');
  }

  // Add this before the restrictive route branches below.  Those branches
  // (status, cancellation, read-only inspection, active-document anchoring,
  // and confirmation) are authoritative and may clear it; ordinary
  // corrections/retries retain the proven read/retry tools instead of losing
  // them to semantic rerouting of the replacement wording.
  if (continuationEvidenceTools.length && !currentAppEdit) {
    for (const name of continuationEvidenceTools) addIfAvailable(selected, available, name);
  }

  if (actionContract.kind === 'messaging_read') {
    for (const entry of routingManifest) {
      const externalCommit = entry.operation === 'communicate'
        || /(?:send|reply|post|publish|upload|submit|message_file)/i.test(entry.toolName);
      if (entry.lane === 'messaging' && externalCommit) {
        selected.delete(entry.toolName);
        forbiddenToolNames.add(entry.toolName);
      }
    }
    reasons.push('message reading hard-forbids every messaging capability with external side effects');
  }

  if (
    actionContract.kind === 'desktop_operation'
    && categories.includes('messaging')
    && hasNamedMessagingSurface(instructionText)
    && !isDirectMessagingSend(instructionText)
  ) {
    for (const entry of routingManifest) {
      const externalCommit = entry.operation === 'communicate'
        || /(?:send|reply|post|publish|upload|submit|message_file)/i.test(entry.toolName);
      if (entry.lane === 'messaging' && externalCommit) {
        selected.delete(entry.toolName);
        forbiddenToolNames.add(entry.toolName);
      }
    }
    reasons.push('opening a messaging surface without send intent hard-forbids messaging side effects');
  }

  if (readOnlyKnowledgeInspection && !currentAppEdit) {
    selected.clear();
    addIfAvailable(selected, available, 'knowledge_file_stats');
    addIfAvailable(selected, available, 'knowledge_coverage_report');
    categories.splice(0, categories.length, 'knowledge');
    reasons.push('read-only knowledge inventory is isolated from client, system, document, and mutation routes');
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (confirmationOnlyExternalCommit && !currentAppEdit) {
    selected.clear();
    addIfAvailable(selected, available, 'wechat_send_message');
    categories.splice(0, categories.length, 'messaging');
    reasons.push('confirmation-only external messaging exposes only the exact send adapter, which must stop at the confirmation gate');
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (currentAppEdit) {
    categories.push('external_control');
    reasons.push(recoveredCurrentAppEdit
      ? 'the current turn edits inside the application recovered from a successful desktop_open receipt'
      : 'the current turn explicitly opens and edits inside a named authoring application');
    manifestPriorities.push(...addGroup(selected, available, 'currentAppControl', routingManifest));
    addIfAvailable(selected, available, 'wps_create_document_with_text');
  } else if (recoveredApplicationContinuation) {
    categories.push('external_control');
    reasons.push('the current turn continues inside the application recovered from a successful desktop_open receipt');
    manifestPriorities.push(...addGroup(selected, available, 'externalControl', routingManifest));
  }

  if (actionContract.kind === 'desktop_operation' && !currentAppEdit) {
    addIfAvailable(selected, available, 'desktop_list_apps');
    addIfAvailable(selected, available, 'desktop_open');
    addIfAvailable(selected, available, 'desktop_active_window');
    for (const name of actionContract.preferredTools) addIfAvailable(selected, available, name);
    reasons.push('explicit open request requires the same launch tool used by the deterministic fast path');
  }

  if (actionContract.kind === 'external_ai_request' && !currentAppEdit) {
    for (const name of actionContract.preferredTools) addIfAvailable(selected, available, name);
    if (!categories.includes('external_control')) categories.push('external_control');
    reasons.push('external AI is exposed as one bounded LumiCore tool target');
  }

  if (actionContract.kind === 'external_ai_history' && !currentAppEdit) {
    for (const name of actionContract.preferredTools) addIfAvailable(selected, available, name);
    if (!categories.includes('external_control')) categories.push('external_control');
    reasons.push('external AI history uses only the persistent authorization, synchronization, and local query pipeline');
    for (const submitTool of ['desktop_ai_ask']) {
      selected.delete(submitTool);
      forbiddenToolNames.add(submitTool);
    }
    reasons.push('history reads hard-forbid every external AI prompt-submission entry');
  }

  if (currentAuthoringDocumentInspection && !currentAppEdit) {
    selected.clear();
    addIfAvailable(selected, available, 'desktop_running_processes');
    addIfAvailable(selected, available, 'desktop_active_window');
    // Discovery/read tools are visible up front so one model turn can finish
    // after a unique native window observation. The shared target-anchor
    // preflight still blocks every file call until that exact observation is
    // present, and then binds reads to the one bounded search result.
    for (const name of [
      'desktop_list_files',
      'search_files',
      'desktop_path_info',
      'read_file',
      'extract_document_text',
      'read_pdf',
      'read_docx',
      'read_xlsx',
    ]) addIfAvailable(selected, available, name);
    categories.splice(0, categories.length, 'current_document_inspection');
    reasons.splice(
      0,
      reasons.length,
      trustedCurrentDocumentReadAnchor
        ? 'a server-owned authoring-window anchor permits bounded discovery and read-only document extraction'
        : 'current-document inspection first observes native background WPS/Office document candidates; shared preflight permits bounded discovery and reading only after one exact candidate is anchored',
    );
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (documentOpenAndReview && !currentAppEdit) {
    selected.clear();
    for (const name of [
      'desktop_list_files',
      'search_files',
      'desktop_path_info',
      'desktop_open',
      'desktop_active_window',
      'read_pdf',
      'read_docx',
      'read_xlsx',
      'extract_document_text',
    ]) addIfAvailable(selected, available, name);
    categories.splice(0, categories.length, 'document_open_and_review');
    reasons.splice(0, reasons.length, 'document presentation requires exact file discovery, opening, content extraction, and visible-target verification');
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (desktopLaunchRequest && !currentAppEdit) {
    selected.clear();
    // A compound "open X, then verify the active window" prompt can make the
    // contract's observation branch prefer only desktop_active_window. Keep
    // the exact launch actuator as the core step and the active-window read as
    // its verifier; neither step is optional.
    for (const name of actionContract.preferredTools) addIfAvailable(selected, available, name);
    if (!selected.has('browser_open_task')) addIfAvailable(selected, available, 'desktop_open');
    addIfAvailable(selected, available, 'desktop_active_window');
    categories.splice(0, categories.length, 'desktop_launch');
    reasons.splice(
      0,
      reasons.length,
      'a launch-only request uses the exact target resolver and verification tools without unrelated production capabilities',
    );
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (runtimeWorkIntent !== 'none' || actionContract.kind === 'task_control') {
    const exactTool = runtimeWorkIntent === 'cancel'
      ? 'runtime_work_cancel'
      : 'runtime_work_status';
    selected.clear();
    addIfAvailable(selected, available, exactTool);
    categories.splice(0, categories.length, 'task_control');
    reasons.splice(
      0,
      reasons.length,
      'runtime work status and cancellation use one exact unified-ledger tool without shell, process-list, or database fallbacks',
    );
    manifestPriorities.unshift(exactTool);
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (extensionRegistryOnly) {
    selected.clear();
    for (const name of [...actionContract.preferredTools, ...actionContract.verificationTools]) {
      addIfAvailable(selected, available, name);
    }
    categories.splice(0, categories.length, 'extension_registry');
    reasons.splice(0, reasons.length, 'signed extension and Provider operations use only the transactional registry and its persistent receipts');
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (categories.length === 0 && instructionText) {
    const ranked = declarations
      .map(declaration => ({ name: declaration.function.name, score: scoreDeclaration(instructionText, declaration) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
    for (const item of ranked) selected.add(item.name);
    if (ranked.length > 0) {
      categories.push('lexical_match');
      reasons.push('tool names/descriptions matched the user wording');
    }
  }

  if (!currentAppEdit && isDirectAutocadOperationsPlayback(instructionText)) {
    for (const entry of routingManifest) {
      if (entry.lane === 'office') selected.delete(entry.toolName);
    }
    addIfAvailable(selected, available, 'mcp_cad-drafting_autocad_playback_file');
    reasons.push('existing AutoCAD operations are played only through MCP/COM');
  }

  if (!currentAppEdit && requestsBlankAutoCadDocument(instructionText)) {
    selected.clear();
    addIfAvailable(selected, available, 'mcp_cad-drafting_autocad_new_document');
    reasons.push('blank AutoCAD document requests use the dedicated COM document tool and never synthesize geometry');
  } else if (!currentAppEdit && requiresVisibleAutoCadExecution(instructionText)) {
    if (!requestsExplicitCadFileExport(instructionText)) selected.delete('cad_generate_dxf');
    selected.delete('mcp_cad-drafting_cad_renovation_folder_workflow');
    addIfAvailable(selected, available, 'desktop_list_apps');
    addIfAvailable(selected, available, 'desktop_open');
    addIfAvailable(selected, available, 'desktop_running_processes');
    addIfAvailable(selected, available, 'desktop_active_window');
    addIfAvailable(selected, available, 'cad_prepare_autocad_operations');
    addIfAvailable(selected, available, 'mcp_cad-drafting_autocad_playback_file');
    reasons.push('visible AutoCAD execution requires MCP/COM playback and excludes generated-file or script fallback');
    reasons.push('the fixed capability envelope also keeps application discovery, open, and recovery available');
  }

  if (!currentAppEdit && localCadImageSourceRequest) {
    for (const name of LOCAL_CAD_GENERIC_READER_TOOLS) selected.delete(name);
    for (const name of Array.from(selected)) {
      if (LOCAL_CAD_SOURCE_FORBIDDEN_TOOL_RE.test(name)) selected.delete(name);
    }
    addIfAvailable(selected, available, 'desktop_list_files');
    addIfAvailable(selected, available, 'desktop_path_info');
    addIfAvailable(selected, available, 'floorplan_extract_geometry');
    addIfAvailable(selected, available, 'ocr_image_file');
    reasons.push('local desktop CAD images must use the built-in desktop discovery and image OCR/geometry path; project-scoped MCP filesystem and shell/base64 fallbacks are excluded');
    if (requiresVisibleAutoCadExecution(instructionText) && available.has('cad_draw_floorplan_in_autocad')) {
      selected.clear();
      addIfAvailable(selected, available, 'cad_draw_floorplan_in_autocad');
      reasons.push('one composite CAD skill owns discovery, calibration, verified geometry, AutoCAD playback, resume, and acceptance for local floor-plan drawing');
    }
  }

  if (!currentAppEdit && cadGeometryExtractionOnly) {
    selected.clear();
    for (const name of availableNames) {
      if (isCadGeometryExtractionAllowedTool(name)) {
        selected.add(name);
      }
    }
    for (const name of availableNames) {
      if (CAD_GEOMETRY_EXTRACTION_FORBIDDEN_TOOL_RE.test(name)) {
        forbiddenToolNames.add(name);
      }
    }
    reasons.push('geometry-extraction-only requests use a hard read/observe allowlist and cannot generate files or operate AutoCAD');
  }

  if (desktopObservationOnly) {
    selected.clear();
    for (const name of desktopObservationToolNames) {
      if (name === 'desktop_active_window') {
        if (available.has('desktop_active_window')) {
          selected.add('desktop_active_window');
        } else {
          addIfAvailable(selected, available, 'get_active_window_info');
        }
        continue;
      }
      addIfAvailable(selected, available, name);
    }
    categories.splice(0, categories.length, 'desktop_observation');
    reasons.splice(
      0,
      reasons.length,
      'pure desktop observation uses only the exact read-only window and desktop-directory tools requested',
    );
    for (const name of availableNames) {
      if (!selected.has(name)) forbiddenToolNames.add(name);
    }
  }

  if (compoundModeAction) {
    addIfAvailable(selected, available, 'client_get_state');
    addIfAvailable(selected, available, 'client_action');
    categories.push('client_surface');
    reasons.push('a compound mode-and-work request needs both client mode control and the task tools selected for the remaining instruction');
  }

  if (mediaGenerationShouldBeForbidden) {
    const mediaGeneratorName = /^(?:generate_image(?:_dalle)?|ai_edit_image|generate_video|mcp_.+_(?:generate|create)_(?:image|video))$/i;
    for (const name of availableNames) {
      if (!mediaGeneratorName.test(name)) continue;
      selected.delete(name);
      forbiddenToolNames.add(name);
    }
    reasons.push('media generation is hard-forbidden for negation, configuration questions, text-only requests, and actions on existing artifacts');
  }

  if (
    runtimeWorkIntent === 'none'
    && isRuntimeCleanupOfferAcceptanceText(instructionText)
  ) {
    // A referential "clean them" utterance has no cancellation authority on
    // its own. Without a validated adjacent offer it may be clarified by the
    // model, but runtime work mutation stays unavailable.
    selected.delete('runtime_work_cancel');
    forbiddenToolNames.add('runtime_work_cancel');
    reasons.push('referential cleanup has no valid adjacent assistant offer; runtime cancellation remains fail-closed');
  }

  const orderedBeforeHealthGate = applyRoutePriority(
    availableNames.filter(name => selected.has(name)),
    unique([
      ...continuationEvidenceTools,
      ...(currentAuthoringDocumentInspection
        ? ['desktop_running_processes', 'desktop_active_window']
        : []),
      ...priorityToolsForRoute(categories, text),
      ...manifestPriorities,
    ]),
  );
  const connectedMcpGate = getConnectedMcpGate(options);
  const unavailableMcpServers: string[] = [];
  const ordered = connectedMcpGate
    ? orderedBeforeHealthGate.filter(name => {
        const serverName = getMcpServerName(name, options?.capabilityManifest);
        if (!serverName) return true;
        if (connectedMcpGate.has(serverName)) return true;
        unavailableMcpServers.push(serverName);
        return false;
      })
    : orderedBeforeHealthGate;

  if (unavailableMcpServers.length) {
    reasons.push(`MCP health gate skipped unavailable servers: ${unique(unavailableMcpServers).join(', ')}`);
  }

  const truncated = ordered.length > maxTools;
  return {
    toolNames: ordered.slice(0, maxTools),
    categories: unique(categories),
    reasons: unique(reasons),
    totalAvailable: declarations.length,
    maxTools,
    truncated,
    unavailableMcpServers: unique(unavailableMcpServers),
    hardAllowlist: desktopObservationOnly
      || readOnlyKnowledgeInspection
      || confirmationOnlyExternalCommit
      || currentAuthoringDocumentInspection
      || documentOpenAndReview
      || desktopLaunchRequest
      || cadGeometryExtractionOnly
      || extensionRegistryOnly
      || runtimeWorkIntent !== 'none'
      || actionContract.kind === 'task_control'
      || selected.has('cad_draw_floorplan_in_autocad')
      || undefined,
    forbiddenToolNames: forbiddenToolNames.size > 0
      ? Array.from(forbiddenToolNames)
      : undefined,
    maxIterations: selected.has('cad_draw_floorplan_in_autocad')
      ? 2
      : Boolean(structuredMediaCategory)
      ? 1
      : readOnlyKnowledgeInspection
      ? Math.max(2, selected.size)
      : confirmationOnlyExternalCommit
      ? 1
      : currentAuthoringDocumentInspection || documentOpenAndReview
      ? Math.max(3, selected.size)
      : desktopLaunchRequest
      ? Math.max(2, selected.size)
      : desktopObservationOnly
      ? desktopObservationToolNames.length + 1
      : extensionRegistryOnly
      ? Math.max(2, selected.size)
      : runtimeWorkIntent !== 'none' || actionContract.kind === 'task_control'
      ? 1
      : undefined,
  };
}

export function mergeToolPolicyWithRoute(policy: ToolPolicy, route: ToolRoute): ToolPolicy {
  const routeAllowed = new Set(route.toolNames);
  const baseAllowed = new Set(policy.allowedTools || []);
  const routeForbidden = new Set(route.forbiddenToolNames || []);
  const allowedTools = baseAllowed.has('*')
    ? route.toolNames.filter(name => !routeForbidden.has(name))
    : route.toolNames.filter(name => baseAllowed.has(name) && !routeForbidden.has(name));

  return {
    ...policy,
    allowedTools,
    forbiddenTools: unique([
      ...(policy.forbiddenTools || []),
      ...routeForbidden,
    ]),
    maxIterations: route.maxIterations === undefined
      ? policy.maxIterations
      : Math.max(0, Math.min(policy.maxIterations ?? route.maxIterations, route.maxIterations)),
  };
}

export function formatToolRouteForPrompt(route: ToolRoute): string {
  const categories = route.categories.length ? route.categories.join(', ') : 'none';
  const reasons = route.reasons.length ? route.reasons.join('; ') : 'no specific route matched';
  return [
    '## Skill and Tool Routing',
    `This turn exposes ${route.toolNames.length}/${route.totalAvailable} tools to reduce tool noise.`,
    `Selected categories: ${categories}.`,
    `Routing reason: ${reasons}.`,
    route.unavailableMcpServers?.length
      ? `MCP health gate skipped unavailable servers: ${route.unavailableMcpServers.join(', ')}. Use a connected fallback or repair/configure the skill before relying on it.`
      : '',
    route.toolNames.length > 0
      ? `Use only the exposed tools. Prefer the most specific skill tool when one directly matches the task.`
      : 'No tool matched strongly. Answer naturally or ask one clarification question instead of inventing tool work.',
    route.hardAllowlist
      ? route.toolNames.includes('cad_draw_floorplan_in_autocad')
        ? 'This route is a hard allowlist for one composite CAD skill. Call only cad_draw_floorplan_in_autocad; it owns source discovery, calibration, geometry verification, visible AutoCAD playback, resume, and final acceptance internally.'
        : route.categories.includes('desktop_launch')
        ? 'This route is a hard allowlist for launching or focusing the exact requested target and verifying the resulting window/process. Do not start unrelated work inside the application.'
        : route.categories.includes('desktop_observation')
        ? 'This route is a hard allowlist for read-only desktop observation. Call only the selected window/directory observation tools. Do not write files or substitute list_directory, search_files, grep_files, filesystem MCP, shell, or Python tools.'
        : route.categories.includes('current_document_inspection')
        ? 'For current-document inspection, call desktop_running_processes first and inspect only its supported WPS/Microsoft Office window titles. If exactly one document candidate exists, resolve that exact filename only through bounded Desktop/Documents/Downloads discovery and read only the one matching path. If the background result is empty, untitled, or ambiguous, call desktop_active_window once; continue only when it identifies one exact supported document, otherwise ask the user to focus the intended document. Never guess from process presence, unrelated windows, or multiple candidates.'
        : route.categories.includes('extension_registry')
        ? 'This route is a hard allowlist for the signed extension registry. Do not substitute skill generation, package installation, shell execution, or arbitrary plugin code.'
        : 'This route is a hard allowlist. Do not generate files, prepare CAD operations, open or operate AutoCAD, or substitute any filesystem MCP, shell, or Python fallback.'
      : '',
  ].filter(Boolean).join('\n');
}
