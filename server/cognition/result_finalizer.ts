import { guardCompletionClaims, needsCompletionEvidence } from '../work_product/completion_guard';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';

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
    if (/^(wechat_send_message)$/i.test(name)) return '\u5fae\u4fe1\u524d\u53f0\u53d1\u9001';
    if (/^(computer_use)$/i.test(name)) return '\u89c6\u89c9\u684c\u9762\u6267\u884c';
    if (/keyboard/i.test(name)) return '\u952e\u76d8\u8f93\u5165';
    if (/mouse|cursor/i.test(name)) return '\u5149\u6807\u70b9\u51fb';
    return name || '\u5de5\u5177\u6267\u884c';
  })();
  return error ? `${action}: ${error}` : action;
}

function formatCompactBlockedResponse(input: LumiResultFinalizerInput, reason?: string): string {
  const zh = isChineseText(input.taskText) || isChineseText(input.responseText);
  const failure = summarizeToolFailure(input.toolRecords || []);
  const source = String(input.source || '').toLowerCase();
  if (source === 'background_delegation') {
    if (zh) {
      return [
        '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002',
        failure
          ? `\u5361\u4f4f\u7684\u4f4d\u7f6e\uff1a${failure}\u3002`
          : '\u539f\u56e0\uff1a\u8fd8\u6ca1\u6709\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684\u5b8c\u6210\u8bc1\u636e\u3002',
        '\u6211\u4e0d\u4f1a\u628a\u8fd9\u79cd\u672a\u786e\u8ba4\u7684\u7ed3\u679c\u8bf4\u6210\u5df2\u5b8c\u6210\uff1b\u9700\u8981\u7ee7\u7eed\u524d\u53f0\u6267\u884c\u5e76\u9a8c\u8bc1\u7ed3\u679c\u3002',
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
    text: String(input.source || '').toLowerCase() === 'background_delegation'
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
