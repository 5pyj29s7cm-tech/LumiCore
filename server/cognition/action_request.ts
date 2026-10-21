import type { ActionIntentAnalysis } from './normalized_action_intent';
import { normalizeActionIntent, independentActionClauses, withoutNegatedLookupClauses } from './normalized_action_intent';
import { hasExplicitNoMutationInstruction } from './tool_intent';
import { isMediaPauseRequest, isVideoPlaybackRequest } from './media_intent';
import { withoutLocationLiterals } from './location_literals';
import { businessInstructionText } from "../regions/routing/business_routing";
import type { ToolExecutionRecord } from '../tools/types';
import { resolveArtifactDelivery } from '../tools/artifact_evidence';
import { requiresRunningProcessObservation } from './desktop_observation';
import { compact } from "./action_contract_support";

export const CURRENT_TURN_ATTACHMENTS_RE = /(?:^|\r?\n)\s*##\s+Current Turn Attachments\b/i;
const INJECTED_TASK_CONTEXT_RE = /(?:^|\r?\n)\s*##\s+(?:Current Turn Attachments|Recent action continuation context|Internal client-surface continuation context)\b/i;

export function extractPrimaryTaskText(input: string): string {
  const raw = String(input || '');
  const marker = INJECTED_TASK_CONTEXT_RE.exec(raw);
  if (!marker || marker.index <= 0) return raw;
  return raw.slice(0, marker.index).trim();
}

const CURRENT_APP_REFERENCE_RE =
  /(?:\u5728|\u5f80|\u7528)(?:\u8fd9\u91cc\u9762|\u8fd9\u91cc)|(?:\u5728|\u5f80|\u7528).{0,16}(?:\u8fd9\u4e2a\u8f6f\u4ef6|\u5f53\u524d\u8f6f\u4ef6|\u521a\u6253\u5f00\u7684(?:\u8f6f\u4ef6|\u5e94\u7528)|(?:WPS(?:\s+Office)?|Word|Excel|PowerPoint|AutoCAD|CAD|\u5fae\u4fe1|WeChat|Chrome|\u753b\u56fe|SketchUp|Photoshop|\u9177\u5bb6\u4e50|\u5343\u725b|\u91d1\u8776).{0,8}(?:\u91cc|\u91cc\u9762|\u4e2d|\u5185))|\b(?:in|inside)\b.{0,24}\b(?:(?:this|current|opened)\b.{0,12}\b(?:app|application|document)\b|(?:WPS|Word|Excel|PowerPoint|AutoCAD|WeChat|Chrome)\b)/iu;

const CURRENT_APP_MUTATION_INTENT_RE =
  /(?:\u65b0\u5efa|\u521b\u5efa|\u5199\u5165|\u8f93\u5165|\u7c98\u8d34|\u5199|\u7f16\u8f91|\u4fee\u6539|\u4fdd\u5b58)|\b(?:new|create|write|type|paste|edit|modify|save)\b/iu;

const AUTHORING_APP_TARGET_RE =
  /(?:\bWPS(?:\s+Office)?\b|\bMicrosoft\s+Word\b|\bWord\b|\bExcel\b|\bPowerPoint\b|\bAutoCAD\b|\bCAD\b|\u91d1\u5c71\u6587\u5b57|\u753b\u56fe)/iu;
const APP_OPEN_INTENT_RE =
  /(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u8fdb\u5165)|\b(?:open|launch|start|run)\b/iu;

export type DesktopWindowAction = 'maximize' | 'minimize' | 'restore';

export function requestedDesktopWindowAction(input: string): DesktopWindowAction | null {
  const primary = compact(extractPrimaryTaskText(input));
  if (/(?:\u6700\u5927\u5316|\u653e\u5927\u5230\u5168\u7a97\u53e3|\u94fa\u6ee1\u5c4f\u5e55)|\bmaximi[sz]e\b/iu.test(primary)) return 'maximize';
  if (/(?:\u6700\u5c0f\u5316|\u6536\u5230\u4efb\u52a1\u680f)|\bminimi[sz]e\b/iu.test(primary)) return 'minimize';
  if (/(?:\u8fd8\u539f\u7a97\u53e3|\u6062\u590d\u7a97\u53e3|\u53d6\u6d88\u6700\u5927\u5316)|\brestore\s+(?:the\s+)?window\b/iu.test(primary)) return 'restore';
  return null;
}

