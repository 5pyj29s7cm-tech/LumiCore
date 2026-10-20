import { playbackObservationText } from './action_media_evidence';
import { extractDesktopLaunchTarget, extractSimpleDesktopOpenTarget, requestedMediaPlayerTarget, hasMediaPlaybackEvidence, hasRequestedDesktopOpenEvidence, hasVisualModelAvailabilityEvidence, requiresCurrentAuthoringDocumentInspection, requiresCurrentAppUiMutation, requiresVisualModelAvailabilityCheck, requiresVisibleAutoCadExecution, resolveVerifiedCurrentAuthoringDocumentEvidence } from './action_contract';
import { parseReceiptObject, toolRecordTerminalPayload, toolRecordTerminalText } from '../tools/receipt_payload';
import { CN_EXECUTION_EVIDENCE_MESSAGES } from "../regions/messages/execution_evidence_messages";
import { evaluateDesktopObservationEvidence, requiresActiveWindowObservation } from './desktop_observation';
import type { ToolExecutionRecord } from '../tools/types';
import { hasMatchingDesktopOpenEvidence, hasMatchingBrowserOpenEvidence } from './action_desktop_evidence';
import { toolRecordSucceeded } from './task_execution_ledger';
import { CN_VOICE_FAST_PATH_MESSAGES, formatCnClientActionTargetLabel } from "../regions/messages/voice_fast_path_messages";
import { normalizeActionIntent } from './normalized_action_intent';
import { isVideoPlaybackRequest } from './media_intent';
import { validatePlaybackVerification } from './playback_verification';
import { artifactRecordMatchesTurn, artifactPathFromRecord } from '../tools/artifact_evidence';
import { CN_TASK_TARGET_ANCHOR_MESSAGES } from "../regions/messages/task_target_anchor_messages";
import { type LumiResultFinalizerInput, type LumiResultFinalizerResult } from "./result_finalizer_types";
import { resultTaskText, isChineseText, taskActionContract, hasResultCoreActionEvidence } from "./result_finalizer_support";

export function formatCurrentAuthoringDocumentClarification(
  input: LumiResultFinalizerInput,
): string | null {
  const taskText = resultTaskText(input);
  if (!requiresCurrentAuthoringDocumentInspection(taskText)) return null;
  const activeWindowRecord = [...(input.toolRecords || [])].reverse().find(record => (
    /^(?:desktop_active_window|get_active_window_info)$/i.test(String(record.name || ''))
    && !record.error
  ));
  const payload = activeWindowRecord
    ? parseReceiptObject(activeWindowRecord.receipt)
      || parseReceiptObject(activeWindowRecord.result)
      || {}
    : {};
  const nestedWindow = payload.activeWindow && typeof payload.activeWindow === 'object'
    ? payload.activeWindow
    : payload.window && typeof payload.window === 'object'
      ? payload.window
      : {};
  const title = String(
    payload.windowTitle
    || payload.title
    || nestedWindow.windowTitle
    || nestedWindow.title
    || '',
  ).trim().slice(0, 180);
  const processName = String(
    payload.processName
    || payload.process_name
    || payload.executable
    || nestedWindow.processName
    || nestedWindow.process_name
    || nestedWindow.executable
    || '',
  ).trim().replace(/^.*[\\/]/, '').slice(0, 120);
  const visibleTarget = title || processName;
  const authoringSurface = /(?:\bwps(?:\.exe)?\b|\bwpp(?:\.exe)?\b|\bet(?:\.exe)?\b|\bwinword(?:\.exe)?\b|\bexcel(?:\.exe)?\b|\bpowerpnt(?:\.exe)?\b|\bword\b|\bpowerpoint\b)/iu
    .test(`${title}\n${processName}`);
  const zh = isChineseText(taskText) || isChineseText(input.responseText);
  if (authoringSurface) {
    return zh
      ? CN_EXECUTION_EVIDENCE_MESSAGES.currentAuthoringNeedsExactFile(visibleTarget)
      : `I can see “${visibleTarget}” in the foreground, but I cannot yet bind it to one exact file. Save the document first or attach the file, and I can continue the analysis.`;
  }
  if (visibleTarget) {
    return zh
      ? CN_EXECUTION_EVIDENCE_MESSAGES.currentAuthoringWrongForeground(visibleTarget)
      : `The foreground window is “${visibleTarget}”, not a readable WPS, Word, Excel, or PowerPoint document. Bring the document to the foreground or attach the file.`;
  }
  return zh
    ? CN_EXECUTION_EVIDENCE_MESSAGES.currentAuthoringMissingForeground
    : 'I cannot identify a foreground document window yet. Bring the document to the foreground or attach the file.';
}

