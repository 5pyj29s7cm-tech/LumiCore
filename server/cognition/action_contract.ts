import type { ToolExecutionRecord } from '../tools/types';
import { LEGAL_ENTRY_PREFERRED_TOOLS, isLegalEntryTurn, isRemoteLegalMessageTurn } from './legal_entry';
import { isInformationOnlyQuestion } from './tool_intent';
import {
  requiresActiveWindowObservation,
  requiresDesktopFileListingObservation,
} from './desktop_observation';
import { classifyRuntimeWorkIntent } from './runtime_work_intent';
import { CN_ACTION_CONTRACT_BLOCKERS } from '../regions/packs/cn/voice_fast_path_messages';

export type LumiActionContractKind =
  | 'none'
  | 'messaging_read'
  | 'messaging_send'
  | 'browser_account'
  | 'public_post'
  | 'cad_document'
  | 'cad_drafting'
  | 'customer_operations'
  | 'ecommerce_operations'
  | 'design_delivery'
  | 'stock_monitor'
  | 'task_control'
  | 'legal_document'
  | 'desktop_operation'
  | 'artifact_work';

export interface LumiActionContract {
  applies: boolean;
  kind: LumiActionContractKind;
  label: string;
  coreAction: string;
  preparationIsNotCompletion: string[];
  requiredEvidence: string[];
  preferredTools: string[];
  verificationTools: string[];
  nextStep: string;
  caution: string;
}

const NONE_CONTRACT: LumiActionContract = {
  applies: false,
  kind: 'none',
  label: 'No external action contract',
  coreAction: '',
  preparationIsNotCompletion: [],
  requiredEvidence: [],
  preferredTools: [],
  verificationTools: [],
  nextStep: '',
  caution: '',
};

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

const INJECTED_TASK_CONTEXT_RE = /(?:^|\r?\n)\s*##\s+(?:Current Turn Attachments|Recent action continuation context|Internal client-surface continuation context)\b/i;

function extractPrimaryTaskText(input: string): string {
  const raw = String(input || '');
  const marker = INJECTED_TASK_CONTEXT_RE.exec(raw);
  if (!marker || marker.index <= 0) return raw;
  return raw.slice(0, marker.index).trim();
}

const CURRENT_APP_REFERENCE_RE =
  /(?:\u5728|\u5f80|\u7528).{0,16}(?:\u8fd9\u91cc\u9762|\u8fd9\u91cc|\u91cc\u9762|\u8fd9\u4e2a\u8f6f\u4ef6|\u5f53\u524d\u8f6f\u4ef6|\u521a\u6253\u5f00\u7684(?:\u8f6f\u4ef6|\u5e94\u7528|\u91cc\u9762)|(?:WPS(?:\s+Office)?|Word|Excel|PowerPoint|AutoCAD|CAD|\u5fae\u4fe1|WeChat|Chrome|\u753b\u56fe).{0,8}(?:\u91cc|\u91cc\u9762|\u4e2d|\u5185))|\b(?:in|inside)\b.{0,24}\b(?:this|current|opened|WPS|Word|Excel|PowerPoint|AutoCAD|WeChat|Chrome)\b.{0,12}\b(?:app|application|document)?/iu;

const CURRENT_APP_MUTATION_INTENT_RE =
  /(?:\u65b0\u5efa|\u521b\u5efa|\u5199\u5165|\u8f93\u5165|\u7c98\u8d34|\u5199|\u7f16\u8f91|\u4fee\u6539|\u4fdd\u5b58)|\b(?:new|create|write|type|paste|edit|modify|save)\b/iu;

export type DesktopWindowAction = 'maximize' | 'minimize' | 'restore';

export function requestedDesktopWindowAction(input: string): DesktopWindowAction | null {
  const primary = compact(extractPrimaryTaskText(input));
  if (/(?:\u6700\u5927\u5316|\u653e\u5927\u5230\u5168\u7a97\u53e3|\u94fa\u6ee1\u5c4f\u5e55)|\bmaximi[sz]e\b/iu.test(primary)) return 'maximize';
  if (/(?:\u6700\u5c0f\u5316|\u6536\u5230\u4efb\u52a1\u680f)|\bminimi[sz]e\b/iu.test(primary)) return 'minimize';
  if (/(?:\u8fd8\u539f\u7a97\u53e3|\u6062\u590d\u7a97\u53e3|\u53d6\u6d88\u6700\u5927\u5316)|\brestore\s+(?:the\s+)?window\b/iu.test(primary)) return 'restore';
  return null;
}

export function requiresCurrentAppUiMutation(input: string): boolean {
  const raw = String(input || '');
  const primary = compact(extractPrimaryTaskText(input));
  const hasRecoveredTarget = /(?:^|\r?\n)\s*-\s*appTarget:\s*(?!none|null|unknown|n\/a)[^\r\n]+/i.test(raw);
  return Boolean(
    primary
    && (CURRENT_APP_REFERENCE_RE.test(primary) || hasRecoveredTarget)
    && CURRENT_APP_MUTATION_INTENT_RE.test(primary)
  );
}

export function extractCurrentAppTarget(input: string): string {
  const raw = String(input || '');
  const recovered = raw.match(/(?:^|\r?\n)\s*-\s*appTarget:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
  if (recovered && !/^(?:none|null|unknown|n\/a)$/i.test(recovered)) return recovered;

  const primary = compact(extractPrimaryTaskText(raw));
  const named = primary.match(/\b(WPS(?:\s+Office)?|Microsoft\s+Word|Word|Excel|PowerPoint|AutoCAD|WeChat|Chrome)\b/i)?.[1]
    || primary.match(/(\u5fae\u4fe1|\u753b\u56fe)/u)?.[1];
  return compact(named);
}

function currentAppMutationRequirements(input: string) {
  const primary = compact(extractPrimaryTaskText(input));
  return {
    required: requiresCurrentAppUiMutation(input),
    target: extractCurrentAppTarget(input),
    wantsCreate: /(?:\u65b0\u5efa|\u521b\u5efa)|\b(?:new|create)\b/iu.test(primary),
    wantsText: /(?:\u5199\u5165|\u8f93\u5165|\u7c98\u8d34|\u5199|\u7f16\u8f91|\u4fee\u6539)|\b(?:write|type|paste|edit|modify)\b/iu.test(primary),
    wantsSave: /(?:\u4fdd\u5b58)|\b(?:save)\b/iu.test(primary),
    requestedText: extractRequestedCurrentAppText(primary),
  };
}

export function extractRequestedCurrentAppText(primary: string): string {
  const quoted = primary.match(/(?:\u5199\u5165|\u8f93\u5165|\u7c98\u8d34|\b(?:write|type|paste)\b)[^“”"'`\r\n]{0,12}[“"'`]([^”"'`\r\n]{2,240})[”"'`]/iu)?.[1];
  if (quoted) return compact(quoted);
  const afterColon = primary.match(/(?:\u5199\u5165|\u8f93\u5165|\u7c98\u8d34|\b(?:write|type|paste)\b)\s*(?:\u5185\u5bb9)?\s*[:\uff1a]\s*([^\r\n]{2,240})/iu)?.[1];
  // Text after an explicit colon is payload, not sentence decoration. Preserve
  // terminal punctuation so the native application receives exactly what the
  // user asked to write.
  return compact(afterColon || '');
}

export function claimsCurrentAppSaveCompletion(input: string): boolean {
  const text = String(input || '');
  const stripped = text
    .replace(/(?:\u6ca1\u6709|\u6ca1|\u5e76\u672a|\u5c1a\u672a|\u672a|\u4e0d\u80fd|\u4e0d\u4f1a)[^\u3002\uff01\uff1f.!?\n]{0,28}(?:\u4fdd\u5b58|\bsav(?:e|ed)\b)/giu, ' ')
    .replace(/\b(?:did\s+not|didn't|was\s+not|wasn't|not)\b[^.!?\n]{0,36}\bsav(?:e|ed)\b/giu, ' ');
  return /(?:\u5df2\u7ecf|\u5df2|\u6210\u529f)?[^。！？!?\n]{0,18}(?:\u4fdd\u5b58\u6210\u529f|\u5df2\u4fdd\u5b58|\u4fdd\u5b58\u597d\u4e86|\u4fdd\u5b58\u5b8c\u6210)|\b(?:saved|save\s+completed|successfully\s+saved)\b/iu.test(stripped);
}

export function extractSimpleDesktopOpenTarget(input: string): string {
  const text = compact(extractPrimaryTaskText(input));
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const match = text.match(/^(?:(?:请|麻烦|请你|帮我|你帮我|给我|我要|我想)\s*)?(?:打开|启动|运行|开启|launch|open|start|run)\s*(?:程序|应用|app|软件)?\s*(?:一下)?\s*(.+?)[。！？.!?]*$/iu);
  if (!match) return '';
  const target = compact(match[1]);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (!target || /^(?:了|着|得|多久|这么久|这么慢|为什么|怎么|为何)/u.test(target)) return '';
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:然后|接着|随后|之后|以后|并且|同时|再(?:去|帮|给|用)?|打开后|启动后|运行后|\b(?:then|after|and\s+then)\b)/iu.test(target)) return '';
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:画图|绘制|出图|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|查找|发送|发布|播放|写入|执行脚本|运行脚本|问一下|问问|询问|回复|告诉|\b(?:draw|draft|create|generate|edit|save|export|login|search|send|publish|play|script|ask|reply|tell)\b)/iu.test(target)) return '';
  return target;
}

export function isSimpleDesktopOpenRequest(input: string): boolean {
  return Boolean(extractSimpleDesktopOpenTarget(input));
}

export function requiresDesktopAiCollaboration(input: string): boolean {
  const text = compact(extractPrimaryTaskText(input));
  // i18n-allow: multilingual desktop-AI surface recognition; not user-visible copy.
  const hasAiSurface = /(?:WorkBuddy|Codex|ChatGPT|Claude|Gemini|DeepSeek|Kimi|豆包|通义|文心|Perplexity|Cursor|Copilot|Ollama|LM\s*Studio|Cherry\s*Studio|AnythingLLM|外部\s*AI|桌面\s*AI|AI\s*(?:工具|客户端|app))/iu.test(text)
    // i18n-allow: generic AI-target recognition; not user-visible copy.
    || /(?:AI|模型|agent|智能体)/iu.test(text);
  // i18n-allow: multilingual collaboration-action recognition; not user-visible copy.
  const hasCollaborationAction = /(?:问(?:一下|问)?|询问|发给|发送给|交给|跟|和|同).{0,48}(?:聊天|聊|对话|说|问|讨论)|(?:聊天|对话|讨论|回答|结果|总结|对比|汇总)|\b(?:ask|send\s+to|hand\s+off|chat|talk|discuss|answer|collect|compare|summari[sz]e)\b/iu.test(text);
  return hasAiSurface && hasCollaborationAction;
}

export function requiresDesktopAiAnswerCollection(input: string): boolean {
  if (!requiresDesktopAiCollaboration(input)) return false;
  const text = compact(extractPrimaryTaskText(input));
  // i18n-allow: multilingual answer-collection intent recognition; not user-visible copy.
  return /(?:聊天|聊|对话|讨论|回答|结果|带回|拿回|告诉我|总结|对比|汇总)|\b(?:chat|talk|discuss|answer|bring\s+back|collect|compare|summari[sz]e)\b/iu.test(text);
}

export function requiresCadGeometryExtractionOnly(input: string): boolean {
  const text = compact(extractPrimaryTaskText(input));
  if (!text) return false;
  const extractionIntent =
    /(?:\u63d0\u53d6|\u89e3\u6790|\u8bc6\u522b).{0,24}(?:\u51e0\u4f55|\u6237\u578b|\u8f6e\u5ed3|\u62d3\u6251|\u5899\u4f53|\u623f\u95f4|\u95e8\u7a97|\u5750\u6807)|(?:\u51e0\u4f55|\u6237\u578b|\u8f6e\u5ed3|\u62d3\u6251|\u5899\u4f53|\u623f\u95f4|\u95e8\u7a97|\u5750\u6807).{0,24}(?:\u63d0\u53d6|\u89e3\u6790|\u8bc6\u522b)|\b(?:extract|parse|identify|detect)\b.{0,32}\b(?:geometry|floorplan|floor\s+plan|topology|walls?|rooms?|doors?|windows?|coordinates?)\b|\b(?:geometry|floorplan|floor\s+plan|topology)\b.{0,32}\b(?:extract|parse|identify|detect)\b/iu.test(text);
  if (!extractionIntent) return false;

  const explicitlyNoDrawing =
    /(?:\u5148|\u6682\u65f6|\u76ee\u524d)?\s*(?:\u4e0d\u8981|\u4e0d\u7528|\u4e0d\u9700\u8981|\u65e0\u9700|\u4e0d\u5fc5|\u5148\u4e0d|\u6682\u4e0d).{0,16}(?:\u7ed8\u5236|\u753b|\u51fa\u56fe|\u751f\u6210.{0,8}(?:CAD|DXF|DWG))|(?:\u53ea|\u4ec5)(?:\u9700\u8981|\u8981)?\s*(?:\u63d0\u53d6|\u89e3\u6790|\u8bc6\u522b).{0,16}(?:\u51e0\u4f55|\u6237\u578b|\u8f6e\u5ed3|\u62d3\u6251)|\b(?:do\s+not|don't|without|no\s+need\s+to)\b.{0,24}\b(?:draw|draft|render|generate\s+(?:cad|dxf|dwg))\b|\b(?:only|just)\b.{0,16}\b(?:extract|parse)\b.{0,16}\b(?:geometry|floorplan|topology)\b/iu.test(text);
  const drawingIntent =
    /(?:\u7ed8\u5236|\u753b\u51fa|\u753b\u5230|\u51fa\u56fe|\u751f\u6210|\u521b\u5efa).{0,24}(?:CAD|DXF|DWG|\u56fe\u7eb8|\u65bd\u5de5\u56fe|\u5e73\u9762\u56fe)|(?:AutoCAD|\bCAD\b|\bDXF\b|\bDWG\b|\u56fe\u7eb8|\u65bd\u5de5\u56fe).{0,24}(?:\u7ed8\u5236|\u753b|\u751f\u6210|\u521b\u5efa|\u5bfc\u51fa)|\b(?:draw|draft|render|generate|create|export)\b.{0,24}\b(?:cad|dxf|dwg|drawing)\b/iu.test(text);
  return explicitlyNoDrawing || !drawingIntent;
}

function buildSimpleDesktopOpenContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: 'Desktop target launch/open',
    coreAction: 'Open or focus exactly the desktop app, file, folder, or URL named by the user',
    preparationIsNotCompletion: ['only listing installed apps', 'opening a different fallback app', 'planning a larger task inside the app'],
    requiredEvidence: ['successful desktop_open or browser_open_task receipt for the requested target', 'or matching active-window/running-process evidence'],
    preferredTools: ['desktop_list_apps', 'desktop_open', 'browser_open_task', 'desktop_active_window', 'desktop_running_processes'],
    verificationTools: ['desktop_active_window', 'desktop_running_processes'],
    nextStep: 'Resolve the exact requested target, open it once, and verify the matching process or active window when needed.',
    caution: 'Do not reinterpret a launch request as content creation, and do not substitute a different application unless the user explicitly asks for a fallback.',
  });
}