export function requiresCurrentAppUiMutation(input: string, appTarget = ''): boolean {
  const primary = compact(extractPrimaryTaskText(input));
  // Creating an artifact and opening it afterwards does not mean editing
  // whatever document happens to be in the foreground right now.
  const createsArtifact = /(?:\u751f\u6210|\u5236\u4f5c|\u8d77\u8349|\u65b0\u5efa|\u521b\u5efa)|\b(?:generate|create|draft)\b/iu.test(primary)
    && /\.(?:docx|xlsx|pptx)\b/iu.test(primary);
  if (createsArtifact && !/(?:\u5f53\u524d|\u6b63\u5728|\u5df2\u6253\u5f00).{0,10}(?:\u7a97\u53e3|\u6587\u6863)|\b(?:current|active|existing)\s+(?:window|document)\b/iu.test(primary)) return false;
  const openIntent = primary.match(APP_OPEN_INTENT_RE);
  const textAfterOpen = openIntent
    ? primary.slice((openIntent.index ?? 0) + openIntent[0].length, (openIntent.index ?? 0) + openIntent[0].length + 64)
    : '';
  const hasNamedAuthoringSequence = Boolean(
    openIntent
    && AUTHORING_APP_TARGET_RE.test(textAfterOpen),
  );
  return Boolean(
    primary
    && (CURRENT_APP_REFERENCE_RE.test(primary) || Boolean(appTarget) || hasNamedAuthoringSequence)
    && CURRENT_APP_MUTATION_INTENT_RE.test(primary)
  );
}

/**
 * A request to inspect the document shown by a named authoring application is
 * more than a desktop-window status read. The active window establishes the
 * application anchor, but an exact document content receipt is still required
 * before the root task can be considered complete.
 */
export function requiresCurrentAuthoringDocumentInspection(input: string): boolean {
  const text = compact(extractPrimaryTaskText(input));
  if (!text) return false;
  const hasAuthoringApp = /(?:WPS|Microsoft\s+Word|Word|Excel|PowerPoint|Office)/iu.test(text);
  const hasCurrentTurnAttachment = CURRENT_TURN_ATTACHMENTS_RE.test(String(input || ''));
  // A deictic request such as "analyze the file that is open" still needs
  // the foreground authoring-window + exact-document contract even when the
  // user did not name WPS/Office. An attached file owns its own target and
  // must never be replaced by foreground-window inference.
  const hasImplicitAuthoringDocument = !hasCurrentTurnAttachment
    && /(?:(?:(?:\u5f53\u524d|\u73b0\u5728|\u6b63\u5728|\u521a\u624d|\u521a\u521a).{0,12}\u6253\u5f00(?:\u7740|\u7684)?|\u6253\u5f00(?:\u7740|\u7684)).{0,8}(?:\u8fd9\u4efd|\u8fd9\u4e2a|\u8be5)?(?:\u6587\u4ef6|\u6587\u6863|PPT|\u6f14\u793a\u6587\u7a3f|\u8868\u683c|\u8d44\u6599)|\b(?:currently?\s+open|opened|active|foreground)\b.{0,24}\b(?:file|document|presentation|sheet)\b)/iu.test(text);
  // i18n-allow: Reviewed multilingual current-document input recognition; not user-visible copy.
  const hasCurrentDocument = /(?:现在|当前|正在).{0,18}(?:打开|编辑|显示).{0,18}(?:这份|这个|该)?(?:文件|文档|表格|幻灯片|演示文稿|PPT|PDF)|(?:打开|编辑|显示)(?:着|的).{0,12}(?:这份|这个|该)?(?:文件|文档|表格|幻灯片|演示文稿|PPT|PDF)|(?:现在|当前|正在).{0,24}(?:活动窗口|前台窗口|窗口里|窗口内).{0,18}(?:文件|文档|表格|幻灯片|演示文稿|PPT|PDF)/u.test(text);
  // i18n-allow: Reviewed multilingual document-inspection input recognition; not user-visible copy.
  const wantsInspection = /(?:分析|总结|介绍|讲解|读取|阅读|看看|看一下|看法|想法|检查)|\b(?:analy[sz]e|summari[sz]e|review|inspect|read|present)\b/iu.test(text);
  const wantsPlainInspection = /(?:\u5206\u6790|\u603b\u7ed3|\u4ecb\u7ecd|\u8bb2\u89e3|\u8bfb\u53d6|\u9605\u8bfb|\u67e5\u770b|\u68c0\u67e5)/u.test(text);
  return (hasAuthoringApp || hasImplicitAuthoringDocument)
    && (hasCurrentDocument || hasImplicitAuthoringDocument)
    && (wantsInspection || wantsPlainInspection);
}

export function extractCurrentAppTarget(input: string): string {
  const raw = String(input || '');

  const primary = compact(extractPrimaryTaskText(raw));
  const named = primary.match(/\b(WPS(?:\s+Office)?|Microsoft\s+Word|Word|Excel|PowerPoint|AutoCAD|WeChat|Chrome|SketchUp|Photoshop)\b/i)?.[1]
    || primary.match(/(\u5fae\u4fe1|\u753b\u56fe|酷家乐|千牛|金蝶)/u)?.[1]; // i18n-allow: explicit application names in user input.
  return compact(named);
}

