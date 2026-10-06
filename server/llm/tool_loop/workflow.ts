import type { ToolExecutionRecord } from "../../tools/types";
import { classifySkillAuthoringIntent, executionBeforeWorkflowSave } from "../../skills/authoring_intent";
import type { NormalizedMessage } from "../providers";
import { recordWorkflow, isWorkflowBusinessTool } from "../../skills/worklog";
import type { LLMConfig } from './contracts';

/** Record workflow from tool execution trace, if any tools were actually called */
export function recordWorkflowIfToolsUsed(
  executionLog: ToolExecutionRecord[],
  messages: NormalizedMessage[],
  config: Pick<LLMConfig, 'userId' | 'domain' | 'orgId' | 'conversationId' | 'source' | 'workflowSource'>,
  routedTaskText?: string,
): void {
  // Rehydrated ledger summaries are not complete replay data. Keep the
  // original trace already observed in this process instead of replacing its
  // code/results with lossy summaries on the next conversation turn.
  const businessRecords = executionLog.filter(record => record.envelope && isWorkflowBusinessTool(record.name));
  if (businessRecords.length === 0) return;
  const rawContent = [...messages].reverse().find(message => {
    if (message.role !== 'user') return false;
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'text').map(part => (part as any).text).join(' ')
        : '';
    // The bounded recovery prompt is a server instruction carried in a user
    // slot for provider compatibility. It is never the user's workflow and
    // must not be learned, displayed, or used as future intent context.
    return !/^\s*Internal execution recovery\./i.test(content);
  })?.content || '';
  const userMsg = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.filter(c => c.type === 'text').map(c => (c as any).text).join(' ') : '';
  const safeMsg = routedTaskText || userMsg || '';
  if (!safeMsg.trim()) return;
  // Authoring/discovery turns must not replace the business trace that the
  // next capture request is trying to save.
  if (classifySkillAuthoringIntent(safeMsg) !== 'none' && !executionBeforeWorkflowSave(safeMsg)) return;
  recordWorkflow({
    source: config.workflowSource || config.source,
    userId: config.userId || 'anonymous',
    conversationId: config.conversationId,
    taskId: businessRecords[0]?.taskId,
    domain: config.domain === 'work' ? 'work' : 'personal',
    orgId: config.domain === 'work' ? (config.orgId || '') : '',
    userIntent: safeMsg.slice(0, 200),
    toolSequence: businessRecords.map(e => ({
      name: e.name,
      args: e.arguments,
      resultSummary: (e.result || e.error || '').slice(0, 200),
      ...(e.result && e.result.length <= 32_768 ? { result: e.result } : {}),
      verified: !e.error && e.terminalVerification?.status === 'verified' && e.envelope?.status === 'verified_success',
      operation: e.capability?.operation || e.evidence?.operation,
    })),
    conversationExcerpt: safeMsg.slice(0, 500),
  });
}