function buildCadGeometryExtractionContract(): LumiActionContract {
  return withDefaults({
    kind: 'cad_drafting',
    label: 'CAD source-geometry extraction',
    coreAction: 'Extract verified structured geometry from the requested source image without drawing or generating a CAD deliverable',
    preparationIsNotCompletion: [
      'only locating or listing the source image',
      'OCR or visual description without executable geometry',
      'partial, truncated, or schema-incomplete model output',
    ],
    requiredEvidence: [
      'floorplan_extract_geometry result with geometryReady=true and geometryVerified=true',
      'a nonempty server-owned geometryReceiptPath from that same result',
    ],
    preferredTools: ['desktop_list_files', 'desktop_system_info', 'floorplan_extract_geometry'],
    verificationTools: ['floorplan_extract_geometry'],
    nextStep: 'If extraction is not verified, report failedStage, parseError, and next from the geometry receipt; retry the same source or a clearer crop without inventing partial geometry.',
    caution: 'Do not require an active application window and do not claim drawing or CAD generation. A listed file, OCR text, or partial geometry is not successful extraction.',
  });
}

function isCustomerOperationsTurn(text: string): boolean {
  const customerSurface = /(?:\u5ba2\u6237|\u9500\u552e|\u7ebf\u7d22|\u552e\u540e|\u5ba2\u670d|\u5de5\u5355|\u5546\u673a|\u5ba2\u6237\u5173\u7cfb|\bCRM\b|customer|sales|lead|after[-\s]?sales|support\s+ticket)/iu.test(text);
  const operationalIntent = /(?:\u63a5\u7ba1|\u8ddf\u8fdb|\u63a8\u8fdb|\u5904\u7406|\u5206\u6790|\u8bc4\u5206|\u62a5\u4ef7|\u56de\u8bbf|\u6210\u4ea4|\u5f02\u8bae|\u5206\u7c7b|\u6d3e\u5355|\u7ef4\u62a4|\u8fd0\u8425|take\s*over|follow\s*up|advance|triage|qualif|score|quote|handle|operate|manage)/iu.test(text);
  const legalOnly = /(?:\u5408\u540c\u5ba1\u67e5|\u6cd5\u5f8b\u610f\u89c1|\u8d77\u8bc9|\u7b54\u8fa9|\u4ee3\u7406\u8bcd|contract\s+review|legal\s+opinion|pleading)/iu.test(text);
  return customerSurface && operationalIntent && !legalOnly;
}

function isEcommerceOperationsTurn(text: string): boolean {
  const commerceSurface = /(?:\u7535\u5546|\u5e97\u94fa|\u5546\u54c1|\u5546\u5bb6\u540e\u53f0|\u8ba2\u5355|\u5e93\u5b58|\u8865\u8d27|\u6295\u653e|\u5e7f\u544a|\u8d26\u6237\u8fd0\u8425|\u5546\u54c1\u8be6\u60c5|\u6296\u5e97|\u6dd8\u5b9d|\u5929\u732b|\u4eac\u4e1c|\u62fc\u591a\u591a|\u5c0f\u7ea2\u4e66|\u6296\u97f3|\u5feb\u624b|\bSKU\b|e-?commerce|marketplace|seller|shopify|\bstore\b|inventory|campaign|listing)/iu.test(text);
  const operationalIntent = /(?:\u63a5\u7ba1|\u8fd0\u8425|\u4f18\u5316|\u5206\u6790|\u4f53\u68c0|\u6838\u7b97|\u5bf9\u8d26|\u8865\u8d27|\u589e\u957f|\u5185\u5bb9|\u77ed\u89c6\u9891|\u4e0a\u67b6|\u53d1\u5e03|\u7ba1\u7406|take\s*over|operate|optim|analy|audit|reconcile|restock|growth|content|publish|manage)/iu.test(text);
  return commerceSurface && operationalIntent;
}

function isCompositeDesignDeliveryTurn(text: string): boolean {
  if (/(?:\u5168\u5957\u8bbe\u8ba1|\u5168\u6848\u8bbe\u8ba1|\u5b8c\u6574\u4ea4\u4ed8\u5305|\u8bbe\u8ba1\u4ea4\u4ed8|\u88c5\u4fee\u4ea4\u4ed8|full\s+(?:design|renovation|interior)|design\s+(?:delivery|package|handoff))/iu.test(text)) return true;
  const groups = [
    /(?:\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u65bd\u5de5\u56fe|\u5e73\u9762\u56fe)/iu,
    /(?:Revit|\bBIM\b|\bIFC\b|Dynamo)/iu,
    /(?:PPT|\u6c47\u62a5|\u65b9\u6848\u4e66|proposal|presentation)/iu,
    /(?:\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|\u54c1\u724c\u89c6\u89c9|render|visual)/iu,
    /(?:\u9884\u7b97|\u6e05\u5355|\u6750\u6599\u8868|BOQ|bill\s+of\s+quantit)/iu,
  ].filter(pattern => pattern.test(text)).length;
  return groups >= 2;
}

function isDesignDeliveryTurn(text: string): boolean {
  const designSurface = /(?:\u88c5\u4fee|\u5bb6\u88c5|\u5de5\u88c5|\u5ba4\u5185\u8bbe\u8ba1|\u7a7a\u95f4\u8bbe\u8ba1|\u5efa\u7b51\u8bbe\u8ba1|\u54c1\u724c\u8bbe\u8ba1|\u89c6\u89c9\u8bbe\u8ba1|\u54c1\u724c\u521b\u610f|\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|Revit|\bBIM\b|\bIFC\b|interior\s+design|spatial\s+design|architectural\s+design|brand\s+design|visual\s+design|render)/iu.test(text);
  const deliveryIntent = /(?:\u8bbe\u8ba1|\u751f\u6210|\u5236\u4f5c|\u7ed8\u5236|\u51fa\u56fe|\u4ea4\u4ed8|\u63a5\u7ba1|\u65b9\u6848|\u6a21\u578b|\u6539\u56fe|design|create|generate|produce|deliver|take\s*over|model|revise)/iu.test(text);
  return isCompositeDesignDeliveryTurn(text) || (designSurface && deliveryIntent);
}

function hasNegatedMessagingSendIntent(text: string): boolean {
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/^(?:我)?(?:没有|没|并未|从未|不是|并不是).{0,100}(?:发给|发送给|给.{0,24}发|让你.{0,24}(?:发|回复|告诉))/u.test(text)) return true;
  return /(?:不要|别|无需|禁止).{0,32}(?:发送|发消息|回复|发出)|\b(?:do\s+not|don't|dont|never)\b.{0,64}\b(?:send|message|reply)\b|\bwithout\b.{0,40}\b(?:sending|messaging|replying)\b/iu.test(text);
}

export function requiresVisibleAutoCadExecution(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const explicitDxfArtifactOnly = /\bDXF\b/i.test(text)
    && !/\bAutoCAD\b|\bacad(?:\.exe)?\b/i.test(text)
    && /(?:\u6587\u4ef6|\u5bfc\u51fa|\u751f\u6210|\u521b\u5efa|\u53ef\u7f16\u8f91|file|export|generate|create|editable)/iu.test(text);
  if (explicitDxfArtifactOnly) return false;
  const mentionsCadSurface =
    /(?:\bAutoCAD\b|\bacad(?:\.exe)?\b|\bCAD\b|(?:CAD|cad)\s*(?:\u56fe|\u56fe\u7eb8|\u8f6f\u4ef6|\u7a97\u53e3|\u754c\u9762|\u91cc|\u4e2d|app)|(?:\u5728|\u7528).{0,16}(?:AutoCAD|CAD|cad))/iu.test(text);
  const wantsVisibleDrawing =
    /(?:\u5b9e\u9645|\u771f\u6b63|\u53ef\u89c1|\u5b9e\u64cd|\u64cd\u4f5c|\u6253\u5f00|\u542f\u52a8|\u8fdb\u5165).{0,32}(?:\u753b|\u7ed8\u5236|\u6267\u884c|\u8dd1)|(?:\u753b\u51fa\u6765|\u7ed8\u5236\u51fa\u6765|\u4e00\u7b14\u4e00\u7b14|\u53ef\u89c1\u7ed8\u56fe|\u5b9e\u64cd\u753b\u56fe)/u.test(text)
    || /(?:\u753b|\u7ed8\u5236|\u51fa\u56fe|\u751f\u6210|\u521b\u5efa|\u8f6c\u6210|\u8fd8\u539f).{0,32}(?:AutoCAD|CAD|cad|\u56fe\u7eb8)|(?:AutoCAD|CAD|cad).{0,32}(?:\u753b|\u7ed8\u5236|\u51fa\u56fe|\u81ea\u52a8\u753b\u56fe)/iu.test(text)
    || /\b(?:actually|visible|visibly|real|run|execute|open|launch|stroke[-\s]?by[-\s]?stroke|step[-\s]?by[-\s]?step).{0,32}(?:draw|drawing|script|AutoCAD|CAD)\b/i.test(text)
    || /\b(?:draw|draft|render|create|generate|convert)\b.{0,32}\b(?:in|inside|through|with|to|as)?\s*(?:AutoCAD|CAD)\b/i.test(text)
    || /\b(?:AutoCAD|CAD)\b.{0,32}\b(?:draw|drawing|draft|render)\b/i.test(text);
  return mentionsCadSurface && wantsVisibleDrawing;
}

export function requestsBlankAutoCadDocument(input: string): boolean {
  const text = compact(extractPrimaryTaskText(input));
  if (!text) return false;
  const cadSurface = /(?:\bAutoCAD\b|\bacad(?:\.exe)?\b|\bCAD\b|CAD\s*(?:\u91cc|\u4e2d|\u8f6f\u4ef6|\u7a97\u53e3|\u754c\u9762))/iu.test(text);
  const blankDocument = /(?:\u65b0\u5efa|\u521b\u5efa|\u6253\u5f00|\u52a0|\u518d\u6765|\u53e6\u5f00).{0,20}(?:\u7a7a\u767d)?(?:\u753b\u5e03|\u56fe\u7eb8|\u7ed8\u56fe|\u6587\u6863|\u6587\u4ef6)|(?:\u7a7a\u767d|\u65b0\u7684?|\u53e6\u4e00\u4e2a).{0,12}(?:CAD\s*)?(?:\u753b\u5e03|\u56fe\u7eb8|\u7ed8\u56fe|\u6587\u6863)|\b(?:new|create|open|add)\b.{0,24}\b(?:blank\s+)?(?:drawing|document|canvas)\b/iu.test(text);
  const asksForGeometry = /(?:\u6309\u7167|\u6839\u636e|\u8bfb\u53d6|\u7167\u7740|\u753b\u8fdb|\u753b\u5165|\u7ed8\u5236|\u753b\u51fa|\u751f\u6210).{0,40}(?:\u8349\u7a3f|\u56fe\u7247|\u7167\u7247|\u6237\u578b|\u5e73\u9762|\u56fe\u7eb8|\u7ebf|\u5899|\u95e8|\u7a97|\u5c3a\u5bf8|\u51e0\u4f55)|\b(?:draw|draft|trace|render|convert)\b.{0,40}\b(?:image|photo|plan|geometry|wall|door|window|line)\b/iu.test(text);
  return cadSurface && blankDocument && !asksForGeometry;
}