export function currentAppMutationRequirements(input: string) {
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
  const multiline = primary.match(/(?:\u5199\u5165|\u8f93\u5165|\u7c98\u8d34|\b(?:write|type|paste)\b)\s*(?:\u5185\u5bb9)?\s*[:\uff1a][^\S\r\n]*\r?\n([\s\S]+)/iu)?.[1];
  if (multiline) {
    // i18n-allow: Separate trailing delivery instructions from an explicit multiline payload.
    return multiline.split(/\r?\n(?=(?:完成后|写入后|只根据|(?:after (?:writing|completion)|once complete)\b))/iu)[0].trim();
  }
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

export function extractSimpleDesktopOpenTarget(input: string, analysis?: ActionIntentAnalysis): string {
  const primary = extractPrimaryTaskText(input);
  const onlyOpen = /(?:只|仅)(?:需要|要|是)?打开|\b(?:only|just)\s+open\b/iu.test(primary); // i18n-allow: Multilingual desktop-open input recognition; not user-visible copy.
  // Normalization is useful for the special "only open" phrasing, but it is
  // unnecessary for every other turn. In particular, do not run the full
  // intent pipeline over long conversational context before we even know the
  // turn contains an open command.
  if (onlyOpen) {
    const normalizedIntent = normalizeActionIntent(primary, analysis);
    if (
      normalizedIntent.kind === 'desktop_operation'
      && normalizedIntent.operation === 'navigate'
      && normalizedIntent.sideEffectClass === 'none'
      && compact(normalizedIntent.target)
    ) {
      return compact(normalizedIntent.target);
    }
  }
  const text = compact(primary);
  // Discourse before a standalone command does not add an account/login
  // requirement. Preserve compound work: only non-action prefaces may be
  // ignored, and never turn reported speech or a question into execution.
  const clauses = text.split(/[，,；;。]/u).map(clause => clause.trim()).filter(Boolean); // i18n-allow: Spoken sentence boundaries.
  if (clauses.length > 1 && clauses.slice(0, -1).every(clause => (
    normalizeActionIntent(clause, analysis).kind === 'none'
    && !/(?:读取|查看|检查|搜索|发送|创建|生成|绘制|画|保存|修改|删除|播放|登录|不要|别|如果|假设|说|问|为什么|怎么)|\b(?:read|check|search|send|create|draw|save|delete|play|login|if|said|say|ask|why|how)\b/iu.test(clause) // i18n-allow: Preserve action, negation, reported-speech and hypothetical prefixes.
  ))) return extractSimpleDesktopOpenTarget(clauses[clauses.length - 1], analysis);
  // i18n-allow: Object-first launch instruction; exact single-clause input only.
  if (/^(?:(?:请|请你|帮我)\s*)?(?:先\s*)?(?:把|将|用)\s*[^，,。；;\n]{1,80}?(?:先\s*)?(?:打开|启动|运行)(?:一下|吧)?[。！!\s]*$/iu.test(text)) {
    const intent = normalizeActionIntent(text, analysis);
    if (intent.kind === 'desktop_operation' && intent.operation === 'navigate' && intent.sideEffectClass === 'none') return compact(intent.target);
  }
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const match = text.match(/^(?:(?:请|麻烦|请你|帮我|你帮我|给我|我要|我想)\s*)?(?:打开|启动|运行|开启|launch|open|start|run)\s*(?:程序|应用|app|软件)?\s*(?:一下)?\s*(.+?)[。！？.!?]*$/iu);
  if (!match) return '';
  const target = compact(match[1]);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (!target || /^(?:了|着|得|多久|这么久|这么慢|为什么|怎么|为何)/u.test(target)) return '';
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:然后|接着|随后|之后|以后|并且|同时|再(?:去|帮|给|用)?|打开后|启动后|运行后|\b(?:then|after|and\s+then)\b)/iu.test(target)) return '';
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:画图|绘制|出图|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|查找|发送|发布|播放|写入|执行脚本|运行脚本|问一下|问问|询问|回复|告诉|分析|总结|介绍|讲解|阅读|逐页|一页一页|\b(?:draw|draft|create|generate|edit|save|export|login|search|send|publish|play|script|ask|reply|tell|analy[sz]e|summari[sz]e|review|present)\b)/iu.test(target)) return '';
  return target;
}

export function isSimpleDesktopOpenRequest(input: string, analysis?: ActionIntentAnalysis): boolean {
  return Boolean(extractSimpleDesktopOpenTarget(input, analysis));
}

