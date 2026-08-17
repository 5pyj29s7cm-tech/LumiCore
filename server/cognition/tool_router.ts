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
import { mcpManager } from '../mcp/client';
import {
  buildActionContract,
  extractDesktopLaunchTarget,
  isSimpleDesktopOpenRequest,
  requestsBlankAutoCadDocument,
  requiresExternalAiHistory,
  requiresCurrentAppUiMutation,
  requiresCadGeometryExtractionOnly,
  requiresVisibleAutoCadExecution,
} from './action_contract';
import { isRecoveredCurrentAppEditingContinuation } from './action_continuation';
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function routeMatches(route: RouteDefinition, text: string): boolean {
  return route.patterns.some(pattern => pattern.test(text));
}

function addIfAvailable(out: Set<string>, available: Set<string>, name: string): void {
  if (available.has(name)) out.add(name);
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
  skills: ['agents', 'client'],
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

function isDesktopAiCollaboration(text: string): boolean {
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

function isCurrentAuthoringDocumentInspection(text: string): boolean {
  const hasAuthoringApp = /(?:WPS|Microsoft\s+Word|Word|Excel|PowerPoint|Office)/iu.test(text);
  // i18n-allow: Reviewed multilingual current-document input recognition; not user-visible copy.
  const hasCurrentDocument = /(?:现在|当前|正在).{0,18}(?:打开|编辑|显示).{0,18}(?:这份|这个|该)?(?:文件|文档|表格|幻灯片|PPT|PDF)|(?:打开|编辑|显示)(?:着|的).{0,12}(?:这份|这个|该)?(?:文件|文档|表格|幻灯片|PPT|PDF)/u.test(text);
  // i18n-allow: Reviewed multilingual document-inspection input recognition; not user-visible copy.
  const wantsInspection = /(?:分析|总结|介绍|讲解|读取|阅读|看看|看一下|看法|想法|检查)|\b(?:analy[sz]e|summari[sz]e|review|inspect|read|present)\b/iu.test(text);
  return hasAuthoringApp && hasCurrentDocument && wantsInspection;
}

function isDocumentOpenAndReviewRequest(text: string): boolean {
  // i18n-allow: Reviewed multilingual negative open/launch input recognition; not user-visible copy.
  if (/(?:不要|别|禁止|无需).{0,18}(?:打开|启动)|\b(?:do\s+not|don't|never|without)\b.{0,28}\b(?:open|launch)\b/iu.test(text)) return false;
  // i18n-allow: Reviewed multilingual open/launch input recognition; not user-visible copy.
  const wantsOpen = /(?:打开|启动)|\b(?:open|launch)\b/iu.test(text);
  // i18n-allow: Reviewed multilingual document-type input recognition; not user-visible copy.
  const hasDocument = /(?:PDF|DOCX|PPTX?|XLSX?|文件|文档|报告|介绍)|\b(?:pdf|docx?|pptx?|xlsx?|file|document)\b/iu.test(text);
  // i18n-allow: Reviewed multilingual review/read input recognition; not user-visible copy.
  const wantsReview = /(?:分析|总结|介绍|讲解|读取|阅读|逐页|一页一页|看一下|看看)|\b(?:analy[sz]e|summari[sz]e|review|read|present|walk\s+through)\b/iu.test(text);
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
  if (requestsBlankAutoCadDocument(text)) {
    priorities.push('mcp_cad-drafting_autocad_new_document');
  }
  if (categories.includes('desktop_observation')) {
    priorities.push(...buildDesktopObservationPlan(text).map(call => call.name));
  }
  if (isRecoveredCurrentAppEditingContinuation(text)) {
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
  if (isDirectAutocadOperationsPlayback(text)) {
    priorities.push('mcp_cad-drafting_autocad_playback_file');
  }
  if (isDesktopAiCollaboration(text)) {
    const wantsCollectedComparison = /(?:\u603b\u7ed3|\u6c47\u603b|\u5bf9\u6bd4|\u90fd\u62ff\u56de\u6765|\u6240\u6709\u56de\u7b54|summari[sz]e|compare|collect\s+all|all\s+answers)/iu.test(text);
    priorities.push(
      'external_ai_collaborate',
      ...(wantsCollectedComparison ? ['external_ai_collect_answers'] : []),
      'external_ai_session_status',
      'external_ai_route_plan',
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
    const isFileTransfer = /(?:文件|附件|材料|文书|图纸|file|attachment).*(?:发送|发给|转发|传到|传给|send|forward|transfer)|(?:发送|发给|转发|传到|传给|send|forward|transfer).*(?:文件|附件|材料|文书|图纸|file|attachment)/iu.test(text);
    if (isFileTransfer) {
      priorities.push(
        'messaging_list_file_targets',
        'feishu_send_file',
        'wechat_send_file',
        'desktop_open',
        'desktop_active_window',
      );
    } else if (isMessagingRead(text)) {
      priorities.push(
        'wechat_read_recent_chat',
        'desktop_open',
        'desktop_active_window',
        'desktop_ui_snapshot',
        'desktop_capture_screen',
        'ocr_screen',
      );
    } else if (isDirectMessagingSend(text)) {
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
    if (isLocalCadSourceRequest(text)) {
      const localCadSourceTools = requiresVisibleAutoCadExecution(text)
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
    if (/现行有效|法源|法条核验|引用核验|法律版本|司法解释版本|current\s+law|authority\s+source|citation\s+verification/i.test(text)) {
      priorities.push(
        'legal_authority_source_status',
        'legal_refresh_authoritative_sources',
        'legal_verify_citation',
        'legal_generate_citation_verification_report',
        'legal_finalize_delivery_package',
      );
    }
    if (/案件文件夹|材料文件夹|文件夹.*(?:代理词|证据目录|委托书|起诉状|答辩状)|读取.*(?:案件|材料).*文件夹|case\s*folder|legal\s*folder/i.test(text)) {
      priorities.push(
        'mcp_legal-casework_legal_case_folder_workflow',
        'legal_analyze_folder_and_draft_argument',
        'read_file',
        'extract_document_text',
        'web_login_run',
        'url_fetch_logged_in',
      );
    }
    if (/(?:飞书|微信|企业微信|企微|短信|远程消息|Lumi\s*bot|机器人).*(?:入案|归档|保存|案件|案号|材料|法院|通知|短信链接|通知链接|链接)|(?:入案|归档|保存).*(?:飞书|微信|企业微信|企微|短信|远程消息|案件材料|法院通知|短信链接|通知链接)|(?:court\s+notice|notice\s+link|sms\s+link|message\s+intake)/i.test(text)) {
      priorities.push(
        'legal_message_intake_to_case',
        'legal_process_notice_link',
        'legal_download_and_extract_document',
        'legal_case_workflow_status',
        'legal_case_workspace',
        'legal_import_materials_to_kb',
      );
    }
    if (/合同审查|合同模板|合同起草|审查合同|起草合同|标书|投标|招标|bid|tender|contract\s+(review|draft)/i.test(text)) {
      priorities.push(
        'legal_review_contract',
        'legal_draft_contract',
        'legal_generate_bid',
      );
    }
    if (/财产线索|被执行人|执行线索|财产保全|诉前保全|股权穿透|实际控制人|关联企业|失信|限制消费|asset|enforcement|equity|shareholder/i.test(text)) {
      priorities.push(
        'legal_trace_assets',
        'legal_equity_penetration',
        'legal_company_database_lookup',
      );
    }
    if (/下一步|下.?一步|缺什么|还缺|完成度|闭环|状态|进度|能不能.*(交付|立案|起草)|case\s*(status|progress|next)|what.*next/i.test(text)) {
      priorities.push(
        'legal_case_workflow_status',
        'legal_case_workspace',
      );
    }
    if (/\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1|\u6cd5\u5f8b\u610f\u89c1|\u8bc9\u72b6|\u6587\u4e66|\u8bc9\u8bbc\u6750\u6599|argument|opinion|complaint|defense|pleading/i.test(text)) {
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

function getMcpServerName(toolName: string): string | null {
  const match = toolName.match(/^mcp_(.+?)_/);
  return match?.[1] || null;
}

function getConnectedMcpGate(options?: {
  connectedMcpServers?: string[];
  enableMcpHealthGate?: boolean;
}): Set<string> | null {
  if (options?.enableMcpHealthGate === false) return null;
  if (options?.connectedMcpServers) return new Set(options.connectedMcpServers);
  try {
    const connected = mcpManager.getRoutableServers();
    // In isolated tests or before MCP startup, no runtime signal exists. Do not
    // hide synthetic MCP declarations unless the caller provided an explicit gate.
    return connected.length ? new Set(connected) : null;
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
  options?: {
    maxTools?: number;
    connectedMcpServers?: string[];
    enableMcpHealthGate?: boolean;
    capabilityManifest?: CapabilityManifestEntry[];
  },
): ToolRoute {
  const maxTools = Math.max(8, Math.min(options?.maxTools ?? 64, 80));
  const text = String(userText || '').trim();
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
  const manifestPriorities: string[] = [];
  const actionContract = buildActionContract(text);
  const explicitArtifactCreation = isExplicitArtifactCreationText(text);
  const readOnlyKnowledgeInspection = isReadOnlyKnowledgeBaseInspectionRequest(text);
  const confirmationOnlyExternalCommit = actionContract.kind === 'messaging_send'
    && isExternalCommitConfirmationOnlyRequest(text);
  const recoveredApplicationContinuation = isRecoveredApplicationContinuation(text);
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(text);
  const currentAppEdit = recoveredCurrentAppEdit
    || (actionContract.kind === 'desktop_operation' && requiresCurrentAppUiMutation(text));
  const requestedMode = detectRequestedOperationMode(text);
  const compoundModeAction = Boolean(
    requestedMode && !isPureOperationModeSwitchRequest(text, requestedMode),
  );
  const localCadSourceRequest = isLocalCadSourceRequest(text);
  const localCadImageSourceRequest = isLocalCadImageSourceRequest(text);
  const cadGeometryExtractionOnly = requiresCadGeometryExtractionOnly(text);
  const currentAuthoringDocumentInspection = isCurrentAuthoringDocumentInspection(text);
  const documentOpenAndReview = !currentAuthoringDocumentInspection
    && !localCadSourceRequest
    && actionContract.kind !== 'design_delivery'
    && actionContract.kind !== 'desktop_operation'
    && isDocumentOpenAndReviewRequest(text);
  const desktopObservationToolNames = currentAppEdit
    ? []
    : strictDesktopObservationToolNames(text, actionContract.kind);
  const desktopObservationOnly = desktopObservationToolNames.length > 0;
  const desktopLaunchRequest =
    actionContract.kind === 'desktop_operation'
    && Boolean(extractDesktopLaunchTarget(text))
    && !documentOpenAndReview
    && !isDirectAutocadOperationsPlayback(text);
  const extensionRegistryOnly = actionContract.kind === 'extension_registry';
  const forbiddenToolNames = new Set<string>();

  if (!currentAppEdit) {
    for (const name of BASELINE_TOOLS) addIfAvailable(selected, available, name);
  }

  for (const route of ROUTES) {
    if (currentAppEdit) continue;
    if (!routeMatches(route, text)) continue;
    if (
      explicitArtifactCreation
      && ['messaging', 'client_surface', 'desktop_launch'].includes(route.category)
    ) continue;
    if (
      route.category === 'work_takeover'
      && recoveredApplicationContinuation
      && !hasPersistentTaskCenterEvidence(text)
    ) continue;
    if (
      route.category === 'messaging' &&
      !hasNamedMessagingSurface(text) &&
      !['messaging_read', 'messaging_send'].includes(actionContract.kind)
    ) continue;
    if (route.category === 'messaging' && hasNegatedMessagingSendIntent(text) && !hasNamedMessagingSurface(text) && !confirmationOnlyExternalCommit) continue;
    if (route.category === 'messaging' && isDesktopAiCollaboration(text) && !hasNamedMessagingSurface(text)) continue;
    if (
      route.category === 'documents' &&
      isDesktopAiCollaboration(text) &&
      !/(?:文件|文档|表格|幻灯片|导出|保存|PPT|PDF|DOCX|XLSX|document|file|spreadsheet|presentation|export|save)/iu.test(text)
    ) continue;
    if (route.category === 'documents' && isDirectAutocadOperationsPlayback(text)) continue;
    categories.push(route.category);
    reasons.push(route.reason);

    for (const group of route.groups || []) {
      manifestPriorities.push(...addGroup(selected, available, group, routingManifest));
    }
    for (const name of route.exact || []) addIfAvailable(selected, available, name);
    for (const prefix of route.prefixes || []) addPrefix(selected, availableNames, prefix);
    for (const pattern of route.namePatterns || []) addNamePattern(selected, availableNames, pattern);
  }

  if (actionContract.applies && !currentAppEdit) {
    manifestPriorities.push(...addActionContractCapabilities(
      selected,
      available,
      actionContract,
      routingManifest,
    ));
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

  if (actionContract.kind === 'external_ai_collaboration' && !currentAppEdit) {
    for (const name of actionContract.preferredTools) addIfAvailable(selected, available, name);
    if (!categories.includes('external_control')) categories.push('external_control');
    reasons.push('external AI collaboration uses one persistent route-priority and receipt pipeline');
    if (available.has('external_ai_collaborate')) {
      for (const legacy of ['desktop_ai_ask', 'desktop_ai_roundtable', 'desktop_ai_collect_answer']) {
        selected.delete(legacy);
        forbiddenToolNames.add(legacy);
      }
      reasons.push('deprecated desktop AI submit/read shortcuts are hidden from new plans');
    }
  }

  if (actionContract.kind === 'external_ai_history' && !currentAppEdit) {
    for (const name of actionContract.preferredTools) addIfAvailable(selected, available, name);
    if (!categories.includes('external_control')) categories.push('external_control');
    reasons.push('external AI history uses only the persistent authorization, synchronization, and local query pipeline');
    for (const submitTool of ['external_ai_collaborate', 'desktop_ai_ask', 'desktop_ai_roundtable']) {
      selected.delete(submitTool);
      forbiddenToolNames.add(submitTool);
    }
    reasons.push('history reads hard-forbid every external AI prompt-submission entry');
  }

  if (currentAuthoringDocumentInspection && !currentAppEdit) {
    selected.clear();
    for (const name of [
      'desktop_active_window',
      'desktop_running_processes',
      'desktop_capture_screen',
      'search_files',
      'desktop_path_info',
      'extract_document_text',
      'read_pdf',
      'read_docx',
      'read_xlsx',
    ]) addIfAvailable(selected, available, name);
    categories.splice(0, categories.length, 'current_document_inspection');
    reasons.splice(0, reasons.length, 'current authoring-document analysis uses visible app evidence plus read-only document extraction');
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

  if (actionContract.kind === 'task_control') {
    for (const name of actionContract.preferredTools) addIfAvailable(selected, available, name);
    addIfAvailable(selected, available, 'runtime_work_status');
    categories.push('task_control');
    reasons.push('runtime work status and cancellation use the unified task ledger');
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

  if (categories.length === 0 && text) {
    const ranked = declarations
      .map(declaration => ({ name: declaration.function.name, score: scoreDeclaration(text, declaration) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
    for (const item of ranked) selected.add(item.name);
    if (ranked.length > 0) {
      categories.push('lexical_match');
      reasons.push('tool names/descriptions matched the user wording');
    }
  }

  if (!currentAppEdit && isDirectAutocadOperationsPlayback(text)) {
    for (const entry of routingManifest) {
      if (entry.lane === 'office') selected.delete(entry.toolName);
    }
    addIfAvailable(selected, available, 'mcp_cad-drafting_autocad_playback_file');
    reasons.push('existing AutoCAD operations are played only through MCP/COM');
  }

  if (!currentAppEdit && requestsBlankAutoCadDocument(text)) {
    selected.clear();
    addIfAvailable(selected, available, 'mcp_cad-drafting_autocad_new_document');
    reasons.push('blank AutoCAD document requests use the dedicated COM document tool and never synthesize geometry');
  } else if (!currentAppEdit && requiresVisibleAutoCadExecution(text)) {
    if (!requestsExplicitCadFileExport(text)) selected.delete('cad_generate_dxf');
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
    if (requiresVisibleAutoCadExecution(text) && available.has('cad_draw_floorplan_in_autocad')) {
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

  const orderedBeforeHealthGate = applyRoutePriority(
    availableNames.filter(name => selected.has(name)),
    unique([
      ...priorityToolsForRoute(categories, text),
      ...manifestPriorities,
    ]),
  );
  const connectedMcpGate = getConnectedMcpGate(options);
  const unavailableMcpServers: string[] = [];
  const ordered = connectedMcpGate
    ? orderedBeforeHealthGate.filter(name => {
        const serverName = getMcpServerName(name);
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
      || selected.has('cad_draw_floorplan_in_autocad')
      || undefined,
    forbiddenToolNames: forbiddenToolNames.size > 0
      ? Array.from(forbiddenToolNames)
      : undefined,
    maxIterations: selected.has('cad_draw_floorplan_in_autocad')
      ? 2
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
        : route.categories.includes('extension_registry')
        ? 'This route is a hard allowlist for the signed extension registry. Do not substitute skill generation, package installation, shell execution, or arbitrary plugin code.'
        : 'This route is a hard allowlist. Do not generate files, prepare CAD operations, open or operate AutoCAD, or substitute any filesystem MCP, shell, or Python fallback.'
      : '',
  ].filter(Boolean).join('\n');
}