export function requiresAutoCadMcpPlayback(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const mentionsMcp = /mcp_cad-drafting_autocad_playback_file|(?:AutoCAD|CAD)\s*MCP|MCP.{0,24}(?:AutoCAD|CAD)/i.test(text);
  const requiresExclusivePath =
    /(?:\u4ec5|\u53ea|\u53ea\u80fd|\u5fc5\u987b|\u52a1\u5fc5|\u4e0d\u8981|\u522b|\u7981\u6b62|\u4e0d\u5f97|\u4e0d\u80fd|\u4e0d\u51c6).{0,48}(?:AutoCAD\s*MCP|CAD\s*MCP|mcp_cad-drafting_autocad_playback_file|LISP|\u811a\u672c|\u56de\u9000|\u964d\u7ea7)/iu.test(text)
    || /\b(?:only|must|required|exclusively)\b.{0,64}\b(?:AutoCAD|CAD|MCP)\b|\b(?:do\s+not|don't|dont|without|no)\b.{0,64}\b(?:LISP|script|fallback)\b/i.test(text);
  return mentionsMcp && requiresExclusivePath;
}

function parseRecordJson(record: ToolExecutionRecord): Record<string, any> | null {
  try {
    const parsed = JSON.parse(String(record.result || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

function normalizeFileReference(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,10}$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function hasRequestedMessagingFileEvidence(record: ToolExecutionRecord, taskText: string): boolean {
  if (record.error || record.name !== 'wechat_send_file') return false;
  const payload = parseRecordJson(record);
  const sent = payload?.sent === true
    || /"sent"\s*:\s*true|sent:\s*true/i.test(String(record.result || ''));
  if (!sent) return false;

  const rawPath = String(
    payload?.fileName
    || payload?.filePath
    || record.arguments?.filePath
    || '',
  ).trim();
  const fileName = rawPath.split(/[\\/]/).pop() || '';
  if (!fileName) return false;

  const primaryTask = extractPrimaryTaskText(taskText);
  const normalizedTask = normalizeFileReference(primaryTask);
  const normalizedFile = normalizeFileReference(fileName);
  const namesRequestedFile = normalizedFile.length >= 2 && normalizedTask.includes(normalizedFile);
  const explicitFileTransfer = /(?:\u6587\u4ef6|\u6587\u6863|\u9644\u4ef6|\u6750\u6599|\u56fe\u7eb8|\u7167\u7247|\u56fe\u7247|\u89c6\u9891\u6587\u4ef6|\u97f3\u9891\u6587\u4ef6|file|document|attachment|photo|image|video\s+file|audio\s+file|\.(?:docx?|pdf|xlsx?|pptx?|txt|md|zip|rar|7z|png|jpe?g|gif|mp4|mov|mp3|wav)\b)/iu.test(primaryTask);
  const contextualFileTransfer = /(?:\u628a|\u5c06)(?:\u5b83|\u8fd9\u4e2a|\u90a3\u4e2a|\u8fd9\u4efd|\u90a3\u4efd|\u4e0a\u9762\u7684|\u521a\u624d\u7684).{0,16}(?:\u53d1|\u4f20|\u8f6c\u53d1)|\b(?:send|forward|transfer)\s+(?:it|that|this)\b/iu.test(primaryTask);
  return namesRequestedFile || explicitFileTransfer || contextualFileTransfer;
}

export function hasVisibleAutoCadExecutionEvidence(
  records: ToolExecutionRecord[] = [],
  _taskText = '',
): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;
  return successful.some(record => {
    if (!/^mcp_cad-drafting_autocad_playback_file$/i.test(record.name)) return false;
    const payload = parseRecordJson(record);
    return payload?.status === 'completed'
      && payload?.transport === 'mcp_autocad_com'
      && payload?.visiblePlayback === true
      && payload?.completionMarkerExists === true
      && payload?.geometryVerified === true
      && payload?.entityCountMatches === true
      && Number(payload?.operationCount) > 0
      && Number(payload?.operationCount) === Number(payload?.expectedEntityCount)
      && Number(payload?.entitiesAdded) === Number(payload?.expectedEntityCount)
      && Boolean(String(payload?.operationSetId || '').trim());
  });
}

export function hasBlankAutoCadDocumentEvidence(records: ToolExecutionRecord[] = []): boolean {
  return records.some(record => {
    if (record.error || !/^mcp_cad-drafting_autocad_new_document$/i.test(String(record.name || ''))) return false;
    const payload = parseRecordJson(record);
    return payload?.status === 'completed'
      && payload?.transport === 'mcp_autocad_com'
      && payload?.documentCreated === true
      && payload?.visible === true
      && Boolean(String(payload?.document || '').trim())
      && Number(payload?.entityCount) === 0;
  });
}

export function requiresAuthenticatedWebResult(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const hasAccountSurface = /\u767b\u5f55|\u81ea\u52a8\u767b\u5f55|\u8d26\u53f7|\u8d26\u6237|\u4f1a\u8bdd|login|log\s*in|sign\s*in|account|session/i.test(text);
  const hasTargetWork = /\u67e5|\u627e|\u641c|\u68c0\u7d22|\u8bfb|\u4e0b\u8f7d|\u6253\u5f00|find|search|query|look\s*up|fetch|download/i.test(text);
  return hasAccountSurface && hasTargetWork;
}

export function hasAuthenticatedWebResultEvidence(records: ToolExecutionRecord[] = [], text = ''): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;
  const task = compact(text);
  const searchIntent = /\u67e5|\u627e|\u641c|\u68c0\u7d22|find|search|query|look\s*up/i.test(task);
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
    if (/open=login|登录\/注册|登录链接|please\s+login|requires authentication|captcha|验证码|2FA|manual_required/i.test(result)) return false;
    const hasTargetTerm = targetTerms.length === 0 || targetTerms.some(term => result.includes(term));
    return hasTargetTerm && /结果|列表|案件|裁判|文书|法院|Page URL|title|content|result|case|search/i.test(result);
  });
}

function withDefaults(contract: Omit<LumiActionContract, 'applies'>): LumiActionContract {
  return {
    ...contract,
    applies: true,
    preparationIsNotCompletion: unique(contract.preparationIsNotCompletion),
    requiredEvidence: unique(contract.requiredEvidence),
    preferredTools: unique(contract.preferredTools),
    verificationTools: unique(contract.verificationTools),
  };
}

function buildCurrentAppMutationContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: '\u5f53\u524d\u5e94\u7528\u5185\u7684\u53ef\u89c1\u7f16\u8f91', // i18n-allow: reviewed internal action-contract prompt copy.
    coreAction: '\u5728\u6062\u590d\u7684\u76ee\u6807\u5e94\u7528\u524d\u53f0\u6267\u884c\u65b0\u5efa\u3001\u8f93\u5165/\u7c98\u8d34\u548c\u4fdd\u5b58\u7b49\u7528\u6237\u8981\u6c42\u7684\u53ef\u89c1\u64cd\u4f5c', // i18n-allow: reviewed internal action-contract prompt copy.
    preparationIsNotCompletion: [
      '\u53ea\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\u5e94\u7528', // i18n-allow: reviewed internal action-contract prompt copy.
      '\u53ea\u6309\u4e0b\u65b0\u5efa\u5feb\u6377\u952e', // i18n-allow: reviewed internal action-contract prompt copy.
      '\u53ea\u751f\u6210\u9879\u76ee\u76ee\u5f55\u4e0b\u7684\u672c\u5730\u6587\u672c\u6587\u4ef6', // i18n-allow: reviewed internal action-contract prompt copy.
      '\u64cd\u4f5c\u540e\u6ca1\u6709\u65b0\u7684\u7a97\u53e3/OCR/\u63a7\u4ef6\u5feb\u7167\u9a8c\u8bc1', // i18n-allow: reviewed internal action-contract prompt copy.
    ],
    requiredEvidence: [
      '\u5339\u914d appTarget \u7684\u524d\u53f0\u7a97\u53e3\u8bc1\u636e', // i18n-allow: reviewed internal action-contract prompt copy.
      '\u5339\u914d\u8bf7\u6c42\u7684 UI \u65b0\u5efa\u4e0e\u8f93\u5165/\u7c98\u8d34\u52a8\u4f5c\u56de\u6267', // i18n-allow: reviewed internal action-contract prompt copy.
      '\u6838\u5fc3\u52a8\u4f5c\u4e4b\u540e\u7684\u7a97\u53e3/OCR/\u63a7\u4ef6\u5feb\u7167\u9a8c\u8bc1', // i18n-allow: reviewed internal action-contract prompt copy.
      '\u82e5\u58f0\u79f0\u5df2\u4fdd\u5b58\uff0c\u8fd8\u9700\u8981\u4fdd\u5b58\u52a8\u4f5c\u548c\u4fdd\u5b58\u540e\u7684\u6587\u6863\u8bc1\u636e', // i18n-allow: reviewed internal action-contract prompt copy.
    ],
    preferredTools: [
      'wps_create_document_with_text',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_click',
      'desktop_ui_invoke',
      'desktop_ui_type',
      'desktop_clipboard_write',
      'desktop_keyboard_press',
      'ocr_screen',
      'desktop_capture_screen',
      'computer_use',
    ],
    verificationTools: ['desktop_active_window', 'desktop_ui_snapshot', 'ocr_screen', 'desktop_capture_screen'],
    nextStep: '\u5148\u786e\u8ba4\u6062\u590d\u7684 appTarget \u6b63\u5728\u524d\u53f0\uff0c\u6267\u884c\u771f\u5b9e UI \u65b0\u5efa\u4e0e\u8f93\u5165\uff0c\u518d\u505a\u4e8b\u540e\u53ef\u89c1\u9a8c\u8bc1\uff1b\u9a8c\u8bc1\u5931\u8d25\u5c31\u5982\u5b9e\u62a5\u544a\u963b\u585e\u3002', // i18n-allow: reviewed internal action-contract prompt copy.
    caution: '\u9879\u76ee\u76ee\u5f55\u4e0b\u7684 write_file \u4e0d\u80fd\u8bc1\u660e\u5185\u5bb9\u5df2\u5199\u5165\u76ee\u6807\u5e94\u7528\uff1bOCR/\u56de\u6267\u660e\u786e\u8bf4\u672a\u6253\u5f00\u3001\u672a\u65b0\u5efa\u6216\u672a\u8f93\u5165\u65f6\u5fc5\u987b\u89c6\u4e3a\u53cd\u8bc1\u3002', // i18n-allow: reviewed internal action-contract prompt copy.
  });
}

function buildLegalDocumentContract(): LumiActionContract {
  return withDefaults({
    kind: 'legal_document',
    label: '\u6cd5\u5f8b\u6587\u4e66/\u4ee3\u7406\u8bcd',
    coreAction: '\u4ee5\u4e09\u6bb5\u8bba\u4e3a\u6838\u5fc3\u57fa\u7840\uff0c\u57fa\u4e8e\u7528\u6237\u63d0\u4f9b\u7684\u4e8b\u5b9e\u548c\u6587\u4ef6\u8d77\u8349\u6216\u5ba1\u9605\u6cd5\u5f8b\u6587\u4e66',
    preparationIsNotCompletion: ['\u6cd5\u5f8b\u5e38\u8bc6\u8bf4\u660e', '\u5217\u5927\u7eb2', '\u6ca1\u6709\u8bfb\u5230\u6848\u60c5\u6750\u6599', '\u5916\u90e8\u5e73\u53f0\u68c0\u7d22\u884c\u52a8\u5355\u4e0d\u7b49\u4e8e\u5df2\u5b8c\u6210\u67e5\u8be2\u6216\u7acb\u6848'],
    requiredEvidence: ['draft/review text grounded in supplied facts', '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c gate \u901a\u8fc7', '\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe/\u6cd5\u5f8b\u4f9d\u636e-\u4e8b\u5b9e\u8bc1\u636e-\u6db5\u6444\u7ed3\u8bba\u8bc1\u636e', '\u6587\u4e66\u6587\u4ef6\u8def\u5f84\u6216\u660e\u786e\u7684\u5ba1\u9605\u610f\u89c1', '\u5916\u90e8\u5e73\u53f0\u7ed3\u679c\u9700\u8981\u6388\u6743\u4f1a\u8bdd/API \u8bc1\u636e\u3001\u6765\u6e90\u767b\u8bb0\u6216\u5165\u6848\u5f52\u6863'],
    preferredTools: LEGAL_ENTRY_PREFERRED_TOOLS,
    verificationTools: ['legal_case_reasoning_matrix', 'legal_authority_source_status', 'legal_refresh_authoritative_sources', 'legal_generate_citation_verification_report', 'legal_finalize_delivery_package', 'legal_search_statute', 'read_docx', 'read_pdf', 'desktop_path_info', 'work_product_verify'],
    nextStep: '\u5148\u62ff\u5230\u4e8b\u5b9e\u3001\u8bc1\u636e\u3001\u8bc9\u8bbc\u76ee\u6807\u548c\u7ba1\u8f96\u7b49\u4fe1\u606f\uff0c\u518d\u8d77\u8349\u6216\u5ba1\u9605\u3002',
    caution: 'Do not present general legal guidance as a complete formal argument. External court, case-law, and company-research platforms support authorized collaboration, result archiving, and pre-delivery verification only. Material legal decisions require review by a qualified lawyer.',
  });
}

function buildCustomerOperationsContract(): LumiActionContract {
  return withDefaults({
    kind: 'customer_operations',
    label: 'Customer operations',
    coreAction: 'Inspect the supplied customer context, perform the requested sales/service work, and record a verifiable customer-facing or operational result.',
    preparationIsNotCompletion: [
      'a canned quotation or contract template',
      'a local customer takeover packet',
      'opening WeChat, CRM, or a customer page',
      'a reply draft that was not sent',
      'a task record with no customer or business outcome',
    ],
    requiredEvidence: [
      'grounded customer analysis based on supplied records when analysis is requested',
      'sent=true or an equivalent channel receipt when contact/reply is requested',
      'a verified document artifact when a quotation, proposal, or agreement is requested',
      'a concrete task/result record that distinguishes completed work from drafts and blockers',
    ],
    preferredTools: [
      'mcp_sales-customer-ops_lead_score',
      'mcp_sales-customer-ops_sales_followup_draft',
      'mcp_sales-customer-ops_objection_response_builder',
      'mcp_sales-customer-ops_customer_health_review',
      'mcp_sales-customer-ops_support_ticket_triage',
      'work_takeover_task_create',
      'work_takeover_task_orchestrate',
      'work_takeover_task_run_suggested_tool',
      'wechat_send_message',
      'create_docx',
      'create_pdf',
      'work_product_verify',
    ],
    verificationTools: ['wechat_send_message', 'work_takeover_task_get', 'work_product_verify', 'desktop_path_info'],
    nextStep: 'Read the actual customer context, choose the relevant customer-operations tool, execute the requested outcome, then verify the channel receipt, artifact, or recorded business result.',
    caution: 'Do not report customer takeover as complete from a local packet, generic template, opened window, or unsent draft.',
  });
}