export function extractDesktopLaunchTarget(input: string, analysis?: ActionIntentAnalysis): string {
  const primary = extractPrimaryTaskText(input);
  const normalizedIntent = normalizeActionIntent(primary, analysis);
  if (
    normalizedIntent.kind === 'desktop_operation'
    && normalizedIntent.operation === 'navigate'
    && normalizedIntent.sideEffectClass === 'none'
    && compact(normalizedIntent.target)
    && isDesktopLaunchVerificationOnly(primary, normalizedIntent)
  ) return compact(normalizedIntent.target);
  return extractSimpleDesktopOpenTarget(primary, analysis);
}

/** A provider/model health question needs a real perception call. Directory
 * discovery, settings reads, and ordinary model prose cannot prove that the
 * configured visual path is usable right now. */
export function requiresVisualModelAvailabilityCheck(input: string): boolean {
  const text = compact(extractPrimaryTaskText(input));
  if (!text) return false;
  const visualRole = /(?:\u89c6\u89c9|\u56fe\u50cf|\u5c4f\u5e55)(?:\u6a21\u578b|\u8bc6\u522b|\u7406\u89e3|\u611f\u77e5)|\b(?:vision|visual)(?:\s+(?:model|provider|perception|recognition))?\b/iu.test(text);
  const liveProbe = /(?:\u68c0\u67e5|\u68c0\u6d4b|\u6d4b\u8bd5|\u9a8c\u8bc1|\u53ef\u7528|\u80fd\u7528|\u6b63\u5e38|\u72b6\u6001|\u8d77\u98de|\u6062\u590d)|\b(?:check|probe|test|verify|available|availability|working|healthy|status|back\s+online)\b/iu.test(text);
  return visualRole && liveProbe;
}

/** Positive music playback is a composite desktop goal: reaching the player
 * is only preparation, and a generic key dispatch is not playback state. */
export function requiresMediaPlaybackAction(input: string): boolean {
  const text = compact(extractPrimaryTaskText(input));
  if (hasExplicitNoMutationInstruction(text)) return false;
  if (isMediaPauseRequest(text)) return false;
  if (isVideoPlaybackRequest(text)) return true;
  if (!text || /(?:AutoCAD|\bCAD\b|\u56de\u653e\u56fe\u7eb8|\u7ed8\u56fe\u56de\u653e)/iu.test(text)) return false;
  const mediaSurface = /(?:\u7f51\u6613\u4e91(?:\u97f3\u4e50)?|QQ\s*\u97f3\u4e50|\u9177\u72d7(?:\u97f3\u4e50)?|\u97f3\u4e50|\u6b4c\u66f2|\u6b4c\u5355)|\b(?:NetEase|CloudMusic|Spotify|Apple\s+Music|music|song|playlist|music\s+player)\b/iu.test(text);
  // Natural follow-ups commonly omit \u201c\u9996\u201d: \u201c\u76f4\u63a5\u653e\u5f53\u524d\u7684\u97f3\u4e50\u201d still asks for
  // verified playback, not merely for the player/window to be discovered.
  const positivePlayback = /(?:\u64ad\u653e|\u653e\u4e00?\u9996|\u542c\u4e00?\u9996|\u7ee7\u7eed\u64ad\u653e|(?:\u7ed9\u6211)?\u76f4\u63a5\u653e(?:\u4e00\u4e0b)?(?:\u5f53\u524d(?:\u7684)?|\u73b0\u5728(?:\u7684)?|\u8fd9\u9996|\u97f3\u4e50|\u6b4c\u66f2?|\u5b83))|\b(?:play|resume|listen\s+to|put\s+on)\b/iu.test(text);
  return mediaSurface && positivePlayback;
}

