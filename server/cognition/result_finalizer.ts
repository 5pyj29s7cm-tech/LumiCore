import { guardCompletionClaims, needsCompletionEvidence } from '../work_product/completion_guard';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';
import { buildActionContract, hasCoreActionEvidence, summarizeActionContractBlocker } from './action_contract';

export interface LumiResultFinalizerInput {
  taskText: string;
  responseText: string;
  toolRecords?: ToolExecutionRecord[];
  source: 'chat' | 'voice' | 'task' | 'workflow' | 'background_delegation' | string;
  flow?: LumiTurnFlow;
}

export interface LumiResultFinalizerResult {
  text: string;
  blocked: boolean;
  reason?: string;
  notification?: {
    type: 'work_product_guard';
    level: 'warning';
    message: string;
  };
}

function hasToolEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => Boolean(record.error) || Boolean(String(record.result || '').trim()));
}

function shouldRunCompletionGuard(input: LumiResultFinalizerInput): boolean {
  const toolRecords = input.toolRecords || [];
  if (hasToolEvidence(toolRecords)) return true;
  if (input.flow?.completionEvidenceNeeded) return true;
  if (needsCompletionEvidence(input.taskText)) return true;

  const source = String(input.source || '').toLowerCase();
  if (['task', 'workflow', 'background_delegation', 'autonomous'].includes(source)) return true;

  return false;
}

function isChineseText(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value || '');
}

function summarizeToolFailure(records: ToolExecutionRecord[]): string {
  const failed = [...records].reverse().find(record => record.error);
  if (!failed) return '';
  const name = String(failed.name || '');
  const error = String(failed.error || '').trim();
  const action = (() => {
    if (/^(desktop_open|open_item)$/i.test(name)) return '\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\u7a97\u53e3';
    if (/^(desktop_active_window|get_active_window_info)$/i.test(name)) return '\u8bfb\u53d6\u5f53\u524d\u524d\u53f0\u7a97\u53e3';
    if (/^(wechat_read_recent_chat)$/i.test(name)) return '\u5fae\u4fe1\u524d\u53f0\u804a\u5929\u8bfb\u53d6';
    if (/^(wechat_send_message)$/i.test(name)) return '\u5fae\u4fe1\u524d\u53f0\u53d1\u9001';
    if (/^(computer_use)$/i.test(name)) return '\u89c6\u89c9\u684c\u9762\u6267\u884c';
    if (/keyboard/i.test(name)) return '\u952e\u76d8\u8f93\u5165';
    if (/mouse|cursor/i.test(name)) return '\u5149\u6807\u70b9\u51fb';
    return name || '\u5de5\u5177\u6267\u884c';
  })();
  return error ? `${action}: ${error}` : action;
}

function shouldUseCompactActionBlockedResponse(input: LumiResultFinalizerInput): boolean {
  const records = input.toolRecords || [];
  if (String(input.source || '').toLowerCase() === 'background_delegation') return true;
  const contract = buildActionContract(`${input.taskText}\n${input.responseText}`);
  if (shouldEnforceCoreActionContract(contract, `${input.taskText}\n${input.responseText}`)) return true;
  const hasDesktopOrMessagingTool = records.some(record =>
    /^(desktop_|wechat_(?:send_message|read_recent_chat)|computer_use|keyboard_|mouse_|cursor_|get_active_window_info|capture_screen|ocr_screen)/i.test(String(record.name || ''))
  );
  if (!hasDesktopOrMessagingTool) return false;
  const text = `${input.taskText}\n${input.responseText}`;
  return /wechat|weixin|\u5fae\u4fe1|\u53d1\u9001|\u53d1\u7ed9|\u665a\u5b89|\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u6700\u540e\u4e00\u6b65/i.test(text);
}

function shouldEnforceCoreActionContract(contract: ReturnType<typeof buildActionContract>, text: string): boolean {
  if (!contract.applies) return false;
  if (['messaging_read', 'messaging_send', 'browser_account', 'public_post', 'cad_drafting', 'stock_monitor', 'desktop_operation'].includes(contract.kind)) {
    return true;
  }
  if (contract.kind === 'legal_document') {
    return /\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|pleading/i.test(text);
  }
  return false;
}