function buildEcommerceOperationsContract(): LumiActionContract {
  return withDefaults({
    kind: 'ecommerce_operations',
    label: 'Ecommerce operations',
    coreAction: 'Use real supplied store, order, SKU, campaign, inventory, or platform state to perform the requested analysis, content production, or store operation.',
    preparationIsNotCompletion: [
      'a generic store audit checklist',
      'a local ecommerce growth packet',
      'image or video prompts without generated media',
      'opening a seller or creator platform',
      'a publish draft without a platform submission receipt',
    ],
    requiredEvidence: [
      'source-backed ecommerce analysis for analysis requests',
      'an actual image/video/file result for requested content production',
      'authenticated post-action platform state for store changes',
      'post-submit receipt or visible platform feedback for publishing',
    ],
    preferredTools: [
      'mcp_ecommerce-ops_product_listing_optimizer',
      'mcp_ecommerce-ops_ecommerce_order_profit',
      'mcp_ecommerce-ops_inventory_restock_plan',
      'mcp_ecommerce-ops_platform_settlement_reconcile',
      'mcp_ecommerce-ops_campaign_roi_analyzer',
      'mcp_ecommerce-ops_after_sales_risk_report',
      'mcp_content-ops_short_video_script',
      'generate_image',
      'generate_video',
      'web_login_run',
      'mcp_playwright_browser_snapshot',
      'work_product_verify',
    ],
    verificationTools: ['work_product_verify', 'desktop_path_info', 'mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
    nextStep: 'Obtain the real source data or authenticated platform session, run the matching ecommerce operation, and verify the produced asset or post-action platform state.',
    caution: 'A local preparation packet or generated copy is not evidence that a store was operated, media was generated, or content was published.',
  });
}

function buildDesignDeliveryContract(): LumiActionContract {
  return withDefaults({
    kind: 'design_delivery',
    label: 'Design delivery',
    coreAction: 'Inspect the real brief and source materials, create every requested design/CAD/BIM/document output through the corresponding production tools, and verify each deliverable.',
    preparationIsNotCompletion: [
      'a generic design package built from defaults',
      'a concept DXF presented as a construction drawing',
      'a Dynamo handoff script presented as a Revit model',
      'prompts presented as finished visuals',
      'one file presented as a complete multi-output delivery',
    ],
    requiredEvidence: [
      'source brief/files were inspected when the task depends on supplied materials',
      'each requested output group has a real artifact or application result',
      'visible AutoCAD requests have MCP/COM completion-marker evidence',
      'Revit/BIM requests have a real model/export/application result, not a handoff script',
      'artifacts pass path/content verification and assumptions are disclosed',
    ],
    preferredTools: [
      'desktop_list_files',
      'read_file',
      'read_pdf',
      'ocr_image_file',
      'floorplan_extract_geometry',
      'generate_image',
      'cad_generate_dxf',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
      'create_ppt',
      'create_pdf',
      'create_docx',
      'adapter_execute',
      'work_product_verify',
    ],
    verificationTools: ['work_product_verify', 'desktop_path_info', 'desktop_capture_screen', 'adapter_health_check'],
    nextStep: 'Inspect the supplied brief and files, enumerate the requested deliverable groups, produce each through its real tool path, and verify the complete set before reporting completion.',
    caution: 'Concept files, scripts, previews, and local package integrity checks do not prove a professional design, AutoCAD, or Revit delivery was completed.',
  });
}

export function buildActionContract(input: string): LumiActionContract {
  const rawInput = String(input || '');
  const primaryTaskText = extractPrimaryTaskText(rawInput);
  if (primaryTaskText && primaryTaskText.trim() !== rawInput.trim()) {
    const primaryContract = buildActionContract(primaryTaskText);
    if (
      primaryContract.applies
      && primaryContract.kind !== 'none'
      && !requiresCurrentAppUiMutation(rawInput)
    ) return primaryContract;
  }

  const text = compact(rawInput);
  if (!text) return NONE_CONTRACT;
  const runtimeWorkIntent = classifyRuntimeWorkIntent(text);
  if (runtimeWorkIntent !== 'none') {
    const cancelling = runtimeWorkIntent === 'cancel';
    return withDefaults({
      kind: 'task_control',
      label: cancelling ? 'Runtime work cancellation' : 'Runtime work status',
      coreAction: cancelling
        ? 'Cancel the active Lumi work recorded in the unified runtime ledger.'
        : 'Read the active Lumi work recorded in the unified runtime ledger.',
      preparationIsNotCompletion: [
        'listing operating-system processes',
        'checking client health',
        'saying work was stopped without a runtime cancellation receipt',
      ],
      requiredEvidence: [cancelling
        ? 'runtime_work_cancel result with ok=true and an exact cancelled/cancelling/idle status'
        : 'runtime_work_status result with ok=true and the exact active item count'],
      preferredTools: [cancelling ? 'runtime_work_cancel' : 'runtime_work_status'],
      verificationTools: ['runtime_work_status'],
      nextStep: cancelling
        ? 'Cancel the matching runtime work and report whether cancellation completed, is still draining, or there was nothing active.'
        : 'Read the runtime work ledger and report its current items without substituting a process list.',
      caution: 'Only runtime ledger receipts prove Lumi task status or cancellation.',
    });
  }
  if (isInformationOnlyQuestion(text)) return NONE_CONTRACT;
  // Blank AutoCAD creation has a dedicated verified COM path. It remains a
  // CAD document action even when continuation context also supplies the
  // current AutoCAD appTarget.
  if (requestsBlankAutoCadDocument(text)) {
    return withDefaults({
      kind: 'cad_document',
      label: 'AutoCAD blank document',
      coreAction: 'Create and focus one real blank drawing document in visible AutoCAD without inventing geometry or dimensions.',
      preparationIsNotCompletion: ['opening AutoCAD', 'focusing an existing drawing', 'preparing drawing operations', 'creating placeholder geometry'],
      requiredEvidence: ['mcp_cad-drafting_autocad_new_document receipt with documentCreated=true, visible=true, and a document name'],
      preferredTools: ['mcp_cad-drafting_autocad_new_document'],
      verificationTools: ['mcp_cad-drafting_autocad_new_document'],
      nextStep: 'Create a real blank AutoCAD document through COM and report only the verified document receipt.',
      caution: 'Do not infer paper size, coordinates, an outer boundary, or source-geometry verification for a blank-document request.',
    });
  }
  // Recovered foreground-app continuations carry trusted appTarget context.
  // Classify the requested UI mutation before inspecting its payload: prose
  // typed into WPS may itself mention law, CAD, websites, or messaging, but
  // those words describe document content rather than a new task lane.
  if (requiresCurrentAppUiMutation(rawInput)) {
    return buildCurrentAppMutationContract();
  }
  const negatedMessagingSend = hasNegatedMessagingSendIntent(text);
  const appInventoryInspection = /\b(?:inspect|check|list|show|find|detect|inventory)\b.{0,64}\b(?:installed|launchable|available|local|app|application|software|program|launch\s+target)\b|(?:\u68c0\u67e5|\u67e5\u770b|\u5217\u51fa|\u8bc6\u522b|\u68c0\u6d4b|\u76d8\u70b9|\u67e5\u627e).{0,32}(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u5e94\u7528|\u8f6f\u4ef6|\u7a0b\u5e8f|\u542f\u52a8\u5165\u53e3|\u5b89\u88c5\u72b6\u6001)/iu.test(text);
  const activeWindowObservation = requiresActiveWindowObservation(text);
  const desktopFileObservation = requiresDesktopFileListingObservation(text);
  const desktopObservationInspection = activeWindowObservation || desktopFileObservation;
  const directedMessageSend = matches(text, /(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u)
    || matches(text, /\b(?:send\s+(?:a\s+)?(?:message|note|reply)\s+to|send\s+(?:him|her|them|the\s+(?:client|customer|contact|group))|message\s+(?:him|her|them|the\s+(?:client|customer|contact|group)|@?(?!(?:has|have|had|is|was|were|contains?|includes?|body|content|attachment|file|text)\b)[\p{L}\p{N}_.'-]{1,40})|reply\s+to)\b/iu);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const directedMessagingInquiry = /(?:问(?:一下|问)?|询问)\s*[^\s，。！？,.!?:：;；、]{1,24}?(?:在干嘛|在做什么|干嘛|做什么|忙什么|现在怎么样|有没有空)/u.test(text);

  if (isRemoteLegalMessageTurn(text)) {
    return buildLegalDocumentContract();
  }

  if (requiresDesktopAiCollaboration(text)) {
    const collectAnswer = requiresDesktopAiAnswerCollection(text);
    return withDefaults({
      kind: 'desktop_operation',
      label: 'Verified desktop AI collaboration',
      coreAction: 'Send the requested question or task through the named desktop AI surface and, when requested, bring its visible answer back to Lumi.',
      preparationIsNotCompletion: ['opening the AI app', 'focusing its window', 'pasting without submitting', 'claiming an answer from a screenshot that was not read'],
      requiredEvidence: [
        'desktop_ai_ask with submittedCount greater than zero or a desktop_ai_roundtable submission receipt',
        ...(collectAnswer ? ['desktop_ai_collect_answer with status=collected and nonempty answerText, or desktop_ai_roundtable with collectedCount greater than zero'] : []),
      ],
      preferredTools: ['desktop_ai_ask', 'desktop_ai_collect_answer', 'desktop_ai_roundtable', 'desktop_ai_list_targets'],
      verificationTools: collectAnswer ? ['desktop_ai_collect_answer', 'desktop_ai_roundtable'] : ['desktop_ai_ask', 'desktop_ai_roundtable'],
      nextStep: collectAnswer
        ? 'Submit through desktop_ai_ask, then collect the visible answer; report pending, login, or vision blockers instead of inventing a response.'
        : 'Submit through desktop_ai_ask and report the verified submission state.',
      caution: 'A launched or focused AI window is not proof that a message was submitted or that an answer was collected.',
    });
  }

  if (
    matches(text, /wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f|message|chat/i) &&
    matches(text, /\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3|read|view|inspect|recent|history/i) &&
    !directedMessageSend &&
    !matches(text, /\u53d1\u9001|\u53d1\u7ed9|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\bsend\b/i)
  ) {
    return withDefaults({
      kind: 'messaging_read',
      label: '\u524d\u53f0\u6d88\u606f\u8bfb\u53d6/\u804a\u5929\u67e5\u770b',
      coreAction: '\u5728\u771f\u5b9e\u6d88\u606f\u5e94\u7528\u91cc\u5b9a\u4f4d\u76ee\u6807\u4f1a\u8bdd\uff0c\u8bfb\u53d6\u5f53\u524d\u53ef\u89c1\u804a\u5929\u5185\u5bb9\u5e76\u8fd4\u56de\u53ef\u9a8c\u8bc1\u7684\u7ed3\u679c',
      preparationIsNotCompletion: [
        '\u6253\u5f00\u6216\u805a\u7126\u5fae\u4fe1',
        '\u641c\u7d22\u8054\u7cfb\u4eba',
        '\u53ea\u8bfb\u5230\u8fdb\u7a0b\u6216\u7a97\u53e3\u6807\u9898',
        '\u6ca1\u6709\u622a\u56fe/OCR/\u63a7\u4ef6\u5feb\u7167\u7684\u7a97\u53e3\u89c2\u5bdf',
      ],
      requiredEvidence: [
        'wechat_read_recent_chat result with read=true',
        '\u6216\u76ee\u6807\u804a\u5929\u7a97\u53e3\u7684\u622a\u56fe/OCR/\u63a7\u4ef6\u5feb\u7167\u8bc1\u636e',
      ],
      preferredTools: ['wechat_read_recent_chat', 'desktop_open', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'ocr_screen'],
      verificationTools: ['wechat_read_recent_chat', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'ocr_screen'],
      nextStep: '\u5148\u590d\u7528\u5df2\u8fd0\u884c\u7684\u6d88\u606f\u5e94\u7528\u7a97\u53e3\uff0c\u5b9a\u4f4d\u76ee\u6807\u4f1a\u8bdd\uff0c\u518d\u7528\u622a\u56fe/OCR/\u63a7\u4ef6\u5feb\u7167\u8bfb\u53d6\u53ef\u89c1\u804a\u5929\u5185\u5bb9\u3002',
      caution: '\u4e0d\u80fd\u628a\u6253\u5f00\u5fae\u4fe1\u6216\u641c\u7d22\u8054\u7cfb\u4eba\u8bf4\u6210\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9\u3002',
    });
  }

  if (
    (
      directedMessageSend ||
      directedMessagingInquiry ||
      (
        matches(text, /wechat|weixin|\u5fae\u4fe1|\u6d88\u606f|\u8054\u7cfb\u4eba|\u7fa4|message|messaging\s+app|chat\s+app/i) &&
        matches(text, /\u53d1\u9001|\u53d1\u7ed9|\u53d1\u4e00\u6761|\u53d1\u4e00\u4e0b|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u665a\u5b89|\bsend\b|\breply\b/i)
      )
    ) &&
    !negatedMessagingSend &&
    !matches(text, /\u8349\u7a3f|\u5148\u5199|\u4e0d\u8981\u53d1|\bdraft\b/i)
  ) {
    return withDefaults({
      kind: 'messaging_send',
      label: 'Verified message/file delivery',
      coreAction: 'Deliver the requested text or local file to the correct recipient through a bound provider channel or a real messaging window.',
      preparationIsNotCompletion: [
        '\u6253\u5f00\u6216\u805a\u7126\u5fae\u4fe1',
        '\u641c\u7d22\u8054\u7cfb\u4eba',
        '\u622a\u56fe/OCR',
        '\u628a\u6587\u672c\u653e\u5230\u526a\u8d34\u677f',
        'only listing or opening the requested file',
      ],
      requiredEvidence: [
        'wechat_send_message result with sent=true',
        'for a file task: wechat_send_file result with sent=true and an acknowledged filename matching the request',
        'or visible tool evidence showing content insertion, send execution, and the correct conversation after sending',
      ],
      preferredTools: ['wechat_send_message', 'wechat_send_file', 'messaging_list_file_targets', 'desktop_open', 'desktop_active_window', 'desktop_mouse_click_at', 'desktop_cursor_glow_show', 'desktop_keyboard_press'],
      verificationTools: ['wechat_send_message', 'wechat_send_file', 'desktop_active_window', 'desktop_capture_screen'],
      nextStep: 'Use the text or file delivery path that matches the request, and require sent=true, a provider acknowledgement, or visible send evidence.',
      caution: 'Opening an app, finding a recipient, listing a file, or preparing clipboard content is not delivery.',
    });
  }

  if (isSimpleDesktopOpenRequest(text)) {
    return buildSimpleDesktopOpenContract();
  }

  if (requiresCadGeometryExtractionOnly(text)) {
    return buildCadGeometryExtractionContract();
  }

  const hasPublicPlatformSurface = matches(text, /(?:\u89c6\u9891\u7f51\u7ad9|\u521b\u4f5c\u8005\u5e73\u53f0|\u793e\u4ea4\u5e73\u53f0|\u5546\u5bb6\u540e\u53f0|\u5e97\u94fa\u540e\u53f0|\u7f51\u7ad9|\u7f51\u9875|\u6296\u97f3|\u5feb\u624b|\u5c0f\u7ea2\u4e66|\u6296\u5e97|\u6dd8\u5b9d|\u5929\u732b|\u4eac\u4e1c|\u62fc\u591a\u591a|video\s*site|creator\s*platform|social\s*(?:site|platform)|seller\s*(?:center|platform)|marketplace|website|web\s*page)/iu);
  const hasPublicCommitIntent = matches(text, /(?:\u8bc4\u8bba|\u53d1\u5e03|\u70b9\u8d5e|\u6295\u7a3f|\u4e0a\u67b6|\u516c\u5f00\u56de\u590d|comment|post|publish|like|submit|list(?:ing)?)/iu);
  const asksForDraftOnly = matches(text, /(?:\u8349\u7a3f|\u6587\u6848|\u63d0\u793a\u8bcd|\u4e0d\u8981\u53d1\u5e03|\u6682\u4e0d\u53d1\u5e03|draft|copy\s*only|do\s+not\s+(?:post|publish|submit))/iu);
  if (hasPublicPlatformSurface && hasPublicCommitIntent && !asksForDraftOnly) {
    return withDefaults({
      kind: 'public_post',
      label: '\u516c\u5f00\u7f51\u7ad9\u53d1\u5e03/\u8bc4\u8bba',
      coreAction: '\u6253\u5f00\u76ee\u6807\u9875\uff0c\u786e\u8ba4\u8d26\u53f7\u548c\u8f93\u5165\u6846\uff0c\u8f93\u5165\u5185\u5bb9\uff0c\u5728\u53d7\u63a7\u8fb9\u754c\u5185\u53d1\u5e03',
      preparationIsNotCompletion: ['\u6253\u5f00\u7f51\u9875', '\u627e\u5230\u8bc4\u8bba\u6846', '\u5199\u597d\u8349\u7a3f', '\u68c0\u67e5\u767b\u5f55\u72b6\u6001'],
      requiredEvidence: ['browser or desktop evidence that the comment/post was submitted', '\u53d1\u5e03\u540e\u7684\u9875\u9762\u53cd\u9988\u6216\u65b0\u8bc4\u8bba\u53ef\u89c1'],
      preferredTools: ['mcp_playwright_browser_snapshot', 'browser_open_task', 'desktop_active_window', 'desktop_ui_snapshot', 'computer_use'],
      verificationTools: ['mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
      nextStep: '\u5148\u786e\u8ba4\u7f51\u7ad9\u3001\u8d26\u53f7\u3001\u8bc4\u8bba\u5185\u5bb9\u548c\u53d1\u5e03\u8fb9\u754c\uff0c\u518d\u6267\u884c\u5e76\u9a8c\u8bc1\u9875\u9762\u53cd\u9988\u3002',
      caution: '\u767b\u5f55\u3001\u9a8c\u8bc1\u7801\u30012FA\u3001\u4ed8\u8d39\u3001\u8fdd\u89c4\u6216\u9ad8\u98ce\u9669\u516c\u5f00\u53d1\u5e03\u5fc5\u987b\u505c\u4e0b\u786e\u8ba4\u3002',
    });
  }

  if (
    matches(text, /\u767b\u5f55|\u6d4f\u89c8\u5668|\u6253\u5f00\u7f51\u7ad9|\u81ea\u52a8\u767b\u5f55|browser|login|log\s*in|website|site/i) &&
    !matches(text, /\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u753b\u56fe|\u753b\u56fe\u7eb8|\u56fe\u7eb8|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u88c5\u4fee|cad/i)
  ) {
    return withDefaults({
      kind: 'browser_account',
      label: '\u6d4f\u89c8\u5668/\u8d26\u53f7\u64cd\u4f5c',
      coreAction: '\u6253\u5f00\u76ee\u6807\u7ad9\u70b9\uff0c\u68c0\u67e5\u5f53\u524d\u4f1a\u8bdd\uff0c\u4f7f\u7528\u53ef\u63a7\u6d4f\u89c8\u5668\u6216\u684c\u9762\u8fdb\u884c\u767b\u5f55\u540e\u64cd\u4f5c',
      preparationIsNotCompletion: ['\u6253\u5f00\u6d4f\u89c8\u5668', '\u6253\u5f00\u767b\u5f55\u9875', '\u770b\u5230\u7f51\u7ad9\u9996\u9875'],
      requiredEvidence: ['logged-in page/session evidence', '\u76ee\u6807\u9875\u9762\u72b6\u6001\u6216\u8d26\u53f7\u72b6\u6001\u9a8c\u8bc1', '\u82e5\u8bf7\u6c42\u5305\u542b\u68c0\u7d22/\u67e5\u627e\uff1b\u8fd8\u9700\u8981\u76ee\u6807\u68c0\u7d22\u7ed3\u679c\u6216\u660e\u786e\u7684\u672a\u767b\u5f55/\u9a8c\u8bc1\u963b\u585e\u8bc1\u636e'],
      preferredTools: ['web_login_profile_list', 'web_login_profile_save_from_preset', 'web_login_run', 'url_fetch_logged_in', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_click', 'browser_open_task', 'desktop_active_window', 'desktop_capture_screen'],
      verificationTools: ['web_login_profile_list', 'web_login_run', 'url_fetch_logged_in', 'mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
      nextStep: '\u5148\u68c0\u67e5\u5df2\u4fdd\u5b58\u7684\u767b\u5f55 profile/\u4f1a\u8bdd\uff1b\u5df2\u77e5\u7ad9\u70b9\u53ef\u5148\u521b\u5efa\u5bf9\u5e94 preset profile \u5e76\u8fd0\u884c web_login_run\uff1b\u9047\u5230\u5bc6\u7801\u3001\u626b\u7801\u3001\u9a8c\u8bc1\u7801\u30012FA \u6216\u672a\u4fdd\u5b58\u51ed\u636e\u5c31\u505c\u4e0b\u8bf4\u660e\u3002',
      caution: '\u4e0d\u80fd\u628a\u6253\u5f00\u7f51\u9875\u8bf4\u6210\u5df2\u767b\u5f55\u6216\u5df2\u5b8c\u6210\u8d26\u53f7\u64cd\u4f5c\u3002',
    });
  }

  if (isDesignDeliveryTurn(text)) {
    return buildDesignDeliveryContract();
  }

  if (isEcommerceOperationsTurn(text)) {
    return buildEcommerceOperationsContract();
  }

  if (isCustomerOperationsTurn(text)) {
    return buildCustomerOperationsContract();
  }

  if (
    !appInventoryInspection &&
    matches(text, /\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u753b\u56fe|\u753b\u56fe\u7eb8|\u56fe\u7eb8|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u88c5\u4fee|cad/i)
  ) {
    const visibleAutoCad = requiresVisibleAutoCadExecution(text) || requiresAutoCadMcpPlayback(text);
    return withDefaults({
      kind: 'cad_drafting',
      label: 'CAD/\u56fe\u7eb8\u4f5c\u6218',
      coreAction: '\u751f\u6210\u6216\u64cd\u4f5c CAD \u56fe\u7eb8\uff0c\u786e\u8ba4\u6587\u4ef6\u4ea7\u7269\u6216\u53ef\u89c1\u8f6f\u4ef6\u7ed8\u5236\u7ed3\u679c',
      preparationIsNotCompletion: ['\u8ba1\u7b97\u65b9\u6848', '\u5199\u51fa\u811a\u672c', '\u6253\u5f00 CAD \u8f6f\u4ef6', '\u67e5\u770b\u6587\u4ef6\u5939', '\u53ea\u751f\u6210 DXF/\u65b9\u6848\u5305'],
      requiredEvidence: visibleAutoCad
        ? ['source geometry receipt with geometryVerified=true', 'created operations JSON with a verified operationSetId', 'mcp_cad-drafting_autocad_playback_file completion marker with exact operationCount, expectedEntityCount, and entitiesAdded equality']
        : ['created CAD/DXF file path with nonzero size and successful file verification'],
      preferredTools: visibleAutoCad
        ? ['desktop_list_apps', 'floorplan_extract_geometry', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'desktop_path_info', 'desktop_capture_screen']
        : ['floorplan_extract_geometry', 'cad_generate_dxf', 'desktop_path_info', 'work_product_verify'],
      verificationTools: ['desktop_path_info', 'work_product_verify', 'desktop_capture_screen', 'desktop_active_window'],
      nextStep: visibleAutoCad
        ? 'Run staged source extraction, require geometryReady=true, and pass only its server-owned receipt to CAD preparation. Then run AutoCAD MCP/COM playback and require both marker and entity-delta verification. If any stage fails, stop and report the exact blocker.'
        : 'Extract structured geometry, create the requested CAD file, and verify the file exists and is non-empty.',
      caution: 'A DXF/DWG file, operations JSON, opened AutoCAD window, desktop screenshot, or any script is not evidence that visible AutoCAD drawing completed.',
    });
  }

  if (matches(text, /\u80a1\u7968|\u76ef\u76d8|\u884c\u60c5|\u62a5\u4ef7|\u5927\u76d8|\u6da8\u8dcc|\bk\u7ebf\b|stock|quote|market|ticker/i)) {
    return withDefaults({
      kind: 'stock_monitor',
      label: '\u80a1\u7968/\u76ef\u76d8',
      coreAction: '\u83b7\u53d6\u5b9e\u65f6\u6216\u8fd1\u671f\u884c\u60c5\uff0c\u8bbe\u5b9a\u76ef\u76d8\u76ee\u6807\u548c\u63d0\u9192\u8fb9\u754c',
      preparationIsNotCompletion: ['\u8bc6\u522b\u80a1\u7968\u540d\u79f0', '\u751f\u6210\u89c2\u5bdf\u6e05\u5355', '\u53ea\u56de\u7b54\u5e38\u8bc6'],
      requiredEvidence: ['fresh quote/kline/market data timestamp', '\u6216\u5df2\u521b\u5efa\u7684\u76ef\u76d8\u4efb\u52a1/\u63d0\u9192\u8bb0\u5f55'],
      preferredTools: [
        'mcp_stockbot_stock_quote',
        'mcp_stockbot_stock_kline',
        'mcp_stockbot_market_index',
        'mcp_stockbot_stock_news',
        'mcp_stockbot_paper_portfolio',
        'autonomy_register_workflow',
      ],
      verificationTools: [
        'mcp_stockbot_stock_quote',
        'mcp_stockbot_stock_kline',
        'mcp_stockbot_market_index',
        'mcp_stockbot_paper_portfolio',
        'autonomy_list_workflows',
      ],
      nextStep: '\u5148\u786e\u8ba4\u6807\u7684\u3001\u5468\u671f\u548c\u89e6\u53d1\u6761\u4ef6\uff0c\u518d\u8bfb\u53d6\u5e26\u65f6\u95f4\u6233\u7684\u884c\u60c5\u6216\u521b\u5efa\u76ef\u76d8\u4efb\u52a1\u3002',
      caution: '\u4e0d\u80fd\u628a\u4e00\u6b21\u6027\u884c\u60c5\u56de\u7b54\u8bf4\u6210\u6b63\u5728\u6301\u7eed\u76ef\u76d8\u3002',
    });
  }

  if (isLegalEntryTurn(text) || matches(text, /\u5f8b\u5e08|\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u5408\u540c|\u534f\u8bae|\u8d22\u4ea7\u7ebf\u7d22|\u88ab\u6267\u884c\u4eba|\u80a1\u6743\u7a7f\u900f|\u8d22\u4ea7\u4fdd\u5168|\u5b9e\u9645\u63a7\u5236\u4eba|\u5931\u4fe1|\u9650\u5236\u6d88\u8d39|\u6cd5\u5f8b\u4f1a\u8bae|\u5f8b\u5e08\u4f1a\u8bae|\u529e\u6848\u4f1a\u8bae|\u6848\u4ef6\u4f1a\u8bae|\u4f1a\u8bae\u7eaa\u8981.*\u6848\u4ef6|\u6c9f\u901a\u8bb0\u5f55.*\u6848\u4ef6|\u4e09\u6bb5\u8bba|\u5927\u524d\u63d0|\u5c0f\u524d\u63d0|\u6db5\u6444|legal|lawyer|pleading|contract|agreement|asset|enforcement|equity|shareholder/i)) {
    return buildLegalDocumentContract();
  }

  const windowAction = requestedDesktopWindowAction(rawInput);
  if (windowAction) {
    return withDefaults({
      kind: 'desktop_operation',
      label: 'Verified external window control',
      coreAction: `${windowAction} the intended foreground external application window.`,
      preparationIsNotCompletion: [
        'bringing Lumi itself to the foreground',
        'only opening the application',
        'pressing a shortcut without verifying the controlled target',
      ],
      requiredEvidence: ['desktop_window_control result with ok=true, status=verified, the requested action, and targetMatched=true'],
      preferredTools: ['desktop_active_window', 'desktop_open', 'desktop_window_control'],
      verificationTools: ['desktop_window_control', 'desktop_active_window'],
      nextStep: 'Recover or identify the intended application, verify/focus it, apply the requested native window state, and report the native receipt.',
      caution: 'Never use desktop_show_lumi_window to control another application.',
    });
  }

  if (desktopObservationInspection) {
    const requiredEvidence = [
      activeWindowObservation ? '\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u7684\u5b9e\u65f6\u6807\u9898/\u8fdb\u7a0b\u56de\u6267' : '', // i18n-allow: reviewed Chinese desktop observation contract.
      desktopFileObservation ? '\u7528\u6237\u684c\u9762\u76ee\u5f55\u7684\u5b9e\u65f6\u6587\u4ef6\u5217\u8868\u56de\u6267' : '', // i18n-allow: reviewed Chinese desktop observation contract.
    ].filter(Boolean);
    const preferredTools = [
      activeWindowObservation ? 'desktop_active_window' : '',
      desktopFileObservation ? 'desktop_list_files' : '',
    ].filter(Boolean);
    return withDefaults({
      kind: 'desktop_operation',
      label: '\u684c\u9762\u72b6\u6001\u8bfb\u53d6', // i18n-allow: reviewed Chinese desktop observation contract.
      coreAction: '\u4ece\u5f53\u524d\u684c\u9762\u5ba2\u6237\u7aef\u8bfb\u53d6\u7528\u6237\u8981\u6c42\u7684\u7a97\u53e3\u548c\u684c\u9762\u6587\u4ef6\u72b6\u6001', // i18n-allow: reviewed Chinese desktop observation contract.
      preparationIsNotCompletion: [
        '\u53ea\u8bfb\u53d6\u5176\u4e2d\u4e00\u9879\u800c\u9057\u6f0f\u540c\u4e00\u8bf7\u6c42\u4e2d\u7684\u5176\u4ed6\u89c2\u5bdf\u9879', // i18n-allow: reviewed Chinese desktop observation contract.
        '\u628a\u7528\u6237\u4e3b\u76ee\u5f55\u5f53\u6210\u684c\u9762\u76ee\u5f55', // i18n-allow: reviewed Chinese desktop observation contract.
      ],
      requiredEvidence,
      preferredTools,
      verificationTools: preferredTools,
      nextStep: '\u9010\u9879\u6267\u884c\u684c\u9762\u53ea\u8bfb\u5de5\u5177\uff0c\u5e76\u76f4\u63a5\u6839\u636e\u5f53\u524d\u8f6e\u56de\u6267\u6c47\u62a5\u7a97\u53e3\u6807\u9898\u548c\u6587\u4ef6\u6570\u91cf\u3002', // i18n-allow: reviewed Chinese desktop observation contract.
      caution: '\u4e0d\u80fd\u7528\u5386\u53f2\u8bb0\u5fc6\u3001\u7528\u6237\u4e3b\u76ee\u5f55\u6216\u5355\u4e00\u5de5\u5177\u7ed3\u679c\u4ee3\u66ff\u5f53\u524d\u8bf7\u6c42\u4e2d\u7684\u5168\u90e8\u684c\u9762\u8bc1\u636e\u3002', // i18n-allow: reviewed Chinese desktop observation contract.
    });
  }

  if (matches(text, /\u6587\u4ef6|\u6587\u6863|PPT|PDF|docx|xlsx|pptx|\u751f\u6210|\u5bfc\u51fa|\u4fdd\u5b58|create|generate|export|save/i)) {
    return withDefaults({
      kind: 'artifact_work',
      label: '\u6587\u4ef6/\u4ea7\u7269\u4ea4\u4ed8',
      coreAction: '\u751f\u6210\u3001\u8bfb\u53d6\u6216\u4fee\u6539\u5b9e\u9645\u6587\u4ef6\u4ea7\u7269',
      preparationIsNotCompletion: ['\u5199\u51fa\u5927\u7eb2', '\u53ea\u6709\u6587\u672c\u8bf4\u660e', '\u53ea\u5217\u51fa\u6587\u4ef6\u5939'],
      requiredEvidence: ['file path exists with expected content/nonzero size', '\u6216\u5de5\u4f5c\u4ea7\u7269\u9a8c\u6536\u901a\u8fc7'],
      preferredTools: ['write_file', 'create_docx', 'create_ppt', 'create_pdf', 'desktop_path_info', 'work_product_verify'],
      verificationTools: ['desktop_path_info', 'work_product_verify'],
      nextStep: '\u6267\u884c\u6587\u4ef6\u751f\u6210/\u8bfb\u53d6\u5de5\u5177\u5e76\u9a8c\u8bc1\u4ea7\u7269\u3002',
      caution: '\u4e0d\u80fd\u628a\u804a\u5929\u6587\u672c\u6216\u8ba1\u5212\u8bf4\u6210\u5df2\u5199\u5165\u6587\u4ef6\u3002',
    });
  }

  if (appInventoryInspection || matches(text, /\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u70b9\u51fb|\u8f93\u5165|\u5e94\u7528|\u8f6f\u4ef6|desktop|open|click|type|app|application/i)) {
    return withDefaults({
      kind: 'desktop_operation',
      label: '\u684c\u9762/\u672c\u673a\u8f6f\u4ef6\u64cd\u4f5c',
      coreAction: '\u5728\u771f\u5b9e\u684c\u9762\u6216\u672c\u673a\u8f6f\u4ef6\u4e0a\u5b8c\u6210\u53ef\u89c1\u64cd\u4f5c',
      preparationIsNotCompletion: ['\u67e5\u8fdb\u7a0b', '\u5217\u5e94\u7528', '\u6253\u5f00\u5feb\u6377\u65b9\u5f0f', '\u53ea\u6267\u884c\u547d\u4ee4\u884c'],
      requiredEvidence: ['active window/process/screen state proves the requested result', '\u6216\u5de5\u5177\u8fd4\u56de\u7684\u64cd\u4f5c\u9a8c\u8bc1'],
      preferredTools: ['desktop_list_apps', 'desktop_open', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'computer_use'],
      verificationTools: ['desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'desktop_running_processes'],
      nextStep: '\u5148\u805a\u7126\u5df2\u8fd0\u884c\u7684\u7a97\u53e3\uff0c\u6267\u884c\u6838\u5fc3\u64cd\u4f5c\uff0c\u518d\u7528\u7a97\u53e3/\u5c4f\u5e55\u8bc1\u636e\u9a8c\u8bc1\u3002',
      caution: '\u4e0d\u80fd\u628a\u8fdb\u7a0b\u5b58\u5728\u6216\u5e94\u7528\u6253\u5f00\u8bf4\u6210\u4e1a\u52a1\u52a8\u4f5c\u5df2\u5b8c\u6210\u3002',
    });
  }

  return NONE_CONTRACT;
}

function expandSuccessfulRecords(records: ToolExecutionRecord[]): ToolExecutionRecord[] {
  const expanded: ToolExecutionRecord[] = [];
  for (const record of records) {
    if (record.error || !String(record.result || '').trim()) continue;
    expanded.push(record);
    if (record.name !== 'work_takeover_task_run_suggested_tool') continue;
    const payload = parseRecordJson(record);
    const run = payload?.run;
    if (!run || run.status !== 'completed' || !run.toolName || !String(run.result || '').trim()) continue;
    expanded.push({
      id: run.id,
      name: String(run.toolName),
      arguments: run.toolArgs && typeof run.toolArgs === 'object' ? run.toolArgs : {},
      result: String(run.result),
    });
  }
  return expanded;
}

function recordText(record: ToolExecutionRecord): string {
  return `${record.name}\n${JSON.stringify(record.arguments || {})}\n${String(record.result || '')}`;
}

function normalizeDesktopTarget(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\\/]+/g, ' ')
    .replace(/\.(?:exe|lnk|appref-ms|url)$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function requestedDesktopTargetAliases(target: string): string[] {
  const normalized = normalizeDesktopTarget(target);
  const aliases = new Set<string>([normalized]);
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
  if (/(?:googlechrome|chrome|\u8c37\u6b4c\u6d4f\u89c8\u5668)/u.test(normalized)) {
    add('Google Chrome', 'chrome', 'chrome.exe', '\u8c37\u6b4c\u6d4f\u89c8\u5668'); // i18n-allow: Application alias used only for evidence matching.
  }

  return Array.from(aliases).filter(Boolean);
}

function matchesRequestedDesktopTarget(value: unknown, aliases: string[]): boolean {
  const normalized = normalizeDesktopTarget(value);
  if (!normalized) return false;
  return aliases.some(alias => alias.length >= 2 && (
    normalized === alias
    || normalized.includes(alias)
    || alias.includes(normalized)
  ));
}

function collectStructuredDesktopTargets(
  value: unknown,
  output: string[],
  depth = 0,
): void {
  if (!value || typeof value !== 'object' || depth > 3 || output.length >= 16) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof nested === 'string'
      && /^(?:actualTarget|openedTarget|resolvedTarget|appTarget|applicationTarget|appName|applicationName|processName|executable|windowTitle|target|app|application|process|path)$/i.test(key)
    ) {
      output.push(nested);
    }
    if (nested && typeof nested === 'object') collectStructuredDesktopTargets(nested, output, depth + 1);
  }
}

function hasMatchingDesktopOpenEvidence(record: ToolExecutionRecord, requestedTarget: string): boolean {
  if (record.name !== 'desktop_open' || record.error || !String(record.result || '').trim()) return false;
  const payload = parseRecordJson(record);
  const status = compact(payload?.status || payload?.verification?.status).toLowerCase();
  if (
    payload?.ok === false
    || payload?.success === false
    || /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled)$/.test(status)
    || /timed out|permission denied|not allowed|forbidden|(?:^|\b)(?:failed|error|blocked)(?:\b|:)/i.test(String(record.result || ''))
  ) return false;

  const aliases = requestedDesktopTargetAliases(requestedTarget);
  if (aliases.length === 0) return false;
  const args = record.arguments || {};
  const argumentTargets = [
    args.target,
    args.appTarget,
    args.applicationTarget,
    args.path,
  ].filter(value => typeof value === 'string' && compact(value));
  // The invoked target is the strongest evidence of intent. A different
  // fallback target (for example mspaint.exe for AutoCAD) must never pass.
  if (argumentTargets.length > 0 && !argumentTargets.some(value => matchesRequestedDesktopTarget(value, aliases))) {
    return false;
  }

  const structuredTargets: string[] = [];
  collectStructuredDesktopTargets(payload, structuredTargets);
  if (
    structuredTargets.length > 0
    && !structuredTargets.some(value => matchesRequestedDesktopTarget(value, aliases))
  ) return false;

  if (argumentTargets.some(value => matchesRequestedDesktopTarget(value, aliases))) return true;
  if (structuredTargets.some(value => matchesRequestedDesktopTarget(value, aliases))) return true;
  return matchesRequestedDesktopTarget(record.result, aliases);
}

function requestedBrowserTargetAliases(target: string): string[] {
  const aliases = new Set(requestedDesktopTargetAliases(target));
  const add = (...values: string[]) => values.forEach(value => aliases.add(normalizeDesktopTarget(value)));
  // i18n-allow: Named public-site aliases are used only to match tool evidence.
  if (/(?:中国)?裁判文书网/u.test(target)) add('wenshu.court.gov.cn');
  // i18n-allow: Named public-site aliases are used only to match tool evidence.
  if (/人民法院案例库/u.test(target)) add('rmfyalk.court.gov.cn');
  // i18n-allow: Named public-site aliases are used only to match tool evidence.
  if (/人民法院在线服务/u.test(target)) add('zxfw.court.gov.cn');
  return Array.from(aliases).filter(Boolean);
}

function hasMatchingBrowserOpenEvidence(record: ToolExecutionRecord, requestedTarget: string): boolean {
  if (record.name !== 'browser_open_task' || record.error || !String(record.result || '').trim()) return false;
  const payload = parseRecordJson(record);
  const status = compact(payload?.status || payload?.verification?.status).toLowerCase();
  if (
    payload?.ok === false
    || payload?.success === false
    || payload?.opened === false
    || /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled)$/.test(status)
    || /timed out|permission denied|not allowed|forbidden|(?:^|\b)(?:failed|error|blocked)(?:\b|:)/i.test(String(record.result || ''))
  ) return false;

  const normalizedRequested = normalizeDesktopTarget(requestedTarget);
  // i18n-allow: Generic browser names are input-recognition aliases, not user-visible copy.
  const genericBrowserRequest = /^(?:browser|webbrowser|浏览器|网页浏览器)$/u.test(normalizedRequested);
  const args = record.arguments || {};
  const evidenceValues = [
    args.url,
    args.query,
    args.target,
    payload?.url,
    payload?.openedUrl,
    payload?.finalUrl,
    payload?.target,
    payload?.query,
    record.result,
  ].filter(value => typeof value === 'string' && compact(value));
  if (genericBrowserRequest) return evidenceValues.length > 0;

  const aliases = requestedBrowserTargetAliases(requestedTarget);
  return evidenceValues.some(value => matchesRequestedDesktopTarget(value, aliases));
}

const CURRENT_APP_FOREGROUND_TOOL_RE =
  /^(?:desktop_active_window|get_active_window_info|desktop_ui_snapshot|ocr_screen|desktop_capture_screen)$/i;

const CURRENT_APP_POST_VERIFICATION_TOOL_RE =
  /^(?:desktop_ui_snapshot|ocr_screen|desktop_capture_screen)$/i;

const CURRENT_APP_NEGATIVE_VERIFICATION_RE =
  /(?:\u7a7a\u767d|\u65b0\u5efa)?\u6587\u6863[^\u3002\uff01\uff1f.!?\n]{0,18}(?:\u672a\u6253\u5f00|\u6ca1\u6709\u6253\u5f00|\u672a\u65b0\u5efa|\u6ca1\u6709\u65b0\u5efa|\u4e0d\u5b58\u5728)|(?:\u672a|\u6ca1\u6709|\u6ca1)[^\u3002\uff01\uff1f.!?\n]{0,18}(?:\u8f93\u5165|\u5199\u5165|\u7c98\u8d34|\u4fdd\u5b58|\u751f\u6548)|\b(?:blank|new)?\s*document\b[^.!?\n]{0,28}\b(?:did\s+not|was\s+not|is\s+not|not)\b[^.!?\n]{0,18}\b(?:open|created|available)\b|\b(?:typing|paste|save)\b[^.!?\n]{0,18}\b(?:failed|not\s+applied|not\s+completed)\b/iu;

const CURRENT_APP_SAVE_VERIFICATION_RE =
  /(?:\u4fdd\u5b58\u6210\u529f|\u5df2\u4fdd\u5b58|\u6587\u6863\u5df2\u4fdd\u5b58|\u4fdd\u5b58\u5b8c\u6210)|\b(?:saved|save\s+(?:completed|succeeded)|successfully\s+saved)\b|\.(?:docx?|wps|xlsx?|pptx?)\b/iu;

function hasFailedDesktopReceipt(record: ToolExecutionRecord): boolean {
  if (record.error || !String(record.result || '').trim()) return true;
  const payload = parseRecordJson(record);
  const status = compact(payload?.status || payload?.verification?.status).toLowerCase();
  if (
    payload?.ok === false
    || payload?.success === false
    || /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|not_found|partial|pending)$/.test(status)
  ) return true;
  return /(?:^|\b)(?:failed|error|blocked|not found|timed out|permission denied)(?:\b|:)/i.test(String(record.result || ''));
}

function recordMatchesCurrentApp(record: ToolExecutionRecord, target: string): boolean {
  if (!target) return !hasFailedDesktopReceipt(record);
  const aliases = requestedDesktopTargetAliases(target);
  return aliases.length > 0 && matchesRequestedDesktopTarget(recordText(record), aliases);
}

function normalizedEvidenceText(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function evidenceContainsRequestedText(record: ToolExecutionRecord, requestedText: string): boolean {
  const expected = normalizedEvidenceText(requestedText);
  if (expected.length < 2) return true;
  const evidence = normalizedEvidenceText(recordText(record));
  const probe = expected.slice(0, Math.min(expected.length, 24));
  return probe.length >= 2 && evidence.includes(probe);
}

function clipboardTextBefore(records: ToolExecutionRecord[], index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const record = records[cursor];
    if (!/^(?:desktop_clipboard_write|write_clipboard)$/i.test(record.name)) continue;
    if (hasFailedDesktopReceipt(record)) return '';
    return compact(record.arguments?.text || parseRecordJson(record)?.text || '');
  }
  return '';
}

function isCreateUiActuation(record: ToolExecutionRecord): boolean {
  if (hasFailedDesktopReceipt(record)) return false;
  if (/^(?:desktop_keyboard_press|keyboard_press)$/i.test(record.name)) {
    return /^ctrl\+n$/i.test(compact(record.arguments?.key));
  }
  if (/^(?:desktop_ui_invoke|desktop_ui_click)$/i.test(record.name)) {
    return /(?:\u65b0\u5efa|\u7a7a\u767d\u6587\u6863|\bnew\b|\bblank\s+document\b)/iu.test(recordText(record));
  }
  return false;
}

function isTextUiActuation(
  record: ToolExecutionRecord,
  records: ToolExecutionRecord[],
  index: number,
  requestedText: string,
): boolean {
  if (hasFailedDesktopReceipt(record)) return false;
  if (/^(?:desktop_ui_type|desktop_keyboard_type|keyboard_type)$/i.test(record.name)) {
    const typed = compact(record.arguments?.text);
    if (!typed) return false;
    return !requestedText || normalizedEvidenceText(typed).includes(
      normalizedEvidenceText(requestedText).slice(0, Math.min(normalizedEvidenceText(requestedText).length, 24)),
    );
  }
  if (/^(?:desktop_keyboard_press|keyboard_press)$/i.test(record.name) && /^ctrl\+v$/i.test(compact(record.arguments?.key))) {
    const pasted = clipboardTextBefore(records, index);
    if (!pasted) return false;
    return !requestedText || normalizedEvidenceText(pasted).includes(
      normalizedEvidenceText(requestedText).slice(0, Math.min(normalizedEvidenceText(requestedText).length, 24)),
    );
  }
  return false;
}

function isSaveUiActuation(record: ToolExecutionRecord): boolean {
  if (hasFailedDesktopReceipt(record)) return false;
  if (/^(?:desktop_keyboard_press|keyboard_press)$/i.test(record.name)) {
    return /^ctrl\+s$/i.test(compact(record.arguments?.key));
  }
  return /^(?:desktop_ui_invoke|desktop_ui_click)$/i.test(record.name)
    && /(?:\u4fdd\u5b58|\bsave\b)/iu.test(recordText(record));
}

function verifiedComputerUseReceipt(
  records: ToolExecutionRecord[],
  target: string,
  requestedText: string,
  requireSave: boolean,
): boolean {
  return records.some(record => {
    if (record.name !== 'computer_use' || hasFailedDesktopReceipt(record)) return false;
    const payload = parseRecordJson(record);
    if (
      payload?.completionVerified !== true
      || payload?.status !== 'verified'
      || Number(payload?.observations || 0) < 2
    ) return false;
    if (target && !recordMatchesCurrentApp(record, target)) return false;
    if (requestedText && !evidenceContainsRequestedText(record, requestedText)) return false;
    return !requireSave || CURRENT_APP_SAVE_VERIFICATION_RE.test(recordText(record));
  });
}

function verifiedWpsAutomationReceipt(
  records: ToolExecutionRecord[],
  target: string,
  requestedText: string,
  requireSave: boolean,
): boolean {
  if (target && !/(?:^|\b)wps(?:\s+office|\s+writer)?(?:\b|$)|\u91d1\u5c71/iu.test(target)) {
    return false;
  }
  return records.some(record => {
    if (record.name !== 'wps_create_document_with_text' || hasFailedDesktopReceipt(record)) {
      return false;
    }
    const payload = parseRecordJson(record);
    if (
      payload?.ok !== true
      || payload?.status !== 'verified'
      || payload?.automation !== 'KWPS.Application'
      || payload?.visible !== true
      || payload?.documentCreated !== true
      || payload?.exactTextMatch !== true
      || payload?.processName !== 'wps.exe'
      || Number(payload?.processId) <= 0
      || !/^(?:attachedExisting|newVisibleInstance)$/.test(String(payload?.attachmentMode || ''))
      || (
        payload?.attachmentMode === 'attachedExisting'
        ? payload?.attachedExisting !== true || payload?.newVisibleInstance !== false
        : payload?.attachedExisting !== false || payload?.newVisibleInstance !== true
      )
      || !compact(payload?.documentName)
      || !compact(payload?.windowTitle)
      || !recordMatchesCurrentApp(record, target || 'WPS')
    ) return false;
    if (requireSave) {
      return payload?.saved === true && Boolean(compact(payload?.savePath));
    }
    if (payload?.saved !== false || compact(payload?.savePath)) return false;
    if (!requestedText) return true;
    const requested = String(requestedText).trim();
    const supplied = String(record.arguments?.text || '').trim();
    const readBack = String(payload?.bodyTextWithoutTerminalParagraph || '');
    return supplied === requested && readBack === requested;
  });
}

function postMutationVerificationMatches(
  record: ToolExecutionRecord,
  target: string,
  requestedText: string,
  wantsCreate: boolean,
): boolean {
  if (
    !CURRENT_APP_POST_VERIFICATION_TOOL_RE.test(record.name)
    || hasFailedDesktopReceipt(record)
    || CURRENT_APP_NEGATIVE_VERIFICATION_RE.test(recordText(record))
    || !recordMatchesCurrentApp(record, target)
  ) return false;
  if (requestedText) return evidenceContainsRequestedText(record, requestedText);
  if (!wantsCreate) return true;
  return /(?:\u7a7a\u767d\u6587\u6863|\u65b0\u5efa\u6587\u6863|\u6b63\u6587|\u7f16\u8f91\u533a|\bblank\s+document\b|\bnew\s+document\b|\bdocument\s*\d+\b|\bwriter\b)/iu
    .test(recordText(record));
}

export function hasCurrentAppSaveEvidence(
  records: ToolExecutionRecord[] = [],
  taskText = '',
): boolean {
  const requirements = currentAppMutationRequirements(taskText);
  if (!requirements.required) return false;
  if (verifiedWpsAutomationReceipt(
    records,
    requirements.target,
    requirements.requestedText,
    true,
  )) return true;
  if (verifiedComputerUseReceipt(records, requirements.target, requirements.requestedText, true)) return true;

  let saveIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isSaveUiActuation(records[index])) continue;
    saveIndex = index;
    break;
  }
  if (saveIndex < 0) return false;
  let lastPositive = -1;
  let lastNegative = -1;
  records.slice(saveIndex + 1).forEach((record, offset) => {
    if (
      !CURRENT_APP_POST_VERIFICATION_TOOL_RE.test(record.name)
      || hasFailedDesktopReceipt(record)
      || !recordMatchesCurrentApp(record, requirements.target)
    ) return;
    const index = saveIndex + 1 + offset;
    if (CURRENT_APP_NEGATIVE_VERIFICATION_RE.test(recordText(record))) {
      lastNegative = index;
      return;
    }
    if (CURRENT_APP_SAVE_VERIFICATION_RE.test(recordText(record))) lastPositive = index;
  });
  return lastPositive > lastNegative;
}

export function hasCurrentAppUiMutationEvidence(
  records: ToolExecutionRecord[] = [],
  taskText = '',
): boolean {
  const requirements = currentAppMutationRequirements(taskText);
  if (!requirements.required) return false;
  if (verifiedWpsAutomationReceipt(
    records,
    requirements.target,
    requirements.requestedText,
    requirements.wantsSave,
  )) return true;
  if (verifiedComputerUseReceipt(records, requirements.target, requirements.requestedText, requirements.wantsSave)) {
    return true;
  }

  const matchingForeground = records.some(record => (
    CURRENT_APP_FOREGROUND_TOOL_RE.test(record.name)
    && !hasFailedDesktopReceipt(record)
    && recordMatchesCurrentApp(record, requirements.target)
  ));
  if (!matchingForeground) return false;

  const createIndex = requirements.wantsCreate ? records.findIndex(isCreateUiActuation) : -1;
  if (requirements.wantsCreate && createIndex < 0) return false;

  const textIndex = requirements.wantsText
    ? records.findIndex((record, index) => isTextUiActuation(
        record,
        records,
        index,
        requirements.requestedText,
      ))
    : -1;
  if (requirements.wantsText && textIndex < 0) return false;

  const mutationIndex = Math.max(createIndex, textIndex);
  if (mutationIndex < 0) return false;
  let lastPositive = -1;
  let lastNegative = -1;
  records.slice(mutationIndex + 1).forEach((record, offset) => {
    if (
      !CURRENT_APP_POST_VERIFICATION_TOOL_RE.test(record.name)
      || hasFailedDesktopReceipt(record)
      || !recordMatchesCurrentApp(record, requirements.target)
    ) return;
    const index = mutationIndex + 1 + offset;
    if (CURRENT_APP_NEGATIVE_VERIFICATION_RE.test(recordText(record))) {
      lastNegative = index;
      return;
    }
    if (postMutationVerificationMatches(
      record,
      requirements.target,
      requirements.requestedText,
      requirements.wantsCreate,
    )) lastPositive = index;
  });
  if (lastPositive <= lastNegative) return false;
  if (requirements.wantsSave && !hasCurrentAppSaveEvidence(records, taskText)) return false;
  return true;
}

function hasMeaningfulArguments(record: ToolExecutionRecord): boolean {
  return Object.values(record.arguments || {}).some(value => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return String(value ?? '').trim().length > 0;
  });
}

function isDesktopAppInventoryRequest(text: string): boolean {
  return /\b(?:inspect|check|list|show|find|detect|inventory)\b.{0,64}\b(?:installed|launchable|available|local|app|application|software|program)\b|(?:\u68c0\u67e5|\u67e5\u770b|\u5217\u51fa|\u8bc6\u522b|\u68c0\u6d4b|\u76d8\u70b9|\u67e5\u627e).{0,32}(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u5e94\u7528|\u8f6f\u4ef6|\u7a0b\u5e8f)/iu.test(text);
}

export function isRunningSoftwareInspectionRequest(text: string): boolean {
  return /(?:\u540e\u53f0|\u6b63\u5728\u8fd0\u884c|\u5f00\u7740|\u8fd0\u884c\u4e2d).{0,24}(?:\u8f6f\u4ef6|\u5e94\u7528|\u7a0b\u5e8f|\u8fdb\u7a0b)|(?:\u8f6f\u4ef6|\u5e94\u7528|\u7a0b\u5e8f|\u8fdb\u7a0b).{0,24}(?:\u6b63\u5728\u8fd0\u884c|\u5f00\u7740|\u6709\u591a\u5c11|\u51e0\u4e2a)|\b(?:running|open|background)\b.{0,24}\b(?:apps?|applications?|software|processes?)\b/iu.test(text);
}

function hasVerifiedGenericDesktopMutation(records: ToolExecutionRecord[]): boolean {
  const mutationPattern = /^(?:desktop_ui_(?:click|invoke|type)|desktop_(?:mouse_.+|keyboard_.+)|keyboard_press|mouse_(?:move|click|drag)|keyboard_type|computer_use|client_action)$/i;
  const observationPattern = /^(?:desktop_active_window|get_active_window_info|desktop_ui_snapshot|desktop_capture_screen|capture_screen|ocr_screen)$/i;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!mutationPattern.test(record.name) || !hasMeaningfulArguments(record)) continue;
    const payload = parseRecordJson(record);
    const embeddedVerification = record.evidence?.assurance === 'verified'
      || payload?.ok === true && /^(?:verified|completed|success|succeeded|ok)$/i.test(String(payload?.status || payload?.verification?.status || ''))
      || payload?.verification?.status === 'pass'
      || Boolean(payload?.selectedAfter);
    if (embeddedVerification) return true;
    if (records.slice(index + 1).some(candidate => observationPattern.test(candidate.name))) return true;
  }
  return false;
}