export function formatGroundedDesktopEvidence(input: LumiResultFinalizerInput): string | null {
  const evidence = evaluateDesktopObservationEvidence(input.toolRecords || [], resultTaskText(input));
  return evidence.complete ? evidence.text : null;
}

const parseDesktopOpenResult = (record: ToolExecutionRecord): Record<string, any> => parseReceiptObject(toolRecordTerminalPayload(record)) || {};

export function isVerifiedPrimaryDesktopOpen(record: ToolExecutionRecord, requestedTarget: string): boolean {
  return hasMatchingDesktopOpenEvidence(record, requestedTarget)
    || (toolRecordSucceeded(record) && hasMatchingBrowserOpenEvidence(record, requestedTarget));
}

function friendlyDesktopOpenTarget(
  requestedTarget: string,
  record: ToolExecutionRecord,
  payload: Record<string, any>,
): string {
  const invoked = String(
    record.arguments?.target
    || record.arguments?.path
    || record.arguments?.url
    || payload.target
    || requestedTarget,
  ).trim();
  const baseName = invoked.split(/[\\/]/).pop() || invoked;
  // i18n-allow -- Chinese generic-browser target recognition; not user-visible copy.
  if (/^(?:浏览器|browser|webbrowser)$/iu.test(requestedTarget.replace(/\s+/g, ''))) {
    const actual = `${payload.actualTarget?.processName || ''} ${payload.actualTarget?.title || ''} ${invoked}`;
    if (/chrome/iu.test(actual)) return 'Google Chrome';
    if (/msedge|microsoft\s*edge/iu.test(actual)) return 'Microsoft Edge';
    if (/firefox/iu.test(actual)) return 'Firefox';
    if (/safari/iu.test(actual)) return 'Safari';
  }
  const invokedLooksLikeFile = /[\\/]/u.test(invoked) || /\.[a-z0-9]{1,10}$/iu.test(invoked);
  // i18n-allow -- Chinese file-reference recognition; not user-visible copy.
  const requestedIsFileReference = /(?:桌面|文件|文档|file|document)/iu.test(requestedTarget);
  return invokedLooksLikeFile && requestedIsFileReference
    ? (baseName || requestedTarget)
    : requestedTarget;
}

function isFailedOptionalPostOpenObservation(record: ToolExecutionRecord): boolean {
  const failed = Boolean(record.error)
    || record.terminalVerification?.status === 'failed'
    || record.terminalVerification?.status === 'unverified'
    || Boolean(record.envelope && record.envelope.status !== 'verified_success');
  if (!failed) return false;
  const name = String(record.name || '');
  if (/^(?:desktop_execution_plan_receipt|desktop_active_window|get_active_window_info|desktop_running_processes|get_running_processes|desktop_capture_screen|desktop_ocr|computer_vision)$/i.test(name)) {
    return true;
  }
  if (!/^desktop_run_command$/i.test(name)) return false;
  return /(?:fingerprint|target[_ ]?mismatch|focus|foreground|window|display|paused_for_user_activity)/iu
    .test(`${record.error || ''}\n${record.result || ''}`);
}

export function formatGroundedSimpleDesktopOpenResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  const primaryTask = actionText.split(/\n## Recent action continuation context\b/i, 1)[0].trim();
  const requestedTarget = extractSimpleDesktopOpenTarget(actionText)
    || (/^(?:你)?(?:直接)?(?:把)?(?:它|这个|那个|文件|文档)?(?:给我)?打开(?:一下)?[。！？.!?]*$/iu.test(primaryTask) // i18n-allow: Chinese referential-open recognition; not user-visible copy.
      ? String([...(input.toolRecords || [])].reverse().find(record => /^(?:desktop_open|browser_open_task)$/i.test(record.name))?.arguments?.target || '')
      : '');
  if (!requestedTarget) return null;
  const contract = taskActionContract(input);
  if (contract.kind !== 'desktop_operation') return null;
  const records = input.toolRecords || [];
  let openIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isVerifiedPrimaryDesktopOpen(records[index], requestedTarget)) {
      openIndex = index;
      break;
    }
  }
  if (openIndex < 0) return null;
  const successfulOpen = records[openIndex];
  const openPayload = parseDesktopOpenResult(successfulOpen);
  const targetLabel = friendlyDesktopOpenTarget(requestedTarget, successfulOpen, openPayload);
  const laterObservationFailed = records.slice(openIndex + 1).some(isFailedOptionalPostOpenObservation);

  // A launch request may explicitly require the real foreground process and
  // window as its completion proof. Keep that receipt detail instead of
  // collapsing the answer to the generic "opened" acknowledgement below.
  // This is intentionally derived from the desktop receipts, never from the
  // model's prose, so the final response cannot invent verification evidence.
  if (requiresActiveWindowObservation(actionText)) {
    const activeRecord = [...(input.toolRecords || [])].reverse().find(record => (
      /^(?:desktop_active_window|get_active_window_info)$/i.test(String(record.name || ''))
      && !record.error
      && String(record.result || '').trim()
    ));
    if (activeRecord) {
      let openResult: Record<string, any> = {};
      let activeResult: Record<string, any> = {};
      try { openResult = JSON.parse(String(successfulOpen.result || '{}')); } catch {}
      try { activeResult = JSON.parse(String(activeRecord.result || '{}')); } catch {}
      const processName = String(
        activeResult.process_name
        || activeResult.processName
        || activeResult.executable
        || '',
      ).trim().replace(/^.*[\\/]/, '');
      const processId = Number(activeResult.pid || activeResult.processId) || 0;
      const windowTitle = String(activeResult.title || activeResult.windowTitle || '').trim();
      const verificationStatus = String(
        openResult.verification?.status
        || openResult.status
        || '',
      ).trim().toLowerCase();
      const targetMatched = openResult.targetMatched === true
        || openResult.verification?.targetMatched === true;
      const verified = targetMatched
        && Boolean(processName || windowTitle)
        && !/^(?:failed|error|blocked|unknown|unverified)$/i.test(verificationStatus);
      if (isChineseText(actionText)) {
        return {
          text: [
          CN_VOICE_FAST_PATH_MESSAGES.opened(targetLabel),
          `实际进程：${processName || '回执未记录'}${processId ? ` (PID ${processId})` : ''}`,
          `窗口：${windowTitle || '回执未记录'}`,
          `验证状态：${verified ? '已验证（目标精确匹配）' : '未验证'}`,
          ].join('\n'),
          blocked: false,
          reason: 'Grounded exact desktop-open success from the requested target receipt.',
        };
      }
      return {
        text: [
          `Opened ${targetLabel}.`,
          `Actual process: ${processName || 'not recorded'}${processId ? ` (PID ${processId})` : ''}`,
          `Window: ${windowTitle || 'not recorded'}`,
          `Verification: ${verified ? 'verified (exact target match)' : 'unverified'}`,
        ].join('\n'),
        blocked: false,
        reason: 'Grounded exact desktop-open success from the requested target receipt.',
      };
    }
  }
  const text = isChineseText(actionText)
    ? [
        CN_VOICE_FAST_PATH_MESSAGES.opened(targetLabel),
        ...(laterObservationFailed
          ? [CN_VOICE_FAST_PATH_MESSAGES.postOpenObservationIncomplete]
          : []),
      ].join('\n')
    : [
        `Opened ${targetLabel}.`,
        ...(laterObservationFailed
          ? ['A later window/focus check did not finish, but that does not undo the verified open action.']
          : []),
      ].join('\n');
  return {
    text,
    blocked: false,
    reason: laterObservationFailed
      ? 'Primary desktop-open verified; optional post-open observation incomplete.'
      : 'Grounded exact desktop-open success from the requested target receipt.',
  };
}

