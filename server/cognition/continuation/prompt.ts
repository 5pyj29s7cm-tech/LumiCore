import type { ActionIntentAnalysis } from "../normalized_action_intent";
import { findLatestRepeatableAssistantReply } from "../../conversation/assistant_restatement";
import { buildTaskCapsuleV1, formatTaskCapsuleForPrompt } from "../../conversation/task_capsule";
import type { ActionContinuationHistoryItem, ConversationActionContinuationState } from './contracts';
import { compact, REFERENTIAL_CONTEXT_MAX_AGE_MS, recordTimestamp, recordRole, recordText } from './history_values';
import { normalizeConversationActionState } from './state_normalization';
import { classifyConversationActionFollowupIntent, needsRecentActionContinuationContext, isActionBearingGoal } from './followup';
import { explicitDurableTaskReference } from './recognition';
import { findTaskAnchorIndex, extractRecentActionContinuationState } from './history_projection';
import { summarizeToolCalls } from './tool_receipts';

export function buildRecentActionContinuationBridge(
  userText: string,
  history: ActionContinuationHistoryItem[] | undefined,
  persistedState?: ConversationActionContinuationState | null,
  currentTurnRef?: string, analysis?: ActionIntentAnalysis
): string {
  const currentText = compact(userText, 700);
  const normalizedDurableState = normalizeConversationActionState(persistedState);
  const durableUpdatedAt = normalizedDurableState
    ? new Date(normalizedDurableState.updatedAt).getTime()
    : Number.NaN;
  const staleReferentialExecution = Boolean(
    normalizedDurableState
    && Number.isFinite(durableUpdatedAt)
    && Date.now() - durableUpdatedAt > REFERENTIAL_CONTEXT_MAX_AGE_MS
    && classifyConversationActionFollowupIntent(currentText, normalizedDurableState, undefined, analysis) === 'execute'
    && !explicitDurableTaskReference(currentText),
  );
  const durableState = staleReferentialExecution ? null : normalizedDurableState;
  const followupIntent = classifyConversationActionFollowupIntent(currentText, durableState, undefined, analysis);
  if (
    !(needsRecentActionContinuationContext(userText, analysis) || followupIntent !== 'none')
    || ((!Array.isArray(history) || history.length === 0) && !durableState)
  ) {
    return '';
  }

  const recent = (Array.isArray(history) ? history : [])
    .slice(-18)
    .filter(item => {
      const timestamp = recordTimestamp(item);
      return timestamp === null || Date.now() - timestamp <= REFERENTIAL_CONTEXT_MAX_AGE_MS;
    })
    .filter(item => ['user', 'assistant', 'agent'].includes(recordRole(item)) && recordText(item))
    .filter(item => !(recordRole(item) === 'user' && recordText(item) === currentText));

  if (followupIntent === 'repeat') {
    const reply = findLatestRepeatableAssistantReply(recent);
    if (!reply) return '';
    return [
      '## Recent action continuation context',
      'The newest user turn asks to hear the immediately preceding Lumi reply again.',
      'Recovered structured action state:',
      '- followupIntent: repeat',
      'Immediate prior Lumi reply:',
      `- ${reply}`,
      'Rules:',
      '- Repeat or lightly restate only the immediate prior Lumi reply so it is easy to hear.',
      '- Do not fall back to an older user task, work-takeover record, tool receipt, or unrelated conversation topic.',
      '- Do not call tools, resume work, diagnose the old task, or claim a new action completed.',
    ].join('\n');
  }
  const deduplicate = (items: ActionContinuationHistoryItem[]) => items.filter((item, index, candidates) => {
    const roleGroup = recordRole(item) === 'user' ? 'user' : 'assistant';
    const key = `${roleGroup}:${recordText(item)}`;
    return candidates.findIndex(candidate => {
      const candidateRoleGroup = recordRole(candidate) === 'user' ? 'user' : 'assistant';
      return `${candidateRoleGroup}:${recordText(candidate)}` === key;
    }) === index;
  });
  const anchorIndex = findTaskAnchorIndex(recent, analysis);
  const executionTail = anchorIndex >= 0 ? recent.slice(anchorIndex) : recent;
  const relevantDeduplicated = deduplicate(executionTail);
  const userTurns = relevantDeduplicated
    .filter(item => recordRole(item) === 'user')
    .map(recordText)
    .slice(-4);
  const assistantTurns = relevantDeduplicated
    .filter(item => ['assistant', 'agent'].includes(recordRole(item)))
    .map(recordText)
    .slice(-3);
  const toolSummaries = durableState?.toolSummaries.length
    ? durableState.toolSummaries
    : summarizeToolCalls(executionTail);
  const state = durableState || extractRecentActionContinuationState(executionTail, analysis);
  const taskCapsule = durableState
    ? buildTaskCapsuleV1(durableState, {
        previousCapsule: durableState.taskCapsule,
        currentTurnText: currentText,
        currentTurnRef: compact(currentTurnRef, 180) || undefined,
      })
    : null;
  const taskCapsulePrompt = taskCapsule ? formatTaskCapsuleForPrompt(taskCapsule) : '';

  // A terse conversational follow-up must not promote an ordinary prior
  // exchange into executable work. Guard output is excluded above, and a
  // history-only bridge is allowed only when its actual user goal carries an
  // external-action contract. Durable state remains safe because it can only
  // be created from terminal tool evidence.
  if (!durableState && !isActionBearingGoal(state.goal, analysis)) return '';

  if (
    userTurns.length === 0
    && assistantTurns.length === 0
    && toolSummaries.length === 0
    && !durableState
  ) return '';

  return [
    '## Recent action continuation context',
    'The current message is referential or underspecified. Resolve it against the recent task below before routing or choosing tools.',
    'Recovered structured action state:',
    `- followupIntent: ${followupIntent}`,
    durableState?.taskId ? `- taskId: ${durableState.taskId}` : '',
    durableState?.status ? `- taskStatus: ${durableState.status}` : '',
    state.goal ? `- originalGoal: ${state.goal}` : '',
    durableState?.latestInstruction ? `- latestInstruction: ${durableState.latestInstruction}` : '',
    state.appTarget ? `- appTarget: ${state.appTarget}` : '',
    state.sourcePaths.length ? `- sourcePaths: ${state.sourcePaths.join(' | ')}` : '',
    state.latestBlocker ? `- latestBlocker: ${state.latestBlocker}` : '',
    `- unfinished: ${state.unfinished ? 'yes' : 'no'}`,
    durableState?.updatedAt ? `- stateUpdatedAt: ${durableState.updatedAt}` : '',
    taskCapsulePrompt,
    userTurns.length ? 'Recent user task context:' : '',
    ...userTurns.map(turn => `- ${turn}`),
    assistantTurns.length ? 'Recent Lumi execution state:' : '',
    ...assistantTurns.map(turn => `- ${turn}`),
    toolSummaries.length ? 'Recent tool evidence:' : '',
    ...toolSummaries.map(summary => `- ${summary}`),
    'Rules:',
    '- Continue the same target, application, files, and acceptance criteria unless the user clearly starts a new task.',
    '- Preserve this task id and its original capability envelope for execute/confirmation follow-ups. Do not recalculate a narrower permission set from the short follow-up alone.',
    '- A tool retry is one logical step: a later successful receipt for the same tool and arguments supersedes its earlier failed attempt.',
    // i18n-allow: Quoted Chinese phrases are input examples inside an internal routing prompt.
    '- appTarget is recovered only from a successful desktop_open receipt. For wording like "在这里面 / 这个软件里 / 刚打开的里面", continue inside that application with active-window and UI typing/control tools.',
    '- This is conversation-scoped persisted execution state, not a task-center record. Do not route to work_takeover/task-center tools unless the evidence above explicitly contains a work_takeover tool or task id.',
    '- Do not reinterpret an underspecified verb such as draw, run, send, open, or continue into another domain.',
    '- Preparation is not completion. Preserve the latest blocker and require evidence for the original task contract.',
    '- Historical attachments are not current inputs; reuse only explicit local paths or artifacts shown in this context.',
  ].filter(Boolean).join('\n');
}