function isPreparationOnlyTool(name: string): boolean {
  return /^(?:work_product_plan|work_takeover_task_(?:create|from_wechat|from_clipboard|list|get|update|continue|orchestrate|execute_step|advance|autorun|export_packet)|work_takeover_capability_reuse_probe|mcp_cad-drafting_cad_renovation_folder_workflow|desktop_(?:open|list_apps|list_files|active_window|capture_screen|ui_snapshot)|browser_open_task|write_clipboard)$/i.test(name);
}

function hasArtifactVerification(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.name === 'work_product_verify') {
      const payload = parseRecordJson(record);
      return payload?.status === 'pass' || /"status"\s*:\s*"pass"/i.test(record.result);
    }
    if (record.name === 'desktop_path_info') {
      const payload = parseRecordJson(record);
      return (payload?.exists === true && Number(payload?.size ?? payload?.sizeBytes ?? 1) > 0)
        || /"exists"\s*:\s*true/i.test(record.result) && !/"(?:size|sizeBytes)"\s*:\s*0\b/i.test(record.result);
    }
    return false;
  });
}

function hasCreatedArtifact(records: ToolExecutionRecord[], namePattern: RegExp): boolean {
  return records.some(record => {
    if (!namePattern.test(record.name) || isPreparationOnlyTool(record.name)) return false;
    const result = String(record.result || '');
    return /(?:[A-Za-z]:\\|\/[^\s"']+|\bpath\b|\bfile\b|\bsaved\b|\bcreated\b|\boutput\b|\burl\b)/i.test(result)
      && !/(?:prompt\s*only|draft\s*only|not\s+(?:created|generated)|missing|failed|blocked)/i.test(result);
  });
}

function hasActualMediaEvidence(records: ToolExecutionRecord[], kind: 'image' | 'video' | 'either'): boolean {
  const namePattern = kind === 'image'
    ? /^(?:generate_image(?:_dalle)?|edit_image|mcp_.+_(?:generate|edit)_image)$/i
    : kind === 'video'
      ? /^(?:generate_video|mcp_.+_(?:generate|create)_video)$/i
      : /^(?:generate_image(?:_dalle)?|edit_image|generate_video|mcp_.+_(?:generate|edit|create)_(?:image|video))$/i;
  return records.some(record => {
    if (!namePattern.test(record.name)) return false;
    const result = String(record.result || '');
    return /(?:image_url|video_url|output_url|download_url|savedPath|outputPath|"path"\s*:|https?:\/\/)/i.test(result)
      && !/(?:prompt\s*only|not\s+generated|failed|blocked)/i.test(result);
  });
}

function hasPublicPostEvidence(records: ToolExecutionRecord[]): boolean {
  const explicitReceipt = records.some(record =>
    /(?:publish|post|comment|submit|listing)/i.test(record.name)
      && /"(?:published|posted|submitted|commented|success)"\s*:\s*true|"status"\s*:\s*"(?:published|posted|submitted|success|completed)"/i.test(record.result)
  );
  if (explicitReceipt) return true;

  const commitIndex = records.findIndex(record => {
    if (!/(?:playwright_browser_click|desktop_ui_(?:click|invoke)|computer_use|mouse_click)/i.test(record.name)) return false;
    return /(?:\u53d1\u5e03|\u8bc4\u8bba|\u6295\u7a3f|\u4e0a\u67b6|\u63d0\u4ea4|publish|post|comment|submit|list(?:ing)?)/iu.test(recordText(record));
  });
  if (commitIndex < 0) return false;
  return records.slice(commitIndex + 1).some(record =>
    /(?:snapshot|evaluate|ui_snapshot|ocr|capture_screen)/i.test(record.name)
      && /(?:\u53d1\u5e03\u6210\u529f|\u8bc4\u8bba\u6210\u529f|\u63d0\u4ea4\u6210\u529f|\u5df2\u53d1\u5e03|\u5df2\u4e0a\u67b6|published|posted|submitted|comment\s+(?:is\s+)?visible|success(?:fully)?)/iu.test(record.result)
  );
}

function hasCustomerOperationsEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const wantsSend = /(?:\u53d1\u7ed9|\u53d1\u9001|\u76f4\u63a5\u56de\u590d|\u56de\u590d\u5ba2\u6237|\u8054\u7cfb\u5ba2\u6237|\u8ddf\u8fdb\u5ba2\u6237|\u56de\u8bbf\u5ba2\u6237|\u63a8\u8fdb\u8ddf\u8fdb|send|message|reply\s+to|contact\s+the\s+customer|follow\s+up\s+with|advance.{0,24}follow[-\s]?up)/iu.test(taskText)
    && !/(?:\u8349\u7a3f|\u8bdd\u672f|\u51c6\u5907|\u62df\u4e00\u4efd|draft|prepare|copy\s*only)/iu.test(taskText);
  const wantsDocument = /(?:\u62a5\u4ef7\u5355|\u62a5\u4ef7\u4e66|\u65b9\u6848\u4e66|\u5408\u540c|\u534f\u8bae|\u63d0\u6848|PPT|PDF|DOCX|quotation|proposal|agreement|contract)/iu.test(taskText);
  const wantsAnalysis = /(?:\u5206\u6790|\u8bc4\u5206|\u5206\u7c7b|\u5f02\u8bae|\u5065\u5eb7\u5ea6|\u5de5\u5355|analy|score|triage|objection|health\s+review)/iu.test(taskText);
  const takeoverOnly = /(?:\u63a5\u7ba1|\u5168\u6743\u5904\u7406|\u76f4\u63a5\u63a8\u8fdb|take\s*over|handle\s+everything)/iu.test(taskText)
    && !wantsSend && !wantsDocument && !wantsAnalysis;

  const sent = records.some(record => record.name === 'wechat_send_message' && /"sent"\s*:\s*true|sent:\s*true/i.test(record.result));
  const analyzed = records.some(record => /^mcp_sales-customer-ops_/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20);
  const documentProduced = hasCreatedArtifact(records, /^(?:create_docx|create_pdf|create_ppt|write_file)$/i) && hasArtifactVerification(records);

  if (wantsSend && !sent) return false;
  if (wantsDocument && !documentProduced) return false;
  if (wantsAnalysis && !analyzed) return false;
  if (takeoverOnly) return sent || documentProduced;
  return sent || analyzed || documentProduced;
}

function hasAuthenticatedPlatformOutcome(records: ToolExecutionRecord[]): boolean {
  return records.some(record =>
    /(?:playwright_browser_snapshot|playwright_browser_evaluate|url_fetch_logged_in|computer_use)/i.test(record.name)
      && /(?:\u64cd\u4f5c\u6210\u529f|\u4fee\u6539\u6210\u529f|\u5df2\u66f4\u65b0|\u5df2\u4fdd\u5b58|\u751f\u6548|operation\s+(?:succeeded|completed)|updated|saved|applied)/iu.test(record.result)
      && !/(?:login|required|captcha|manual_required|blocked|failed)/i.test(record.result)
  );
}

function hasEcommerceOperationsEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const wantsAnalysis = /(?:\u5206\u6790|\u4f53\u68c0|\u5229\u6da6|\u6838\u7b97|\u5bf9\u8d26|\u8865\u8d27|\u5e93\u5b58|ROI|ROAS|\u98ce\u9669|\u6807\u9898\u4f18\u5316|analy|audit|profit|reconcile|restock|inventory|risk|listing\s+optim)/iu.test(taskText);
  const wantsImage = /(?:\u751f\u6210|\u5236\u4f5c|\u51fa).{0,16}(?:\u56fe\u7247|\u4e3b\u56fe|\u6d77\u62a5|\u56fe\u6587)|(?:generate|create).{0,16}(?:image|poster|creative)/iu.test(taskText);
  const wantsVideo = /(?:\u751f\u6210|\u5236\u4f5c|\u51fa).{0,16}(?:\u89c6\u9891|\u6210\u7247)|(?:generate|create|produce).{0,16}(?:video|clip)/iu.test(taskText);
  const wantsCopyOrScript = /(?:\u6587\u6848|\u811a\u672c|\u8be6\u60c5\u9875|\u6807\u9898|\u5356\u70b9|\u53d1\u5e03\u8349\u7a3f|copy|script|listing|caption|draft)/iu.test(taskText);
  const wantsPlatformChange = /(?:\u6539\u4ef7|\u6539\u5e93\u5b58|\u4e0a\u67b6|\u4e0b\u67b6|\u5f00\u59cb\u6295\u653e|\u8c03\u6574\u6295\u653e|\u4fee\u6539\u5e97\u94fa|change\s+price|update\s+inventory|list\s+the\s+product|start\s+campaign|change\s+the\s+store)/iu.test(taskText);
  const takeoverOnly = /(?:\u63a5\u7ba1|\u5168\u6258|take\s*over|fully\s+manage)/iu.test(taskText)
    && !wantsAnalysis && !wantsImage && !wantsVideo && !wantsCopyOrScript && !wantsPlatformChange;

  const analyzed = records.some(record => /^mcp_ecommerce-ops_/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20);
  const copyProduced = records.some(record => /^(?:mcp_content-ops_|mcp_ecommerce-ops_product_listing_optimizer)/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20)
    || hasCreatedArtifact(records, /^(?:create_docx|create_pdf|create_xlsx|write_file)$/i) && hasArtifactVerification(records);
  const platformChanged = hasAuthenticatedPlatformOutcome(records);

  if (wantsAnalysis && !analyzed) return false;
  if (wantsImage && !hasActualMediaEvidence(records, 'image')) return false;
  if (wantsVideo && !hasActualMediaEvidence(records, 'video')) return false;
  if (wantsCopyOrScript && !copyProduced) return false;
  if (wantsPlatformChange && !platformChanged) return false;
  if (takeoverOnly) return platformChanged;
  return analyzed || copyProduced || hasActualMediaEvidence(records, 'either') || platformChanged;
}

function hasSourceInspectionEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => /^(?:read_file|read_files_batch|read_pdf|read_docx|extract_document_text|ocr_image_file|floorplan_extract_geometry)$/i.test(record.name));
}

function requiresSourceGrounding(taskText: string): boolean {
  return /(?:\u6839\u636e|\u6309\u7167|\u91cc\u9762|\u6587\u4ef6\u5939|\u9644\u4ef6|\u56fe\u7247|\u539f\u56fe|\u73b0\u573a\u5c3a\u5bf8|provided|attached|source\s+(?:file|folder|drawing)|based\s+on)/iu.test(taskText);
}

function hasGroundedCadGeometryEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.name === 'floorplan_extract_geometry') {
      const payload = parseRecordJson(record);
      const geometry = payload?.cadGenerateDxfArgs && typeof payload.cadGenerateDxfArgs === 'object'
        ? payload.cadGenerateDxfArgs
        : payload;
      const width = Number(geometry?.width ?? payload?.geometryReview?.width);
      const height = Number(geometry?.height ?? payload?.geometryReview?.height);
      const geometryCount = [geometry?.walls, geometry?.rooms, geometry?.doors, geometry?.windows]
        .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
        + Number(payload?.geometryReview?.counts?.outerBoundary || 0)
        + Number(payload?.geometryReview?.counts?.walls || 0)
        + Number(payload?.geometryReview?.counts?.rooms || 0)
        + Number(payload?.geometryReview?.counts?.doors || 0)
        + Number(payload?.geometryReview?.counts?.windows || 0);
      return payload?.geometryReady === true
        && payload?.geometryVerified === true
        && Boolean(String(payload?.geometryReceiptPath || '').trim())
        && width > 0 && height > 0 && geometryCount > 0
        && !/No configured vision model|not available|failed|blocked/i.test(String(record.result || ''));
    }
    if (!/^(?:cad_generate_dxf|cad_prepare_autocad_operations)$/i.test(record.name)) return false;
    const args = record.arguments || {};
    const payload = parseRecordJson(record);
    const geometryCount = [args.walls, args.polylines, args.rooms, args.doors, args.windows]
      .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
      + (Array.isArray(args.outerBoundary) ? args.outerBoundary.length : 0)
      + Number(payload?.outerBoundaryPointCount || 0)
      + Number(payload?.operationCount || 0);
    return Boolean(String(args.sourcePath || payload?.sourcePath || payload?.geometryReceiptPath || '').trim())
      && geometryCount > 0
      && payload?.geometryVerified === true
      && payload?.geometryValidation?.passed === true
      && Boolean(String(payload?.geometryReceiptPath || '').trim());
  });
}