function parseVerifiedClientActionReceipt(record: ToolExecutionRecord): {
  action: string;
  mode: string;
  enabled: boolean;
  target: string;
  say: string;
} | null {
  if (record.error || record.name !== 'client_action') return null;
  try {
    const payload = JSON.parse(String(record.result || '{}'));
    const status = String(payload?.verification?.status || payload?.status || '').trim().toLowerCase();
    if (payload?.ok !== true || !['verified', 'not_applicable'].includes(status)) return null;
    return {
      action: String(payload?.action || record.arguments?.action || '').trim(),
      mode: String(payload?.mode || record.arguments?.mode || '').trim(),
      enabled: Boolean(payload?.enabled ?? record.arguments?.enabled),
      target: String(
        payload?.target
        || payload?.expectation?.target
        || payload?.relayResult?.target
        || record.arguments?.target
        || '',
      ).trim(),
      say: String(payload?.say || payload?.verification?.message || '').trim(),
    };
  } catch {
    return null;
  }
}

export function formatGroundedClientActionResult(input: LumiResultFinalizerInput): string | null {
  // The client-action-only route already performed exact target selection and
  // state-diff verification. A verified native navigation receipt is stronger
  // evidence than a model sentence that happens to claim the action failed.
  const expectedIntent = normalizeActionIntent(resultTaskText(input));
  if (
    expectedIntent.kind !== 'client_navigation'
    || !expectedIntent.clientAction
  ) return null;
  const expectedAction = expectedIntent.clientAction;
  const expectedMode = String(expectedIntent.clientActionArguments?.mode || '').trim();
  const expectedEnabled = expectedIntent.clientActionArguments?.enabled;
  const receipts = (input.toolRecords || [])
    .filter(record => artifactRecordMatchesTurn(record, input))
    .map(parseVerifiedClientActionReceipt)
    .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
  const receipt = [...receipts].reverse().find(item => (
    item.action === expectedAction
    && (expectedAction !== 'set_client_mode' || !expectedMode || item.mode === expectedMode)
    && (expectedAction !== 'set_wallpaper_mode'
      || typeof expectedEnabled !== 'boolean'
      || item.enabled === expectedEnabled)
  ));
  if (!receipt) return null;

  if (!isChineseText(resultTaskText(input))) {
    return receipt.say || 'The requested Lumi client action is complete.';
  }
  if (receipt.action === 'set_client_mode') {
    return CN_VOICE_FAST_PATH_MESSAGES.operationModeChanged(receipt.mode || 'assistant');
  }
  if (receipt.action === 'set_wallpaper_mode') {
    return receipt.enabled ? '壁纸模式已开启。' : '壁纸模式已关闭。';
  }
  if (receipt.action === 'refresh_client_state') return '客户端状态已刷新。';
  const label = formatCnClientActionTargetLabel(receipt.action, receipt.target || 'Lumi 界面');
  if (/^(?:close_|exit_)/.test(receipt.action)) return `${label}已关闭。`;
  if (/^(?:open_|show_|focus_|enter_)/.test(receipt.action)) {
    return CN_VOICE_FAST_PATH_MESSAGES.opened(label);
  }
  return `已完成${label}操作。`;
}

