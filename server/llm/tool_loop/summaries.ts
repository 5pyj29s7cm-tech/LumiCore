import type { ToolExecutionRecord } from "../../tools/types";
import type { NormalizedMessage } from "../providers";
import { isConfirmationBlockedToolRecord } from "../../tools/confirmation_block";
import { CN_DURABLE_EXECUTION_MESSAGES, CN_TOOL_LOOP_MESSAGES } from "../../regions/messages/durable_execution_messages";
import { collectExistingArtifacts, formatBytes } from './artifacts';

export function getPrimaryUserText(messages: NormalizedMessage[]): string {
  const rawContent = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  if (typeof rawContent === 'string') return rawContent;
  if (!Array.isArray(rawContent)) return '';
  return rawContent
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join(' ');
}

export function localizeInternalStatusLeak(text: string, userText: string): string {
  const raw = String(text || '');
  if (!/[\u3400-\u9fff]/.test(userText || '')) return raw;

  if (/I have not actually operated the Lumi client yet/i.test(raw)) {
    return CN_TOOL_LOOP_MESSAGES.lumiClientNotOperated;
  }
  if (/I have not verified the desktop action yet|I tried the desktop action, but cannot mark it complete yet/i.test(raw)) {
    return CN_TOOL_LOOP_MESSAGES.desktopActionUnverified;
  }
  if (/I have not actually started that action yet|No successful tool execution was recorded for the promised action/i.test(raw)) {
    return CN_TOOL_LOOP_MESSAGES.promisedActionNotStarted;
  }
  if (/The tool loop reached its limit|Maximum tool call iterations reached|before Lumi could write the final answer/i.test(raw)) {
    return CN_TOOL_LOOP_MESSAGES.toolIterationLimit;
  }
  if (/No verified generated file was detected/i.test(raw)) {
    return CN_TOOL_LOOP_MESSAGES.noVerifiedGeneratedFile;
  }
  if (/requires user confirmation|Action Constitution/i.test(raw)) {
    return CN_TOOL_LOOP_MESSAGES.confirmationRequired;
  }
  return raw;
}

export function humanToolLabel(name: string): string {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('database')) return CN_TOOL_LOOP_MESSAGES.databaseTool;
  if (lower.includes('filesystem') || lower.includes('file')) return CN_TOOL_LOOP_MESSAGES.filesystemTool;
  if (lower.includes('desktop') || lower.includes('computer')) return CN_TOOL_LOOP_MESSAGES.desktopTool;
  if (lower.includes('browser') || lower.includes('web')) return CN_TOOL_LOOP_MESSAGES.browserTool;
  if (lower.includes('message') || lower.includes('wechat') || lower.includes('feishu')) return CN_TOOL_LOOP_MESSAGES.messagingTool;
  if (lower.includes('install') || lower.includes('skill')) return CN_TOOL_LOOP_MESSAGES.installationTool;
  if (lower.includes('sleep')) return CN_TOOL_LOOP_MESSAGES.statusTool;
  return CN_TOOL_LOOP_MESSAGES.controlledTool;
}

export function buildConfirmationBlockedSummary(executionLog: ToolExecutionRecord[], task: string): string {
  const isZh = /[\u3400-\u9fff]/.test(task);
  const blocked = executionLog.filter(isConfirmationBlockedToolRecord);
  const successful = executionLog.filter(record => !record.error);
  const labels = Array.from(new Set(blocked.map(record => humanToolLabel(record.name)))).slice(0, 4);

  if (!isZh) {
    return [
      'I started checking this, but I hit a confirmation boundary before I could finish.',
      labels.length ? `Blocked step: ${labels.join(', ')}.` : '',
      successful.length ? `Already checked: ${successful.map(record => humanToolLabel(record.name)).slice(0, 3).join(', ')}.` : '',
      'I have not completed the requested action yet. Reply "confirm" to approve only this exact pending action.',
    ].filter(Boolean).join('\n');
  }

  return [
    CN_TOOL_LOOP_MESSAGES.confirmationBlockedProgress,
    labels.length ? CN_TOOL_LOOP_MESSAGES.blockedStep(labels.join('、')) : '',
    successful.length ? CN_TOOL_LOOP_MESSAGES.alreadyChecked(successful.map(record => humanToolLabel(record.name)).slice(0, 3).join('、')) : '',
    CN_TOOL_LOOP_MESSAGES.confirmationOnlyPendingAction,
  ].filter(Boolean).join('\n');
}

export function buildIterationLimitSummary(executionLog: ToolExecutionRecord[], task: string = ''): string {
  if (executionLog.some(isConfirmationBlockedToolRecord)) {
    return buildConfirmationBlockedSummary(executionLog, task);
  }

  const isZh = /[\u3400-\u9fff]/.test(task);
  if (executionLog.length === 0) {
    return isZh
      ? CN_DURABLE_EXECUTION_MESSAGES.noExecutableToolResult
      : 'The tool loop ended before any tool result was available, so completion is not verified. Recovery must preserve the current goal and re-plan an available capability or declared fallback without asking the user to repeat known information.';
  }

  const artifacts = collectExistingArtifacts(executionLog).slice(0, 8);

  const recentSteps = executionLog.slice(-6).map((record, index) => {
    const status = record.error
      ? (isZh ? CN_TOOL_LOOP_MESSAGES.notCompletedStatus : 'not completed')
      : record.terminalVerification?.status === 'verified'
        ? (isZh ? CN_DURABLE_EXECUTION_MESSAGES.verifiedStatus : 'verified')
        : (isZh ? CN_DURABLE_EXECUTION_MESSAGES.unverifiedStatus : 'unverified');
    return `${index + 1}. ${humanToolLabel(record.name)} - ${status}`;
  });

  if (isZh) {
    return [
      CN_DURABLE_EXECUTION_MESSAGES.recoveryBudgetExhausted,      CN_TOOL_LOOP_MESSAGES.progressHeading,
      ...recentSteps,      artifacts.length > 0 ? CN_TOOL_LOOP_MESSAGES.verifiedArtifactsHeading : '',
      ...artifacts.map(artifact => `- ${artifact.path} (${formatBytes(artifact.size)})`),      artifacts.length > 0
        ? CN_DURABLE_EXECUTION_MESSAGES.resumeFromVerifiedArtifacts
        : CN_DURABLE_EXECUTION_MESSAGES.resumeWithoutVerifiedArtifacts,
    ].filter(Boolean).join('\n');
  }

  return [
    'The bounded tool execution and automatic recovery budget was exhausted before final verification passed.',    'Progress:',
    ...recentSteps,    artifacts.length > 0 ? 'Verified generated files:' : '',
    ...artifacts.map(artifact => `- ${artifact.path} (${formatBytes(artifact.size)})`),    artifacts.length > 0
      ? 'Recovery must continue from these verified results, prefer a declared fallback or independent verification capability, and avoid repeating completed work.'
      : 'No verified artifact was detected. Recovery must preserve the receipts and re-plan a declared fallback or verification capability instead of treating the failure explanation as completion.',
  ].filter(Boolean).join('\n');
}
