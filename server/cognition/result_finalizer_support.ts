import { artifactRecordMatchesTurn } from '../tools/artifact_evidence';
import { mediaContractForRequest } from './contracts/media_contract';
import { buildActionEvidenceContract, extractPrimaryTaskText, hasCoreActionEvidence } from './action_contract';
import type { ToolExecutionRecord } from '../tools/types';
import { toolRecordSucceeded } from './task_execution_ledger';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { formatInternalDispatchUnavailable } from "../regions/messages/naturalness_messages";
import { CN_MESSAGING_MESSAGES } from "../regions/messages/messaging_messages";
import { CN_VOICE_FAST_PATH_MESSAGES, formatCnToolFailureDetail } from "../regions/messages/voice_fast_path_messages";
import { CN_EXECUTION_EVIDENCE_MESSAGES } from "../regions/messages/execution_evidence_messages";
import { type LumiResultFinalizerInput } from "./result_finalizer_types";

export function resultTaskText(input: LumiResultFinalizerInput): string {
  const routed = String(input.flow?.routeText || '').trim();
  return routed || String(input.taskText || '').trim();
}

export function hasResultCoreActionEvidence(
  input: LumiResultFinalizerInput,
  contract: ReturnType<typeof buildActionEvidenceContract>,
  records: ToolExecutionRecord[],
  taskText: string,
): boolean {
  return hasCoreActionEvidence(contract, records, taskText, undefined, {
    requestId: input.requestId,
    taskId: input.taskId,
  }, input.flow?.acceptedTaskTarget);
}

/** A completion/progress claim may consume only receipts fenced to this turn. */
export function isVerifiedCurrentTurnRecord(
  input: LumiResultFinalizerInput,
  record: ToolExecutionRecord,
): boolean {
  if (!toolRecordSucceeded(record) || !artifactRecordMatchesTurn(record, input)) return false;
  const receipt = parseReceiptObject(record.receipt);
  const result = parseReceiptObject(record.result);
  return record.terminalVerification?.status === 'verified'
    || (
      record.envelope?.status === 'verified_success'
      && record.envelope.verification?.status === 'verified'
    )
    || receipt?.status === 'verified_success'
    || receipt?.status === 'verified'
    || receipt?.verification?.status === 'verified'
    || receipt?.terminalVerification?.status === 'verified'
    || result?.status === 'verified_success'
    || result?.status === 'verified'
    || result?.verification?.status === 'verified'
    || result?.terminalVerification?.status === 'verified';
}

export function taskActionContract(input: LumiResultFinalizerInput) {
  const text = resultTaskText(input);
  const accepted = input.flow?.acceptedActionContract;
  const contract = input.flow?.structuredMediaRequest
    ? mediaContractForRequest(input.flow.structuredMediaRequest) : buildActionEvidenceContract(text, undefined, accepted);
  if (!input.flow?.preparationRootText) return contract;
  const root = input.flow.preparationRootText;
  return { ...contract, components: [
    { text: root, contract: buildActionEvidenceContract(root) },
    { text: extractPrimaryTaskText(text), contract },
  ] };
}

export function isInternalRuntimeWorkNarration(value: string): boolean {
  const text = String(value || '').trim();
  if (!text) return true;
  // These are model/tool-loop control messages, not useful user feedback. A
  // verified runtime receipt must still produce a concise visible answer.
  return /(?:内部调度没有形成可用结果|模型不得重新快照|无法形成已验证.*(?:提议|清理)|当前模型请求没有声明|只能由运行时采用|工具结果已收到|no response|no (?:verified|actual) .*result|cannot .*reconstruct .*target)/iu.test(text); // i18n-allow: internal execution-narration recognition; not user-visible copy.
}

export function isChineseText(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value || '');
}