export function requiresDesktopAiRequest(input: string): boolean {
  const text = compact(withoutLocationLiterals(extractPrimaryTaskText(input)));
  const positiveText = text.replace(
    /(?:不要|不得|禁止|严禁|无需|不需要|不能|别|避免)[^。！？!?；;\n]{0,96}(?:AI|模型|agent|智能体)[^。！？!?；;\n]*/giu,
    ' ',
  );
  // i18n-allow: multilingual desktop-AI surface recognition; not user-visible copy.
  const hasNamedAiSurface = /(?:WorkBuddy|Codex|ChatGPT|Claude|Gemini|DeepSeek|Kimi|豆包|通义|文心|Perplexity|Cursor|Copilot|Ollama|LM\s*Studio|Cherry\s*Studio|AnythingLLM|外部\s*AI|桌面\s*AI|AI\s*(?:工具|客户端|app))/iu.test(positiveText);
  // Generic words such as "模型" and "智能体" can identify an external AI target
  // only when a positive sentence actually directs work to or requests an
  // answer from them. A safety boundary such as "禁止凭模型记忆编造" must
  // not divert an industry task into the external-AI lane.
  const hasGenericAiTarget = /(?:问(?!题)(?:一下|问)?|询问|发给|发送给|交给|让|跟|和).{0,48}(?:AI|模型|agent|智能体)|(?:AI|模型|agent|智能体).{0,48}(?:聊天|对话|讨论|回答|协同|合作|汇总|对比)/iu.test(positiveText);
  // i18n-allow: multilingual external-AI request recognition; not user-visible copy.
  const requestedActionText = positiveText.replace(/https?:\/\/[^\s，。；;！？!?]+/giu, ' ')
    .replace(/(?:不要|别|不必|无需|不用)\s*(?:发送|发|进行)?(?:消息|聊天|对话)[^，,。；;！？!?\n]*/gu, ' '); // i18n-allow: Prohibited conversations are not requests to contact an AI.
  // i18n-allow: Positive external-AI action recognition.
  const hasAskAction = /(?:问(?!题)(?:一下|问)?|询问|发给|发送给|交给|跟|和).{0,48}(?:聊天|聊|对话|说|问|讨论)|(?:聊天|对话|讨论|回答|结果|总结|对比|汇总)|\b(?:ask|send\s+to|hand\s+off|chat|talk|discuss|answer|collect|compare|summari[sz]e)\b/iu.test(requestedActionText);
  return (hasNamedAiSurface || hasGenericAiTarget) && hasAskAction;
}

/** Inspection is a separate read capability; it never creates a submission contract. */
export function requiresDesktopAiInspection(input: string): boolean {
  const text = compact(withoutLocationLiterals(extractPrimaryTaskText(input)))
    .split(/(?:\bdo\s+not\b|不要|不得|禁止)/iu)[0]; // i18n-allow: Reviewed negated inspection request recognition.
  const target = /(?:\b(?:desktop|external|running)\s+AI\s+(?:applications?|apps?|tools?|clients?)\b|桌面\s*AI|外部\s*AI|Codex|ChatGPT|Claude|Cursor)/iu.test(text); // i18n-allow: Reviewed explicit AI application targets.
  return target && /(?:\b(?:inspect|list|detect|check|find)\b|检查|检测|查看|列出)/iu.test(text); // i18n-allow: Reviewed read-only inspection verbs.
}

export function requiresExternalAiHistory(input: string): boolean {
  const text = compact(withoutLocationLiterals(extractPrimaryTaskText(input)));
  // i18n-allow: Multilingual external-AI history target recognition; not user-visible copy.
  const hasExternalAiTarget = /(?:\b(?:ChatGPT|Claude|Gemini|DeepSeek|Kimi|Perplexity|Copilot|Cursor|Ollama|LM\s*Studio|external\s+AI|AI\s+(?:assistant|agent|app|chat))\b|外部\s*AI|AI\s*(?:助手|智能体|客户端|应用))/iu.test(text);
  // i18n-allow: Multilingual external-AI history action recognition; not user-visible copy.
  const hasHistoryAction = /(?:聊天(?:历史|记录|内容)|对话(?:历史|记录|内容)|历史(?:消息|会话)|同步.{0,24}(?:聊天|对话|历史)|导入.{0,24}(?:聊天|对话|历史)|授权.{0,24}(?:聊天|对话|历史)|读取.{0,24}(?:聊天|对话|历史|内容)|查看.{0,24}(?:聊天|对话|历史|内容)|\b(?:chat|conversation|message)\s+history\b|\b(?:sync|import|archive|authorize|read|view|search|query)\b.{0,48}\b(?:chat|conversation|message)\s+(?:history|content|archive)\b)/iu.test(text);
  // i18n-allow: Multilingual external-AI submission exclusion; not user-visible copy.
  const explicitNewSubmission = /(?:发给|发送给|交给|问问|询问|提问|让.{0,20}(?:回答|处理)|\b(?:ask|send\s+to|delegate|submit|prompt)\b)/iu.test(text);
  return hasExternalAiTarget && hasHistoryAction && !explicitNewSubmission;
}

