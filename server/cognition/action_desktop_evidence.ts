import crypto from 'node:crypto';
import { toolRecordSucceeded } from '../tools/receipt_payload';
import type { ToolExecutionRecord } from '../tools/types';
import { sameArtifactPath } from '../tools/artifact_evidence';
import { toolRecordHasTerminalPayload, toolRecordTerminalPayload } from '../tools/receipt_payload';
import type { ActionIntentAnalysis } from './normalized_action_intent';
import type { TaskCapsuleV1 } from '../conversation/task_capsule';
import { hasRequestedArtifactMutation } from './tool_intent';
import type { AcceptedTaskTarget } from '../conversation/task_target_anchor';
import { sourceDocumentInstruction } from '../conversation/task_target_anchor';
import { preservedSourceOutputScope } from './artifact_write_scope';
import { parseRecordJson, compact, recordText, expandSuccessfulRecords } from "./action_contract_support";
import { requestedDesktopTargetAliases, matchesRequestedDesktopTarget, collectStructuredDesktopTargets, normalizeDesktopTarget, requestedBrowserTargetAliases } from "./desktop_action_target";
import { extractDesktopLaunchTarget, extractSimpleDesktopOpenTarget, requestedMediaPlayerTarget, currentAppMutationRequirements, extractPrimaryTaskText, requiresCurrentAuthoringDocumentInspection } from "./action_request";