export function sanitizeInternalExecutionText(value: string, chinese: boolean): string {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const internalLine = /(?:No successful (?:current-turn )?tool execution|\ballowedTools\b|\bappTarget\b|\bUI\s*evidence\b|work product guard|action contract|Required completion evidence|Preferred tools|Verification tools|tool route|tool protocol|Maximum tool call iterations|execution_recovery_incomplete|desktop_control_paused_for_user_activity|target_mismatch|<\/?function_calls?>|<invoke\b|\[historical\s+source=[^\]]+\]|\[[^\]\r\n]{1,48}\]\s*[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\(|^\s*(?:\u72b6\u6001\s*[:\uff1a]\s*(?:\u5931\u8d25|\u53d7\u963b)|\u8bc1\u636e\s*[:\uff1a]|\u5177\u4f53\u963b\u585e\s*[:\uff1a]|\u6267\u884c\u53cd\u9988\s*$|\u5df2\u5b8c\u6210\u9879\s*$|\u673a\u5668\u8bc1\u636e\s*$|\u672a\u5b8c\u6210\u9879\s*$|\u963b\u585e\u9879\s*$|\u4e0b\u4e00\u6b65\s*$)|\u6211\u5df2\u4fdd\u7559\u539f\u76ee\u6807.{0,120}\u56de\u6267)/i;
  const withoutHistoryMarkers = raw.replace(/\[historical\s+source=[^\]]+\]\s*/gi, '');
  if (!internalLine.test(withoutHistoryMarkers) && withoutHistoryMarkers === raw) return raw;
  const cleaned = withoutHistoryMarkers
    .split(/\r?\n/)
    .filter(line => !internalLine.test(line))
    .join('\n')
    .trim();
  return cleaned || formatInternalDispatchUnavailable(chinese);
}

export function summarizeToolFailure(records: ToolExecutionRecord[]): string {
  const webAccountBlocker = summarizeWebAccountBlocker(records);
  if (webAccountBlocker) return webAccountBlocker;
  const failed = [...records].reverse().find(record => record.error);
  if (!failed) return '';
  const name = String(failed.name || '');
  const error = String(failed.error || '').trim();
  const action = (() => {
    if (/^(desktop_open|open_item)$/i.test(name)) return '\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\u7a97\u53e3';
    if (/^(desktop_active_window|get_active_window_info)$/i.test(name)) return '\u8bfb\u53d6\u5f53\u524d\u524d\u53f0\u7a97\u53e3';
    if (/^(wechat_read_recent_chat)$/i.test(name)) return '\u5fae\u4fe1\u524d\u53f0\u804a\u5929\u8bfb\u53d6';
    if (/^(wechat_send_message)$/i.test(name)) return CN_MESSAGING_MESSAGES.textSendAction;
    if (/^(wechat_send_file)$/i.test(name)) return CN_MESSAGING_MESSAGES.fileSendAction;
    if (/^(computer_use)$/i.test(name)) return '\u89c6\u89c9\u684c\u9762\u6267\u884c';
    if (/keyboard/i.test(name)) return '\u952e\u76d8\u8f93\u5165';
    if (/mouse|cursor/i.test(name)) return '\u5149\u6807\u70b9\u51fb';
    return CN_VOICE_FAST_PATH_MESSAGES.genericToolAction;
  })();
  return error ? `${action}\uff1a${formatCnToolFailureDetail(error)}` : action;
}