export function requiresDesktopAiAnswerReadback(input: string): boolean {
  if (!requiresDesktopAiRequest(input)) return false;
  const text = compact(withoutLocationLiterals(extractPrimaryTaskText(input)));
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

export function isCustomerOperationsTurn(text: string): boolean {
  const customerSurface = /(?:\u5ba2\u6237|\u9500\u552e|\u7ebf\u7d22|\u552e\u540e|\u5ba2\u670d|\u5de5\u5355|\u5546\u673a|\u5ba2\u6237\u5173\u7cfb|\bCRM\b|customer|sales|lead|after[-\s]?sales|support\s+ticket)/iu.test(text);
  const operationalIntent = /(?:\u63a5\u7ba1|\u8ddf\u8fdb|\u63a8\u8fdb|\u5904\u7406|\u5206\u6790|\u8bc4\u5206|\u62a5\u4ef7|\u56de\u8bbf|\u6210\u4ea4|\u5f02\u8bae|\u5206\u7c7b|\u6d3e\u5355|\u7ef4\u62a4|\u8fd0\u8425|take\s*over|follow\s*up|advance|triage|qualif|score|quote|handle|operate|manage)/iu.test(text);
  const legalOnly = /(?:\u5408\u540c\u5ba1\u67e5|\u6cd5\u5f8b\u610f\u89c1|\u8d77\u8bc9|\u7b54\u8fa9|\u4ee3\u7406\u8bcd|contract\s+review|legal\s+opinion|pleading)/iu.test(text);
  const explicitLocalArtifact = /(?:[A-Za-z]:\\[^\n]+\.(?:txt|md|docx?|pdf|xlsx?|pptx?)\b|\b(?:local\s+)?file\b|本地文件)/iu.test(text)
    && /(?:读取|创建|生成|修改|保存|验证|read|create|generate|write|edit|save|verify)/iu.test(text);
  const actualCustomerOperation = /(?:发送|联系|回复|回访|派单|成交|CRM|客服工单|销售线索|send|contact|reply|call|ticket|lead\s+score)/iu.test(text);
  return customerSurface && operationalIntent && !legalOnly
    && !(explicitLocalArtifact && !actualCustomerOperation);
}

export function isEcommerceOperationsTurn(text: string): boolean {
  text = businessInstructionText(text);
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

export function isDesignDeliveryTurn(text: string): boolean {
  const designSurface = /(?:\u88c5\u4fee|\u5bb6\u88c5|\u5de5\u88c5|\u5ba4\u5185\u8bbe\u8ba1|\u7a7a\u95f4\u8bbe\u8ba1|\u5efa\u7b51\u8bbe\u8ba1|\u54c1\u724c\u8bbe\u8ba1|\u89c6\u89c9\u8bbe\u8ba1|\u54c1\u724c\u521b\u610f|\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|Revit|\bBIM\b|\bIFC\b|interior\s+design|spatial\s+design|architectural\s+design|brand\s+design|visual\s+design|\brender\b)/iu.test(text);
  const deliveryIntent = /(?:\u8bbe\u8ba1|\u751f\u6210|\u5236\u4f5c|\u7ed8\u5236|\u51fa\u56fe|\u4ea4\u4ed8|\u63a5\u7ba1|\u65b9\u6848|\u6a21\u578b|\u6539\u56fe|design|create|generate|produce|deliver|take\s*over|model|revise)/iu.test(text);
  return isCompositeDesignDeliveryTurn(text) || (designSurface && deliveryIntent);
}
export { hasNegatedMessagingSendIntent } from './normalized_action_intent';


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

export function requiresAuthenticatedWebResult(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const positiveText = text.replace(
    /(?:不要|不得|禁止|严禁|无需|不需要|不能|别|避免)[^。！？!?；;\n]{0,96}(?:登录|账号|账户|会话|login|log\s*in|sign\s*in|account|session)[^。！？!?；;\n]*/giu,
    ' ',
  );
  const hasAccountSurface = /\u767b\u5f55|\u81ea\u52a8\u767b\u5f55|\u8d26\u53f7|\u8d26\u6237|\u4f1a\u8bdd|login|log\s*in|sign\s*in|account|session/i.test(positiveText);
  const hasTargetWork = /\u67e5|\u627e|\u641c|\u68c0\u7d22|\u8bfb|\u4e0b\u8f7d|\u6253\u5f00|find|search|query|look\s*up|fetch|download/i.test(positiveText);
  return hasAccountSurface && hasTargetWork;
}

/** An existing browser session check is distinct from a managed account workflow. */
export function isBrowserSessionInspection(input: string): boolean {
  const text = extractPrimaryTaskText(input);
  const positive = text.split(/[，,。；;\n]/u).filter(clause => !/(?:不要|不发|不点|不用|无需)|\b(?:do not|don't|without)\b/iu.test(clause)).join(' '); // i18n-allow: negative scope in observation-only requests.
  return /(?:检查|核对|查看|确认).{0,32}(?:登录|会话)|(?:登录|会话).{0,24}(?:状态|是否|有效)|\b(?:check|inspect|verify)\b.{0,40}\b(?:login|session|logged.in)\b/iu.test(text) // i18n-allow: existing browser-session inspection intent.
    && !/(?:搜索|检索|查找|找一下|下载|发送|发布|创建|生成|导出|写入|修改|删除|下单|付款|点赞)|\b(?:search|look.up|download|send|publish|create|generate|export|write|modify|delete|pay|like)\b/iu.test(positive); // i18n-allow: separate authenticated account work.
}

export function isDocumentOpenAndReviewRequest(text: string): boolean {
  // i18n-allow: Requested document opening and content verification.
  if (/(?:不要|别|禁止|无需).{0,18}(?:打开|启动)|\b(?:do\s+not|don't|never|without)\b.{0,28}\b(?:open|launch)\b/iu.test(text)) return false;
  const candidate = text
    .replace(/(?:不能|不要|别|禁止|不可).{0,64}(?:替代|冒充|代替)/gu, ' ') // i18n-allow: Exact-target exclusions.
    .replace(/\b(?:do\s+not|don't|never)\b.{0,80}\b(?:substitute|replace|use\s+instead)\b/giu, ' ');
  const wantsOpen = /(?:打开|启动)|\b(?:open|launch)\b/iu.test(candidate); // i18n-allow: Open intent.
  const hasDocument = /(?:PDF|DOCX|PPTX?|XLSX?|文件|文档)|\b(?:pdf|docx?|pptx?|xlsx?|file|document)\b|\.(?:csv|txt|md|json|rtf)\b/iu.test(candidate) // i18n-allow: Document targets.
    || /(?:打开|启动|阅读|读取).{0,24}(?:报告|介绍)|(?:报告|介绍)(?:文件|文档)/u.test(candidate) // i18n-allow: Named report targets.
    || /\b(?:open|launch|read|review).{0,32}\breport\b/iu.test(candidate);
  const wantsReview = /(?:分析|总结|介绍|讲解|读取|阅读|逐页|一页一页|看一下|看看|核对|核验|检查|查看)|\b(?:analy[sz]e|summari[sz]e|review|read|present|walk\s+through|inspect|check|verify)\b/iu.test(candidate); // i18n-allow: Reading or inspecting contents is work after launch.
  return wantsOpen && hasDocument && wantsReview;
}

export function isDesktopLaunchVerificationOnly(
  text: string,
  normalizedIntent: ReturnType<typeof normalizeActionIntent>,
): boolean {
  if (
    normalizedIntent.kind !== 'desktop_operation'
    || normalizedIntent.operation !== 'navigate'
    || normalizedIntent.sideEffectClass !== 'none'
  ) return false;
  // A file mentioned only in a prohibition is not a file-reading task.
  // Stop at commas so a following affirmative operation stays visible.
  const withoutExclusions = text
    .replace(/(?:\u7981\u6b62|\u4e0d\u8981|\u4e0d\u51c6|\u4e0d\u5f97|\u4e0d\u7528|\u65e0\u9700|\u907f\u514d|\u52ff|\u522b)[^\u3002\uFF0C\uFF1B,;.!?\n\r]*/giu, ' ')
    .replace(/\b(?:do\s+not|don't|never|must\s+not|without)\b[^,.;!?\n\r]*/giu, ' ');
  if (isDocumentOpenAndReviewRequest(withoutExclusions)) return false;
  const target = compact(normalizedIntent.target);
  if (!target || /(?:https?:|www\.|\u7f51\u7ad9|\u7f51\u9875|\u6d4f\u89c8\u5668)/iu.test(target)) return false;
  if (/(?:\u767b\u5f55|\u641c\u7d22|\u67e5\u627e|\u627e\u4e00\u4e0b|\u8be2\u95ee|\u95ee\u4e00\u4e0b|\u56de\u590d|\u8f93\u5165|\u7f16\u8f91|\u53d1\u9001|\u64ad\u653e|\u521b\u5efa|\u751f\u6210|\u7ed8\u5236|\u753b\u56fe|\u70b9\u51fb|\u62d6\u62fd|\u9f20\u6807|\u952e\u76d8|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u53d1\u5e03)|\b(?:login|search|find|ask|message|reply|type|edit|send|play|create|generate|draw|operate|mouse|keyboard|cursor|click|drag|write|save|export|publish)\b/iu.test(withoutExclusions)) {
    return false;
  }
  return !/(?:\u6253\u5f00\u540e|\u542f\u52a8\u540e|\u8fd0\u884c\u540e|\u7136\u540e|\u63a5\u7740|\u968f\u540e|\u5e76\u4e14).{0,96}(?:\u8f93\u5165|\u7f16\u8f91|\u767b\u5f55|\u641c\u7d22|\u53d1\u9001|\u64ad\u653e|\u521b\u5efa|\u751f\u6210|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u53d1\u5e03)|\b(?:then|after)\b.{0,96}\b(?:type|edit|login|search|send|play|create|generate|write|save|export|publish)\b/iu.test(withoutExclusions);
}

export function requiresArtifactPostWriteReadback(input: string): boolean {
  // i18n-allow: locations and quoted document data are operands, not readback instructions.
  const text = withoutLocationLiterals(String(input || '')).replace(/((?:内容(?:为|是)|写入)\s*[：:]?\s*|\b(?:containing|content\s*(?:is|:|=))\s*)(?:“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`)/giu, '$1 ');
  // i18n-allow: explicit post-write verification input recognition.
  if (/(?:写完|保存完|创建完|生成完)(?:后|之后)?\s*(?:再|然后|并)?\s*(?:回读|重读|重新读取)/u.test(text)) return true;
  return /(?:\u5199\u5165|\u4fdd\u5b58|\u521b\u5efa|\u65b0\u5efa|\u751f\u6210).{0,48}(?:\u540e|\u4e4b\u540e|\u2192|->|\u7136\u540e|\u63a5\u7740|\u518d|\u5e76).{0,48}(?:\u91cd\u8bfb|\u56de\u8bfb|\u91cd\u65b0\u8bfb\u53d6|\u518d\u8bfb)|(?:\u91cd\u8bfb|\u56de\u8bfb|\u91cd\u65b0\u8bfb\u53d6|\u518d\u8bfb).{0,32}(?:\u6838\u9a8c|\u9a8c\u8bc1|\u68c0\u67e5|\u62a5\u544a)|\bafter\s+(?:writing|saving|creating)\b[\s\S]{0,420}\b(?:read|verify|check)\b|\b(?:write|save|create)\b[\s\S]{0,220}\b(?:then|afterwards|next)\b[\s\S]{0,220}\b(?:read|verify|check)\b|\b(?:write|save|create)\b[\s\S]{0,220}\band\s+(?:re)?read\s+(?:it\s+)?back\b/iu.test(text);
}

export function hasRequestedArtifactPostWriteReadback(
  records: ToolExecutionRecord[] = [],
  taskText = '',
): boolean {
  if (!requiresArtifactPostWriteReadback(taskText)) return true;
  return Boolean(resolveArtifactDelivery(records)?.readback);
}

export function requestedMediaPlayerTarget(taskText: string, analysis?: ActionIntentAnalysis): string {
  const text = compact(extractPrimaryTaskText(taskText));
  const videoPlayer = text.match(/(?:爱奇艺|优酷|腾讯视频|哔哩哔哩|芒果TV)|\b(?:iqiyi|youku|youtube|netflix|bilibili)\b/iu)?.[0]; // i18n-allow: Named video application recognition.
  if (videoPlayer) return videoPlayer;
  const named = text.match(/(?:\u7f51\u6613\u4e91(?:\u97f3\u4e50)?|QQ\s*\u97f3\u4e50|\u9177\u72d7(?:\u97f3\u4e50)?|Spotify|Apple\s+Music|NetEase(?:\s+Cloud\s+Music)?|CloudMusic)/iu)?.[0];
  return compact(named || extractDesktopLaunchTarget(text, analysis) || extractSimpleDesktopOpenTarget(text, analysis));
}

export function requiresArtifactOpen(input: string): boolean {
  // i18n-allow: quoted document text and locations are data, not opening instructions.
  const text = withoutLocationLiterals(input).replace(/((?:内容(?:为|是)|写入)\s*[：:]?\s*|\b(?:containing|content\s*(?:is|:|=))\s*)(?:“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`)/giu, '$1 ');
  // i18n-allow: reuse affirmative clauses so coordinated prohibitions stay negative.
  const positive = text.replace(/\bwithout\s+open(?:ing)?\b[^,;.!?\n]*/giu, ' ');
  return independentActionClauses(withoutNegatedLookupClauses(positive), true).some(clause => /打开|\bopen\b/iu.test(clause));
}

export function isDesktopAppInventoryRequest(text: string): boolean {
  return /\b(?:inspect|check|list|show|find|detect|inventory)\b.{0,64}\b(?:installed|launchable|available|local|app|application|software|program)\b|(?:\u68c0\u67e5|\u67e5\u770b|\u5217\u51fa|\u8bc6\u522b|\u68c0\u6d4b|\u76d8\u70b9|\u67e5\u627e).{0,32}(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u5e94\u7528|\u8f6f\u4ef6|\u7a0b\u5e8f)/iu.test(text);
}

export function isRunningSoftwareInspectionRequest(text: string): boolean {
  return requiresRunningProcessObservation(text);
}

export function requiresSourceGrounding(taskText: string): boolean {
  return /(?:\u6839\u636e|\u6309\u7167|\u91cc\u9762|\u6587\u4ef6\u5939|\u9644\u4ef6|\u56fe\u7247|\u539f\u56fe|\u73b0\u573a\u5c3a\u5bf8|provided|attached|source\s+(?:file|folder|drawing)|based\s+on)/iu.test(taskText);
}
