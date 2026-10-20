import { requestedArtifactInstructions } from './artifact_progress';
import { buildMediaGenerationContract } from './contracts/media_contract';
import { isExplicitArtifactCreationText, isExternalCommitConfirmationOnlyRequest, normalizeActionIntent } from "./normalized_action_intent";
import { isLegalEntryTurn, isRemoteLegalMessageTurn } from "./legal_entry";
import type { ActionIntentAnalysis } from "./normalized_action_intent";
import { hasExplicitNoToolInstruction, isInformationOnlyQuestion } from "./tool_intent";
import { withoutNegatedLookupClauses, compositeNavigationInstructions, independentActionClauses, genericExternalCommit } from "./normalized_action_intent";
import { withoutLocationLiterals } from "./location_literals";
import { isAvatarAuthoringRequest } from "./media_creation_intent";
import { classifyExternalCliIntent, isExternalCliDelegation } from "./external_cli_intent";
import { classifySkillAuthoringIntent, skillAuthoringTools, executionBeforeWorkflowSave } from "../skills/authoring_intent";
import { buildDesktopObservationPlan } from "./desktop_observation";
import { isReadOnlyKnowledgeBaseInspectionRequest } from "./knowledge_intent";
import { isMediaPauseRequest } from "./media_intent";
import { CN_RESULT_GROUNDING_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { isRuntimeCleanupOfferAcceptanceText } from "./pending_assistant_offer";
import { compact, matches } from "./action_contract_support";
import { extractPrimaryTaskText, isBrowserSessionInspection, requiresCurrentAppUiMutation, CURRENT_TURN_ATTACHMENTS_RE, requiresVisualModelAvailabilityCheck, requestsBlankAutoCadDocument, isDesktopLaunchVerificationOnly, hasNegatedMessagingSendIntent, requiresCurrentAuthoringDocumentInspection, requiresDesktopAiRequest, requiresDesktopAiAnswerReadback, requiresMediaPlaybackAction, isSimpleDesktopOpenRequest, requiresCadGeometryExtractionOnly, isDesignDeliveryTurn, isEcommerceOperationsTurn, isCustomerOperationsTurn, requiresVisibleAutoCadExecution, requiresAutoCadMcpPlayback, requestedDesktopWindowAction } from "./action_request";
import { requestsExactReadOnlyArtifactInspection } from "./action_desktop_evidence";
import type { LumiActionContract } from './contracts/contracts';
import { NONE_CONTRACT, withDefaults } from './contracts/contracts';
import { buildRuntimeControlContract } from './contracts/runtime_contract';
import { buildArtifactWorkContract, buildArtifactRetrievalContract, buildLegalDocumentContract, buildCadGeometryExtractionContract, buildDesignDeliveryContract, buildReadOnlyArtifactInspectionContract } from './contracts/artifact_contracts';
import { extensionRegistryToolForAction, buildVisualModelAvailabilityContract, buildCurrentAppMutationContract, buildSimpleDesktopOpenContract, buildMediaPlaybackContract, buildDesktopOperationContract } from './contracts/navigation_contracts';
import { buildExternalHistoryActionContract } from './contracts/external_history_contract';
import { buildEcommerceOperationsContract, buildCustomerOperationsContract } from './contracts/business_contracts';

export { extractExplicitArtifactTextRequirements } from './artifact_progress';
export { hasVisualModelAvailabilityEvidence } from "./action_contract_support";
export { extractPrimaryTaskText, type DesktopWindowAction, requestedDesktopWindowAction, requiresCurrentAppUiMutation, requiresCurrentAuthoringDocumentInspection, extractCurrentAppTarget, extractRequestedCurrentAppText, claimsCurrentAppSaveCompletion, extractSimpleDesktopOpenTarget, isSimpleDesktopOpenRequest, extractDesktopLaunchTarget, requiresVisualModelAvailabilityCheck, requiresMediaPlaybackAction, requiresDesktopAiRequest, requiresDesktopAiInspection, requiresExternalAiHistory, requiresDesktopAiAnswerReadback, requiresCadGeometryExtractionOnly, requiresVisibleAutoCadExecution, requestsBlankAutoCadDocument, requiresAutoCadMcpPlayback, requiresAuthenticatedWebResult, isBrowserSessionInspection, isDocumentOpenAndReviewRequest, requiresArtifactPostWriteReadback, hasRequestedArtifactPostWriteReadback, requestedMediaPlayerTarget, requiresArtifactOpen, isRunningSoftwareInspectionRequest } from "./action_request";
export { hasVisibleAutoCadExecutionEvidence, hasBlankAutoCadDocumentEvidence, hasRequestedDesktopOpenEvidence, hasCurrentAppSaveEvidence, hasCurrentAppUiMutationEvidence, isSuccessfulExactDocumentRead, type VerifiedCurrentAuthoringDocumentEvidence, resolveVerifiedCurrentAuthoringDocumentEvidence, documentReadMatchesRequestedTarget } from "./action_desktop_evidence";
export { hasMediaPauseEvidence, hasMediaPlaybackEvidence } from "./action_media_evidence";
export { matchesRequestedDesktopActionTarget } from "./desktop_action_target";
export type { LumiActionContractKind } from './contracts/contracts';
export type { LumiActionContract } from './contracts/contracts';
export type { ActionCapabilityRequirement } from './contracts/contracts';
export { isNamedPersistentWorkTaskStatusQuery } from './contracts/navigation_contracts';
export { browserSessionObservation } from './contracts/browser_evidence';
export { hasAuthenticatedWebResultEvidence } from './contracts/browser_evidence';
export { getArtifactTaskProgress } from './contracts/artifact_evidence';
export { hasVerifiedCadGeometryExtractionEvidence } from './contracts/cad_evidence';
export { hasCoreActionEvidence } from './contracts/core_evidence';
export { formatActionContractPrompt } from './contracts/prompt';
export { summarizeActionContractBlocker } from './contracts/prompt';

function combineActionContracts(primary: LumiActionContract, components: NonNullable<LumiActionContract['components']>): LumiActionContract {
  const all = <K extends 'preferredTools' | 'verificationTools' | 'requiredEvidence'>(key: K) => Array.from(new Set(components.flatMap(item => item.contract[key])));
  return { ...primary, components, preferredTools: all('preferredTools'), verificationTools: all('verificationTools'),
    requiredEvidence: all('requiredEvidence'), coreAction: components.map(item => item.contract.coreAction).join('; '),
    nextStep: 'Complete every requested operation and verify each one. One successful operation does not complete the whole request.' };
}

export function buildActionContract(input: string, acceptedIntent?: Readonly<ReturnType<typeof normalizeActionIntent>>, analysis?: ActionIntentAnalysis): LumiActionContract {
  const rawInput = String(input || '');
  const normalizedIntent = acceptedIntent || normalizeActionIntent(rawInput, analysis);
  const primaryTaskText = extractPrimaryTaskText(rawInput);
  if (hasExplicitNoToolInstruction(primaryTaskText || rawInput)) return NONE_CONTRACT;
  const resolvedComponents = compositeNavigationInstructions(primaryTaskText || rawInput).map(({ text }) => {
    const intent = normalizeActionIntent(text, analysis);
    return { text, intent, contract: buildActionContract(text, intent, analysis) };
  });
  if (resolvedComponents.length > 1) {
    const primary = resolvedComponents.find(item => item.intent.kind === 'desktop_operation')!.contract;
    const components = resolvedComponents.map(({ text, contract }) => ({ text, contract }));
    return combineActionContracts(primary, components);
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

  const retrieval = buildArtifactRetrievalContract(rawInput);
  if (retrieval) return retrieval;
  const text = compact(withoutLocationLiterals(withoutNegatedLookupClauses(rawInput), true));
  if (!text) return NONE_CONTRACT;
  const authoringContract = buildAuthoringActionContract(rawInput, text, analysis);
  if (authoringContract) return authoringContract;
  const runtimeContract = buildRuntimeControlContract(rawInput, text, primaryTaskText);
  if (runtimeContract) return runtimeContract;
  if (normalizedIntent.kind === 'media_generation') {
    return buildMediaGenerationContract(normalizedIntent.target as 'generate_image' | 'ai_edit_image' | 'generate_video', primaryTaskText || rawInput, undefined, normalizedIntent.operation === 'mutate' && normalizedIntent.target === 'generate_video');
  }
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
  if (isExplicitArtifactCreationText(rawInput)) return buildArtifactWorkContract();
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
  const negatedMessagingSend = hasNegatedMessagingSendIntent(rawInput) && !confirmationOnlyExternalCommit;
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

  if (
    !readOnlyArtifactInspection &&
    normalizedIntent.kind === 'messaging_read' &&
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
    return { ...contract, mediaPlayback: 'pause', label: 'Verified media pause',
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
export function buildActionEvidenceContract(input: string, analysis?: ActionIntentAnalysis,
  accepted?: { readonly taskText: string; readonly contract: LumiActionContract }): LumiActionContract {
  const contract = accepted?.taskText === input ? accepted.contract : buildActionContract(input, undefined, analysis);
  if (!contract.components?.length && contract.kind === 'artifact_work' && !hasExplicitNoToolInstruction(input) && !isInformationOnlyQuestion(input, analysis)) {
    const artifacts = requestedArtifactInstructions(input);
    if (artifacts.length > 1) return combineActionContracts(contract, artifacts.map(({ text }) => ({ text, contract: buildActionContract(text, undefined, analysis) })));
  }
  // This is completion evidence, never a positive execution grant. Keep an
  // independent final commit even when the routing contract chose its input read.
  const clauses = !contract.components?.length && !hasExplicitNoToolInstruction(input) && !isInformationOnlyQuestion(input, analysis)
    ? independentActionClauses(extractPrimaryTaskText(input) || input, true) : [];
  if (clauses.length > 1) {
    const parts = clauses.map(text => ({ text, intent: genericExternalCommit(withoutLocationLiterals(text), true) }));
    if (parts.some(item => item.intent)) {
      const components = parts.map(({ text, intent }) => ({ text, contract: intent
        ? withDefaults({ kind: 'external_commit', label: 'External final action', coreAction: text,
            preparationIsNotCompletion: ['Reading the input', 'Preparing a document or proposal'],
            requiredEvidence: ['Dedicated exact confirmed external-action terminal receipt'], preferredTools: [], verificationTools: [],
            nextStep: 'Keep this action unverified until its dedicated capability confirms the exact final result.',
            caution: 'A generic successful tool receipt cannot verify a signature, payment, publication or submission.' })
        : buildActionContract(text, undefined, analysis) })).filter(item => item.contract.applies);
      if (components.length > 1) return combineActionContracts(components.find(item => item.contract.kind !== 'external_commit')?.contract || contract, components);
    }
  }
  if (contract.applies || !isRuntimeCleanupOfferAcceptanceText(compact(input))) {
    return contract;
  }
  return buildActionContract('Cancel all active background tasks', undefined, analysis);
}

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