function summarizeWebAccountBlocker(records: ToolExecutionRecord[]): string {
  const browserWindow = [...records].reverse().find(record => record.name === 'desktop_active_window' && !record.error);
  const browserIdentity = browserWindow ? parseReceiptObject(toolRecordTerminalPayload(browserWindow)) : null;
  if (browserIdentity && /(?:chrome|msedge|firefox)/iu.test(String(browserIdentity.process_name || browserIdentity.processName || ''))) {
    const browserPid = Number(browserIdentity.pid || browserIdentity.processId);
    for (const record of [...records].reverse()) {
      if (record.name !== 'desktop_ui_snapshot' || record.error) continue;
      const snapshot = parseReceiptObject(toolRecordTerminalPayload(record));
      if (snapshot?.status !== 'ok' || !browserPid || snapshot.tree?.processId !== browserPid) continue;
      const nodes = [snapshot.tree];
      for (let count = 0; nodes.length && count < 300; count++) {
        const node = nodes.shift();
        // i18n-allow: Observed login-control names, not instructions from web content.
        if (node?.controlType === 'Edit' && /(?:请输入手机号|手机号码|登录密码|login password|phone number)/iu.test(String(node.name || ''))) {
          return CN_EXECUTION_EVIDENCE_MESSAGES.browserLoginFormVisible;
        }
        if (Array.isArray(node?.children)) nodes.push(...node.children);
      }
    }
  }
  for (const record of [...records].reverse()) {
    const name = String(record.name || '');
    const result = String(record.result || '');
    const error = String(record.error || '');
    if (/^web_login_profile_list$/i.test(name) && /"profiles"\s*:\s*\[\s*\]/i.test(result)) {
      return '\u6ca1\u6709\u627e\u5230\u5df2\u4fdd\u5b58\u7684\u7f51\u9875\u767b\u5f55 profile/\u4f1a\u8bdd';
    }
    if (/^web_login_run$/i.test(name) && /manual_required|captcha|2FA|QR|passkey|\u9a8c\u8bc1\u7801|\u626b\u7801|\u4e8c\u6b21\u9a8c\u8bc1/i.test(`${result}\n${error}`)) {
      return '\u767b\u5f55\u9700\u8981\u624b\u52a8\u5b8c\u6210\u626b\u7801\u3001\u9a8c\u8bc1\u7801\u30012FA \u6216\u8d26\u53f7\u786e\u8ba4';
    }
    if (/mcp_playwright_browser_(?:evaluate|run_code_unsafe)/i.test(name) && /cross-origin|Blocked a frame|iframe|contentFrame/i.test(`${result}\n${error}`)) {
      return '\u767b\u5f55\u6846\u5728\u8de8\u57df iframe \u91cc\uff0c\u666e\u901a\u9875\u9762 JS \u4e0d\u80fd\u76f4\u63a5\u63a5\u7ba1\uff1b\u9700\u8981\u8d70\u53ef\u89c1 web_login_run \u4f1a\u8bdd\u6216\u7528\u6237\u5b8c\u6210\u9a8c\u8bc1';
    }
  }
  return '';
}

export function requiresSourceGroundedArtifactContent(actionText: string): boolean {
  return /(?:\u4ee5|\u6839\u636e|\u57fa\u4e8e|\u53c2\u7167).{0,80}(?:\u771f\u5b9e\u5185\u5bb9|\u6e90\u6587\u4ef6|\u6750\u6599|\u6587\u4ef6\u5185\u5bb9).{0,100}(?:\u6765\u6e90|\u751f\u6210|\u521b\u5efa|\u586b\u5199|\u6574\u7406)|(?:\u771f\u5b9e\u5185\u5bb9|\u6e90\u6587\u4ef6).{0,100}(?:\u552f\u4e00\u6765\u6e90|\u751f\u6210|\u521b\u5efa|\u586b\u5199|\u6574\u7406)/iu.test(actionText);
}

export function findUnresolvedArtifactPlaceholder(artifactText: string): string {
  const line = String(artifactText || '')
    .split(/\r?\n/u)
    .map(value => value.trim())
    .find(value => /(?:\u6839\u636e|\u57fa\u4e8e|\u53c2\u7167).{0,24}(?:\u586b\u5199|\u8865\u5145|\u751f\u6210|\u66ff\u6362)|\u5f85(?:\u586b\u5199|\u8865\u5145|\u751f\u6210|\u66ff\u6362)|\b(?:TBD|TODO)\b|\{\{[^}]+\}\}/iu.test(value));
  return line || '';
}
