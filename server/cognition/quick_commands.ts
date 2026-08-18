/**
 * Quick Command Fast-Path — deterministic pattern-match tree.
 *
 * Legacy deterministic matcher retained for one release of routing comparison.
 * Runtime execution is disabled by legacy_route_policy; results are diagnostic
 * hints only and cannot bypass the semantic capability plan.
 */

import { readDB } from '../../db_layer';
import { getWorkTakeoverContinuationQuickCommand, type WorkTakeoverTurnSurface } from '../work_takeover/continuity';
import { listWorkflows } from '../agents/workflows';
import {
  formatCnClientActionTargetLabel,
  CN_VOICE_FAST_PATH_MESSAGES,
  CN_VOICE_QUICK_WORK_MESSAGES,
} from '../regions/packs/cn/voice_fast_path_messages';
import type { ToolPolicy } from '../personality/types';
import {
  isExternalCommitConfirmationOnlyRequest,
  normalizeActionIntent,
  type NormalizedActionIntent,
} from './normalized_action_intent';
import { listWebLoginSitePresets } from '../web_login/legal_presets';
import { formatKnownLoginOpening, formatKnownLoginResult } from '../i18n/naturalness_messages';
import { classifyRuntimeWorkIntent } from './runtime_work_intent';
import {
  extractCurrentAppTarget,
  extractExplicitArtifactTextRequirements,
  extractRequestedCurrentAppText,
  isRunningSoftwareInspectionRequest,
  requiresCurrentAppUiMutation,
  requestedDesktopWindowAction,
} from './action_contract';
import { getPersonalClientSurfaceByAction } from '../../shared/client_surfaces';
import { requiresActiveWindowObservation } from './desktop_observation';
import { isReadOnlyKnowledgeBaseInspectionRequest } from './knowledge_intent';
import {
  isRecoveredWpsCreateAndTypeTask,
  isRecoveredWpsCreateTask,
} from './current_app_execution';
import { WPS_CREATE_DOCUMENT_TOOL } from '../external_control/wps_automation';

export interface QuickCommandResult {
  /** The response text to send back to the user */
  responseText: string;
  /** Optional tool call to execute alongside the response */
  toolCall?: { name: string; arguments: Record<string, any> };
  /** Deterministic read-only verification calls that must follow toolCall. */
  followUpToolCalls?: Array<{ name: string; arguments: Record<string, any> }>;
  /** Optional formatter for commands whose reply depends on the tool result */
  formatToolResult?: (raw: string, error?: string) => string;
  /** Optional formatter that may verify the complete primary + follow-up receipt chain. */
  formatToolRecords?: (records: Array<{
    name: string;
    arguments?: Record<string, any>;
    result?: string;
    error?: string;
  }>) => string;
  /** Whether this input was matched as a quick command */
  matched: boolean;
}

