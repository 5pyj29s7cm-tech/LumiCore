/** Builders for bounded capabilities selected by the shared execution pipeline.
 * They prepare arguments and receipt formatters; authorization and execution
 * remain with the caller's governed tool loop.
 */

import {
  formatCnClientActionTargetLabel,
  CN_VOICE_FAST_PATH_MESSAGES,
} from '../regions/packs/cn/voice_fast_path_messages';
import type { ToolPolicy } from '../personality/types';
import {
  isExternalCommitConfirmationOnlyRequest,
  normalizeActionIntent,
  type NormalizedActionIntent,
} from './normalized_action_intent';
import { CN_TASK_LEDGER_MESSAGES } from '../i18n/task_ledger_messages';
import {
  buildActionContract,
  extractRequestedCurrentAppText,
  requiresCurrentAppUiMutation,
  requiresMediaPlaybackAction,
} from './action_contract';
import { getPersonalClientSurfaceByAction } from '../../shared/client_surfaces';
import { requiresActiveWindowObservation } from './desktop_observation';
import { isReadOnlyKnowledgeBaseInspectionRequest } from './knowledge_intent';
import {
  isWpsCreateAndTypeTask,
  isWpsCreateTask,
} from './current_app_execution';
import { WPS_CREATE_DOCUMENT_TOOL } from '../external_control/wps_automation';

export interface QuickCommandResult {
  /** The response text to send back to the user */
  responseText: string;
  /** Optional tool call to execute alongside the response */
  toolCall?: { name: string; arguments: Record<string, any> };
  /** Deterministic read-only verification calls that must follow toolCall. */
  followUpToolCalls?: Array<{ name: string; arguments: Record<string, any> }>;
  /**
   * Follow-up calls derived from the primary receipt. Use this when a mutation
   * is safe only after the current persistent state has been read and checked.
   */
  buildFollowUpToolCalls?: (records: Array<{
    name: string;
    arguments?: Record<string, any>;
    result?: string;
    error?: string;
  }>) => Array<{ name: string; arguments: Record<string, any> }>;
  /** Optional formatter for commands whose reply depends on the tool result */
  formatToolResult?: (raw: string, error?: string) => string;
  /** Optional formatter that may verify the complete primary + follow-up receipt chain. */
  formatToolRecords?: (records: Array<{
    name: string;
    arguments?: Record<string, any>;
    result?: string;
    error?: string;
  }>) => string;
  /** Semantic verification that can be stricter than each tool's generic envelope. */
  verifyToolRecords?: (records: Array<{
    name: string;
    arguments?: Record<string, any>;
    result?: string;
    error?: string;
  }>) => { verified: boolean; reason?: string };
  /** Whether this input was matched as a quick command */
  matched: boolean;
}

/**
 * Persist an explicitly structured long-running task without asking a model to
 * reconstruct fields the user already supplied. This path only creates Lumi's
 * internal task record; confirmation-gated external steps remain unexecuted.
 */