export function hasVisibleAutoCadExecutionEvidence(
  records: ToolExecutionRecord[] = [],
  _taskText = '',
): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;
  return successful.some(record => {
    if (!/^(?:mcp_cad-drafting_autocad_playback_file|cad_draw_floorplan_in_autocad)$/i.test(record.name)) return false;
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

export function hasMatchingDesktopOpenEvidence(record: ToolExecutionRecord, requestedTarget: string): boolean {
  if (record.name !== 'desktop_open' || !toolRecordSucceeded(record)) return false;
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
  collectStructuredDesktopTargets(
    payload?.actualTarget
      || payload?.verification?.actualTarget
      || payload?.postState
      || payload?.observedTarget,
    structuredTargets,
  );
  const verifiedPostState = payload?.targetMatched === true && (
    payload?.verified === true
    || status === 'verified'
    || compact(payload?.verification?.status).toLowerCase() === 'verified'
    || record.terminalVerification?.status === 'verified'
  );
  // Invocation arguments prove intent, not outcome. Completion requires a
  // matching structured post-open target from the desktop client.
  if (!verifiedPostState || structuredTargets.length === 0) return false;
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(requestedTarget)) {
    // Native office windows expose the filename, not the absolute path. Bind
    // that title to the exact invoked AND acknowledged path before accepting it.
    if (!argumentTargets.some(value => sameArtifactPath(String(value), requestedTarget))
      || !sameArtifactPath(String(payload?.target || ''), requestedTarget)) return false;
    if (payload?.verificationBasis === 'post_open_foreground') {
      const actual = payload?.actualTarget || payload?.verification?.actualTarget;
      const filename = requestedTarget.replace(/\\/g, '/').split('/').pop()!.normalize('NFKC').toLowerCase();
      const title = String(actual?.title || actual?.windowTitle || '').normalize('NFKC').trim().toLowerCase();
      if (title === filename || (title.startsWith(filename) && /^\s+[-–—|]\s+/u.test(title.slice(filename.length)))) return true;
      // A document's mismatched title cannot fall back to its folder's app aliases.
      if (!/\.(?:exe|lnk|appref-ms|url)$/iu.test(requestedTarget)) return false;
    }
  }
  return structuredTargets.some(value => matchesRequestedDesktopTarget(value, aliases));
}

export function hasMatchingDesktopObservationEvidence(record: ToolExecutionRecord, requestedTarget: string): boolean {
  if (
    record.error
    || !/^(?:desktop_active_window|desktop_running_processes|get_active_window_info|get_running_processes)$/i.test(String(record.name || ''))
  ) return false;
  const aliases = requestedDesktopTargetAliases(requestedTarget);
  const structuredTargets: string[] = [];
  collectStructuredDesktopTargets(parseRecordJson(record), structuredTargets);
  if (structuredTargets.some(value => matchesRequestedDesktopTarget(value, aliases))) return true;
  return aliases.some(alias => alias.length >= 2 && normalizeDesktopTarget(recordText(record)).includes(alias));
}

export function hasMatchingBrowserOpenEvidence(record: ToolExecutionRecord, requestedTarget: string): boolean {
  if (record.name !== 'browser_open_task' || !toolRecordSucceeded(record)) return false;
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

function hasObservedMatchingTargetAfterOpenAttempt(
  record: ToolExecutionRecord,
  requestedTarget: string,
): boolean {
  if (
    record.error
    || !/^(?:desktop_open|browser_open_task)$/i.test(String(record.name || ''))
    || !toolRecordHasTerminalPayload(record)
  ) return false;
  const payload = parseRecordJson(record);
  const status = compact(payload?.status || record.envelope?.status).toLowerCase();
  // The desktop relay can report target_mismatch when it compared a URL or
  // localized application name with a browser/player process identity. Accept
  // only that one false-negative shape, and only when the structured observed
  // title/process itself matches the exact requested target.
  if (status !== 'target_mismatch') return false;
  const aliases = record.name === 'browser_open_task'
    || /(?:https?:\/\/|www\.|\u5b98\u7f51|\u7f51\u7ad9|\u7f51\u9875)/iu.test(requestedTarget)
      ? requestedBrowserTargetAliases(requestedTarget)
      : requestedDesktopTargetAliases(requestedTarget);
  const argumentTargets = [
    record.arguments?.target,
    record.arguments?.url,
    record.arguments?.path,
    payload?.target,
    payload?.url,
  ].filter(value => typeof value === 'string' && compact(value));
  if (
    argumentTargets.length === 0
    || !argumentTargets.some(value => matchesRequestedDesktopTarget(value, aliases))
  ) return false;
  const observedTargets: string[] = [];
  collectStructuredDesktopTargets(
    payload?.actualTarget
      || payload?.verification?.actualTarget
      || payload?.postState
      || payload?.observedTarget,
    observedTargets,
  );
  return observedTargets.some(value => matchesRequestedDesktopTarget(value, aliases));
}

/** Fuse exact open attempts and same-turn target observations. This keeps a
 * later auxiliary failure from erasing a page/player that the desktop relay
 * already observed, while refusing an unrelated active window or process. */
export function hasRequestedDesktopOpenEvidence(
  records: ToolExecutionRecord[] = [],
  taskText = '',
  explicitTarget = '', analysis?: ActionIntentAnalysis
): boolean {
  const requestedTarget = compact(
    explicitTarget
    || extractDesktopLaunchTarget(taskText, analysis)
    || extractSimpleDesktopOpenTarget(taskText, analysis)
    || requestedMediaPlayerTarget(taskText, analysis),
  );
  if (!requestedTarget) return false;
  const successful = expandSuccessfulRecords(records);
  if (successful.some(record => (
    hasMatchingDesktopOpenEvidence(record, requestedTarget)
    || hasMatchingBrowserOpenEvidence(record, requestedTarget)
    || hasMatchingDesktopObservationEvidence(record, requestedTarget)
  ))) return true;
  return records.some(record => hasObservedMatchingTargetAfterOpenAttempt(record, requestedTarget));
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

export function hasMeaningfulArguments(record: ToolExecutionRecord): boolean {
  return Object.values(record.arguments || {}).some(value => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return String(value ?? '').trim().length > 0;
  });
}

type RequestedAuthoringApplication = 'wps' | 'word' | 'excel' | 'powerpoint' | 'microsoft_office' | 'any_authoring';

const CURRENT_DOCUMENT_READER_RE = /^(?:read_file|extract_document_text|read_pdf|read_docx|read_xlsx|ocr_image_file)$/i;
const DOCUMENT_TARGET_EXTENSION_RE = /\.(?:pptx?|docx?|xlsx?|pdf|rtf|txt|md|csv|json|wps|et|dps)$/i;
const DOCUMENT_TARGET_MENTION_RE = new RegExp(DOCUMENT_TARGET_EXTENSION_RE.source.replace(/\$$/u, '\\b'), DOCUMENT_TARGET_EXTENSION_RE.flags);
const FAILED_DOCUMENT_READ_STATUS_RE = /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|not_found|not_ready|partial|pending|queued|unverified|unknown)$/i;

function requestedAuthoringApplication(taskText: string): RequestedAuthoringApplication | null {
  const primary = compact(extractPrimaryTaskText(taskText));
  if (/\bWPS(?:\s+Office)?\b/iu.test(primary)) return 'wps';
  if (/\b(?:Microsoft\s+)?PowerPoint\b/iu.test(primary)) return 'powerpoint';
  if (/\b(?:Microsoft\s+)?Excel\b/iu.test(primary)) return 'excel';
  if (/\b(?:Microsoft\s+)?Word\b/iu.test(primary)) return 'word';
  if (/\bMicrosoft\s+Office\b/iu.test(primary)) return 'microsoft_office';
  if (requiresCurrentAuthoringDocumentInspection(taskText)) return 'any_authoring';
  return null;
}

function processMatchesAuthoringApplication(
  processName: string,
  requested: RequestedAuthoringApplication,
): boolean {
  const executable = processName.trim().split(/[\\/]/).pop()?.toLowerCase() || '';
  if (!executable) return false;
  if (requested === 'wps') return /^(?:(?:wps|wpp|et|wpsoffice)(?:\.exe)?|wps office)$/i.test(executable);
  if (requested === 'word') return /^(?:winword(?:\.exe)?|microsoft word)$/i.test(executable);
  if (requested === 'excel') return /^(?:excel(?:\.exe)?|microsoft excel)$/i.test(executable);
  if (requested === 'powerpoint') return /^(?:powerpnt(?:\.exe)?|microsoft powerpoint)$/i.test(executable);
  if (requested === 'any_authoring') return /^(?:(?:wps|wpp|et|wpsoffice|winword|excel|powerpnt|msoffice|office)(?:\.exe)?|wps office|microsoft (?:word|excel|powerpoint))$/i.test(executable);
  return /^(?:(?:winword|excel|powerpnt|msoffice|office)(?:\.exe)?|microsoft (?:word|excel|powerpoint))$/i.test(executable);
}

function labelMatchesAuthoringApplication(
  label: string,
  requested: RequestedAuthoringApplication,
): boolean {
  const value = compact(label).toLowerCase();
  if (!value) return false;
  // i18n-allow: Reviewed WPS product aliases in observed native-window evidence; not user-visible copy.
  if (requested === 'wps') return /(?:\bwps(?:\s+office|\s+writer)?\b|金山(?:文字|表格|演示|wps))/iu.test(value);
  if (requested === 'word') return /\b(?:microsoft\s+)?word\b/iu.test(value);
  if (requested === 'excel') return /\b(?:microsoft\s+)?excel\b/iu.test(value);
  if (requested === 'powerpoint') return /\b(?:microsoft\s+)?powerpoint\b/iu.test(value);
  if (requested === 'any_authoring') return /(?:\bwps(?:\s+office|\s+writer)?\b|\b(?:microsoft\s+)?(?:word|excel|powerpoint)\b|\bmicrosoft\s+office\b)/iu.test(value);
  return /\b(?:microsoft\s+office|word|excel|powerpoint)\b/iu.test(value);
}

function recordMatchesRequestedAuthoringWindow(
  record: ToolExecutionRecord,
  taskText: string,
): boolean {
  if (
    !/^(?:desktop_active_window|get_active_window_info)$/i.test(record.name)
    || record.terminalVerification?.status !== 'verified'
    || hasFailedDesktopReceipt(record)
  ) return false;
  const requested = requestedAuthoringApplication(taskText);
  if (!requested) return false;
  const payload = parseRecordJson(record);
  if (!payload) return false;
  const processName = compact(
    payload.processName
    || payload.process_name
    || payload.executable
    || payload.process?.name,
  );
  // A concrete foreground process is stronger than a document/window title.
  // If it names another application, a title containing "WPS" cannot override
  // that mismatch (for example, a browser tab about WPS).
  if (processName) return processMatchesAuthoringApplication(processName, requested);
  const application = compact(
    payload.application
    || payload.applicationName
    || payload.appName
    || payload.app,
  );
  if (application) return labelMatchesAuthoringApplication(application, requested);
  return labelMatchesAuthoringApplication(
    payload.windowTitle || payload.title || '',
    requested,
  );
}

function verifiedObservedDocumentPath(record: ToolExecutionRecord, taskText: string): string {
  if (!recordMatchesRequestedAuthoringWindow(record, taskText)) return '';
  const payload = parseRecordJson(record);
  const currentDocument = payload?.currentDocument
    && typeof payload.currentDocument === 'object'
    && !Array.isArray(payload.currentDocument)
    ? payload.currentDocument as Record<string, any>
    : {};
  const pathStatus = compact(
    currentDocument.pathStatus
    || currentDocument.path_status
    || payload?.documentPathStatus
    || payload?.document_path_status,
  );
  if (/^(?:unknown|unresolved|missing|not_found|unavailable|null|none)$/i.test(pathStatus)) return '';
  const candidate = compact(currentDocument.path || payload?.documentPath);
  return DOCUMENT_TARGET_EXTENSION_RE.test(candidate) ? candidate : '';
}

function documentBasename(value: string, extensions = DOCUMENT_TARGET_EXTENSION_RE): string {
  const withoutQuery = compact(value)
    .normalize('NFKC')
    .split(/[?#]/, 1)[0]
    .replace(/^[*\s'"`\u201c\u201d\u2018\u2019]+/gu, '')
    .replace(/[\s'"`\u201c\u201d\u2018\u2019]+$/gu, '')
    .replace(/\\/gu, '/');
  const basename = withoutQuery.split('/').pop()?.trim() || '';
  return extensions.test(basename) ? basename : '';
}

function verifiedObservedDocumentName(record: ToolExecutionRecord, taskText: string): string {
  if (!recordMatchesRequestedAuthoringWindow(record, taskText)) return '';
  const payload = parseRecordJson(record);
  const title = compact(payload?.windowTitle || payload?.title || '');
  return documentNameFromWindowTitle(title);
}

function documentNameFromWindowTitle(title: string): string {
  if (!title) return '';

  const titleSegments = title.split(/\s+(?:-|\u2014|\u2013|\|)\s+/u);
  for (const segment of titleSegments) {
    const undecorated = segment
      .replace(/\s+(?:\[[^\]\r\n]+\]|\([^()\r\n]+\))\s*$/u, '')
      .trim();
    const candidate = documentBasename(undecorated);
    if (candidate) return candidate;
  }
  return '';
}

interface VerifiedAuthoringWindowCandidate {
  source: 'active_window' | 'running_window';
  documentName: string;
  documentPath: string;
}

function runningAuthoringWindowCandidates(
  record: ToolExecutionRecord,
  taskText: string,
): VerifiedAuthoringWindowCandidate[] {
  if (
    !/^(?:desktop_running_processes|get_running_processes)$/i.test(record.name)
    || record.terminalVerification?.status !== 'verified'
    || hasFailedDesktopReceipt(record)
  ) return [];
  const requested = requestedAuthoringApplication(taskText);
  if (!requested) return [];
  const payload = toolRecordTerminalPayload(record);
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (['processes', 'items', 'results']
          .map(key => (payload as Record<string, any>)[key])
          .find(Array.isArray) as unknown[] | undefined) || []
      : [];
  const candidates: VerifiedAuthoringWindowCandidate[] = [];
  for (const rawItem of items.slice(0, 100)) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, any>;
    const processName = compact(
      item.name
      || item.processName
      || item.process_name
      || item.executable,
    );
    if (!processMatchesAuthoringApplication(processName, requested)) continue;
    const rawTitles = Array.isArray(item.window_titles)
      ? item.window_titles
      : Array.isArray(item.windowTitles)
        ? item.windowTitles
        : [];
    const titles = [
      ...rawTitles,
      item.window_title,
      item.windowTitle,
    ];
    for (const rawTitle of titles) {
      if (typeof rawTitle !== 'string') continue;
      const documentName = documentNameFromWindowTitle(compact(rawTitle));
      if (!documentName) continue;
      candidates.push({
        source: 'running_window',
        documentName,
        documentPath: '',
      });
    }
  }
  return candidates.filter((candidate, index, all) => all.findIndex(item => (
    sameDocumentBasename(item.documentName, candidate.documentName)
  )) === index);
}

function selectVerifiedAuthoringWindowCandidate(
  records: ToolExecutionRecord[],
  taskText: string,
): VerifiedAuthoringWindowCandidate | null {
  const latestActive = [...records].reverse().find(record => (
    /^(?:desktop_active_window|get_active_window_info)$/i.test(record.name)
  ));
  if (latestActive && recordMatchesRequestedAuthoringWindow(latestActive, taskText)) {
    const documentPath = verifiedObservedDocumentPath(latestActive, taskText);
    const documentName = documentBasename(documentPath)
      || verifiedObservedDocumentName(latestActive, taskText);
    if (documentName) {
      return { source: 'active_window', documentName, documentPath };
    }
  }

  const latestRunning = [...records].reverse().find(record => (
    /^(?:desktop_running_processes|get_running_processes)$/i.test(record.name)
  ));
  if (!latestRunning) return null;
  const background = runningAuthoringWindowCandidates(latestRunning, taskText);
  return background.length === 1 ? background[0] : null;
}

function discoveryResultItems(record: ToolExecutionRecord): Record<string, any>[] {
  const payload = toolRecordTerminalPayload(record);
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (['files', 'entries', 'items', 'results']
          .map(key => (payload as Record<string, any>)[key])
          .find(Array.isArray) as unknown[] | undefined) || []
      : [];
  return values.slice(0, 200).flatMap(value => {
    if (typeof value === 'string') return [{ path: value }];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? [value as Record<string, any>]
      : [];
  });
}

function uniquelyDiscoveredDocumentPath(
  records: ToolExecutionRecord[],
  documentName: string,
): string {
  const paths: string[] = [];
  for (const record of records) {
    if (
      !/^(?:desktop_list_files|search_files)$/i.test(record.name)
      || record.terminalVerification?.status !== 'verified'
      || hasFailedDesktopReceipt(record)
    ) continue;
    const directory = compact(record.arguments?.directory || record.arguments?.path);
    for (const item of discoveryResultItems(record)) {
      const rawPath = compact(
        item.path
        || item.filePath
        || item.file_path
        || item.name
        || item.fileName,
      );
      if (!rawPath || !sameDocumentBasename(rawPath, documentName)) continue;
      const exactPath = /^(?:~[\\/]|[a-z]:[\\/]|\\\\|\/)/i.test(rawPath)
        ? rawPath
        : directory
          ? `${directory.replace(/[\\/]+$/u, '')}/${rawPath}`
          : '';
      if (!exactPath || !documentBasename(exactPath)) continue;
      if (!paths.some(existing => sameExactDocumentTarget(existing, exactPath))) paths.push(exactPath);
    }
  }
  return paths.length === 1 ? paths[0] : '';
}

function sameDocumentBasename(left: string, right: string): boolean {
  const normalizedLeft = documentBasename(left).toLocaleLowerCase('en-US');
  const normalizedRight = documentBasename(right).toLocaleLowerCase('en-US');
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function sameExactDocumentTarget(left: string, right: string): boolean {
  const normalize = (value: string) => value
    .normalize('NFKC')
    .replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '')
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
    .trim();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const windowsIdentity = /^(?:[a-z]:\/|\/\/)/i.test(normalizedLeft)
    || /^(?:[a-z]:\/|\/\/)/i.test(normalizedRight);
  return windowsIdentity
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function exactDocumentReadTarget(record: ToolExecutionRecord): string {
  const args = record.arguments || {};
  const target = compact(
    (record.name === 'ocr_image_file' ? args.imagePath : '')
    || args.path
    || args.filePath
    || args.filepath
    || args.documentPath
    || args.documentpath
    || args.targetPath
    || args.targetpath
    || args.target,
  );
  if (
    !target
    || /[\u0000-\u001f]/u.test(target)
    // i18n-allow: Reviewed multilingual placeholder-target recognition; not user-visible copy.
    || /^(?:none|null|undefined|unknown|n\/a|current|active|file|document|current\s+(?:file|document)|active\s+(?:file|document)|当前(?:文件|文档)|活动(?:文件|文档))$/iu.test(target)
  ) return '';
  const withoutQuery = target.split(/[?#]/, 1)[0].replace(/["'“”‘’]+$/u, '');
  const extensions = record.name === 'ocr_image_file' ? /\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i : DOCUMENT_TARGET_EXTENSION_RE;
  return extensions.test(withoutQuery) ? target : '';
}

export function actualDocumentReadContent(record: ToolExecutionRecord): string {
  const persistedResult = String(record.result || '').trim();
  let rawResult = persistedResult;
  try {
    const compacted = JSON.parse(persistedResult || '{}');
    const envelopeResult = record.envelope?.status === 'verified_success'
      && record.envelope.verification?.status === 'verified'
      ? record.envelope.result
      : undefined;
    if (compacted?.resultOmitted === true && envelopeResult !== undefined) {
      rawResult = typeof envelopeResult === 'string'
        ? envelopeResult.trim()
        : JSON.stringify(envelopeResult);
    }
  } catch {}
  if (!rawResult) return '';
  // The durable receipt may carry byte-count/digest metadata alongside the
  // actual semantic result. Inspect the result itself here: generic
  // parseRecordJson intentionally prefers receipt metadata, which would hide
  // a valid read_file text result and make the completion ledger disagree
  // with the user-visible tool loop.
  let payload: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(rawResult);
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    payload = null;
  }
  if (record.name === 'knowledge_file_stats' && !payload) return '';
  if (payload) {
    const verification = payload.verification && typeof payload.verification === 'object'
      ? payload.verification as Record<string, any>
      : {};
    const status = compact(
      payload.status
      || payload.verificationStatus
      || verification.status,
    );
    if (
      payload.ok === false
      || payload.success === false
      || payload.failed === true
      || payload.completed === false
      || payload.verified === false
      || FAILED_DOCUMENT_READ_STATUS_RE.test(status)
      || compact(payload.error || verification.error)
    ) return '';
    if (record.name === 'knowledge_file_stats') {
      const ids = record.arguments?.fileIds;
      const files = payload.files;
      if (record.error || record.adapterStarted !== true || record.terminalVerification?.status !== 'verified'
        || !record.requestId || !record.taskId || record.envelope?.requestId !== record.requestId || record.envelope?.taskId !== record.taskId
        || record.envelope?.status !== 'verified_success' || record.envelope.verification?.status !== 'verified' || record.envelope.toolName !== record.name
        || payload.mode !== 'source_text' || payload.ok !== true || payload.status !== 'observed' || !payload.userId
        || !['personal', 'work'].includes(payload.domain) || !Array.isArray(ids) || !ids.length || !Array.isArray(files)
        || ids.some((id: unknown) => typeof id !== 'string' || !id || /[\\/]/.test(id)) || files.length !== new Set(ids).size
        || !files.every((file: any, i: number) => file.fileId === [...new Set(ids)][i] && typeof file.name === 'string' && file.name.trim()
          && typeof file.text === 'string' && file.text.trim() && file.characters === file.text.length && file.truncated === false
          && /^[a-f0-9]{64}$/.test(file.sourceHash || '') && file.sourceRevision === file.sourceHash
          && file.textHash === crypto.createHash('sha256').update(file.text).digest('hex'))) return '';
      return files.map((file: any) => '[Knowledge original fileId=' + file.fileId + ' filename=' + file.name + ' sourceSHA256=' + file.sourceHash + ' textSHA256=' + file.textHash + ']\n' + file.text).join('\n\n');
    }
    // read_file returns the file bytes as UTF-8 text. A JSON object here is
    // therefore the document itself (for example package.json), not a generic
    // adapter receipt. Wrapped desktop reads are unwrapped by the handler.
    if (record.name === 'read_file') return rawResult;
    const structuredContent = [
      payload.content,
      payload.text,
      payload.excerpt,
      payload.bodyText,
      record.name === 'ocr_image_file' && typeof payload.analysis === 'string' ? payload.analysis : undefined,
      payload.data,
    ];
    for (const value of structuredContent) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value) && value.length > 0) {
        const rendered = value.map(item => (
          typeof item === 'string' ? item : JSON.stringify(item)
        )).filter(Boolean).join('\n').trim();
        if (rendered) return rendered;
      }
      if (value && typeof value === 'object' && Object.keys(value).length > 0) {
        return JSON.stringify(value);
      }
    }
    // A JSON object returned by a document reader is a receipt, not document
    // content, unless it carries one of the explicit content fields above.
    return '';
  }
  if (/^(?:error|failed|blocked|not found|permission denied|timed out)(?:\b|:)/iu.test(rawResult)) return '';
  if (record.name === 'read_pdf') {
    const withoutMetadata = rawResult
      .replace(/^Pages:\s*\d+\s*$/gimu, '')
      .replace(/^Info:\s*\{[^\r\n]*\}\s*$/gimu, '')
      .trim();
    return withoutMetadata;
  }
  return rawResult;
}

function hasActualDocumentReadContent(record: ToolExecutionRecord): boolean {
  return Boolean(actualDocumentReadContent(record));
}

export function isSuccessfulExactDocumentRead(record: ToolExecutionRecord): boolean {
  if (record.name === 'knowledge_file_stats') return Boolean(actualDocumentReadContent(record));
  return CURRENT_DOCUMENT_READER_RE.test(record.name)
    && !record.error
    && record.terminalVerification?.status !== 'failed'
    && Boolean(exactDocumentReadTarget(record))
    && hasActualDocumentReadContent(record);
}

export interface VerifiedCurrentAuthoringDocumentEvidence {
  windowSource: 'active_window' | 'running_window';
  documentName: string;
  documentPath: string;
  content: string;
  readRecord: ToolExecutionRecord;
}

/**
 * Resolve the complete current-authoring-document proof once and reuse it at
 * every execution boundary. Window identity, exact path, and semantic read
 * content are independent facts; no caller may infer one of them from a
 * lossy target-source label or from model narration.
 */
export function resolveVerifiedCurrentAuthoringDocumentEvidence(
  records: ToolExecutionRecord[] = [],
  taskText = '',
  taskCapsule?: TaskCapsuleV1 | null,
): VerifiedCurrentAuthoringDocumentEvidence | null {
  if (!requiresCurrentAuthoringDocumentInspection(taskText)) return null;
  const successful = expandSuccessfulRecords(records);
  const observedWindow = selectVerifiedAuthoringWindowCandidate(successful, taskText);
  if (!observedWindow) return null;

  const capsuleCurrentTarget = compact(taskCapsule?.target?.path);
  const capsuleCurrentName = compact(
    taskCapsule?.target?.object
    || taskCapsule?.target?.label
    || capsuleCurrentTarget,
  );
  const capsuleRejectedTargets = (taskCapsule?.rejectedTargets || [])
    .map(item => compact(item?.identity))
    .filter(Boolean);
  const capsuleHasUsableCurrentTarget = Boolean(
    taskCapsule
    && taskCapsule.schemaVersion === 1
    && taskCapsule.target?.status !== 'rejected'
    && capsuleCurrentTarget
    && DOCUMENT_TARGET_EXTENSION_RE.test(capsuleCurrentTarget),
  );
  if (taskCapsule?.target?.status === 'rejected') return null;
  if (
    capsuleCurrentName
    && !sameDocumentBasename(capsuleCurrentName, observedWindow.documentName)
  ) return null;
  if (
    capsuleHasUsableCurrentTarget
    && capsuleRejectedTargets.some(rejected => (
      sameExactDocumentTarget(rejected, capsuleCurrentTarget)
    ))
  ) return null;

  const resolvedTarget = capsuleHasUsableCurrentTarget
    ? capsuleCurrentTarget
    : observedWindow.documentPath
      || uniquelyDiscoveredDocumentPath(successful, observedWindow.documentName);
  if (
    !resolvedTarget
    || !sameDocumentBasename(resolvedTarget, observedWindow.documentName)
    || capsuleRejectedTargets.some(rejected => sameExactDocumentTarget(rejected, resolvedTarget))
  ) return null;

  const readRecord = [...successful].reverse().find(record => {
    if (!isSuccessfulExactDocumentRead(record)) return false;
    const readTarget = exactDocumentReadTarget(record);
    if (capsuleRejectedTargets.some(rejected => sameExactDocumentTarget(rejected, readTarget))) return false;
    return sameExactDocumentTarget(resolvedTarget, readTarget);
  });
  if (!readRecord) return null;
  const content = actualDocumentReadContent(readRecord);
  if (!content) return null;
  return {
    windowSource: observedWindow.source,
    documentName: observedWindow.documentName,
    documentPath: resolvedTarget,
    content,
    readRecord,
  };
}

function explicitDocumentTargets(taskText: string): string[] {
  return taskText.match(
    /(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/(?!\/))[^\r\n<>|*?"']+?\.(?:pptx?|docx?|xlsx?|pdf|rtf|txt|md|csv|json|wps|et|dps|png|jpe?g|webp|bmp|gif|tiff?)\b/giu,
  ) || [];
}

export function requestsExactReadOnlyArtifactInspection(taskText: string): boolean {
  const primary = compact(extractPrimaryTaskText(taskText));
  if (!primary) return false;
  // Keep this branch deliberately narrower than generic artifact work. A
  // create/write/edit request may inspect the source first, but that read is
  // preparation rather than completion of the requested mutation.
  // i18n-allow: file analysis includes calculations over the accepted source.
  const wantsSemanticRead = /(?:计算|核算|汇总|算出|口算|重新算|列出|金额|数量|\u8bfb\u53d6|\u9605\u8bfb|\u67e5\u770b|\u68c0\u67e5|\u68c0\u89c6|\u5206\u6790|\u603b\u7ed3|\u5ba1\u9605|\u5185\u5bb9|\u91cc\u9762|\u6587\u4ef6\u4e2d)|\b(?:read|calculate|recalculate|compute|inspect|examine|analy[sz]e|review|summari[sz]e|contents?|inside|marker|amount|quantity)\b/iu.test(primary);
  if (!wantsSemanticRead) return false;
  // i18n-allow: File/attachment subject recognition.
  const hasFileSubject = /(?:附件|已有资料|提供的资料|\u6587\u4ef6|\u6587\u6863|\u6587\u672c|\u8def\u5f84)|\b(?:attachment|file|document|filepath|path)\b|\b(?:read|inspect)\s+(?:the\s+)?(?:available|provided|attached)\s+source\b/iu.test(primary) || explicitDocumentTargets(primary).length > 0 || DOCUMENT_TARGET_MENTION_RE.test(primary);
  if (!hasFileSubject) return false;
  const wantsMutation = hasRequestedArtifactMutation(primary);
  return !wantsMutation;
}

/**
 * Bind a semantic document-read receipt to the exact file identity supplied
 * by the accepted task. A reader choosing some other file is useful evidence
 * about that file, but can never complete this request.
 */
export function documentReadMatchesRequestedTarget(
  record: ToolExecutionRecord,
  taskText: string,
  acceptedTaskTarget?: AcceptedTaskTarget,
  currentAttachmentPaths: string[] = [],
  sourceScope?: { userId: string; domain: string; orgId: string },
): boolean {
  if (record.name === 'knowledge_file_stats') {
    if (!isSuccessfulExactDocumentRead(record)) return false;
    const payload = JSON.parse(record.result);
    if (sourceScope && (payload.userId !== sourceScope.userId || payload.domain !== sourceScope.domain || String(payload.orgId || '') !== sourceScope.orgId)) return false;
    return record.arguments.fileIds.every((id: string) => new RegExp('(^|[^A-Za-z0-9_.-])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^A-Za-z0-9_.-])', 'u').test(taskText));
  }
  // Target correlation is independent from content retention. Large structured
  // reads may be compacted before a later finalization pass, but their exact
  // path and verified envelope remain authoritative for deciding whether this
  // was the requested file. Callers that require semantic read completion must
  // separately require isSuccessfulExactDocumentRead.
  if (
    !CURRENT_DOCUMENT_READER_RE.test(record.name)
    || Boolean(record.error)
    || record.terminalVerification?.status === 'failed'
  ) return false;
  const target = exactDocumentReadTarget(record);
  const requestedTask = compact(extractPrimaryTaskText(taskText));
  // The save-as destination belongs to output verification. It must not
  // replace an explicitly preserved source or its server-owned continuation.
  const primaryTask = sourceDocumentInstruction(preservedSourceOutputScope(requestedTask)?.sourceText || requestedTask);
  if (!target || !primaryTask) return false;

  // When the user supplied an absolute document path, basename equality is
  // insufficient: two directories may legitimately contain the same name.
  const absoluteTargets = explicitDocumentTargets(primaryTask);
  if (absoluteTargets.length > 0) {
    return absoluteTargets.some(candidate => sameExactDocumentTarget(candidate, target));
  }

  // i18n-allow: Current-upload reference recognition.
  if (/(?:附件|这个文件|该文件|这张图|这个图|\b(?:this\s+)?attachment\b)/iu.test(primaryTask) && currentAttachmentPaths.length) {
    return currentAttachmentPaths.some(candidate => sameExactDocumentTarget(candidate, target));
  }

  if (acceptedTaskTarget?.target.path) {
    return acceptedTaskTarget.target.status !== 'rejected'
      && sameExactDocumentTarget(acceptedTaskTarget.target.path, target);
  }

  const targetName = documentBasename(target, record.name === 'ocr_image_file' ? /\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i : DOCUMENT_TARGET_EXTENSION_RE);
  if (targetName) {
    const normalizedTask = primaryTask.normalize('NFKC').toLocaleLowerCase('en-US');
    if (normalizedTask.includes(targetName.normalize('NFKC').toLocaleLowerCase('en-US'))) {
      return true;
    }
  }

  const args = record.arguments || {};
  const explicitAttachmentIdentities = [
    args.attachmentId,
    args.attachmentID,
    args.fileId,
    args.fileID,
    args.sourceId,
    args.sourceID,
  ].map(value => compact(value)).filter(value => value.length >= 4);
  const normalizedTask = primaryTask.normalize('NFKC').toLocaleLowerCase('en-US');
  if (explicitAttachmentIdentities.some(identity => (
    normalizedTask.includes(identity.normalize('NFKC').toLocaleLowerCase('en-US'))
  ))) return true;
  const envelopeTarget = compact(record.envelope?.targetIdentity);
  const refersToAttachment = /(?:附件|这个文件|该文件|这张图|这个图|\b(?:this\s+)?attachment\b)/iu.test(primaryTask); // i18n-allow: reviewed attachment-reference intent.
  return refersToAttachment
    && envelopeTarget.length >= 4
    && explicitAttachmentIdentities.some(identity => identity === envelopeTarget);
}

export function hasVerifiedExactReadOnlyArtifactEvidence(
  records: ToolExecutionRecord[],
  taskText: string,
  acceptedTaskTarget?: AcceptedTaskTarget,
): boolean {
  if (!requestsExactReadOnlyArtifactInspection(taskText)) return false;
  return records.some(record => {
    if (
      record.terminalVerification?.status !== 'verified'
      || !isSuccessfulExactDocumentRead(record)
    ) return false;
    return documentReadMatchesRequestedTarget(record, taskText, acceptedTaskTarget);
  });
}
