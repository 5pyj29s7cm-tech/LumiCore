import type { CapabilityLane, CapabilityOperation, ToolExecutionRecord } from '../tools/types';
import { hasMixedStatusExecutionIntent, isExplicitArtifactCreationText, isExternalCommitConfirmationOnlyRequest, normalizeActionIntent, withoutChatReplyDestination } from './normalized_action_intent';
import { LEGAL_ENTRY_PREFERRED_TOOLS, isLegalEntryTurn, isRemoteLegalMessageTurn } from './legal_entry';
import type { ActionIntentAnalysis } from './normalized_action_intent';
import { artifactRecordMatchesTurn } from '../tools/artifact_evidence';
import { projectArtifactProgress } from './artifact_progress';
import { matchesRequestedArtifactOutput } from './artifact_write_scope';
import { hasExplicitNoToolInstruction, isInformationOnlyQuestion } from './tool_intent';
import { withoutNegatedLookupClauses, compositeNavigationInstructions } from './normalized_action_intent';
import { withoutLocationLiterals } from './location_literals';
import { isAvatarAuthoringRequest } from './media_creation_intent';
import { classifyExternalCliIntent, isExternalCliDelegation, requestedCliProviders } from './external_cli_intent';
import { classifySkillAuthoringIntent, skillAuthoringTools, executionBeforeWorkflowSave } from '../skills/authoring_intent';
import { buildClientDiagnosticPlan } from './client_diagnostic_result';
import { classifyRuntimeWorkIntent } from './runtime_work_intent';
import { buildDesktopObservationPlan, evaluateDesktopObservationEvidence, requiresActiveWindowObservation, requiresDesktopFileListingObservation } from './desktop_observation';
import { isReadOnlyKnowledgeBaseInspectionRequest } from './knowledge_intent';
import { isMediaPauseRequest } from './media_intent';
import { CN_ACTION_CONTRACT_BLOCKERS, CN_RESULT_GROUNDING_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { isRuntimeCleanupOfferAcceptanceText } from './pending_assistant_offer';
import type { TaskCapsuleV1 } from '../conversation/task_capsule';
import type { AcceptedTaskTarget } from '../conversation/task_target_anchor';
import { verifiedSkillAuthoringReceipt } from '../skills/authoring_receipt';
import { verifiedExternalCliStatus } from './external_cli_status';
import { compact, parseRecordJson, terminalPayloadText, unique, expandSuccessfulRecords, matches, recordText, hasVisualModelAvailabilityEvidence } from "./action_contract_support";
import { extractPrimaryTaskText, isBrowserSessionInspection, requiresArtifactPostWriteReadback, requiresArtifactOpen, requiresCurrentAppUiMutation, CURRENT_TURN_ATTACHMENTS_RE, requiresVisualModelAvailabilityCheck, requestsBlankAutoCadDocument, isDesktopLaunchVerificationOnly, hasNegatedMessagingSendIntent, requiresCurrentAuthoringDocumentInspection, requiresExternalAiHistory, requiresDesktopAiRequest, requiresDesktopAiAnswerReadback, requiresMediaPlaybackAction, isSimpleDesktopOpenRequest, requiresCadGeometryExtractionOnly, isDesignDeliveryTurn, isEcommerceOperationsTurn, isCustomerOperationsTurn, requiresVisibleAutoCadExecution, requiresAutoCadMcpPlayback, requestedDesktopWindowAction, requiresSourceGrounding, extractDesktopLaunchTarget, extractSimpleDesktopOpenTarget, isDesktopAppInventoryRequest, isRunningSoftwareInspectionRequest } from "./action_request";
import { hasRequestedDesktopOpenEvidence, requestsExactReadOnlyArtifactInspection, hasMeaningfulArguments, hasVisibleAutoCadExecutionEvidence, hasBlankAutoCadDocumentEvidence, hasVerifiedExactReadOnlyArtifactEvidence, hasCurrentAppUiMutationEvidence, resolveVerifiedCurrentAuthoringDocumentEvidence, hasMatchingDesktopObservationEvidence } from "./action_desktop_evidence";
import { hasMediaPauseEvidence, hasMediaPlaybackEvidence } from "./action_media_evidence";

export type LumiActionContractKind =
  | 'avatar_authoring'
  | 'skill_authoring'
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
  | 'work_task'
  | 'external_ai_history'
  | 'external_ai_request'
  | 'external_cli_status'
  | 'extension_registry'
  | 'legal_document'
  | 'desktop_operation'
  | 'artifact_work';

export interface LumiActionContract {
  components?: Array<{ text: string; contract: LumiActionContract }>;
  applies: boolean;
  kind: LumiActionContractKind;
  label: string;
  coreAction: string;
  preparationIsNotCompletion: string[];
  requiredEvidence: string[];
  preferredTools: string[];
  verificationTools: string[];
  preferredCapabilities: ActionCapabilityRequirement[];
  verificationCapabilities: ActionCapabilityRequirement[];
  nextStep: string;
  caution: string;
}

export interface ActionCapabilityRequirement {
  lanes: CapabilityLane[];
  operations?: CapabilityOperation[];
  terms: string[];
}

const ACTION_CAPABILITY_REQUIREMENTS: Partial<Record<LumiActionContractKind, ActionCapabilityRequirement[]>> = {
  messaging_read: [{ lanes: ['messaging', 'desktop'], operations: ['observe'], terms: ['message', 'wechat', 'chat', 'window', 'screen', 'ocr'] }],
  messaging_send: [{ lanes: ['messaging', 'desktop'], operations: ['communicate', 'mutate'], terms: ['message', 'wechat', 'send', 'file', 'desktop'] }],
  browser_account: [{ lanes: ['web', 'desktop'], operations: ['observe', 'mutate'], terms: ['login', 'session', 'account', 'browser', 'page'] }],
  public_post: [{ lanes: ['web', 'desktop'], operations: ['communicate', 'mutate'], terms: ['post', 'publish', 'comment', 'browser', 'page'] }],
  cad_document: [{ lanes: ['cad'], operations: ['create', 'mutate'], terms: ['autocad', 'document', 'drawing'] }],
  cad_drafting: [{ lanes: ['cad', 'media', 'files', 'desktop'], operations: ['observe', 'create', 'mutate', 'test'], terms: ['cad', 'autocad', 'floorplan', 'geometry', 'drawing'] }],
  customer_operations: [{ lanes: ['agents', 'messaging', 'office', 'industry'], terms: ['customer', 'sales', 'lead', 'takeover', 'message'] }],
  ecommerce_operations: [{ lanes: ['industry', 'web', 'office', 'media'], terms: ['ecommerce', 'store', 'listing', 'inventory', 'campaign', 'content'] }],
  design_delivery: [{ lanes: ['cad', 'media', 'office', 'files'], terms: ['design', 'cad', 'image', 'presentation', 'document'] }],
  stock_monitor: [{ lanes: ['industry', 'web', 'agents'], operations: ['observe', 'create'], terms: ['stock', 'market', 'quote', 'watch', 'workflow'] }],
  task_control: [{ lanes: ['system', 'agents'], operations: ['observe', 'mutate'], terms: ['runtime', 'task', 'work', 'status', 'cancel'] }],
  work_task: [{ lanes: ['agents'], operations: ['create', 'observe', 'mutate'], terms: ['persistent', 'task', 'takeover', 'ledger', 'workflow'] }],
  external_ai_history: [{ lanes: ['agents'], operations: ['observe', 'create', 'mutate'], terms: ['external', 'ai', 'history', 'conversation', 'sync', 'authorization'] }],
  external_ai_request: [{ lanes: ['web', 'desktop'], operations: ['communicate', 'observe'], terms: ['external', 'ai', 'tool', 'answer', 'target'] }],
  external_cli_status: [{ lanes: ['agents'], operations: ['observe'], terms: ['external', 'cli', 'status'] }],
  extension_registry: [{ lanes: ['system'], operations: ['observe', 'test', 'mutate'], terms: ['extension', 'registry', 'provider', 'plugin', 'compatibility', 'rollback'] }],
  legal_document: [{ lanes: ['industry', 'web', 'office'], terms: ['legal', 'law', 'case', 'citation', 'court', 'document'] }],
  desktop_operation: [{ lanes: ['desktop'], operations: ['observe', 'mutate', 'test'], terms: ['desktop', 'window', 'application', 'native', 'screen', 'open'] }],
  artifact_work: [{ lanes: ['files', 'office', 'media'], operations: ['observe', 'create', 'mutate', 'test'], terms: ['file', 'document', 'artifact', 'create', 'verify'] }],
};

function actionCapabilityRequirements(kind: LumiActionContractKind): ActionCapabilityRequirement[] {
  return (ACTION_CAPABILITY_REQUIREMENTS[kind] || []).map(requirement => ({
    lanes: [...requirement.lanes],
    operations: requirement.operations ? [...requirement.operations] : undefined,
    terms: [...requirement.terms],
  }));
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
  preferredCapabilities: [],
  verificationCapabilities: [],
  nextStep: '',
  caution: '',
};

export function isNamedPersistentWorkTaskStatusQuery(text: string): boolean {
  const value = compact(text);
  const namesExactTask = /(?:\u4efb\u52a1|task)\s*[\u201c"']([^\u201d"']{1,140})[\u201d"']/iu.test(value);
  const namesPersistentLedger = /(?:\u6301\u4e45\u72b6\u6001|\u4efb\u52a1\u8d26\u672c|\u6301\u4e45\u4efb\u52a1)|\b(?:persistent task|task ledger)\b/iu.test(value);
  const asksStatus = /(?:\u67e5\u8be2|\u67e5\u770b|\u72b6\u6001|\u8fdb\u5ea6)|\b(?:query|status|progress)\b/iu.test(value);
  const createsTask = /(?:\u521b\u5efa|\u65b0\u5efa|\u6dfb\u52a0).{0,12}(?:\u6301\u4e45)?\u4efb\u52a1|\b(?:create|add)\b.{0,20}\b(?:persistent\s+)?task\b/iu.test(value);
  const namesTaskId = /\bwt_task_[A-Za-z0-9_-]+\b/u.test(value);
  return (namesExactTask || namesTaskId) && namesPersistentLedger && asksStatus
    && !createsTask && !hasMixedStatusExecutionIntent(value);
}

function extensionRegistryToolForAction(text: string): string | null {
  // i18n-allow: Multilingual signed-extension input recognition; not user-visible copy.
  const subject = /(?:\bext_[a-z0-9_.-]+\b|\b(?:signed\s+)?(?:extension|plugin)\b|\bopenai[-\s]?compatible\s+provider\b|\bcustom\s+(?:model\s+)?provider\b|\bprovider\s+registry\b|(?:Lumi\s*)?(?:签名扩展|扩展插件|插件扩展|插件|扩展|OpenAI\s*兼容(?:模型|Provider|提供商)?|自定义(?:模型)?\s*Provider|Provider\s*注册表))/iu.test(text);
  if (!subject) return null;
  // i18n-allow: Multilingual signed-extension rollback input recognition; not user-visible copy.
  if (/(?:回滚|恢复.{0,12}(?:版本|修订)|\brollback\b|\brevert\b)/iu.test(text)) return 'extension_registry_rollback';
  // i18n-allow: Multilingual signed-extension disable input recognition; not user-visible copy.
  if (/(?:停用|禁用|关闭|卸载|\bdisable\b|\bdeactivate\b|\buninstall\b)/iu.test(text)) return 'extension_registry_disable';
  // i18n-allow: Multilingual signed-extension receipt input recognition; not user-visible copy.
  if (/(?:回执|审计|记录|\breceipts?\b|\baudit\b)/iu.test(text)) return 'extension_registry_receipts';
  // i18n-allow: Multilingual signed-extension compatibility input recognition; not user-visible copy.
  if (/(?:测试|探测|健康检查|兼容性|\btest\b|\bprobe\b|\bhealth\s*check\b|\bcompatibility\b)/iu.test(text)) return 'extension_registry_test';
  // i18n-allow: Multilingual signed-extension install input recognition; not user-visible copy.
  if (/(?:安装|注册|接入|启用|激活|添加|\binstall\b|\bregister\b|\bactivate\b|\badd\b)/iu.test(text)) return 'extension_registry_install';
  // i18n-allow: Multilingual signed-extension list input recognition; not user-visible copy.
  if (/(?:列出|查看|显示|有哪些|清单|\blist\b|\bshow\b|\binspect\b)/iu.test(text)) return 'extension_registry_list';
  return null;
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

function buildVisualModelAvailabilityContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: 'Live visual-perception availability check',
    coreAction: 'Run one real current-screen perception request through the configured visual model and report whether it returned usable visual analysis.',
    preparationIsNotCompletion: [
      'reading model settings',
      'searching files or directories',
      'capturing an image without obtaining visual analysis',
    ],
    requiredEvidence: ['a successful current-turn OCR or visual-analysis receipt containing usable analysis text'],
    preferredTools: ['ocr_screen', 'ocr_region'],
    verificationTools: ['ocr_screen', 'ocr_region'],
    nextStep: 'Run one bounded visual probe and report the provider/account blocker naturally if it does not return analysis.',
    caution: 'File discovery, screenshots, and unrelated successful tools do not prove that the visual model is available.',
  });
}

function buildMediaPlaybackContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: 'Verified music playback',
    coreAction: 'Open or focus the requested music player and start playback in that exact player.',
    preparationIsNotCompletion: [
      'listing installed applications',
      'opening or focusing the music player',
      'dispatching a generic keyboard shortcut without observing playback state afterwards',
    ],
    requiredEvidence: [
      'matching player window/open evidence',
      'a verified playback receipt, or a playback action followed by visible playing-state evidence',
    ],
    preferredTools: ['computer_use', 'desktop_list_apps', 'desktop_open', 'desktop_active_window', 'desktop_ui_snapshot', 'ocr_screen'],
    verificationTools: ['computer_use', 'desktop_ui_snapshot', 'ocr_screen'],
    nextStep: 'Use computer_use with the exact player, song and performer to own the playback action and its read-only progress verification. It can focus, search and play as needed, and returns a verified playback receipt. Do not spend the turn repeatedly listing windows or capturing raw screenshots; raw image bytes are not perception. Once verified, report that receipt without restarting or toggling playback.',
    caution: 'A successful Space/media-key dispatch proves input delivery only; it cannot distinguish play from pause.',
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

function withDefaults(
  contract: Omit<LumiActionContract, 'applies' | 'preferredCapabilities' | 'verificationCapabilities'>,
): LumiActionContract {
  const preferredCapabilities = actionCapabilityRequirements(contract.kind);
  return {
    ...contract,
    applies: true,
    preparationIsNotCompletion: unique(contract.preparationIsNotCompletion),
    requiredEvidence: unique(contract.requiredEvidence),
    preferredTools: unique(contract.preferredTools),
    verificationTools: unique(contract.verificationTools),
    preferredCapabilities,
    verificationCapabilities: preferredCapabilities.map(requirement => ({
      ...requirement,
      lanes: [...requirement.lanes],
      operations: requirement.operations ? [...requirement.operations] : undefined,
      terms: [...requirement.terms],
    })),
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

function buildArtifactWorkContract(): LumiActionContract {
  return withDefaults({
    kind: 'artifact_work',
    label: '\u6587\u4ef6/\u4ea7\u7269\u4ea4\u4ed8',
    coreAction: '\u751f\u6210\u3001\u8bfb\u53d6\u6216\u4fee\u6539\u5b9e\u9645\u6587\u4ef6\u4ea7\u7269',
    preparationIsNotCompletion: ['\u5199\u51fa\u5927\u7eb2', '\u53ea\u6709\u6587\u672c\u8bf4\u660e', '\u53ea\u5217\u51fa\u6587\u4ef6\u5939'],
    requiredEvidence: ['file path exists with expected content/nonzero size', '\u6216\u5de5\u4f5c\u4ea7\u7269\u9a8c\u6536\u901a\u8fc7'],
    preferredTools: ['write_file', 'desktop_write_text_file', 'create_docx', 'create_ppt', 'create_pdf', 'desktop_path_info', 'work_product_verify'],
    verificationTools: ['desktop_path_info', 'work_product_verify'],
    nextStep: '\u6267\u884c\u6587\u4ef6\u751f\u6210/\u8bfb\u53d6\u5de5\u5177\u5e76\u9a8c\u8bc1\u4ea7\u7269\u3002',
    caution: '\u4e0d\u80fd\u628a\u804a\u5929\u6587\u672c\u6216\u8ba1\u5212\u8bf4\u6210\u5df2\u5199\u5165\u6587\u4ef6\u3002',
  });
}

function buildReadOnlyArtifactInspectionContract(): LumiActionContract {
  return withDefaults({
    kind: 'artifact_work',
    label: 'Exact read-only file inspection',
    coreAction: 'Read semantic content from the one exact absolute file path named by the user without mutating it.',
    preparationIsNotCompletion: [
      'listing a directory or searching for a possible file',
      'reading a model-selected path that the user did not name',
      'returning file metadata without semantic content',
      'reading a source file before an unfinished create, write, or edit action',
    ],
    requiredEvidence: [
      'verified read_file receipt for the same absolute path present in the accepted user task',
      'non-empty semantic file content from that receipt',
    ],
    preferredTools: ['read_file'],
    verificationTools: ['read_file'],
    nextStep: 'Read only the exact user-anchored file and answer from its verified semantic content.',
    caution: 'A basename, directory search, guessed path, metadata-only result, or preparatory read cannot complete this contract.',
  });
}

function buildDesktopOperationContract(): LumiActionContract {
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

export function getArtifactTaskProgress(task: string, records: ToolExecutionRecord[], turn: { requestId?: string; taskId?: string } = {}, analysis?: ActionIntentAnalysis) {
  const current = expandSuccessfulRecords(records).filter(record => artifactRecordMatchesTurn(record, turn));
  return projectArtifactProgress(task, current, {
    readbackRequired: requiresArtifactPostWriteReadback(task),
    openRequired: requiresArtifactOpen(task),
    openVerified: file => hasRequestedDesktopOpenEvidence(current, task, file, analysis),
    acceptsOutput: file => matchesRequestedArtifactOutput(task, file, analysis),
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

export function buildActionContract(input: string, acceptedIntent?: Readonly<ReturnType<typeof normalizeActionIntent>>, analysis?: ActionIntentAnalysis): LumiActionContract {
  const rawInput = String(input || '');
  const normalizedIntent = acceptedIntent || normalizeActionIntent(rawInput, analysis);
  const primaryTaskText = extractPrimaryTaskText(rawInput);
  if (hasExplicitNoToolInstruction(primaryTaskText || rawInput)) return NONE_CONTRACT;
  const components = compositeNavigationInstructions(primaryTaskText || rawInput)
    .map(item => ({ text: item.text, contract: buildActionContract(item.text, undefined, analysis) }));
  if (components.length > 1) {
    const primary = components.find(item => normalizeActionIntent(item.text, analysis).kind === 'desktop_operation')!.contract;
    const all = <K extends 'preferredTools' | 'verificationTools' | 'requiredEvidence'>(key: K) => Array.from(new Set(components.flatMap(item => item.contract[key])));
    return { ...primary, components, preferredTools: all('preferredTools'), verificationTools: all('verificationTools'),
      requiredEvidence: all('requiredEvidence'), coreAction: components.map(item => item.contract.coreAction).join('; '),
      nextStep: 'Complete every requested operation and verify each one. One successful operation does not complete the whole request.' };
  }
  if (primaryTaskText && primaryTaskText.trim() !== rawInput.trim()) {
    const primaryContract = buildActionContract(primaryTaskText, undefined, analysis);
    if (
      primaryContract.applies
      && primaryContract.kind !== 'none'
      && !requiresCurrentAppUiMutation(rawInput)
      && !(
        CURRENT_TURN_ATTACHMENTS_RE.test(rawInput)
        && primaryContract.label === 'Current authoring document inspection'
      )
    ) return primaryContract;
  }

  const text = compact(withoutLocationLiterals(withoutNegatedLookupClauses(rawInput), true));
  if (!text) return NONE_CONTRACT;
  const authoringContract = buildAuthoringActionContract(rawInput, text, analysis);
  if (authoringContract) return authoringContract;
  const runtimeContract = buildRuntimeControlContract(rawInput, text, primaryTaskText);
  if (runtimeContract) return runtimeContract;
  // Preserve a narrow local-file inspection candidate across the generic
  // question/status guards below. Domain-specific contracts still get first
  // refusal, and the candidate is materialized only near the artifact branch.
  const readOnlyArtifactInspection = requestsExactReadOnlyArtifactInspection(text);
  const desktopObservationPlan = buildDesktopObservationPlan(text);
  if (normalizedIntent.kind === 'client_navigation' && normalizedIntent.clientAction) {
    return withDefaults({
      kind: 'desktop_operation',
      label: 'Verified Lumi client action',
      coreAction: 'Apply the exact requested Lumi client navigation or mode change through the native client action router.',
      preparationIsNotCompletion: [
        'describing the intended client state',
        'reading the current client state without applying the requested action',
        'asking the user to expose a tool that is already authorized',
      ],
      requiredEvidence: [
        `a client_action receipt for ${normalizedIntent.clientAction} with verification.status=verified or not_applicable`,
      ],
      preferredTools: ['client_get_state', 'client_action'],
      verificationTools: ['client_get_state', 'client_action'],
      nextStep: 'Read current client state when needed, run the exact client action once, and report only the verified native result.',
      caution: 'Mode authorization and model schema projection are internal runtime facts. Never ask the user to enable a fictional tool mode or claim a UI change without a matching client_action receipt.',
    });
  }
  if (normalizedIntent.kind === 'client_state') {
    return withDefaults({
      kind: 'desktop_operation',
      label: 'Verified Lumi client state',
      coreAction: 'Read the current native Lumi client state requested by the user.',
      preparationIsNotCompletion: ['describing remembered or assumed client state'],
      requiredEvidence: ['a successful current-turn client_get_state receipt'],
      preferredTools: ['client_get_state'],
      verificationTools: ['client_get_state'],
      nextStep: 'Read the native client state and answer from that receipt.',
      caution: 'Do not infer the current mode, surface, or client state from conversation history.',
    });
  }
  if (
    !readOnlyArtifactInspection
    && desktopObservationPlan.length === 0
    && (
      normalizedIntent.kind === 'correction_explanation'
      || normalizedIntent.kind === 'client_navigation'
      || normalizedIntent.kind === 'status_query'
    )
  ) return NONE_CONTRACT;
  if (normalizedIntent.kind === 'work_task') {
    return withDefaults({
      kind: 'work_task',
      label: 'Persistent work task',
      coreAction: 'Create the explicitly requested persistent Lumi work task with its title, ordered next actions, and confirmation boundaries.',
      preparationIsNotCompletion: [
        'describing a task without persisting it',
        'reusing the previous conversation action task',
        'sending or submitting anything while creating the task',
      ],
      requiredEvidence: [
        'work_takeover_task_create receipt with ok=true, persisted=true, a stable task id, status, next actions, and confirmation boundaries',
      ],
      preferredTools: ['work_takeover_task_create'],
      verificationTools: ['work_takeover_task_get'],
      nextStep: 'Persist the exact new task, report its stable id and current state, and stop before any confirmation-gated external action.',
      caution: 'Task creation is an internal write only. Never inherit an unrelated prior task or perform the task\'s external send/submit step during creation.',
    });
  }
  // An explicit local artifact instruction owns every noun inside its payload.
  // Literal values such as "channel: command-center chat" or "status: pending"
  // must not be reclassified as messaging, navigation, or task-status work.
  if (isExplicitArtifactCreationText(text)) return buildArtifactWorkContract();
  const extensionRegistryTool = extensionRegistryToolForAction(text);
  if (extensionRegistryTool) {
    const mutating = ['extension_registry_install', 'extension_registry_rollback', 'extension_registry_disable'].includes(extensionRegistryTool);
    return withDefaults({
      kind: 'extension_registry',
      label: 'Signed extension and Provider registry',
      coreAction: 'Operate Lumi\'s signed declarative extension registry through signature, permission, compatibility, and transactional activation controls.',
      preparationIsNotCompletion: ['editing a manifest', 'saving a credential', 'probing an endpoint without a registry receipt', 'loading arbitrary extension code'],
      requiredEvidence: [mutating
        ? `${extensionRegistryTool} terminal receipt bound to the exact extension revision, manifest digest, signer fingerprint, and final activation state`
        : `${extensionRegistryTool} read-only registry or compatibility receipt`],
      preferredTools: [extensionRegistryTool],
      verificationTools: extensionRegistryTool === 'extension_registry_install'
        ? ['extension_registry_receipts', 'extension_registry_list']
        : ['extension_registry_list'],
      nextStep: mutating
        ? 'Require exact confirmation, then verify the signed manifest and compatibility probe before changing the active revision.'
        : 'Read or probe only the requested signed extension state and report its persistent receipt.',
      caution: 'Never execute arbitrary plugin code, embed credentials in a manifest, widen signed permissions, or bypass the unified tool policy and receipt pipeline.',
    });
  }
  if (requiresVisualModelAvailabilityCheck(text)) {
    return buildVisualModelAvailabilityContract();
  }
  if (isInformationOnlyQuestion(text, analysis) && !readOnlyArtifactInspection) return NONE_CONTRACT;
  if (isReadOnlyKnowledgeBaseInspectionRequest(text)) return NONE_CONTRACT;
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
  if (isDesktopLaunchVerificationOnly(text, normalizedIntent)) {
    return buildSimpleDesktopOpenContract();
  }
  const confirmationOnlyExternalCommit = isExternalCommitConfirmationOnlyRequest(text);
  const negatedMessagingSend = hasNegatedMessagingSendIntent(text) && !confirmationOnlyExternalCommit;
  const appInventoryInspection = /\b(?:inspect|check|list|show|find|detect|inventory)\b.{0,64}\b(?:installed|launchable|available|local|app|application|software|program|launch\s+target)\b|(?:\u68c0\u67e5|\u67e5\u770b|\u5217\u51fa|\u8bc6\u522b|\u68c0\u6d4b|\u76d8\u70b9|\u67e5\u627e).{0,32}(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u5e94\u7528|\u8f6f\u4ef6|\u7a0b\u5e8f|\u542f\u52a8\u5165\u53e3|\u5b89\u88c5\u72b6\u6001)/iu.test(text);
  const desktopObservationInspection = desktopObservationPlan.length > 0;
  const currentAuthoringDocumentInspection = requiresCurrentAuthoringDocumentInspection(rawInput);
  const directedMessageSend = normalizedIntent.kind === 'messaging_send' || (
    normalizedIntent.kind !== 'messaging_read'
    && (
      matches(text, /(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:(?:\u53d1\u9001|\u53d1)\s*[^,\uFF0C\u3002\uFF01\uFF1F!?;\uFF1B\u3001\n]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u)
      || matches(text, /\b(?:send\s+(?:a\s+)?(?:message|note|reply)\s+to|send\s+(?:him|her|them|the\s+(?:client|customer|contact|group))|message\s+(?:him|her|them|the\s+(?:client|customer|contact|group)|@?(?!(?:has|have|had|is|was|were|contains?|includes?|body|content|attachment|file|text)\b)[\p{L}\p{N}_.'-]{1,40})|reply\s+to)\b/iu)
    )
  );
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const directedMessagingInquiry = /(?:问(?:一下|问)?|询问)\s*[^\s，。！？,.!?:：;；、]{1,24}?(?:在干嘛|在做什么|干嘛|做什么|忙什么|现在怎么样|有没有空)/u.test(text);

  if (isRemoteLegalMessageTurn(text)) {
    return buildLegalDocumentContract();
  }
  const externalHistory = buildExternalHistoryActionContract(text);
  if (externalHistory) return externalHistory;

  if (requiresDesktopAiRequest(text)) {
    const collectAnswer = requiresDesktopAiAnswerReadback(text);
    return withDefaults({
      kind: 'external_ai_request',
      label: 'Verified external AI tool request',
      coreAction: 'Send the request to exactly one named external AI tool and keep LumiCore responsible for verifying and presenting the result.',
      preparationIsNotCompletion: ['planning a route', 'opening an AI app', 'focusing its window', 'pasting without submitting', 'claiming an answer without an archived source receipt'],
      requiredEvidence: [
        'desktop_ai_ask receipt for one named target with an explicit prepared or submitted state',
        ...(collectAnswer ? ['desktop_ai_collect_answer receipt with visible answer text attributed to the same target'] : []),
      ],
      preferredTools: ['desktop_ai_ask', 'desktop_ai_collect_answer', 'desktop_ai_list_targets'],
      verificationTools: collectAnswer ? ['desktop_ai_collect_answer'] : ['desktop_ai_ask'],
      nextStep: collectAnswer
        ? 'Read the visible answer from the same target; report pending, login, or vision blockers without resending.'
        : 'Stop on an unknown outcome and report the target state; never resend a possibly submitted request.',
      caution: 'External submission requires exact confirmation. A route plan, launched window, pressed shortcut, or unbound text is not proof of a provider answer.',
    });
  }

  // URLs and prohibitions on sending are not a request to read messages.
  // i18n-allow: Negative message-action clause recognition.
  const messageSourceText = withoutChatReplyDestination(text).replace(/https?:\/\/[^\s，。；;！？!?]+/giu, ' ')
    .replace(/(?:不要|无需|不用|别|不)\s*(?:发送|发|读|读取|查看)(?:任何)?(?:消息|聊天|对话)[^，,。；;！？!?\n]*/gu, ' ');
  if (
    !readOnlyArtifactInspection &&
    matches(messageSourceText, /wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f|message|chat/i) &&
    matches(messageSourceText, /\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3|read|view|inspect|recent|history/i) &&
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
    (!matches(text, /\u8349\u7a3f|\u5148\u5199|\u4e0d\u8981\u53d1|\bdraft\b/i) || confirmationOnlyExternalCommit)
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

  if (isMediaPauseRequest(text)) {
    const contract = buildMediaPlaybackContract();
    return { ...contract, label: 'Verified media pause',
      coreAction: 'Pause the requested player and verify that its current playback state is paused.',
      requiredEvidence: ['current-turn observation of the requested player with an explicit paused state'],
      nextStep: 'Observe the player first; if it is already paused, stop. Otherwise pause once, then observe the paused state without toggling again.' };
  }
  if (requiresMediaPlaybackAction(text)) {
    return buildMediaPlaybackContract();
  }

  if (isSimpleDesktopOpenRequest(text, analysis)) {
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

  const positiveBrowserAccountText = text.replace(
    /(?:不要|不得|禁止|严禁|无需|不需要|不能|别|避免)[^。！？!?；;\n]{0,96}(?:登录|浏览器|打开网站|外部网站|网页|网站|login|log\s*in|browser|website|site)[^。！？!?；;\n]*/giu,
    ' ',
  );
  if (
    matches(positiveBrowserAccountText, /\u767b\u5f55|\u6d4f\u89c8\u5668|\u6253\u5f00\u7f51\u7ad9|\u81ea\u52a8\u767b\u5f55|browser|login|log\s*in|website|site/i) &&
    !matches(text, /\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u753b\u56fe|\u753b\u56fe\u7eb8|\u56fe\u7eb8|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u88c5\u4fee|cad/i)
  ) {
    return withDefaults({
      kind: 'browser_account',
      label: '\u6d4f\u89c8\u5668/\u8d26\u53f7\u64cd\u4f5c',
      coreAction: '\u6253\u5f00\u76ee\u6807\u7ad9\u70b9\uff0c\u68c0\u67e5\u5f53\u524d\u4f1a\u8bdd\uff0c\u4f7f\u7528\u53ef\u63a7\u6d4f\u89c8\u5668\u6216\u684c\u9762\u8fdb\u884c\u767b\u5f55\u540e\u64cd\u4f5c',
      preparationIsNotCompletion: ['\u6253\u5f00\u6d4f\u89c8\u5668', '\u6253\u5f00\u767b\u5f55\u9875', '\u770b\u5230\u7f51\u7ad9\u9996\u9875'],
      requiredEvidence: ['logged-in page/session evidence', '\u76ee\u6807\u9875\u9762\u72b6\u6001\u6216\u8d26\u53f7\u72b6\u6001\u9a8c\u8bc1', '\u82e5\u8bf7\u6c42\u5305\u542b\u68c0\u7d22/\u67e5\u627e\uff1b\u8fd8\u9700\u8981\u76ee\u6807\u68c0\u7d22\u7ed3\u679c\u6216\u660e\u786e\u7684\u672a\u767b\u5f55/\u9a8c\u8bc1\u963b\u585e\u8bc1\u636e'],
      preferredTools: [...(isBrowserSessionInspection(text) ? ['browser_open_task', 'desktop_active_window', 'desktop_ui_snapshot', 'ocr_screen'] : []), 'web_login_profile_list', 'web_login_profile_save_from_preset', 'web_login_run', 'url_fetch_logged_in', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_click', 'browser_open_task', 'desktop_active_window', 'desktop_ui_snapshot', 'ocr_screen'],
      verificationTools: ['desktop_ui_snapshot', 'ocr_screen', 'web_login_run', 'url_fetch_logged_in', 'mcp_playwright_browser_snapshot'],
      nextStep: isBrowserSessionInspection(text)
        ? 'Open the exact URL in the requested browser and inspect that same window using desktop_ui_snapshot or ocr_screen. An empty Lumi login-profile list does not prove the browser is logged out: its cookies/password store are separate. Do not create a new profile or start a separate browser merely to inspect the existing session. Report visible account or login-form evidence; if verification is required, explain that specific step.'
        : 'First inspect saved login profiles or existing sessions. Reuse an authorized profile with web_login_run for the requested account work, and verify the target results. Stop at missing credentials, QR/captcha/2FA or an external submission requiring confirmation.',
      caution: '\u4e0d\u80fd\u628a\u6253\u5f00\u7f51\u9875\u8bf4\u6210\u5df2\u767b\u5f55\u6216\u5df2\u5b8c\u6210\u8d26\u53f7\u64cd\u4f5c\u3002',
    });
  }

  const conversationalNoArtifactMutation = /[？?]|(?:先聊|只回答|告诉我|你认为|解释)/u.test(text)
    && /(?:不要|别|无需|不用|禁止|请勿|勿).{0,16}(?:修改|改动|改写|写入|保存|覆盖|创建|新建|生成).{0,12}(?:文件|文档|内容)?/u.test(text)
    && !/(?:读取|查看|检查|分析|总结).{0,80}(?:文件|文档|路径|[A-Za-z]:\\|\.(?:txt|md|docx?|pdf|xlsx?|pptx?)\b)|(?:read|inspect|review|analy[sz]e|summari[sz]e).{0,80}(?:file|document|path|\.(?:txt|md|docx?|pdf|xlsx?|pptx?)\b)/iu.test(text);
  if (conversationalNoArtifactMutation) return NONE_CONTRACT;

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
        ? ['one verified cad_draw_floorplan_in_autocad receipt, or source geometry plus an operation set and AutoCAD completion marker with exact operationCount, expectedEntityCount, and entitiesAdded equality']
        : ['created CAD/DXF file path with nonzero size and successful file verification'],
      preferredTools: visibleAutoCad
        ? ['cad_draw_floorplan_in_autocad', 'desktop_list_files', 'desktop_path_info', 'desktop_list_apps', 'desktop_open', 'desktop_running_processes', 'desktop_active_window', 'floorplan_extract_geometry', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'desktop_capture_screen']
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

  if (currentAuthoringDocumentInspection) {
    return withDefaults({
      kind: 'desktop_operation',
      label: 'Current authoring document inspection',
      coreAction: 'Anchor exactly one visible WPS/Office document window (background or foreground), resolve one exact file path, and read its contents for the requested analysis.',
      preparationIsNotCompletion: [
        'observing only an application process without a document title',
        'choosing one item from multiple visible authoring-document candidates',
        'guessing a document from a window title without resolving an exact target',
        'listing candidate files without reading the confirmed document',
      ],
      requiredEvidence: [
        'verified native receipt identifying exactly one supported WPS/Office document title',
        'one exact matching path from the native window receipt, durable target capsule, or unique bounded file discovery',
        'successful content-reader receipt bound to that exact path',
      ],
      preferredTools: [
        'desktop_running_processes',
        'desktop_active_window',
        'desktop_list_files',
        'search_files',
        'desktop_path_info',
        'read_file',
        'extract_document_text',
        'read_pdf',
        'read_docx',
        'read_xlsx',
      ],
      verificationTools: ['desktop_running_processes', 'desktop_active_window', 'desktop_path_info'],
      nextStep: 'Inspect supported background document windows first; if exactly one title exists, resolve only that filename inside bounded user locations and read it. Otherwise inspect the foreground once and ask the user to focus the intended document if ambiguity remains.',
      caution: 'A process name or one item chosen from multiple window titles is never a document anchor; a unique title still requires one exact matching path before completion.',
    });
  }

  if (desktopObservationInspection) {
    const preferredTools = desktopObservationPlan.map(call => call.name);
    const requiredEvidence = preferredTools.map(toolName => (
      `a verified current-turn ${toolName} receipt with structured native desktop data`
    ));
    return withDefaults({
      kind: 'desktop_operation',
      label: CN_RESULT_GROUNDING_MESSAGES.desktopObservationLabel,
      coreAction: 'Read every explicitly requested local system, application, process, window, idle-state, or Desktop-directory observation from the connected desktop client.',
      preparationIsNotCompletion: [
        'reading only one item while omitting another observation requested in the same turn',
        'listing capability metadata without observing the computer',
        'treating the user home directory as the Desktop directory',
      ],
      requiredEvidence,
      preferredTools,
      verificationTools: preferredTools,
      nextStep: 'Run each planned read-only observation and summarize only the fresh structured receipts.',
      caution: 'Do not use history, a capability manifest, or one partial receipt as a substitute for all requested machine evidence. A bounded computer inventory does not authorize recursively reading personal file contents.',
    });
  }

  if (readOnlyArtifactInspection) return buildReadOnlyArtifactInspectionContract();

  if (matches(text, /\u6587\u4ef6|\u6587\u6863|PPT|PDF|txt|markdown|md\b|docx|xlsx|pptx|\u521b\u5efa|\u5199\u5165|\u751f\u6210|\u5bfc\u51fa|\u4fdd\u5b58|create|write|generate|export|save/i)) {
    return buildArtifactWorkContract();
  }

  if (appInventoryInspection || matches(text, /\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u70b9\u51fb|\u8f93\u5165|\u5e94\u7528|\u8f6f\u4ef6|desktop|open|click|type|app|application/i)) {
    return buildDesktopOperationContract();
  }

  return NONE_CONTRACT;
}

/**
 * Completion truth is intentionally stricter than execution authority. A
 * referential cleanup utterance without its adjacent frozen task-id offer is
 * not allowed to route a cancel-all call, but it still cannot be marked done
 * from directory/search receipts. Evidence adjudicators use this projection;
 * planners and routers must continue using buildActionContract.
 */
export function buildActionEvidenceContract(input: string, analysis?: ActionIntentAnalysis): LumiActionContract {
  const contract = buildActionContract(input, undefined, analysis);
  if (contract.applies || !isRuntimeCleanupOfferAcceptanceText(compact(input))) {
    return contract;
  }
  return buildActionContract('Cancel all active background tasks', undefined, analysis);
}

function hasVerifiedManifestCapabilityEvidence(
  contract: LumiActionContract,
  records: ToolExecutionRecord[],
): boolean {
  return records.some(record => {
    if (record.terminalVerification?.status !== 'verified' || !record.capability) return false;
    const searchText = [
      record.name,
      record.capability.capabilityId,
      record.evidence?.capability || '',
    ].join(' ').toLowerCase();
    return contract.verificationCapabilities.some(requirement => (
      requirement.lanes.includes(record.capability!.lane)
      && (!requirement.operations?.length || requirement.operations.includes(record.capability!.operation))
      && requirement.terms.some(term => searchText.includes(term.toLowerCase()))
    ));
  });
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
    ? /^(?:generate_image(?:_dalle)?|edit_image|ai_edit_image|mcp_.+_(?:generate|edit)_image)$/i
    : kind === 'video'
      ? /^(?:generate_video|mcp_.+_(?:generate|create)_video)$/i
      : /^(?:generate_image(?:_dalle)?|edit_image|ai_edit_image|generate_video|mcp_.+_(?:generate|edit|create)_(?:image|video))$/i;
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

  const analyzed = records.some(record => /^(?:mcp_ecommerce-ops_|business_ecommerce_|industry_ecommerce_(?:today_snapshot|store_data_snapshot|listing_action_queue|customer_service_drafts|trend_discovery)$)/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20
    && (!record.name.startsWith('industry_') || (record.terminalVerification?.status === 'verified' && parseRecordJson(record)?.status === 'verified')));
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
  return records.some(record => /^(?:read_file|read_files_batch|read_pdf|read_docx|extract_document_text|ocr_image_file|floorplan_extract_geometry|cad_draw_floorplan_in_autocad)$/i.test(record.name));
}

function hasGroundedCadGeometryEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.name === 'cad_draw_floorplan_in_autocad') {
      const payload = parseRecordJson(record);
      return !record.error
        && payload?.status === 'completed'
        && Boolean(String(payload?.geometryReceiptPath || '').trim())
        && Boolean(String(payload?.geometryHash || '').trim());
    }
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
  taskCapsule?: TaskCapsuleV1 | null,
  currentTurn?: { requestId?: string; taskId?: string },
  acceptedTaskTarget?: AcceptedTaskTarget, analysis?: ActionIntentAnalysis
): boolean {
  if (!contract.applies) return true;
  if (contract.components?.length) return contract.components.every(item => hasCoreActionEvidence(item.contract, records, item.text, taskCapsule, currentTurn, acceptedTaskTarget, analysis));
  if (contract.kind === 'skill_authoring') return Boolean(verifiedSkillAuthoringReceipt(taskText, records, currentTurn));
  const successful = expandSuccessfulRecords(records);
  const recoverableObservedOpen = contract.kind === 'desktop_operation'
    ? (() => {
        const target = extractDesktopLaunchTarget(taskText, analysis) || extractSimpleDesktopOpenTarget(taskText, analysis);
        return Boolean(target) && records.some(record => (
          /^(?:desktop_open|browser_open_task)$/iu.test(String(record.name || ''))
          && hasRequestedDesktopOpenEvidence([record], taskText, target, analysis)
        ));
      })()
    : false;
  if (successful.length === 0 && !recoverableObservedOpen) return false;
  if (contract.kind === 'avatar_authoring') return successful.some(record => {
    if (!['memory_avatar_read','memory_avatar_configure_animation','memory_avatar_create','memory_avatar_import_image'].includes(record.name)) return false;
    const p = parseRecordJson(record);
    if (p?.verified !== true || p.saved !== true || !p.avatarId) return false;
    // i18n-allow: requested animation features must have corresponding saved evidence.
    if (/动画|animation/iu.test(taskText) && !p.animation?.configured) return false;
    if (/眨眼|闭眼|blink/iu.test(taskText) && !p.animation?.blink) return false;
    // i18n-allow: feature names parsed from the user's request, not UI text.
    if (/口型|说话|lip|speech/iu.test(taskText) && !p.animation?.speech) return false;
    // i18n-allow: requested animation feature.
    if (/呼吸|breath/iu.test(taskText) && !p.animation?.breathing) return false;
    // i18n-allow: requested environment animation feature.
    if (/背景动画|环境微动|背景微动|background\s*(?:motion|animation)/iu.test(taskText) && !p.animation?.backgroundMotion) return false;
    const samePersonReceipt = (name: string) => successful.some(item => item.name === name && parseRecordJson(item)?.avatarId === p.avatarId);
    // i18n-allow: requested person creation requires creation evidence.
    if (/新建|创建|create/iu.test(taskText) && !samePersonReceipt('memory_avatar_create')) return false;
    // i18n-allow: requested media import requires import evidence.
    if (/导入|import/iu.test(taskText) && (!p.media?.length || !samePersonReceipt('memory_avatar_import_image'))) return false;
    return true;
  });
  if (contract.kind === 'task_control') {
    const intent = classifyRuntimeWorkIntent(taskText);
    const expectedTool = contract.preferredTools.includes('runtime_work_cancel')
      ? 'runtime_work_cancel'
      : intent === 'cancel'
        ? 'runtime_work_cancel'
        : 'runtime_work_status';
    return successful.some(record => {
      if (record.name !== expectedTool) return false;
      const payload = parseRecordJson(record);
      if (payload?.ok !== true) return false;
      if (expectedTool === 'runtime_work_cancel') {
        return ['idle', 'cancelled'].includes(String(payload.status || ''))
          && Number.isFinite(Number(payload.matchedCount))
          && Number.isFinite(Number(payload.cancelledCount))
          && Number.isFinite(Number(payload.cancellingCount))
          && Number(payload.failedCount || 0) === 0;
      }
      return ['idle', 'active', 'paused', 'attention'].includes(String(payload.status || ''))
        && Number.isFinite(Number(payload.activeCount));
    });
  }
  if (contract.kind === 'messaging_read') {
    return successful.some(record =>
      record.name === 'wechat_read_recent_chat' && /"read"\s*:\s*true|read:\s*true/i.test(String(record.result || ''))
    ) || successful.some(record => /^(ocr_screen|desktop_capture_screen|desktop_ui_snapshot)$/i.test(record.name))
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'messaging_send') {
    return successful.some(record =>
      record.name === 'wechat_send_message' && /"sent"\s*:\s*true|sent:\s*true/i.test(String(record.result || ''))
    ) || successful.some(record => hasRequestedMessagingFileEvidence(record, taskText))
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'public_post') {
    return hasPublicPostEvidence(successful) || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'browser_account') {
    return Boolean(browserSessionObservation(successful, taskText)) || hasAuthenticatedWebResultEvidence(successful, taskText)
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
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
    return successful.some(record => /legal_|read_|create_docx|write_file|desktop_path_info|work_product_verify/i.test(record.name))
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'artifact_work') {
    const resolvedTarget = acceptedTaskTarget || (taskCapsule?.target.path && taskCapsule.target.status !== 'rejected'
      && (!currentTurn?.taskId || taskCapsule.taskId === currentTurn.taskId)
      ? { target: taskCapsule.target, source: 'task' as const, sourceId: taskCapsule.taskId } : undefined);
    if (requestsExactReadOnlyArtifactInspection(taskText)) {
      return hasVerifiedExactReadOnlyArtifactEvidence(successful, taskText, resolvedTarget);
    }
    const current = successful.filter(record => artifactRecordMatchesTurn(record, currentTurn || {}));
    return getArtifactTaskProgress(taskText, current, undefined, analysis)?.complete === true;
  }
  if (contract.kind === 'external_cli_status') return verifiedExternalCliStatus(taskText, records, currentTurn) !== null;
  if (contract.kind === 'external_ai_request') {
    if (isExternalCliDelegation(taskText)) {
      const requested = requestedCliProviders(taskText);
      const providers = requested.length ? requested : ['codex', 'claude'];
      const completed = (provider: string) =>
        successful.some(record => {
          const payload = parseRecordJson(record);
          return record.name === 'external_cli_run' && record.terminalVerification?.status === 'verified'
            && artifactRecordMatchesTurn(record, currentTurn || {}) && payload?.ok === true
            && payload.status === 'completed' && payload.exitCode === 0 && Boolean(compact(payload.response))
            && Boolean(payload.runId) && payload.provider === provider;
        });
      return requested.length ? providers.every(completed) : providers.some(completed);
    }
    const hasSubmission = successful.some(record => {
      const payload = parseRecordJson(record);
      return record.name === 'desktop_ai_ask'
        && payload?.ok === true
        && ['prepared', 'submitted_unverified'].includes(String(payload?.status || ''))
        && Array.isArray(payload?.results)
        && payload.results.length === 1;
    });
    const hasAnswer = successful.some(record => {
      const payload = parseRecordJson(record);
      return record.name === 'desktop_ai_collect_answer'
        && payload?.status === 'collected'
        && Boolean(compact(payload?.answerText));
    });
    if (requiresDesktopAiAnswerReadback(taskText)) return hasAnswer;
    return hasSubmission || hasAnswer;
  }
  if (contract.kind === 'external_ai_history') {
    return successful.some(record => {
      const payload = parseRecordJson(record);
      if (record.name === 'external_ai_history_source_register') {
        return payload?.ok === true
          && ['registered', 'already_registered'].includes(String(payload?.status || ''))
          && Boolean(compact(payload?.authorizationDigest));
      }
      if (record.name === 'external_ai_history_source_revoke') {
        return payload?.ok === true && payload?.status === 'revoked';
      }
      if (record.name === 'external_ai_history_sync') {
        return payload?.verified === true
          && ['completed', 'partial'].includes(String(payload?.status || ''))
          && Boolean(compact(payload?.jobId));
      }
      if (record.name === 'external_ai_history_query') {
        return payload?.ok === true && payload?.status === 'queried' && Array.isArray(payload?.messages);
      }
      if (record.name === 'external_ai_history_status') {
        return payload?.ok === true && Boolean(payload?.source);
      }
      if (record.name === 'external_ai_history_source_list') {
        return payload?.ok === true && payload?.status === 'listed' && Array.isArray(payload?.sources);
      }
      return false;
    });
  }
  if (contract.kind === 'desktop_operation') {
    if (contract.label === 'Current Lumi runtime diagnostic') {
      return contract.verificationTools.every(name => successful.some(record => {
        if (record.name !== name) return false;
        const payload = parseRecordJson(record);
        return Boolean(payload) && payload?.ok !== false && payload?.success !== false
          && !/^(?:failed|error|blocked|denied|timeout|unavailable)$/.test(String(payload?.status || ''));
      }));
    }
    const clientIntent = normalizeActionIntent(taskText, analysis);
    if (clientIntent.kind === 'client_navigation' && clientIntent.clientAction) {
      return successful.some(record => {
        if (record.name !== 'client_action') return false;
        const payload = parseRecordJson(record);
        const status = String(payload?.verification?.status || payload?.status || '').toLowerCase();
        const action = String(payload?.action || record.arguments?.action || '');
        return action === clientIntent.clientAction
          && payload?.ok !== false
          && /^(?:verified|not_applicable)$/.test(status);
      });
    }
    if (clientIntent.kind === 'client_state') {
      return successful.some(record => (
        record.name === 'client_get_state'
        && Boolean(parseRecordJson(record))
      ));
    }
    if (requiresVisualModelAvailabilityCheck(taskText)) {
      return hasVisualModelAvailabilityEvidence(records);
    }
    if (isMediaPauseRequest(taskText)) return hasMediaPauseEvidence(records, taskText, currentTurn, analysis);
    if (requiresMediaPlaybackAction(taskText)) {
      return hasMediaPlaybackEvidence(records, taskText, currentTurn, analysis);
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
    // A named application can be both the launch target and the surface for a
    // follow-on mutation (for example, "Open WPS and create a Word
    // document").  In that composite case an exact desktop_open receipt only
    // proves the first boundary.  Evaluate the mutation contract before the
    // simpler launch contract so a confirmed open cannot prematurely complete
    // the whole durable task.
    if (requiresCurrentAppUiMutation(taskText)) {
      return hasCurrentAppUiMutationEvidence(records, taskText);
    }
    if (requiresCurrentAuthoringDocumentInspection(taskText)) {
      return Boolean(resolveVerifiedCurrentAuthoringDocumentEvidence(
        records,
        taskText,
        taskCapsule,
      ));
    }
    const desktopObservation = evaluateDesktopObservationEvidence(records, taskText);
    if (desktopObservation.requested) return desktopObservation.complete;
    const desktopLaunchTarget = extractDesktopLaunchTarget(taskText, analysis);
    const needsActiveWindow = requiresActiveWindowObservation(taskText);
    const needsDesktopFiles = requiresDesktopFileListingObservation(taskText);
    if (desktopLaunchTarget) {
      const openedExactTarget = hasRequestedDesktopOpenEvidence(records, taskText, desktopLaunchTarget, analysis);
      if (!openedExactTarget) return false;
      const hasBoundOpenAction = records.some(record => (
        /^(?:desktop_open|browser_open_task)$/iu.test(String(record.name || ''))
        && hasRequestedDesktopOpenEvidence([record], taskText, desktopLaunchTarget, analysis)
      ));
      if (!hasBoundOpenAction) return false;
      if (needsActiveWindow && !successful.some(record => hasMatchingDesktopObservationEvidence(record, desktopLaunchTarget))) {
        return false;
      }
      return !needsDesktopFiles || successful.some(record => /^desktop_list_files$/i.test(record.name));
    }
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
    if (isDesktopAppInventoryRequest(taskText)) {
      return successful.some(record => record.name === 'desktop_list_apps');
    }
    if (isRunningSoftwareInspectionRequest(taskText)) {
      return successful.some(record => /^(?:desktop_running_processes|get_running_processes)$/i.test(record.name));
    }
    if (isSimpleDesktopOpenRequest(taskText, analysis)) {
      const target = extractSimpleDesktopOpenTarget(taskText, analysis);
      return successful.some(record => (
        /^(?:desktop_open|browser_open_task)$/iu.test(String(record.name || ''))
        && hasRequestedDesktopOpenEvidence([record], taskText, target, analysis)
      ));
    }
    return hasVerifiedGenericDesktopMutation(successful)
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  return successful.length > 0;
}

export function formatActionContractPrompt(contract: LumiActionContract): string {
  if (!contract.applies) return '';
  const capabilityRequirements = contract.preferredCapabilities.map(requirement => {
    const operations = requirement.operations?.length
      ? `; operations=${requirement.operations.join('|')}`
      : '';
    return `lanes=${requirement.lanes.join('|')}${operations}; terms=${requirement.terms.join('|')}`;
  });
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
    capabilityRequirements.length
      ? `Capability requirements: ${capabilityRequirements.join('; ')}. Resolve actual tools from the current CapabilityManifest.`
      : '',
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
export { extractExplicitArtifactTextRequirements } from './artifact_progress';
export { hasVisualModelAvailabilityEvidence } from "./action_contract_support";
export { extractPrimaryTaskText, type DesktopWindowAction, requestedDesktopWindowAction, requiresCurrentAppUiMutation, requiresCurrentAuthoringDocumentInspection, extractCurrentAppTarget, extractRequestedCurrentAppText, claimsCurrentAppSaveCompletion, extractSimpleDesktopOpenTarget, isSimpleDesktopOpenRequest, extractDesktopLaunchTarget, requiresVisualModelAvailabilityCheck, requiresMediaPlaybackAction, requiresDesktopAiRequest, requiresDesktopAiInspection, requiresExternalAiHistory, requiresDesktopAiAnswerReadback, requiresCadGeometryExtractionOnly, requiresVisibleAutoCadExecution, requestsBlankAutoCadDocument, requiresAutoCadMcpPlayback, requiresAuthenticatedWebResult, isBrowserSessionInspection, isDocumentOpenAndReviewRequest, requiresArtifactPostWriteReadback, hasRequestedArtifactPostWriteReadback, requestedMediaPlayerTarget, requiresArtifactOpen, isRunningSoftwareInspectionRequest } from "./action_request";
export { hasVisibleAutoCadExecutionEvidence, hasBlankAutoCadDocumentEvidence, hasRequestedDesktopOpenEvidence, hasCurrentAppSaveEvidence, hasCurrentAppUiMutationEvidence, isSuccessfulExactDocumentRead, type VerifiedCurrentAuthoringDocumentEvidence, resolveVerifiedCurrentAuthoringDocumentEvidence, documentReadMatchesRequestedTarget } from "./action_desktop_evidence";
export { hasMediaPauseEvidence, hasMediaPlaybackEvidence } from "./action_media_evidence";
export { matchesRequestedDesktopActionTarget } from "./desktop_action_target";

function buildAuthoringActionContract(rawInput: string, text: string, analysis?: ActionIntentAnalysis): LumiActionContract | null {

  if (isAvatarAuthoringRequest(text)) return withDefaults({ kind:'avatar_authoring', label:'Memory person authoring',
    coreAction:'Create/import/configure the requested person through the memory person tools and read back the saved state.',
    preparationIsNotCompletion:['Generating a still image','Opening Memory Territory','Writing a plan'],
    requiredEvidence:['Verified memory_avatar_read or configuration receipt for the requested person and every requested animation feature'],
    preferredTools:['memory_avatar_read','memory_avatar_create','memory_avatar_import_image','memory_avatar_configure_animation','generate_image','ai_edit_image'],
    verificationTools:['memory_avatar_read'], nextStep:'Import the actual generated images, save the animation config, then read the same person back.',
    caution:'Do not overwrite an existing person unless requested. Missing expression frames cannot be reported as working blinking or speech.' });
  if (classifyExternalCliIntent(text) === 'inspect') {
    return withDefaults({ kind: 'external_cli_status', label: 'External CLI availability check',
      coreAction: 'Inspect the named local CLI installation and login/configuration; answer the capability question from that receipt.',
      preparationIsNotCompletion: ['An unverified claim about the local installation'],
      requiredEvidence: ['Verified current-turn external_cli_status receipt containing every requested provider'],
      preferredTools: ['external_cli_status'], verificationTools: ['external_cli_status'],
      nextStep: 'Report installed/readiness facts directly. No project directory or CLI task is required for this question.',
      caution: 'A successful status check can report an unavailable CLI. It does not verify model quota or task execution.' });
  }
  if (isExternalCliDelegation(text)) {
    return withDefaults({ kind: 'external_ai_request', label: 'External CLI task',
      coreAction: 'Delegate the bounded task to the named CLI within the existing Lumi task and verify its returned result.',
      preparationIsNotCompletion: ['CLI installed', 'CLI authenticated', 'process started', 'provider text without terminal success'],
      requiredEvidence: ['external_cli_run successful terminal receipt, matching provider and current task', 'validate returned deliverables and source changes against the user request'],
      preferredTools: ['external_cli_run', 'external_cli_status', 'external_cli_get_run'], verificationTools: ['external_cli_get_run'],
      nextStep: 'Resume the exact Lumi runId for follow-ups; use existing task cancellation. Verify business correctness separately.',
      caution: 'CLI settings and account are independent from Lumi model routing. Never claim completion for a timed-out, cancelled, or unverified run.' });
  }
  const authoringIntent = classifySkillAuthoringIntent(rawInput);
  const executionBeforeSave = executionBeforeWorkflowSave(rawInput);
  if (executionBeforeSave) {
    const execution = buildActionContract(executionBeforeSave, undefined, analysis);
    const saveText = rawInput.slice(rawInput.indexOf(executionBeforeSave) + executionBeforeSave.length);
    return withDefaults({ kind: 'skill_authoring', label: 'Execute and save workflow',
      components: [
        { text: executionBeforeSave, contract: execution },
        { text: saveText, contract: buildActionContract(saveText, undefined, analysis) },
      ],
      coreAction: 'Execute and verify the explicit current task, then save its input-dependent workflow draft.',
      preparationIsNotCompletion: ['saving a draft without performing the requested current task', 'performing the task without saving its executable workflow'],
      requiredEvidence: [...execution.requiredEvidence, 'a verified current-turn workflow draft save receipt'],
      preferredTools: [...execution.preferredTools, 'code_execution', ...skillAuthoringTools('save')],
      verificationTools: [...execution.verificationTools, 'get_workflow'],
      nextStep: 'Complete and verify the current task first, then save all calculations as executable steps bound to fresh inputs.',
      caution: 'The separately requested current action is authorized; a skill description or past example alone is not.' });
  }
  if (['generate', 'save', 'install', 'publish'].includes(authoringIntent)
    || authoringIntent === 'use' && /工作流|流程|\bworkflow\b/iu.test(rawInput)) { // i18n-allow: workflow execution intent recognition.
    return withDefaults({
      kind: 'skill_authoring', label: 'Skill/workflow authoring',
      coreAction: `Complete the requested ${authoringIntent} lifecycle phase.`,
      preparationIsNotCompletion: ['describing a skill', 'executing the example task instead of saving its capability'],
      requiredEvidence: ['a verified current-turn receipt for the requested lifecycle phase'],
      preferredTools: skillAuthoringTools(authoringIntent), verificationTools: [],
      nextStep: 'Use the authoring receipt to report the exact draft, registration, or publication state; do not repeat successful creation.',
      caution: 'A reviewed draft is not installed or executed. Registration does not prove a business task succeeded.',
    });
  }
  return null;
}

function buildRuntimeControlContract(rawInput: string, text: string, primaryTaskText: string): LumiActionContract | null {

  // A named persistent takeover-task query belongs to the takeover ledger,
  // not the active runtime-work ledger. Its deterministic quick command emits
  // a verified work_takeover_task_list receipt, so do not demand the unrelated
  // runtime_work_status tool in the final completion gate.
  if (isNamedPersistentWorkTaskStatusQuery(text)) return NONE_CONTRACT;
  const diagnosticPlan = buildClientDiagnosticPlan(primaryTaskText || rawInput);
  if (diagnosticPlan.length) {
    const tools = diagnosticPlan.map(step => step.name);
    return withDefaults({ kind: 'desktop_operation', label: 'Current Lumi runtime diagnostic',
      coreAction: 'Inspect the current Lumi runtime state and explain its actual health findings.',
      preparationIsNotCompletion: ['listing generic capabilities or unrelated business integrations'],
      requiredEvidence: tools.map(name => `successful current-turn ${name} receipt`), preferredTools: tools, verificationTools: tools,
      nextStep: 'Read all required runtime receipts, identify attention items, and distinguish optional disconnected integrations from core failures.',
      caution: 'A task ledger snapshot alone does not verify client and backend health.' });
  }
  // Runtime status/cancellation has its own exact ledger contract. Classify it
  // before the generic normalized status guard so a phrase such as
  // "background task progress" cannot be reduced to a no-tool status turn.
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
        ? 'runtime_work_cancel result with ok=true and cancelled/idle for completion; cancelling proves only that the request was accepted and must be rechecked'
        : 'runtime_work_status result with ok=true and the exact active item count'],
      preferredTools: [cancelling ? 'runtime_work_cancel' : 'runtime_work_status'],
      verificationTools: ['runtime_work_status'],
      nextStep: cancelling
        ? 'Cancel the matching runtime work and report whether cancellation completed, is still draining, or there was nothing active.'
        : 'Read the runtime work ledger and report its current items without substituting a process list.',
      caution: 'Only runtime ledger receipts prove Lumi task status or cancellation.',
    });
  }
  return null;
}

function buildExternalHistoryActionContract(text: string): LumiActionContract | null {


  if (requiresExternalAiHistory(text)) {
    // i18n-allow: Multilingual external-AI authorization intent recognition; not user-visible copy.
    const wantsAuthorization = /(?:授权|注册|添加|连接).{0,28}(?:来源|历史|会话)|\b(?:authorize|register|add|connect)\b.{0,32}\b(?:source|history|session)\b/iu.test(text);
    // i18n-allow: Multilingual external-AI revocation intent recognition; not user-visible copy.
    const wantsRevocation = /(?:撤销|取消|禁用).{0,28}(?:授权|来源)|\b(?:revoke|disable|remove)\b.{0,32}\b(?:authorization|source)\b/iu.test(text);
    // i18n-allow: Multilingual external-AI sync status intent recognition; not user-visible copy.
    const wantsStatus = /(?:状态|进度|同步到哪)|\b(?:status|progress)\b/iu.test(text);
    // i18n-allow: Multilingual external-AI history query intent recognition; not user-visible copy.
    const wantsQuery = /(?:读取|查看|搜索|查询|总结).{0,32}(?:聊天|对话|历史|内容)|\b(?:read|view|search|query|summari[sz]e)\b/iu.test(text);
    const preferredTools = wantsRevocation
      ? ['external_ai_history_source_revoke', 'external_ai_history_status']
      : wantsAuthorization
        ? ['external_ai_history_source_register', 'external_ai_history_source_list']
        : wantsStatus
          ? ['external_ai_history_status', 'external_ai_history_source_list']
          : wantsQuery
            ? ['external_ai_history_query', 'external_ai_history_status', 'external_ai_history_sync', 'external_ai_history_source_list']
            : ['external_ai_history_sync', 'external_ai_history_status', 'external_ai_history_source_list'];
    return withDefaults({
      kind: 'external_ai_history',
      label: 'Authorized external AI history access',
      coreAction: 'Read, synchronize, or manage only the external AI history source and scope explicitly authorized by this user in the current personal or organization domain.',
      preparationIsNotCompletion: ['opening an AI app', 'seeing a conversation list without message evidence', 'using an unregistered session', 'reading only a process/window title', 'treating one visible viewport as complete history'],
      requiredEvidence: [
        wantsAuthorization
          ? 'external_ai_history_source_register receipt with an immutable authorizationDigest'
          : wantsRevocation
            ? 'external_ai_history_source_revoke receipt with status=revoked'
            : wantsStatus
              ? 'external_ai_history_status receipt derived from the persistent source and job ledger'
              : wantsQuery
                ? 'external_ai_history_query receipt with message ids and sourceEvidence'
                : 'external_ai_history_sync receipt with verified=true, a durable jobId/cursor, counts, completeness, and source limitations',
      ],
      preferredTools,
      verificationTools: ['external_ai_history_status', 'external_ai_history_query'],
      nextStep: 'Use an existing exact authorization source. If none exists, explain the missing source and request confirmation to register a connector, JSON export, authorized session, or desktop-visible source. Never submit a new prompt while fulfilling a history-read request.',
      caution: 'Do not claim arbitrary account access. Credentials remain outside this ledger; scope expansion requires a new confirmation; desktop-visible extraction is partial, uses local vision first, and never scrolls or submits.',
    });
  }
  return null;
}