export function buildDeterministicWorkTaskCreateCommand(text: string): QuickCommandResult | null {
  const intent = normalizeActionIntent(text);
  if (intent.kind !== 'work_task' || intent.operation !== 'create') return null;

  const title = intent.target;
  const rawCategory = text.match(/(?:\u7c7b\u522b|category)\s*[\uff1a:=]?\s*([\p{L}\p{N}_-]{1,40})/iu)?.[1]?.trim().toLowerCase() || 'general_work';
  const categoryAliases: Record<string, string> = {
    '\u5ba2\u6237': 'customer',
    customer: 'customer',
    '\u5e97\u94fa': 'store',
    store: 'store',
    '\u6cd5\u5f8b': 'legal_case',
    '\u6848\u4ef6': 'legal_case',
    legal: 'legal_case',
    legal_case: 'legal_case',
    '\u8bbe\u8ba1': 'design_delivery',
    design: 'design_delivery',
    design_delivery: 'design_delivery',
    '\u901a\u7528': 'general_work',
    general: 'general_work',
    general_work: 'general_work',
  };
  const category = categoryAliases[rawCategory] || rawCategory;
  const source = text.match(/(?:\u6765\u6e90|source)\s*[\uff1a:=]?\s*([\p{L}\p{N}_-]{1,40})/iu)?.[1]?.trim() || 'chat';
  const goalText = text.match(/(?:\u76ee\u6807\u662f|\u76ee\u6807|goal)\s*[\uff1a:]\s*([\s\S]*?)(?=(?:\u73b0\u5728\u53ea|\u5b8c\u6210\u540e|$))/iu)?.[1]?.trim() || text;
  const nextActions = Array.from(goalText.matchAll(
    /\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u6b65\s*([^\uff0c,\u3002\uff1b;]+)(?=[\uff0c,\u3002\uff1b;]|$)/gu,
  )).map(match => String(match[1] || '').trim()).filter(Boolean);
  const confirmationRequired = nextActions.filter(action => /(?:\u786e\u8ba4|\u6279\u51c6|\u540c\u610f|\u5916\u53d1|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03)/u.test(action));
  if (confirmationRequired.length === 0 && /(?:\u786e\u8ba4|\u6279\u51c6|\u540c\u610f).{0,24}(?:\u5916\u53d1|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03)/u.test(text)) {
    confirmationRequired.push('\u5916\u90e8\u53d1\u9001\u6216\u63d0\u4ea4');
  }
  const allowedNow = nextActions.filter(action => !confirmationRequired.includes(action));

  return {
    responseText: '\u6b63\u5728\u521b\u5efa\u5e76\u6301\u4e45\u5316\u65b0\u4efb\u52a1\u3002',
    matched: true,
    toolCall: {
      name: 'work_takeover_task_create',
      arguments: {
        title,
        category,
        source,
        sourceMessage: text,
        summary: goalText,
        nextActions,
        allowedNow,
        confirmationRequired,
      },
    },
    formatToolResult: (raw, error) => {
      if (error) return `\u4efb\u52a1\u521b\u5efa\u5931\u8d25\uff1a${error}`;
      let data: Record<string, any> = {};
      try { data = JSON.parse(String(raw || '{}')); } catch {}
      const task = data.task && typeof data.task === 'object' ? data.task : {};
      const id = String(task.id || '').trim();
      const status = String(task.status || data.status || 'created').trim();
      const persisted = data.persisted === true && Boolean(id);
      const actions = Array.isArray(task.nextActions) ? task.nextActions.map(String).filter(Boolean) : nextActions;
      const confirmations = Array.isArray(task.confirmationRequired)
        ? task.confirmationRequired.map(String).filter(Boolean)
        : confirmationRequired;
      return [
        `\u4efb\u52a1\u7f16\u53f7\uff1a${id || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        `\u72b6\u6001\uff1a${persisted ? `\u5df2\u521b\u5efa\u5e76\u6301\u4e45\u5316\uff08${status}\uff09` : `\u672a\u9a8c\u8bc1\uff08${status}\uff09`}`,
        `\u4e0b\u4e00\u6b65\uff1a${actions.length ? actions.join('\u2192') : CN_TASK_LEDGER_MESSAGES.pending}`,
        `\u9700\u8981\u786e\u8ba4\uff1a${confirmations.length ? confirmations.join('\uff1b') : '\u65e0'}`,
      ].join('\n');
    },
  };
}

/**
 * Resolve an explicitly named persistent-task status question from the
 * takeover ledger. This must stay separate from the conversation action
 * ledger: the latter tracks the most recent foreground execution and can
 * otherwise answer with an unrelated older desktop/navigation receipt.
 */
export function buildDeterministicWorkTaskStatusCommand(text: string): QuickCommandResult | null {
  const value = String(text || '').trim();
  if (!/(?:\u6301\u4e45\u72b6\u6001|\u4efb\u52a1\u8d26\u672c|\u6301\u4e45\u4efb\u52a1).{0,40}(?:\u72b6\u6001|\u8fdb\u5ea6|\u67e5\u8be2)|(?:\u67e5\u8be2|\u67e5\u770b).{0,40}(?:\u6301\u4e45\u72b6\u6001|\u4efb\u52a1\u8d26\u672c)|\b(?:persistent task|task ledger)\b.{0,40}\b(?:status|progress|query)\b/iu.test(value)) {
    return null;
  }
  if (/(?:\u521b\u5efa|\u65b0\u5efa|\u6dfb\u52a0).{0,12}(?:\u6301\u4e45)?\u4efb\u52a1/iu.test(value)) return null;
  // A progress mutation often asks Lumi to return the new status in the same
  // sentence. The mutation owns that turn; otherwise the read-only query path
  // shadows "continue / finish step / write back" and silently does no work.
  if (buildDeterministicWorkTaskProgressCommand(value)) return null;
  const taskId = value.match(/\b(wt_task_[A-Za-z0-9_-]+)\b/u)?.[1] || '';
  const title = value.match(/(?:\u4efb\u52a1|task)\s*[\u201c"']([^\u201d"']{1,140})[\u201d"']/iu)?.[1]?.trim();
  if (!title && !taskId) return null;

  return {
    responseText: CN_TASK_LEDGER_MESSAGES.queryStarted,
    matched: true,
    toolCall: taskId
      ? { name: 'work_takeover_task_get', arguments: { id: taskId } }
      : { name: 'work_takeover_task_list', arguments: { limit: 200 } },
    formatToolResult: (raw, error) => {
      if (error) return CN_TASK_LEDGER_MESSAGES.queryFailed(error);
      let data: Record<string, any> = {};
      try { data = JSON.parse(String(raw || '{}')); } catch {}
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const task = taskId
        ? data.task && String(data.task.id || '') === taskId ? data.task : null
        : tasks.find((candidate: any) => String(candidate?.title || '').trim() === title);
      if (!task) return taskId
        ? CN_TASK_LEDGER_MESSAGES.notFoundById(taskId)
        : CN_TASK_LEDGER_MESSAGES.notFoundByTitle(String(title || ''));
      const actions = Array.isArray(task.nextActions) ? task.nextActions.map(String).filter(Boolean) : [];
      const index = Math.max(0, Math.min(Number(task.currentActionIndex) || 0, Math.max(0, actions.length - 1)));
      const current = actions[index] || '\u5f85\u8865\u5145';
      const remaining = actions.slice(index + 1);
      const confirmations = Array.isArray(task.confirmationRequired)
        ? task.confirmationRequired.map(String).filter(Boolean)
        : [];
      return [
        CN_TASK_LEDGER_MESSAGES.taskId(task.id),
        CN_TASK_LEDGER_MESSAGES.currentStatus(task.status),
        CN_TASK_LEDGER_MESSAGES.currentStep(current),
        CN_TASK_LEDGER_MESSAGES.followingSteps(remaining),
        CN_TASK_LEDGER_MESSAGES.confirmationBoundary(confirmations),
      ].join('\n');
    },
  };
}

function hasPersistentTaskExecutionIntent(text: string): boolean {
  const value = String(text || '').trim();
  if (!/\bwt_task_[A-Za-z0-9_-]+\b/u.test(value)) return false;
  const verbPattern = /(?:\u7ee7\u7eed|\u7eed\u63a5|\u6062\u590d|\u63a8\u8fdb|\u6267\u884c|\u5904\u7406|\u5f00\u59cb|\u5b8c\u6210|\u505a\u5b8c)/gu;
  const executionVerb = Array.from(value.matchAll(verbPattern)).some(match => {
    const index = match.index || 0;
    const prefix = value.slice(Math.max(0, index - 14), index);
    const suffix = value.slice(index + match[0].length, index + match[0].length + 14);
    const negated = /(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u9700\u8981|\u4e0d|\u672a|\u6ca1\u6709|\u5c1a\u672a)[^\uff0c,\uff1b;\u3002\uff01\uff1f.!?\n]{0,8}$/u.test(prefix);
    const statusQuestion = /(?:\u662f\u5426|\u6709\u6ca1\u6709|\u662f\u4e0d\u662f)\s*$/u.test(prefix)
      || /^(?:\u4e86?\u5417|\u4e86?\u6ca1|\u6ca1\u6709|\u5230\u54ea|\u60c5\u51b5|\u72b6\u6001|\u8fdb\u5ea6|\u7ed3\u679c)/u.test(suffix);
    return !negated && !statusQuestion;
  });
  const taskObject = /(?:\u6301\u4e45\u4efb\u52a1|\u4efb\u52a1|\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u6b65|\u6b65\u9aa4)/u.test(value);
  return executionVerb && taskObject;
}

function explicitWorkTaskBookkeepingNote(text: string): { taskId: string; note: string } | null {
  const value = String(text || '').trim();
  const taskId = value.match(/\b(wt_task_[A-Za-z0-9_-]+)\b/u)?.[1] || '';
  if (!taskId) return null;
  const explicitlyRecordsOnly = /(?:\u7eaf\u8bb0\u8d26|(?:\u53ea|\u4ec5).{0,16}(?:\u8bb0\u5f55|\u8bb0\u5165|\u5199\u5165|\u8ffd\u52a0|\u66f4\u65b0).{0,14}(?:\u4efb\u52a1\u8d26\u672c|\u8d26\u672c\u5907\u6ce8|\u4efb\u52a1\u5907\u6ce8|\u5907\u6ce8))/u.test(value);
  const explicitlyDoesNotExecute = /(?:(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u9700\u8981|\u4e0d).{0,10}(?:\u6267\u884c|\u63a8\u8fdb|\u5b8c\u6210|\u5904\u7406).{0,8}(?:\u4efb\u52a1|\u6b65\u9aa4|\u52a8\u4f5c)?|(?:\u4e0d\u6539\u53d8|\u4e0d\u4fee\u6539).{0,10}(?:\u4efb\u52a1\u8fdb\u5ea6|\u5f53\u524d\u72b6\u6001|\u6b65\u9aa4\u72b6\u6001))/u.test(value);
  if (!explicitlyRecordsOnly || !explicitlyDoesNotExecute) return null;

  const explicitNote = value.match(/(?:\u8bb0\u8d26\u5185\u5bb9|\u4efb\u52a1\u5907\u6ce8|\u5907\u6ce8|\u8bf4\u660e)\s*[\uff1a:]\s*([\s\S]{1,700})$/u)?.[1]?.trim();
  const note = String(explicitNote || value).replace(/\s+/gu, ' ').trim().slice(0, 700);
  return note ? { taskId, note } : null;
}

/**
 * Keep an explicit bookkeeping-only write deterministic, while returning a
 * non-matching routing marker for any request that asks Lumi to actually
 * continue/execute/finish persistent task steps. Chat uses the marker to keep
 * status shortcuts from consuming the turn, then falls through to the shared
 * LLM/tool planner because `matched` is false.
 */
export function buildDeterministicWorkTaskProgressCommand(text: string): QuickCommandResult | null {
  const value = String(text || '').trim();
  const bookkeeping = explicitWorkTaskBookkeepingNote(value);
  if (!bookkeeping) {
    return hasPersistentTaskExecutionIntent(value)
      ? { matched: false, responseText: '' }
      : null;
  }

  return {
    responseText: CN_TASK_LEDGER_MESSAGES.noteWriteStarted,
    matched: true,
    toolCall: {
      name: 'work_takeover_task_update',
      arguments: {
        id: bookkeeping.taskId,
        note: bookkeeping.note,
      },
    },
    formatToolResult: (raw, error) => {
      if (error) return CN_TASK_LEDGER_MESSAGES.noteWriteFailed(error);
      let data: Record<string, any> = {};
      try { data = JSON.parse(String(raw || '{}')); } catch {}
      const task = data.task && typeof data.task === 'object' ? data.task : {};
      const persisted = data.persisted === true && String(task.id || '') === bookkeeping.taskId;
      if (!persisted) return CN_TASK_LEDGER_MESSAGES.noteMissingReceipt;
      const actions = Array.isArray(task.nextActions) ? task.nextActions.map(String).filter(Boolean) : [];
      const currentIndex = Math.max(0, Number(task.currentActionIndex) || 0);
      return [
        CN_TASK_LEDGER_MESSAGES.taskId(bookkeeping.taskId),
        CN_TASK_LEDGER_MESSAGES.notePersisted,
        CN_TASK_LEDGER_MESSAGES.executionNotAdvanced,
        CN_TASK_LEDGER_MESSAGES.currentTaskStatus(task.status),
        CN_TASK_LEDGER_MESSAGES.currentStep(actions[currentIndex]),
      ].join('\n');
    },
  };
}

/**
 * Build the exact native-client action already authorized by the unified
 * normalized-intent pipeline. It cannot launch desktop apps or infer a target.
 */
export function buildDeterministicClientNavigationCommand(
  normalizedIntent: NormalizedActionIntent,
): QuickCommandResult | null {
  if (normalizedIntent.kind !== 'client_navigation' || !normalizedIntent.clientAction) return null;
  const surface = getPersonalClientSurfaceByAction(normalizedIntent.clientAction);
  const label = formatCnClientActionTargetLabel(
    normalizedIntent.clientAction,
    surface?.navigationAliases?.[0] || surface?.label || normalizedIntent.target,
  );
  return {
    responseText: '\u6b63\u5728\u5207\u6362 Lumi \u754c\u9762\u3002', // i18n-allow: reviewed deterministic client-navigation acknowledgement.
    matched: true,
    toolCall: {
      name: 'client_action',
      arguments: {
        action: normalizedIntent.clientAction,
        ...(normalizedIntent.clientActionArguments || {}),
      },
    },
    formatToolResult: (raw, error) => {
      if (error) return '\u672a\u80fd\u6253\u5f00' + label + '\uff1a' + error; // i18n-allow: receipt-grounded client-navigation failure.
      try {
        const parsed = JSON.parse(String(raw || '{}'));
        const status = String(parsed?.verification?.status || parsed?.status || '').toLowerCase();
        if (parsed?.ok !== false && /^(?:verified|not_applicable)$/.test(status)) {
          return '\u5df2\u6253\u5f00' + label + '\u3002'; // i18n-allow: receipt-grounded client-navigation completion.
        }
        const detail = String(parsed?.verification?.message || parsed?.say || '').trim();
        return detail
          ? '\u5df2\u53d1\u51fa\u6253\u5f00' + label + '\u7684\u8bf7\u6c42\uff0c\u4f46\u754c\u9762\u8fd8\u6ca1\u6709\u786e\u8ba4\uff1a' + detail // i18n-allow: receipt-grounded client-navigation pending state.
          : '\u5df2\u53d1\u51fa\u6253\u5f00' + label + '\u7684\u8bf7\u6c42\uff0c\u4f46\u754c\u9762\u8fd8\u6ca1\u6709\u786e\u8ba4\u3002'; // i18n-allow: receipt-grounded client-navigation pending state.
      } catch {
        return '\u5df2\u53d1\u51fa\u6253\u5f00' + label + '\u7684\u8bf7\u6c42\uff0c\u4f46\u56de\u6267\u65e0\u6cd5\u9a8c\u8bc1\u3002'; // i18n-allow: receipt-grounded client-navigation unknown state.
      }
    },
    verifyToolRecords: records => {
      const action = records.find(record => record.name === 'client_action');
      if (!action) return { verified: false, reason: 'client_action produced no receipt' };
      if (action.error) return { verified: false, reason: `client_action failed: ${action.error}` };
      try {
        const parsed = JSON.parse(String(action.result || '{}'));
        const status = String(parsed?.verification?.status || parsed?.status || '').toLowerCase();
        return parsed?.ok !== false && /^(?:verified|not_applicable)$/.test(status)
          ? { verified: true }
          : {
              verified: false,
              reason: String(parsed?.verification?.message || parsed?.say || status || 'client_action was not verified'),
            };
      } catch {
        return { verified: false, reason: 'client_action receipt was not parseable' };
      }
    },
  };
}

export function buildDeterministicExternalCommitConfirmationCommand(
  normalizedIntent: NormalizedActionIntent,
  text: string,
): QuickCommandResult | null {
  if (
    normalizedIntent.kind !== 'messaging_send'
    || normalizedIntent.sideEffectClass !== 'external_commit'
    || !normalizedIntent.target
    || !normalizedIntent.payload
    || !isExternalCommitConfirmationOnlyRequest(text)
  ) return null;
  return {
    responseText: '\u6b63\u5728\u751f\u6210\u5916\u53d1\u786e\u8ba4\uff0c\u5c1a\u672a\u53d1\u9001\u3002',
    toolCall: {
      name: 'wechat_send_message',
      arguments: {
        contact: normalizedIntent.target,
        message: normalizedIntent.payload,
        applicationTarget: 'wechat',
        useSearch: true,
        useVirtualCursor: true,
      },
    },
    matched: true,
  };
}

/**
 * Execute an exact, side-effect-free local navigation intent without asking a
 * language model to repeat the already-normalized tool choice. The actual app
 * resolution and target verification still belong to desktop_open (or the
 * browser adapter for an explicit URL); this function never guesses a path or
 * substitutes another application.
 */
export function buildDeterministicLocalDesktopNavigationCommand(
  normalizedIntent: NormalizedActionIntent,
  taskText = '',
): QuickCommandResult | null {
  if (
    normalizedIntent.kind !== 'desktop_operation'
    || normalizedIntent.operation !== 'navigate'
    || normalizedIntent.sideEffectClass !== 'none'
    || requiresCurrentAppUiMutation(taskText)
    || requiresMediaPlaybackAction(taskText)
  ) return null;
  const target = String(normalizedIntent.target || '').trim();
  if (!target) return null;
  // An open-only adapter cannot complete a larger request. Reuse the shared
  // evidence contract instead of interpreting the first navigation as the goal.
  const contract = buildActionContract(taskText);
  if (contract.components?.length || (contract.applies && contract.kind !== 'desktop_operation')) return null;
  if (!/^(?:https?:\/\/|www\.|[A-Za-z]:[\\/])/iu.test(target)) {
    // i18n-allow: reject task descriptions masquerading as application names.
    if (/(?:看下|看一下|看看|查看|检查|统计|有多少|记住|读取|联系人|绘制|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|发送|发布|播放|问一下|问问|询问|值守|监控|处理|协作|聊天|对话|消息|工作流|任务|\b(?:then|inspect|count|remember|read|draw|create|generate|edit|save|export|login|search|send|publish|play|ask|watch|monitor|handle|workflow|task)\b)/iu.test(target)) return null;
    // Unknown website labels need contextual resolution by the shared loop.
    // i18n-allow: website-label recognition; exact known sites remain supported.
    if (!resolveKnownSiteUrl(target) && /(?:主页|官网|网站|网页|页面|平台)$/u.test(target)) return null;
  }
  // The Windows app resolver accepts canonical app aliases. Preserve the
  // user-facing label, but remove a redundant OS/vendor prefix before handing
  // the target to the native launcher so `Windows 计算器` cannot fall
  // through to `cmd /c start` as a window title.
  const launchTarget = /^(?:windows|microsoft)\s*(?:计算器|calculator)$/iu.test(target)
    ? (/计算器/u.test(target) ? '计算器' : 'calculator')
    : /^(?:windows|microsoft)\s*(?:记事本|notepad)$/iu.test(target)
      ? (/记事本/u.test(target) ? '记事本' : 'notepad')
      : target;
  const toolCall = quickOpenToolCall(launchTarget);
  const observeActiveWindow = requiresActiveWindowObservation(taskText);
  return {
    responseText: CN_VOICE_FAST_PATH_MESSAGES.opening(target),
    matched: true,
    toolCall,
    followUpToolCalls: observeActiveWindow
      ? [{ name: 'desktop_active_window', arguments: {} }]
      : undefined,
    formatToolResult: (_raw, error) => error
      ? CN_VOICE_FAST_PATH_MESSAGES.openFailed(target, error)
      : CN_VOICE_FAST_PATH_MESSAGES.opened(target),
    formatToolRecords: observeActiveWindow
      ? records => {
          const open = records.find(record => record.name === 'desktop_open');
          const active = [...records].reverse().find(record => record.name === 'desktop_active_window');
          if (open?.error) return CN_VOICE_FAST_PATH_MESSAGES.openFailed(target, open.error);
          if (active?.error) return CN_VOICE_FAST_PATH_MESSAGES.openFailed(target, active.error);
          let openResult: Record<string, any> = {};
          let activeResult: Record<string, any> = {};
          try { openResult = JSON.parse(String(open?.result || '{}')); } catch {}
          try { activeResult = JSON.parse(String(active?.result || '{}')); } catch {}
          const processName = String(activeResult.process_name || activeResult.processName || '').trim();
          const processId = Number(activeResult.pid || activeResult.processId) || 0;
          const windowTitle = String(activeResult.title || activeResult.windowTitle || '').trim();
          const verified = openResult.targetMatched === true && Boolean(processName || windowTitle);
          return [
            `已打开${target}。`,
            `实际进程：${processName || '回执未记录'}${processId ? ` (PID ${processId})` : ''}`,
            `窗口：${windowTitle || '回执未记录'}`,
            `验证状态：${verified ? '已验证（目标精确匹配）' : '未验证'}`,
          ].join('\n');
        }
      : undefined,
  };
}

/**
 * Execute the dedicated, receipt-verified WPS create path without depending
 * on a reasoning model to reconstruct the tool call. This is still a normal
 * governed tool execution: the current-app guard binds the exact user payload
 * and the completion finalizer requires WPS COM readback evidence.
 */
export function buildDeterministicWpsDocumentCommand(
  taskText: string,
  appTarget = '',
): QuickCommandResult | null {
  if (!isWpsCreateTask(taskText, appTarget)) return null;
  // The dedicated adapter intentionally leaves the document unsaved. A save
  // request must continue through the full current-app state machine.
  if (/(?:\u4fdd\u5b58|\u53e6\u5b58|\b(?:save|save as)\b)/iu.test(taskText)) return null;
  const requestedText = extractRequestedCurrentAppText(taskText);
  if (isWpsCreateAndTypeTask(taskText, appTarget) && !requestedText) return null;
  return {
    responseText: '',
    matched: true,
    toolCall: {
      name: WPS_CREATE_DOCUMENT_TOOL,
      arguments: { text: requestedText },
    },
  };
}

export function buildDeterministicKnowledgeInspectionCommand(taskText: string): QuickCommandResult | null {
  if (!isReadOnlyKnowledgeBaseInspectionRequest(taskText)) return null;
  return {
    responseText: CN_VOICE_FAST_PATH_MESSAGES.readingKnowledgeStats,
    matched: true,
    toolCall: { name: 'knowledge_file_stats', arguments: {} },
    formatToolResult: (raw, error) => CN_VOICE_FAST_PATH_MESSAGES.knowledgeStats(raw, error),
  };
}

function resolveKnownSiteUrl(target: string): string | null {
  const clean = String(target || '').trim();
  // i18n-allow: Chinese site-name recognition patterns; not user-visible copy.
  const knownSites: Array<[RegExp, string]> = [
    [/(?:中国)?裁判文书网/u, 'https://wenshu.court.gov.cn/'], // i18n-allow: site-name input recognition
    [/人民法院案例库/u, 'https://rmfyalk.court.gov.cn/'], // i18n-allow: site-name input recognition
    [/人民法院在线服务/u, 'https://zxfw.court.gov.cn/'], // i18n-allow: site-name input recognition
  ];
  const known = knownSites.find(([pattern]) => pattern.test(clean));
  return known?.[1] || null;
}

function quickOpenToolCall(target: string): { name: string; arguments: Record<string, any> } {
  const clean = String(target || '').trim();
  const knownSiteUrl = resolveKnownSiteUrl(clean);
  if (knownSiteUrl) return { name: 'browser_open_task', arguments: { url: knownSiteUrl, open: true } };
  if (/^(?:https?:\/\/|www\.)/i.test(clean)) return { name: 'browser_open_task', arguments: { url: clean, open: true } };
  // i18n-allow: Chinese website-target recognition pattern; not user-visible copy.
  if (/(?:网站|网页|网址|网)$/u.test(clean)) return { name: 'browser_open_task', arguments: { query: clean, open: true } };
  return { name: 'desktop_open', arguments: { target: clean } };
}

/**
 * Quick-command compatibility code is never an authorization source. Return
 * the existing policy unchanged: a selected tool that is absent from the
 * allow-list must fail closed and return to the shared model capability loop.
 */
export function buildQuickCommandToolPolicy(
  policy: ToolPolicy | undefined,
  toolName: string,
): ToolPolicy | undefined {
  if (!policy) return undefined;
  void toolName;
  return policy;
}