export function formatGroundedPartialActionResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  const contract = taskActionContract(input);
  if (!contract.applies || hasResultCoreActionEvidence(input, contract, input.toolRecords || [], actionText)) return null;
  if (requiresCurrentAppUiMutation(actionText) || requiresVisibleAutoCadExecution(actionText)) return null;

  const openRecord = [...(input.toolRecords || [])].reverse().find(record => (
    /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || ''))
    && toolRecordSucceeded(record)
  ));
  if (openRecord && contract.kind === 'desktop_operation') {
    const target = String(
      openRecord.arguments?.target
      || openRecord.arguments?.url
      || openRecord.arguments?.path
      || extractSimpleDesktopOpenTarget(actionText)
      || '',
    ).trim();
    const normalizedTarget = target.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const normalizedTask = actionText.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const targetMatchesTask = normalizedTarget.length >= 2
      && (
        normalizedTask.includes(normalizedTarget)
        || normalizedTarget.includes(normalizedTask.replace(/^(?:\u8bf7|\u5e2e\u6211)?(?:\u6253\u5f00|open)/iu, ''))
      );
    if (target && targetMatchesTask) {
      const zh = isChineseText(actionText);
      const text = zh
        ? CN_VOICE_FAST_PATH_MESSAGES.partialOpen(target)
        : `Opened ${target}, but the remaining requested action has not been verified.`;
      return {
        text,
        blocked: true,
        reason: 'The open step succeeded, but the remaining requested action lacks verification.',
        notification: {
          type: 'work_product_guard',
          level: 'warning',
          message: 'The open step succeeded, but the remaining requested action lacks verification.',
        },
      };
    }
  }

  return null;
}

function requestedMediaPlayerLabel(taskText: string, records: ToolExecutionRecord[]): string {
  const requested = requestedMediaPlayerTarget(taskText);
  if (requested) return requested;
  const named = String(taskText || '').match(/(?:\u7f51\u6613\u4e91(?:\u97f3\u4e50)?|QQ\s*\u97f3\u4e50|\u9177\u72d7(?:\u97f3\u4e50)?|Spotify|Apple\s+Music|NetEase(?:\s+Cloud\s+Music)?|CloudMusic)/iu)?.[0];
  if (named) return named;
  const invoked = records.find(record => /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || '')));
  return String(
    invoked?.arguments?.target
    || invoked?.arguments?.url
    || extractDesktopLaunchTarget(taskText)
    || CN_EXECUTION_EVIDENCE_MESSAGES.genericMusicPlayer,
  ).trim().slice(0, 100);
}

function visualFailureCategory(records: ToolExecutionRecord[]): 'billing' | 'unconfigured' | 'paused' | 'generic' {
  const details = records.map(record => [
    record.error,
    record.terminalVerification?.reason,
    toolRecordTerminalText(record),
  ].map(value => String(value || '').slice(0, 1200)).join('\n')).join('\n');
  if (/(?:account is not in good standing|overdue(?:-payment)?|insufficient balance|\b402\b|\u6b20\u8d39|\u4f59\u989d\u4e0d\u8db3)/iu.test(details)) {
    return 'billing';
  }
  if (/(?:No configured visual-perception model|no vision (?:reader|model)|visual perception.{0,32}not configured|\u672a\u914d\u7f6e.{0,16}\u89c6\u89c9\u6a21\u578b)/iu.test(details)) {
    return 'unconfigured';
  }
  if (/(?:paused_for_user_activity|user activity|\u7528\u6237.{0,12}\u64cd\u4f5c.{0,12}\u6682\u505c)/iu.test(details)) {
    return 'paused';
  }
  return 'generic';
}

/** User-visible terminal wording for the two composite desktop goals that
 * previously accepted unrelated receipts. This consumes the existing action
 * contract verdict; it does not invent a second execution state machine. */
export function formatGoalSpecificDesktopResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const taskText = resultTaskText(input);
  const records = input.toolRecords || [];
  const zh = isChineseText(taskText) || isChineseText(input.responseText);

  if (requiresVisualModelAvailabilityCheck(taskText)) {
    if (hasVisualModelAvailabilityEvidence(records)) {
      return {
        text: zh
          ? CN_EXECUTION_EVIDENCE_MESSAGES.visualModelAvailable
          : 'The visual model is available; the live probe returned usable visual analysis.',
        blocked: false,
        reason: zh ? CN_EXECUTION_EVIDENCE_MESSAGES.visualProbeSucceeded : 'The live visual probe succeeded.',
      };
    }
    const category = visualFailureCategory(records);
    const text = zh
      ? category === 'billing'
        ? CN_EXECUTION_EVIDENCE_MESSAGES.visualModelBillingUnavailable
        : category === 'unconfigured'
          ? CN_EXECUTION_EVIDENCE_MESSAGES.visualModelUnconfigured
          : category === 'paused'
            ? CN_EXECUTION_EVIDENCE_MESSAGES.visualProbeInterrupted
            : CN_EXECUTION_EVIDENCE_MESSAGES.visualProbeUnconfirmed
      : category === 'billing'
        ? 'The visual model is unavailable because the provider rejected the account for billing or account-status reasons. Restore the account and try again.'
        : category === 'unconfigured'
          ? 'No usable visual model is configured. Select and save one in settings, then try again.'
          : category === 'paused'
            ? 'The live visual check was interrupted by foreground activity, so availability is not confirmed yet.'
            : 'The visual model did not return a usable result, so it is not confirmed available yet.';
    return {
      text,
      blocked: true,
      reason: text,
      notification: { type: 'work_product_guard', level: 'warning', message: text },
    };
  }

  if (taskActionContract(input).mediaPlayback === 'play') {
    const label = requestedMediaPlayerLabel(taskText, records);
    const video = isVideoPlaybackRequest(taskText);
    const opened = hasRequestedDesktopOpenEvidence(records, taskText, label);
    if (hasMediaPlaybackEvidence(records, taskText, { requestId: input.requestId, taskId: input.taskId })) {
      const proofRecord = [...records].reverse().find(record => record.name === 'computer_use'
        && hasMediaPlaybackEvidence([record], taskText, { requestId: input.requestId, taskId: input.taskId }));
      const proof = proofRecord && parseReceiptObject(toolRecordTerminalPayload(proofRecord))?.playbackVerification;
      if (validatePlaybackVerification(proof, taskText)) {
        const goal = proof.target;
        const targetLabel = goal.player || label;
        const contentLabel = [goal.title, goal.season ? `season ${goal.season}` : '', goal.episode ? `episode ${goal.episode}` : ''].filter(Boolean).join(', ');
        return {
          text: zh
            ? CN_EXECUTION_EVIDENCE_MESSAGES.verifiedPlaybackTarget(targetLabel, goal.title, goal.season, goal.episode)
            : `Confirmed ${contentLabel || 'the requested content'} is playing in ${targetLabel}; playback is advancing.`,
          blocked: false,
          reason: 'verified_playback_progress',
        };
      }
      return {
        text: (proofRecord && playbackObservationText(proofRecord)) || (zh
          ? CN_EXECUTION_EVIDENCE_MESSAGES.mediaPlaybackActive(label, video)
          : `Opened ${label}; playback is active.`),
        blocked: false,
        reason: zh ? CN_EXECUTION_EVIDENCE_MESSAGES.mediaPlaybackConfirmed : 'Playback state was confirmed.',
      };
    }
    const text = opened
      ? zh
        ? CN_EXECUTION_EVIDENCE_MESSAGES.mediaOpenedPlaybackUnconfirmed(label)
        : `Opened ${label}, but the requested content is not confirmed playing.`
      : zh
        ? CN_EXECUTION_EVIDENCE_MESSAGES.mediaOpenAndPlaybackUnconfirmed(label)
        : `${label} was not confirmed open, and playback was not confirmed.`;
    return {
      text,
      blocked: true,
      reason: text,
      notification: { type: 'work_product_guard', level: 'warning', message: text },
    };
  }

  return null;
}

function friendlyObservedOpenLabel(target: string): string {
  const raw = String(target || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.hostname.replace(/^www\./i, '') || raw;
  } catch {}
  if (/[\\/]/u.test(raw)) return raw.split(/[\\/]/).pop() || raw;
  return raw;
}

export function formatObservedDesktopOpenResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const taskText = resultTaskText(input);
  const target = extractDesktopLaunchTarget(taskText) || extractSimpleDesktopOpenTarget(taskText);
  if (!target || !hasRequestedDesktopOpenEvidence(input.toolRecords || [], taskText, target)) return null;
  const label = friendlyObservedOpenLabel(target);
  const zh = isChineseText(taskText) || isChineseText(input.responseText);
  return {
    text: zh ? CN_EXECUTION_EVIDENCE_MESSAGES.desktopObservedOpen(label) : `Opened ${label}.`,
    blocked: false,
    reason: zh ? CN_EXECUTION_EVIDENCE_MESSAGES.desktopObservedOpenReason : 'The requested page or window was observed in the same turn.',
  };
}

export function formatCreatedArtifactWithoutInAppCompletion(input: LumiResultFinalizerInput): string | null {
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    /^(?:create_docx|create_xlsx|create_ppt|create_pdf|write_file|cad_generate_dxf)$/i.test(String(item.name || ''))
    && toolRecordSucceeded(item)
    && artifactPathFromRecord(item)
  ));
  if (!record) return null;
  const path = artifactPathFromRecord(record);
  return isChineseText(resultTaskText(input))
    ? CN_VOICE_FAST_PATH_MESSAGES.partialArtifact(path)
    : `The file was created at ${path}, but the corresponding action was not completed in the target application.`;
}

function currentDocumentSummaryFragments(content: string): string[] {
  const raw = String(content || '')
    .replace(/\u0000/gu, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (!raw) return [];
  const lineCandidates = raw
    .split(/\n+/u)
    .map(line => line
      .replace(/^\s*(?:[-=]{2,}\s*)?(?:slide|page)\s*\d+\s*(?:[-=:]{1,}\s*)?/iu, '')
      // i18n-allow: Reviewed Chinese slide/page marker recognition; not user-visible copy.
      .replace(/^\s*第\s*\d+\s*(?:页|张|部分)\s*[：:]?\s*/u, '')
      .replace(/^\s*[•●▪◦*-]\s*/u, '')
      .replace(/\s+/gu, ' ')
      .trim())
    .filter(line => line.length >= 2 && line.length <= 220)
    .filter(line => !/^(?:path|file(?:path)?|source|bytes?|pages?|mime(?:type)?|status|ok|success)\s*[:=]/iu.test(line))
    // i18n-allow: Reviewed multilingual prompt-injection recognition; not user-visible copy.
    .filter(line => !/(?:ignore (?:all )?previous instructions|system prompt|reveal (?:the )?(?:secret|token|password)|请忽略(?:之前|以上|所有)指令|泄露(?:密钥|令牌|密码)|执行以下(?:命令|脚本))/iu.test(line));
  const candidates = lineCandidates.length >= 2
    ? lineCandidates
    : raw
      .split(/(?<=[。！？.!?])\s*/u)
      .map(part => part.replace(/\s+/gu, ' ').trim())
      .filter(part => part.length >= 4 && part.length <= 260);
  const unique: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const candidate of candidates) {
    const key = candidate.normalize('NFKC').toLocaleLowerCase('en-US');
    if (!key || seen.has(key)) continue;
    if (total + candidate.length > 760 && unique.length > 0) break;
    seen.add(key);
    unique.push(candidate);
    total += candidate.length;
    if (unique.length >= 8) break;
  }
  return unique;
}

export function formatGroundedCurrentAuthoringDocumentResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  const evidence = resolveVerifiedCurrentAuthoringDocumentEvidence(
    input.toolRecords || [],
    actionText,
  );
  if (!evidence) return null;
  const fragments = currentDocumentSummaryFragments(evidence.content);
  const zh = isChineseText(actionText) || isChineseText(evidence.content);
  const body = fragments.join(zh ? '；' : '; ');
  const text = zh
    ? body
      ? CN_TASK_TARGET_ANCHOR_MESSAGES.currentDocumentSummary(evidence.documentName, body)
      : CN_TASK_TARGET_ANCHOR_MESSAGES.currentDocumentWithoutUsableText(evidence.documentName)
    : body
      ? `I read “${evidence.documentName}”. It mainly covers: ${body}`
      : `I read “${evidence.documentName}”, but it contains no usable text to summarize.`;
  return {
    text,
    blocked: false,
    reason: 'grounded_current_authoring_document',
  };
}