export function hasVerifiedCadGeometryExtractionEvidence(
  records: ToolExecutionRecord[] = [],
): boolean {
  return records.some(record => {
    if (
      record.error
      || record.name !== 'floorplan_extract_geometry'
      || !String(record.result || '').trim()
    ) return false;
    const payload = parseRecordJson(record);
    return payload?.parsed !== false
      && payload?.geometryReady === true
      && payload?.geometryVerified === true
      && payload?.executableGeometryAvailable !== false
      && Boolean(String(payload?.geometryReceiptPath || '').trim());
  });
}

function hasDesignDeliveryEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const sourceRequired = requiresSourceGrounding(taskText);
  const wantsCompositePackage = /(?:\u5168\u5957\u8bbe\u8ba1|\u5168\u6848\u8bbe\u8ba1|\u5b8c\u6574\u4ea4\u4ed8\u5305|\u8bbe\u8ba1\u4ea4\u4ed8|\u88c5\u4fee\u4ea4\u4ed8|full\s+(?:design|renovation|interior)|design\s+(?:delivery|package|handoff))/iu.test(taskText);
  const wantsCad = /(?:\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u65bd\u5de5\u56fe|\u5e73\u9762\u56fe)/iu.test(taskText);
  const wantsBim = /(?:Revit|\bBIM\b|\bIFC\b|Dynamo)/iu.test(taskText);
  const wantsPresentation = /(?:PPT|\u6c47\u62a5|\u65b9\u6848\u4e66|presentation|proposal)/iu.test(taskText);
  const wantsVisual = /(?:\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|\u54c1\u724c\u89c6\u89c9|render|visual)/iu.test(taskText);
  const wantsSchedule = /(?:\u9884\u7b97|\u6e05\u5355|\u6750\u6599\u8868|BOQ|bill\s+of\s+quantit)/iu.test(taskText);

  if (sourceRequired && !hasSourceInspectionEvidence(records)) return false;
  if (sourceRequired && wantsCad && !hasGroundedCadGeometryEvidence(records)) return false;

  if (wantsCad) {
    if (requiresVisibleAutoCadExecution(taskText) || requiresAutoCadMcpPlayback(taskText)) {
      if (!hasVisibleAutoCadExecutionEvidence(records, taskText)) return false;
    } else {
      const cadCreated = hasCreatedArtifact(records, /^(?:cad_generate_dxf|mcp_cad-drafting_.+)$/i);
      if (!cadCreated || !hasArtifactVerification(records)) return false;
    }
  }

  if (wantsBim) {
    const realBim = records.some(record => {
      if (!/(?:revit|bim|ifc)/i.test(record.name) || /(?:prepare|package|handoff|dynamo)/i.test(record.name)) return false;
      return /"status"\s*:\s*"(?:completed|success)"|"(?:modelPath|ifcPath|outputPath|path)"\s*:/i.test(record.result);
    });
    if (!realBim) return false;
  }

  if (wantsPresentation) {
    if (!hasCreatedArtifact(records, /^(?:create_ppt|create_docx|create_pdf)$/i) || !hasArtifactVerification(records)) return false;
  }
  if (wantsVisual && !hasActualMediaEvidence(records, 'image')) return false;
  if (wantsSchedule) {
    if (!hasCreatedArtifact(records, /^(?:create_xlsx|create_docx|create_pdf|write_file)$/i) || !hasArtifactVerification(records)) return false;
  }

  const requestedSpecificOutput = wantsCad || wantsBim || wantsPresentation || wantsVisual || wantsSchedule;
  if (wantsCompositePackage && !requestedSpecificOutput) return false;
  if (!requestedSpecificOutput) return hasActualMediaEvidence(records, 'image') || hasCreatedArtifact(records, /^(?:create_ppt|create_pdf|create_docx)$/i) && hasArtifactVerification(records);
  return true;
}