function formatCompactBlockedResponse(input: LumiResultFinalizerInput, reason?: string): string {
  const zh = isChineseText(input.taskText) || isChineseText(input.responseText);
  const failure = summarizeToolFailure(input.toolRecords || []);
  const contract = buildActionContract(`${input.taskText}\n${input.responseText}`);
  const contractBlocker = summarizeActionContractBlocker(contract, failure);
  const source = String(input.source || '').toLowerCase();
  if (source === 'background_delegation' || shouldUseCompactActionBlockedResponse(input)) {
    if (zh) {
      return [
        '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002',
        contractBlocker || (failure
          ? `\u5361\u4f4f\u7684\u4f4d\u7f6e\uff1a${failure}\u3002`
          : '\u539f\u56e0\uff1a\u8fd8\u6ca1\u6709\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684\u5b8c\u6210\u8bc1\u636e\u3002'),
        contract.kind === 'messaging_send'
          ? '\u6211\u4e0d\u4f1a\u628a\u672a\u786e\u8ba4\u7684\u5fae\u4fe1\u53d1\u9001\u8bf4\u6210\u5df2\u53d1\u9001\uff1b\u9700\u8981\u7ee7\u7eed\u524d\u53f0\u6267\u884c\u5e76\u9a8c\u8bc1\u7ed3\u679c\u3002'
          : contract.kind === 'messaging_read'
            ? '\u6211\u4e0d\u4f1a\u628a\u53ea\u6253\u5f00\u6216\u805a\u7126\u5fae\u4fe1\u8bf4\u6210\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9\uff1b\u9700\u8981\u7ee7\u7eed\u8bfb\u53d6\u5e76\u9a8c\u8bc1\u53ef\u89c1\u5185\u5bb9\u3002'
            : '\u6211\u4e0d\u4f1a\u628a\u8fd9\u79cd\u672a\u786e\u8ba4\u7684\u7ed3\u679c\u8bf4\u6210\u5df2\u5b8c\u6210\uff1b\u9700\u8981\u7ee7\u7eed\u524d\u53f0\u6267\u884c\u5e76\u9a8c\u8bc1\u7ed3\u679c\u3002',
      ].join('\n');
    }
    return [
      'This is not complete yet.',
      failure ? `Blocked at: ${failure}.` : 'Reason: I do not have verifiable completion evidence yet.',
      'I will not mark that as done until the real action is verified.',
    ].join('\n');
  }

  if (reason && reason.length < 180) {
    return zh
      ? `\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\uff1a${reason}\u3002`
      : `This is not complete yet: ${reason}.`;
  }
  return zh
    ? '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\uff1a\u8fd8\u6ca1\u6709\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684\u5b8c\u6210\u8bc1\u636e\u3002'
    : 'This is not complete yet: I do not have verifiable completion evidence.';
}

export function finalizeLumiResponse(input: LumiResultFinalizerInput): LumiResultFinalizerResult {
  if (!shouldRunCompletionGuard(input)) {
    return { text: input.responseText, blocked: false };
  }

  const actionContract = buildActionContract(`${input.taskText}\n${input.responseText}`);
  const claimsActionDone = /(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u53d1\u9001|\u53d1\u51fa|\u6253\u5f00\u4e86|\u770b\u5230|\u8bfb\u5230|\u8bfb\u53d6|\u603b\u7ed3|\u751f\u6210|done|completed|success|sent|opened|read|viewed|created|generated)/iu
    .test(input.responseText || '');
  if (shouldEnforceCoreActionContract(actionContract, `${input.taskText}\n${input.responseText}`) && claimsActionDone && !hasCoreActionEvidence(actionContract, input.toolRecords || [])) {
    return {
      text: formatCompactBlockedResponse(input, `Missing core evidence for ${actionContract.kind}.`),
      blocked: true,
      reason: `Missing core evidence for ${actionContract.kind}.`,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: `Missing core evidence for ${actionContract.kind}.`,
      },
    };
  }

  const guard = guardCompletionClaims({
    task: input.taskText,
    response: input.responseText,
    toolCalls: input.toolRecords || [],
    source: input.source,
  });

  if (!guard.blocked) {
    return { text: input.responseText, blocked: false };
  }

  return {
    text: shouldUseCompactActionBlockedResponse(input)
      ? formatCompactBlockedResponse(input, guard.reason)
      : guard.text,
    blocked: true,
    reason: guard.reason,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: guard.reason || 'Completion claim needs verification.',
    },
  };
}