function extractExactTextArtifactRequest(text: string): { path: string; content: string; lines: string[] } | null {
  const source = String(text || '');
  if (!/(?:创建|新建|写入|生成)/u.test(source)) return null;
  if (!/(?:只写入|写入以下|以下.+行|第(?:[一二三四五六七八九十百\d]+)行)/u.test(source)) return null;
  const target = source.match(/([A-Za-z]:[\\/][^"\r\n<>|*?]+?\.(?:txt|md))\b/iu)?.[1]?.trim() || '';
  if (!target) return null;

  const lines = extractExplicitArtifactTextRequirements(source);
  if (!lines.length) return null;
  return { path: target, content: lines.join('\n'), lines };
}

/**
 * Exact local TXT/Markdown creation does not need a model to rediscover the
 * path or rewrite user-authored lines. Execute the requested write, then read
 * the same file back and format the answer only from those two receipts.
 */
export function buildDeterministicTextArtifactCommand(text: string): QuickCommandResult | null {
  const request = extractExactTextArtifactRequest(text);
  if (!request) return null;
  return {
    responseText: '正在写入指定文本文件并回读核验。',
    matched: true,
    toolCall: {
      name: 'write_file',
      arguments: { path: request.path, content: request.content },
    },
    followUpToolCalls: [{ name: 'read_file', arguments: { path: request.path } }],
    formatToolResult: (_raw, error) => error
      ? `未能写入指定文本文件：${error}`
      : '文件已写入，正在回读核验。',
    formatToolRecords: records => {
      const write = records.find(record => record.name === 'write_file');
      const read = records.find(record => record.name === 'read_file');
      if (write?.error) return `未能写入指定文本文件：${write.error}`;
      if (!write) return '未能写入指定文本文件：没有写入回执。';
      if (read?.error) return `文件已经写入，但回读核验失败：${read.error}`;
      if (!read) return '文件已经写入，但没有取得回读回执，不能报告完成。';
      const actual = String(read.result || '').replace(/\r\n/g, '\n');
      const expected = request.content.replace(/\r\n/g, '\n');
      if (actual !== expected) {
        return '文件已经写入，但回读内容与用户指定的逐行文本不一致，不能报告完成。';
      }
      return [
        '已完成本地文件创建与回读核验。',
        `路径：${request.path}`,
        '编码：UTF-8',
        `总行数：${request.lines.length}`,
        '全文：',
        request.content,
      ].join('\n');
    },
  };
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
        `\u4e0b\u4e00\u6b65\uff1a${actions.length ? actions.join('\u2192') : '\u5f85\u8865\u5145'}`,
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
  const title = value.match(/(?:\u4efb\u52a1|task)\s*[\u201c"']([^\u201d"']{1,140})[\u201d"']/iu)?.[1]?.trim();
  if (!title) return null;

  return {
    responseText: '\u6b63\u5728\u67e5\u8be2\u6301\u4e45\u4efb\u52a1\u8d26\u672c\u3002',
    matched: true,
    toolCall: {
      name: 'work_takeover_task_list',
      arguments: { limit: 200 },
    },
    formatToolResult: (raw, error) => {
      if (error) return `\u4efb\u52a1\u72b6\u6001\u67e5\u8be2\u5931\u8d25\uff1a${error}`;
      let data: Record<string, any> = {};
      try { data = JSON.parse(String(raw || '{}')); } catch {}
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const task = tasks.find((candidate: any) => String(candidate?.title || '').trim() === title);
      if (!task) return `\u4efb\u52a1\u8d26\u672c\u4e2d\u672a\u627e\u5230\u201c${title}\u201d\u3002`;
      const actions = Array.isArray(task.nextActions) ? task.nextActions.map(String).filter(Boolean) : [];
      const index = Math.max(0, Math.min(Number(task.currentActionIndex) || 0, Math.max(0, actions.length - 1)));
      const current = actions[index] || '\u5f85\u8865\u5145';
      const remaining = actions.slice(index + 1);
      const confirmations = Array.isArray(task.confirmationRequired)
        ? task.confirmationRequired.map(String).filter(Boolean)
        : [];
      return [
        `\u4efb\u52a1\u7f16\u53f7\uff1a${String(task.id || '\u56de\u6267\u672a\u8bb0\u5f55')}`,
        `\u5f53\u524d\u72b6\u6001\uff1a${String(task.status || '\u672a\u77e5')}`,
        `\u5f53\u524d\u6b65\u9aa4\uff1a${current}`,
        `\u540e\u7eed\u6b65\u9aa4\uff1a${remaining.length ? remaining.join('\u2192') : '\u65e0'}`,
        `\u786e\u8ba4\u8fb9\u754c\uff1a${confirmations.length ? confirmations.join('\uff1b') : '\u65e0'}`,
      ].join('\n');
    },
  };
}

function parseChineseOrdinal(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const direct: Record<string, number> = {
    '\u4e00': 1, '\u4e8c': 2, '\u4e09': 3, '\u56db': 4, '\u4e94': 5,
    '\u516d': 6, '\u4e03': 7, '\u516b': 8, '\u4e5d': 9, '\u5341': 10,
  };
  return direct[value] || 0;
}

/**
 * Apply an explicitly enumerated, internal-only progress update to a named
 * persistent task. The exact task id and completed step labels keep this path
 * narrow: it cannot guess which task to mutate or perform external work.
 */
export function buildDeterministicWorkTaskProgressCommand(text: string): QuickCommandResult | null {
  const value = String(text || '').trim();
  const taskId = value.match(/\b(wt_task_[A-Za-z0-9_-]+)\b/u)?.[1] || '';
  if (!taskId || !/(?:\u7ee7\u7eed|\u7eed\u63a5|\u63a8\u8fdb)/u.test(value)) return null;
  if (!/(?:\u5b8c\u6210)\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u6b65/u.test(value) || !/\u6e05\u5355/u.test(value)) return null;

  const completedSteps = Array.from(value.matchAll(
    /\u7b2c([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+)\u6b65\s*[\u201c"']([^\u201d"']{1,100})[\u201d"']/gu,
  )).map(match => ({ index: parseChineseOrdinal(match[1]), label: String(match[2] || '').trim() }))
    .filter(step => step.index > 0 && step.label);
  if (!completedSteps.length) return null;

  const completedActionCount = Math.max(...completedSteps.map(step => step.index));
  const requestedChecklistCount = parseChineseOrdinal(
    value.match(/([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+)\u9879(?:\u68c0\u67e5)?\u6e05\u5355/u)?.[1] || '\u4e94',
  );
  const checklistCount = Math.max(1, Math.min(requestedChecklistCount || 5, 10));
  const completedLabels = completedSteps
    .filter(step => step.index <= completedActionCount)
    .sort((a, b) => a.index - b.index)
    .map(step => step.label);
  const checklist = [
    `\u4efb\u52a1\u5f15\u7528\u5df2\u6838\u5bf9\uff1a${taskId}`,
    `\u9a8c\u6536\u9700\u6c42\u5df2\u8bb0\u5f55\uff1a${completedLabels[0] || '\u5df2\u6309\u672c\u8f6e\u8981\u6c42\u8bb0\u5f55'}`,
    `\u804a\u5929\u4ea4\u4ed8\u5df2\u751f\u6210\uff1a${completedLabels.slice(1).join('\uff1b') || '\u68c0\u67e5\u6e05\u5355'}`,
    /\u4e0d\u8981\u5199\u6587\u4ef6/u.test(value) && /\u4e0d\u8981\u5916\u53d1/u.test(value)
      ? '\u6267\u884c\u8fb9\u754c\u5df2\u9075\u5b88\uff1a\u672a\u5199\u6587\u4ef6\u3001\u672a\u5916\u53d1'
      : '\u6267\u884c\u8fb9\u754c\u5df2\u8bb0\u5f55\uff1a\u672c\u8f6e\u4ec5\u66f4\u65b0\u5185\u90e8\u4efb\u52a1\u8d26\u672c',
    /\u7b49\u5f85.{0,8}\u786e\u8ba4|\u7b49\u5f85\u786e\u8ba4/u.test(value)
      ? '\u786e\u8ba4\u8fb9\u754c\u5df2\u4fdd\u7559\uff1a\u540e\u7eed\u6b65\u9aa4\u4ecd\u7b49\u5f85\u786e\u8ba4'
      : '\u540e\u7eed\u8fb9\u754c\u5df2\u8bb0\u5f55\uff1a\u4ec5\u6309\u7528\u6237\u660e\u786e\u6307\u4ee4\u7ee7\u7eed',
  ];
  while (checklist.length < checklistCount) {
    checklist.push(`\u4efb\u52a1\u8fdb\u5ea6\u5df2\u5199\u56de\u6301\u4e45\u8d26\u672c\uff08\u7b2c ${checklist.length + 1} \u9879\uff09`);
  }
  const exactChecklist = checklist.slice(0, checklistCount);
  const waitingConfirmation = /\u7b49\u5f85.{0,8}\u786e\u8ba4|\u7b49\u5f85\u786e\u8ba4/u.test(value);
  const taskTitle = value.match(/(?:\u6301\u4e45\u4efb\u52a1|\u4efb\u52a1)\s*[\u201c"']([^\u201d"']{1,140})[\u201d"']/u)?.[1]?.trim() || '';

  return {
    responseText: '\u6b63\u5728\u7eed\u63a5\u5e76\u5199\u56de\u6301\u4e45\u4efb\u52a1\u8fdb\u5ea6\u3002',
    matched: true,
    toolCall: {
      name: 'work_takeover_task_update',
      arguments: {
        id: taskId,
        ...(taskTitle ? { title: taskTitle } : {}),
        status: waitingConfirmation ? 'waiting_confirmation' : 'in_progress',
        currentActionIndex: completedActionCount,
        draftReply: exactChecklist.map((item, index) => `${index + 1}. ${item}`).join('\n'),
        result: `\u5df2\u5b8c\u6210\uff1a${completedLabels.join('\u2192')}`,
        note: '\u663e\u5f0f\u5206\u6b65\u7eed\u63a5\u6307\u4ee4\u5df2\u901a\u8fc7\u539f\u751f\u5ba2\u6237\u7aef\u5199\u56de\u3002',
      },
    },
    formatToolResult: (raw, error) => {
      if (error) return `\u4efb\u52a1\u7eed\u63a5\u5931\u8d25\uff1a${error}`;
      let data: Record<string, any> = {};
      try { data = JSON.parse(String(raw || '{}')); } catch {}
      const task = data.task && typeof data.task === 'object' ? data.task : {};
      const persisted = data.persisted === true && String(task.id || '') === taskId;
      if (!persisted) return '\u4efb\u52a1\u8fdb\u5ea6\u672a\u53d6\u5f97\u53ef\u9a8c\u8bc1\u7684\u6301\u4e45\u56de\u6267\u3002';
      const actions = Array.isArray(task.nextActions) ? task.nextActions.map(String).filter(Boolean) : [];
      const currentIndex = Math.max(0, Number(task.currentActionIndex) || completedActionCount);
      const done = actions.slice(0, currentIndex);
      const remaining = actions.slice(currentIndex);
      return [
        `\u5df2\u5b8c\u6210\u6b65\u9aa4\uff1a${done.length ? done.join('\u2192') : completedLabels.join('\u2192')}`,
        `${checklistCount}\u9879\u68c0\u67e5\u6e05\u5355\uff1a`,
        ...exactChecklist.map((item, index) => `${index + 1}. ${item}`),
        `\u5f53\u524d\u72b6\u6001\uff1a${String(task.status || (waitingConfirmation ? 'waiting_confirmation' : 'in_progress'))}`,
        `\u5269\u4f59\u6b65\u9aa4\uff1a${remaining.length ? remaining.join('\u2192') : '\u65e0'}`,
      ].join('\n');
    },
  };
}

interface QuickPattern {
  patterns: RegExp[];
  handler: (match: RegExpMatchArray, userId: string, options?: QuickCommandOptions) => QuickCommandResult | Promise<QuickCommandResult>;
}

export interface QuickCommandOptions {
  domain?: string;
  orgId?: string;
  surface?: WorkTakeoverTurnSurface;
  currentAppTarget?: string;
}

/**
 * Build the exact native-client action already authorized by the unified
 * normalized-intent pipeline. This is deliberately narrower than the legacy
 * quick-command matcher: it cannot launch desktop apps or infer a target.
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
      arguments: { action: normalizedIntent.clientAction },
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
  ) return null;
  const target = String(normalizedIntent.target || '').trim();
  if (!target) return null;
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
): QuickCommandResult | null {
  if (!isRecoveredWpsCreateTask(taskText)) return null;
  // The dedicated adapter intentionally leaves the document unsaved. A save
  // request must continue through the full current-app state machine.
  if (/(?:\u4fdd\u5b58|\u53e6\u5b58|\b(?:save|save as)\b)/iu.test(taskText)) return null;
  const requestedText = extractRequestedCurrentAppText(taskText);
  if (isRecoveredWpsCreateAndTypeTask(taskText) && !requestedText) return null;
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
 * A deterministic quick command has already selected one exact tool from the
 * user's words. Route selection occasionally omits that same tool from the
 * broader LLM allow-list; add only the selected tool while preserving every
 * explicit forbidden rule and confirmation setting.
 */
export function buildQuickCommandToolPolicy(
  policy: ToolPolicy | undefined,
  toolName: string,
): ToolPolicy | undefined {
  if (!policy) return undefined;
  if (policy.forbiddenTools.includes('*') || policy.forbiddenTools.includes(toolName)) return policy;
  if (policy.allowedTools.includes('*') || policy.allowedTools.includes(toolName)) return policy;
  return {
    ...policy,
    allowedTools: [...policy.allowedTools, toolName],
  };
}

function normalizeQuickOpenTarget(value: string): string | null {
  let target = String(value || '')
    .trim()
    // Realtime ASR commonly terminates an app name with an ASCII comma. It is
    // punctuation, not part of the application/window identity.
    .replace(/[。！？.!?，,；;：:、]+$/u, '')
    .trim();
  if (!target) return null;

  // “打开正在运行的微信，不要启动新的微信” means focus the existing
  // application. desktop_open already focuses a matching running window first,
  // so reduce the phrase to the real application name.
  target = target
    .replace(/^(?:正在运行|当前运行|已经打开|已打开|现有)(?:着)?(?:的)?/u, '') // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    .replace(/[，,；;。]\s*(?:不要|别)(?:再|重新)?(?:启动|打开|新开).+$/u, '') // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    .replace(/\s*(?:不要|别)(?:再|重新)?(?:启动|打开|新开)(?:一个|新的?)?.+$/u, '') // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    .trim();

  if (!target) return null;
  // Natural-language website labels are context-sensitive in speech (ASR can
  // turn a recently mentioned brand into a homophone). Keep URLs and cataloged
  // sites deterministic, but let unknown home-page/site labels reach the
  // normal contextual planner instead of launching an unrelated local app.
  // i18n-allow: Chinese website-target recognition; not user-visible copy.
  if (!resolveKnownSiteUrl(target) && !/^(?:https?:\/\/|www\.)/i.test(target) && /(?:主页|官网|网站|网页|页面|平台)$/u.test(target)) {
    return null;
  }
  // Do not let the low-latency app launcher eat a compound task. The full turn
  // must reach the normal planner so later actions (inspect, count, remember,
  // message, edit, etc.) remain part of the user's requested outcome.
  if (/(?:然后|接着|随后|之后|以后|并且|同时|打开后|启动后|运行后|看下|看一下|看看|看一看|查一下|检查一下|统计|数一下|有多少|记住|读取|联系人|画图|绘制|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|发送|发布|播放|执行脚本|运行脚本|问一下|问问|询问|回复|告诉|值守|监控|盯着|处理|管理|协作|聊天|对话|操作|移动|搬到|窗口|消息|工作流|任务|\b(?:then|after|inspect|count|remember|read|draw|draft|create|generate|edit|save|export|login|search|send|publish|play|script|ask|reply|tell|watch|monitor|handle|manage|collaborate|chat|message|workflow|task|move|window)\b)/iu.test(target)) { // i18n-allow: Chinese compound-work recognition; not user-visible copy.
    return null;
  }
  return target;
}

function findKnownLoginPreset(target: string) {
  const clean = String(target || '')
    .replace(/(?:网站|官网|平台|网页)$/u, '') // i18n-allow: Chinese site-target normalization; not user-visible copy.
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
  if (!clean) return undefined;
  return listWebLoginSitePresets().find(preset => {
    const label = preset.label.replace(/\s+/g, '').toLowerCase();
    return clean.includes(label) || label.includes(clean);
  });
}

const patterns: QuickPattern[] = [
  {
    patterns: [/[\s\S]+/u],
    handler: (match) => {
      const intent = classifyRuntimeWorkIntent(match[0]);
      if (intent === 'none') return { responseText: '', matched: false };
      const cancelling = intent === 'cancel';
      return {
        responseText: CN_VOICE_QUICK_WORK_MESSAGES.readingRuntimeWork(cancelling),
        matched: true,
        toolCall: { name: cancelling ? 'runtime_work_cancel' : 'runtime_work_status', arguments: {} },
        formatToolResult: (raw, error) => {
          if (error) return CN_VOICE_QUICK_WORK_MESSAGES.runtimeReadFailed;
          try {
            const payload = JSON.parse(raw || '{}');
            if (cancelling) {
              if (payload.status === 'idle' || Number(payload.matchedCount || 0) === 0) return CN_VOICE_QUICK_WORK_MESSAGES.noActiveWork;
              if (payload.status === 'cancelling') return CN_VOICE_QUICK_WORK_MESSAGES.workCancelling(Number(payload.cancellingCount || 0));
              return CN_VOICE_QUICK_WORK_MESSAGES.workCancelled(Number(payload.cancelledCount || payload.matchedCount || 0));
            }
            if (payload.status === 'idle' || Number(payload.activeCount || 0) === 0) return CN_VOICE_QUICK_WORK_MESSAGES.noActiveWork;
            const titles = Array.isArray(payload.items)
              ? payload.items.slice(0, 3).map((item: any) => String(item.title || item.id || '')).filter(Boolean)
              : [];
            return CN_VOICE_QUICK_WORK_MESSAGES.activeWork(Number(payload.activeCount || titles.length), titles);
          } catch {
            return CN_VOICE_QUICK_WORK_MESSAGES.runtimeReceiptInvalid;
          }
        },
      };
    },
  },
  {
    patterns: [/[\s\S]+/u],
    handler: (match) => {
      if (!isRunningSoftwareInspectionRequest(match[0])) return { responseText: '', matched: false };
      return {
        responseText: CN_VOICE_QUICK_WORK_MESSAGES.readingProcesses,
        matched: true,
        toolCall: { name: 'desktop_running_processes', arguments: { top: 50 } },
        formatToolResult: (raw, error) => {
          if (error) return CN_VOICE_QUICK_WORK_MESSAGES.processReadFailed;
          try {
            const payload = JSON.parse(raw || '[]');
            const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.processes) ? payload.processes : [];
            const names = Array.from(new Set(entries
              .map((item: any) => String(item?.name || item?.process_name || '').replace(/\.exe$/i, '').trim())
              .filter(Boolean)));
            const topNames = names.slice(0, 8).join('\u3001');
            return [
              CN_VOICE_QUICK_WORK_MESSAGES.processSummary(entries.length, names.length),
              topNames ? CN_VOICE_QUICK_WORK_MESSAGES.processExamples(topNames) : '',
              CN_VOICE_QUICK_WORK_MESSAGES.processSnapshotCaveat,
            ].filter(Boolean).join('');
          } catch {
            return CN_VOICE_QUICK_WORK_MESSAGES.processReceiptInvalid;
          }
        },
      };
    },
  },
  {
    patterns: [/[\s\S]+/u],
    handler: (match, _userId, options) => {
      const action = requestedDesktopWindowAction(match[0]);
      if (!action) return { responseText: '', matched: false };
      const expectedTarget = String(options?.currentAppTarget || extractCurrentAppTarget(match[0]) || '').trim();
      return {
        responseText: CN_VOICE_QUICK_WORK_MESSAGES.adjustingWindow,
        matched: true,
        toolCall: {
          name: 'desktop_window_control',
          arguments: { action, ...(expectedTarget ? { expectedTarget } : {}) },
        },
        formatToolResult: (raw, error) => {
          if (error) return CN_VOICE_QUICK_WORK_MESSAGES.windowControlFailed;
          try {
            const payload = JSON.parse(raw || '{}');
            if (payload.ok === true && payload.status === 'verified' && payload.targetMatched === true) {
              return CN_VOICE_QUICK_WORK_MESSAGES.windowAdjusted(
                CN_VOICE_QUICK_WORK_MESSAGES.windowActionLabels[action],
                expectedTarget ? ` ${expectedTarget}` : '',
              );
            }
            if (payload.status === 'target_mismatch') return CN_VOICE_QUICK_WORK_MESSAGES.windowTargetMismatch;
            return CN_VOICE_QUICK_WORK_MESSAGES.windowNotVerified;
          } catch {
            return CN_VOICE_QUICK_WORK_MESSAGES.windowReceiptInvalid;
          }
        },
      };
    },
  },
  // ── Voice connection acknowledgement ──
  {
    patterns: [
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      /^(?:你)?(?:能不能|能否|可以不可以|可不可以|能)?\s*(?:听见|听到|听清|听得到)\s*(?:我说话(?:吗|么)?|我吗|吗|么)?[。！？.!?]*$/i,
      /^can\s+you\s+hear\s+me[。！？.!?]*$/i,
    ],
    handler: () => ({
      responseText: CN_VOICE_FAST_PATH_MESSAGES.audible,
      matched: true,
    }),
  },

  {
    patterns: [
      // i18n-allow: direct client-mode status question.
      /^(?:你)?(?:现在|当前)?(?:是|处于)?(?:什么|哪种|哪个)模式[。！？.!?]*$/u,
      /^(?:what|which)\s+(?:client\s+)?mode\s+(?:are\s+you|is\s+active)[?!.]*$/i,
    ],
    handler: async (_, userId) => {
      const { getStoredOperationMode } = await import('./operation_mode_store');
      let mode = 'assistant';
      try { mode = getStoredOperationMode(userId); } catch {}
      return {
        responseText: CN_VOICE_FAST_PATH_MESSAGES.operationModeStatus(mode),
        matched: true,
      };
    },
  },

  {
    patterns: [
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      /^(?:(?:看一下|查一下|查一查|告诉我)\s*)?(?:现在\s*)?知识库(?:里|里面|中)?(?:现在\s*)?有多少(?:个|的)?文件(?:内容)?[。！？.!?]*$/u,
    ],
    handler: () => ({
      responseText: CN_VOICE_FAST_PATH_MESSAGES.readingKnowledgeStats,
      toolCall: { name: 'knowledge_file_stats', arguments: {} },
      formatToolResult: (raw, error) => CN_VOICE_FAST_PATH_MESSAGES.knowledgeStats(raw, error),
      matched: true,
    }),
  },

  // ── Time / Date ──
  {
    patterns: [/^(几点|几点了|现在几点|什么时间|what\s*time|current\s*time|时间)[。！？.!?]*$/i],
    handler: () => {
      const now = new Date();
      const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
      return {
        responseText: `现在是${time}，${weekday}。`,
        matched: true,
      };
    },
  },
  {
    patterns: [/^(今天几号|今天日期|日期|几号|星期几|what\s*day|date\s*today)[。！？.!?]*$/i],
    handler: () => {
      const now = new Date();
      const date = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
      const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
      return {
        responseText: `今天是${date}，${weekday}。`,
        matched: true,
      };
    },
  },

  // ── Weather ──
  {
    patterns: [/^(天气|今天天气|天气怎么样|what'?s?\s*the\s*weather|weather|查天气|今天热不热|今天冷不冷)[。！？.!?]*$/i],
    handler: async (_, userId) => {
      try {
        const { getWeatherBrief } = await import('../services/weather');
        const weather = await getWeatherBrief();
        if (weather) {
          return { responseText: weather, matched: true };
        }
      } catch {}
      return { responseText: '抱歉，暂时获取不到天气信息。', matched: true };
    },
  },

  // ── Calculator / Apps ──
  {
    patterns: [/^(打开计算器|计算器|calculator|open\s*calculator)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开计算器。',
      toolCall: { name: 'desktop_open', arguments: { target: 'calc.exe' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开记事本|记事本|notepad|open\s*notepad)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开记事本。',
      toolCall: { name: 'desktop_open', arguments: { target: 'notepad.exe' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开任务管理器|任务管理器|task\s*manager)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开任务管理器。',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'taskmgr' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开终端|终端|terminal|cmd|命令提示符|命令行)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开终端。',
      toolCall: { name: 'desktop_open', arguments: { target: 'cmd.exe' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开浏览器|浏览器|browser|open\s*browser)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开浏览器。',
      toolCall: { name: 'browser_open_task', arguments: { url: 'https://www.google.com', open: true } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开VS\s*Code|打开vscode|vscode|code)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开 VS Code。',
      toolCall: { name: 'desktop_open', arguments: { target: 'code' } },
      matched: true,
    }),
  },
  {
    // Known account sites use the visible persistent login session directly.
    // Captcha/QR/2FA remain manual and are reported by the tool receipt.
    patterns: [
      /^(?:(?:请|麻烦|请你|帮我|你帮我|给我)\s*)?(?:登录|登陆|登入|log\s*in(?:to)?|sign\s*in(?:to)?)\s*(.+?)[。！？.!?]*$/iu, // i18n-allow: Chinese login-intent recognition; not user-visible copy.
    ],
    handler: (match) => {
      const target = String(match[1] || '').trim();
      const preset = findKnownLoginPreset(target);
      if (!preset) return { responseText: '', matched: false };
      return {
        responseText: formatKnownLoginOpening(match[0], preset.label),
        toolCall: {
          name: 'web_login_run',
          arguments: {
            profileId: preset.id,
            url: preset.loginUrl,
            headless: false,
            waitForManualMs: 45_000,
          },
        },
        formatToolResult: (raw, error) => formatKnownLoginResult(match[0], preset.label, raw, error),
        matched: true,
      };
    },
  },
  {
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    patterns: [/^(?:(?:请|麻烦|请你|帮我|你帮我|给我|我要|我想)\s*)?(?:打开|启动|运行|开启|launch|open|start|run)\s*(?:程序|应用|app|软件)?\s*(?:一下)?\s*(.+?)[。！？.!?]*$/i],
    handler: (match) => {
      const target = normalizeQuickOpenTarget(String(match[1] || ''));
      if (
        !target
        // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
        || /^(?:了|着|得|多久|这么久|这么慢|为什么|怎么|为何)/u.test(target)
        // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
        || /(?:然后|接着|随后|之后|以后|并且|同时|打开后|启动后|运行后|画图|绘制|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|发送|发布|播放|执行脚本|运行脚本|问一下|问问|询问|回复|告诉|\b(?:then|after|draw|draft|create|generate|edit|save|export|login|search|send|publish|play|script|ask|reply|tell)\b)/iu.test(target)
      ) {
        return { responseText: '', matched: false };
      }
      return {
        responseText: CN_VOICE_FAST_PATH_MESSAGES.opening(target),
        toolCall: quickOpenToolCall(target),
        formatToolResult: (raw, error) => error
          ? CN_VOICE_FAST_PATH_MESSAGES.openFailed(target, error)
          : raw.trim()
            ? CN_VOICE_FAST_PATH_MESSAGES.opened(target)
            : CN_VOICE_FAST_PATH_MESSAGES.openReceiptMissing(target),
        matched: true,
      };
    },
  },

  // ── Volume Control ──
  {
    patterns: [/^(静音|mute|关闭声音|关声音)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，已静音。',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'nircmd mutesysvolume 1' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(取消静音|开声音|unmute|打开声音)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，已取消静音。',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'nircmd mutesysvolume 0' } },
      matched: true,
    }),
  },

  // ── Screenshot ──
  {
    patterns: [/^(截图|截屏|screenshot|screen\s*shot|屏幕截图)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '正在截图...',
      toolCall: { name: 'ocr_screen', arguments: {} },
      matched: true,
    }),
  },

  // ── System Info ──
  {
    patterns: [/^(系统信息|system\s*info|sysinfo|内存|CPU|磁盘|电脑配置)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '正在获取系统信息...',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'systeminfo | findstr /B /C:"OS Name" /C:"Total Physical Memory" /C:"Available Physical Memory"' } },
      matched: true,
    }),
  },

  // ── Settings Toggles ──
  {
    patterns: [/^(打开|关闭)?(深色模式|dark\s*mode|夜间模式|浅色模式|light\s*mode)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '你可以在设置中切换主题模式。',
      matched: true,
    }),
  },

  // ── Lumi Status / Health ──
  {
    patterns: [/^\/status$|^状态$|^系统状态$|^健康检查$|^lumi.*状态|^检查.*系统/i],
    handler: async (_, userId, options) => {
      try {
        const { runHealthAudit } = await import('../agents/health_audit');
        const report = runHealthAudit(userId, {
          domain: options?.domain === 'work' ? 'work' : 'personal',
          orgId: options?.orgId || '',
        });
        const lines = [
          `## Lumi 系统状态: ${report.overallStatus === 'healthy' ? '✅ 健康' : report.overallStatus === 'degraded' ? '⚠️ 部分降级' : '❌ 异常'}`,
          '',
          ...report.checks.map(c =>
            `- **${c.name}**: ${c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'} ${c.detail}`
          ),
          '',
        ];
        if (report.recommendations.length > 0) {
          lines.push('### 建议');
          report.recommendations.forEach(r => lines.push(`- ${r}`));
        }
        if (report.evolutionInsight) {
          lines.push('', `> ${report.evolutionInsight}`);
        }
        return { responseText: lines.join('\n'), matched: true };
      } catch (e: any) {
        return { responseText: `状态检查失败: ${e.message}`, matched: true };
      }
    },
  },

  // ── Evolution / Self-awareness ──
  {
    patterns: [/^(你学到了什么|你有什么变化|你进化了吗|你变了吗|你更懂我了吗|你的成长|你的记忆|你记得什么|what.*learn|what.*change|how.*evolve)[。！？.!?]*$/i],
    handler: async (_, userId, options) => {
      try {
        const { personalityRegistry } = await import('../personality');
        const domain = options?.domain === 'work' ? 'work' : 'personal';
        const orgId = domain === 'work' ? String(options?.orgId || '') : '';
        const personality = personalityRegistry.getForUser('lumi', userId, orgId || undefined);
        if (!personality) return { responseText: '我还是出厂设置，还没开始学习呢。多和我互动吧！', matched: true };

        const history = personalityRegistry.getEvolutionHistory('lumi', userId, orgId || undefined);
        const lines: string[] = [];

        // Memory stats
        try {
          const db = readDB();
          const memories = ((db as any).memories || []).filter((memory: any) => (
            memory.userId === userId
            && (memory.domain || 'personal') === domain
            && (memory.orgId || '') === orgId
          ));
          const byType: Record<string, number> = {};
          for (const m of memories) {
            const t = m.type || 'other';
            byType[t] = (byType[t] || 0) + 1;
          }
          const memSummary = Object.entries(byType)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          lines.push(`**记忆**: ${memories.length} 条 (${memSummary || 'empty'})`);
        } catch {
          lines.push('**记忆**: 暂时无法读取');
        }

        // Agent team
        try {
          const db = readDB();
          const agents = ((db as any).agents || []).filter((agent: any) => {
            if (domain === 'work') {
              return (agent.domain || 'work') === 'work' && (agent.orgId || '') === orgId;
            }
            return agent.domain !== 'work'
              && !agent.orgId
              && (!agent.ownerUid || agent.ownerUid === userId);
          });
          const internal = agents.filter((a: any) => a.runtime !== 'external');
          const external = agents.filter((a: any) => a.runtime === 'external');
          lines.push(`**团队**: ${agents.length} 个 Agent (${internal.length} 内置, ${external.length} 外部)`);
        } catch {
          lines.push('**团队**: 暂时无法读取');
        }

        // Workflow count
        try {
          const wfs = listWorkflows(userId, undefined, { domain, orgId });
          lines.push(`**工作流**: ${wfs.length} 个已保存的自动化流程`);
        } catch {
          lines.push('**工作流**: 暂时无法读取');
        }

        // Personality evolution
        if (history && history.length > 0) {
          const last = history[history.length - 1];
          const daysAgo = Math.round((Date.now() - new Date(last.timestamp).getTime()) / 86400000);
          lines.push(`**人格演化**: ${history.length} 次进化，最近一次 ${daysAgo} 天前`);
          if (last.narrative) {
            lines.push(`> "${last.narrative.slice(0, 200)}"`);
          }
        } else {
          lines.push('**人格演化**: 还在出厂设置，多聊天我会自动调整风格');
        }

        const version = personality.version || '2.3';
        lines.push('', `*Lumi ${version} · 持续进化中*`);

        return { responseText: lines.join('\n'), matched: true };
      } catch (e: any) {
        return { responseText: `抱歉，暂时无法读取进化数据: ${e.message}`, matched: true };
      }
    },
  },

  // ── Work takeover continuity ──
  {
    patterns: [
      /^(继续|继续做|继续推进|继续执行|继续处理|接着|接着做|往下|往下走|下一步|下一步呢|接下来呢|做下一步|跑下一步|再跑一步|然后呢|然后|开始吧|来吧|做完了吗|好了没|好了吗|完成了吗|跑完了吗|结果呢|结果怎么样|进度呢|状态呢|状态怎么样|卡在哪|哪里卡了|哪里卡住了|为什么没做完|怎么回事|好|好的|可以|行|嗯|嗯嗯|ok|okay|收到|继续吧|继续一下|推进一下)[。！？.!?]*$/i,
      /(刚刚|刚才|上一个|上一条|这个任务|这个事|那件事|它|这个).*(继续|下一步|接着|推进|执行|处理|跑|做|做完|完成|结果|进度|状态|卡|失败|成功|怎么回事)/u,
    ],
    handler: (match, userId, options) => {
      const command = getWorkTakeoverContinuationQuickCommand(match.input || '', userId, {
        domain: options?.domain,
        orgId: options?.orgId,
        surface: options?.surface,
      });
      if (!command) return { responseText: '', matched: false };
      return {
        responseText: command.responseText,
        toolCall: command.toolCall,
        formatToolResult: command.formatToolResult,
        matched: true,
      };
    },
  },

  // ── Simple Yes/No ──
  {
    patterns: [
      // i18n-allow: a short affirmative result from the user, not a new open command.
      /^(?:(?:已经|现在|刚才|它|软件|页面|窗口)\s*)?(?:打开|启动|运行)(?:了|好(?:了)?)[。！!]*$/u,
      /^(?:it\s+)?(?:opened|launched|started)(?:\s+now)?[.!]*$/i,
    ],
    handler: () => ({
      responseText: CN_VOICE_FAST_PATH_MESSAGES.openConfirmedByUser,
      matched: true,
    }),
  },
  {
    patterns: [/^(好的|ok|okay|好|嗯|知道了|收到|明白了|懂了|got\s*it|alright|fine)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '👍',
      matched: true,
    }),
  },
  {
    patterns: [/^(谢谢|多谢|thanks|thank\s*you|3Q|thx)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '不客气！',
      matched: true,
    }),
  },
  {
    patterns: [/^(晚安|good\s*night|bye|再见|拜拜|回头见|see\s*you|later)[。！？.!?]*$/i],
    handler: () => ({
      responseText: new Date().getHours() < 6 ? '晚安，早点休息。' : '再见，有需要随时叫我。',
      matched: true,
    }),
  },
];