export function hasCoreActionEvidence(
  contract: LumiActionContract,
  records: ToolExecutionRecord[] = [],
  taskText = '',
): boolean {
  if (!contract.applies) return true;
  const successful = expandSuccessfulRecords(records);
  if (successful.length === 0) return false;
  const toolNames = successful.map(record => record.name);
  if (contract.kind === 'task_control') {
    const intent = classifyRuntimeWorkIntent(taskText);
    const expectedTool = intent === 'cancel' ? 'runtime_work_cancel' : 'runtime_work_status';
    return successful.some(record => {
      if (record.name !== expectedTool) return false;
      const payload = parseRecordJson(record);
      if (payload?.ok !== true) return false;
      if (expectedTool === 'runtime_work_cancel') {
        return ['idle', 'cancelled', 'cancelling'].includes(String(payload.status || ''))
          && Number.isFinite(Number(payload.matchedCount));
      }
      return ['idle', 'active'].includes(String(payload.status || ''))
        && Number.isFinite(Number(payload.activeCount));
    });
  }
  if (contract.kind === 'messaging_read') {
    return successful.some(record =>
      record.name === 'wechat_read_recent_chat' && /"read"\s*:\s*true|read:\s*true/i.test(String(record.result || ''))
    ) || successful.some(record => /^(ocr_screen|desktop_capture_screen|desktop_ui_snapshot)$/i.test(record.name));
  }
  if (contract.kind === 'messaging_send') {
    return successful.some(record =>
      record.name === 'wechat_send_message' && /"sent"\s*:\s*true|sent:\s*true/i.test(String(record.result || ''))
    ) || successful.some(record => hasRequestedMessagingFileEvidence(record, taskText));
  }
  if (contract.kind === 'public_post') {
    return hasPublicPostEvidence(successful);
  }
  if (contract.kind === 'browser_account') {
    return hasAuthenticatedWebResultEvidence(successful, taskText);
  }
  if (contract.kind === 'cad_document') {
    return hasBlankAutoCadDocumentEvidence(successful);
  }
  if (contract.kind === 'cad_drafting') {
    if (requiresCadGeometryExtractionOnly(taskText)) {
      return hasVerifiedCadGeometryExtractionEvidence(successful);
    }
    if (requiresVisibleAutoCadExecution(taskText) || requiresAutoCadMcpPlayback(taskText)) {
      return hasVisibleAutoCadExecutionEvidence(successful, taskText);
    }
    if (requiresSourceGrounding(taskText) && (
      !hasSourceInspectionEvidence(successful)
      || !hasGroundedCadGeometryEvidence(successful)
    )) return false;
    return hasCreatedArtifact(successful, /^(?:cad_generate_dxf|mcp_cad-drafting_.+)$/i)
      && hasArtifactVerification(successful);
  }
  if (contract.kind === 'customer_operations') {
    return hasCustomerOperationsEvidence(successful, taskText);
  }
  if (contract.kind === 'ecommerce_operations') {
    return hasEcommerceOperationsEvidence(successful, taskText);
  }
  if (contract.kind === 'design_delivery') {
    return hasDesignDeliveryEvidence(successful, taskText);
  }
  if (contract.kind === 'stock_monitor') {
    return successful.some(record =>
      /stock_|market_index|reminder_|alert|watchlist|autonomy_(?:register|list|set)_workflow|work_takeover_task/i.test(record.name) ||
      /(?:alert|watchlist|reminder|scheduled|monitoring|workflow|price\s*alert|market\s*alert|\u9884\u8b66|\u63d0\u9192|\u76ef\u76d8\u4efb\u52a1|\u76d1\u63a7\u4efb\u52a1)/iu.test(String(record.result || ''))
    );
  }
  if (contract.kind === 'legal_document') {
    return successful.some(record => /legal_|read_|create_docx|write_file|desktop_path_info|work_product_verify/i.test(record.name));
  }
  if (contract.kind === 'artifact_work') {
    return successful.some(record => /write_file|create_|desktop_path_info|work_product_verify/i.test(record.name));
  }
  if (contract.kind === 'desktop_operation') {
    if (requiresDesktopAiCollaboration(taskText)) {
      const submitted = successful.some(record => {
        if (!/^(?:desktop_ai_ask|desktop_ai_roundtable)$/i.test(record.name)) return false;
        const payload = parseRecordJson(record);
        if (record.name === 'desktop_ai_roundtable') {
          return Number(payload?.ask?.submittedCount || 0) > 0;
        }
        return payload?.ok === true && Number(payload?.submittedCount || 0) > 0;
      });
      if (!submitted) return false;
      if (!requiresDesktopAiAnswerCollection(taskText)) return true;
      return successful.some(record => {
        const payload = parseRecordJson(record);
        if (record.name === 'desktop_ai_collect_answer') {
          return payload?.status === 'collected' && Boolean(compact(payload?.answerText));
        }
        if (record.name === 'desktop_ai_roundtable') {
          return payload?.ok === true && Number(payload?.collectedCount || 0) > 0;
        }
        return false;
      });
    }
    const windowAction = requestedDesktopWindowAction(taskText);
    if (windowAction) {
      return successful.some(record => {
        if (record.name !== 'desktop_window_control') return false;
        const payload = parseRecordJson(record);
        return payload?.ok === true
          && payload?.status === 'verified'
          && payload?.action === windowAction
          && payload?.targetMatched === true;
      });
    }
    const needsActiveWindow = requiresActiveWindowObservation(taskText);
    const needsDesktopFiles = requiresDesktopFileListingObservation(taskText);
    if (needsActiveWindow || needsDesktopFiles) {
      const hasActiveWindow = successful.some(record =>
        /^(?:desktop_active_window|get_active_window_info)$/i.test(record.name)
      );
      const hasDesktopFiles = successful.some(record =>
        /^desktop_list_files$/i.test(record.name)
      );
      return (!needsActiveWindow || hasActiveWindow)
        && (!needsDesktopFiles || hasDesktopFiles);
    }
    if (requiresCurrentAppUiMutation(taskText)) {
      return hasCurrentAppUiMutationEvidence(records, taskText);
    }
    if (isDesktopAppInventoryRequest(taskText)) {
      return successful.some(record => record.name === 'desktop_list_apps');
    }
    if (isRunningSoftwareInspectionRequest(taskText)) {
      return successful.some(record => /^(?:desktop_running_processes|get_running_processes)$/i.test(record.name));
    }
    if (isSimpleDesktopOpenRequest(taskText)) {
      const target = extractSimpleDesktopOpenTarget(taskText).toLowerCase();
      const targetTerms = target.includes('autocad') || /\bacad(?:\.exe)?\b/i.test(target)
        ? ['autocad', 'acad']
        : [target.replace(/\.exe$/i, '').trim()].filter(Boolean);
      return successful.some(record => {
        if (record.name === 'desktop_open') return hasMatchingDesktopOpenEvidence(record, target);
        if (record.name === 'browser_open_task') return hasMatchingBrowserOpenEvidence(record, target);
        if (!/^(?:desktop_active_window|desktop_running_processes|get_active_window_info|get_running_processes)$/i.test(record.name)) return false;
        const evidence = recordText(record).toLowerCase();
        return targetTerms.some(term => term.length >= 2 && evidence.includes(term));
      });
    }
    return hasVerifiedGenericDesktopMutation(successful);
  }
  return successful.length > 0;
}

export function formatActionContractPrompt(contract: LumiActionContract): string {
  if (!contract.applies) return '';
  return [
    '## Lumi Action Contract',
    `Action type: ${contract.label}.`,
    `Core action: ${contract.coreAction}.`,
    contract.preparationIsNotCompletion.length
      ? `Preparation is not completion: ${contract.preparationIsNotCompletion.join('; ')}.`
      : '',
    contract.requiredEvidence.length
      ? `Required completion evidence: ${contract.requiredEvidence.join('; ')}.`
      : '',
    contract.preferredTools.length ? `Preferred tools: ${contract.preferredTools.join(', ')}.` : '',
    contract.verificationTools.length ? `Verification tools: ${contract.verificationTools.join(', ')}.` : '',
    contract.caution ? `Caution: ${contract.caution}` : '',
    contract.nextStep ? `If blocked: ${contract.nextStep}` : '',
  ].filter(Boolean).join('\n');
}

export function summarizeActionContractBlocker(contract: LumiActionContract, failure = ''): string {
  if (!contract.applies) return failure || '';
  const safeFailure = compact(failure);
  if (contract.kind === 'task_control') {
    return CN_ACTION_CONTRACT_BLOCKERS.taskControl(safeFailure);
  }
  if (contract.kind === 'messaging_read') {
    return CN_ACTION_CONTRACT_BLOCKERS.messagingRead(safeFailure);
  }
  if (contract.kind === 'cad_drafting') {
    return CN_ACTION_CONTRACT_BLOCKERS.cadDrafting(safeFailure);
  }
  return CN_ACTION_CONTRACT_BLOCKERS.generic(safeFailure);
}