/**
 * Try to match user input against quick command patterns.
 * Returns null if no match — caller should proceed to LLM path.
 */
export async function matchQuickCommand(
  text: string,
  userId: string,
  options?: QuickCommandOptions,
): Promise<QuickCommandResult | null> {
  const clean = text.trim();
  const normalizedIntent = normalizeActionIntent(clean);

  // Safety-critical intent classes are resolved before the generic "open X"
  // shortcut. This prevents client-native surfaces and complaints containing
  // an action verb from being converted into desktop_open side effects.
  if (
    normalizedIntent.kind === 'correction_explanation'
    || normalizedIntent.kind === 'status_query'
  ) return null;
  const clientNavigation = buildDeterministicClientNavigationCommand(normalizedIntent);
  if (clientNavigation) return clientNavigation;

  for (const pattern of patterns) {
    for (const regex of pattern.patterns) {
      const match = clean.match(regex);
      if (match) {
        const result = await pattern.handler(match, userId, options);
        if (result?.matched) return result;
      }
    }
  }

  return null;
}

/**
 * Quick check: can this input be handled without LLM?
 * Returns true if any pattern matches — used to skip LLM classifier cost.
 */
export function isQuickCommand(text: string): boolean {
  const clean = text.trim();
  for (const pattern of patterns) {
    for (const regex of pattern.patterns) {
      if (regex.test(clean)) return true;
    }
  }
  return false;
}
