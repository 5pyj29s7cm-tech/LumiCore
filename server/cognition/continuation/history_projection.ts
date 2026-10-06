import type { ActionIntentAnalysis } from "../normalized_action_intent";
import { isUnconfirmedRuntimeCandidate } from "../../conversation/task_target_anchor";
import { toolRecordHasTerminalPayload } from "../../tools/receipt_payload";
import type { ActionContinuationHistoryItem, RecentActionContinuationState } from './contracts';
import { recordRole, recordText, parseToolCalls, toolCallName, collectPathValues, toolCallArguments, resultCarriesDirectSourcePath, toolCallResult } from './history_values';
import { isContinuationOrPressureText, isActionBearingGoal } from './followup';
import { toolCallFailure } from './tool_receipts';
import { successfulApplicationTarget } from './application_target';

export function findTaskAnchorIndex(history: ActionContinuationHistoryItem[], analysis?: ActionIntentAnalysis): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (recordRole(history[index]) !== 'user') continue;
    const text = recordText(history[index]);
    if (text && !isContinuationOrPressureText(text, analysis)) return index;
  }

  // A complete task can still contain a referential pronoun (for example,
  // "read the desktop image and draw it in AutoCAD") and therefore look like
  // a continuation to the terse-language classifier. Recover that task only
  // when the same history contains a terminal tool receipt after it. This
  // preserves evidence-backed CAD/status continuity without promoting an
  // ordinary reflective chat followed by "continue" into executable work.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (recordRole(history[index]) !== 'user') continue;
    const text = recordText(history[index]);
    if (!text || !isActionBearingGoal(text, analysis)) continue;
    const hasTerminalEvidence = history.slice(index + 1).some(item =>
      parseToolCalls(item).some(call => Boolean(
        toolCallName(call)
        && (toolCallFailure(call) || toolRecordHasTerminalPayload(call)),
      )),
    );
    if (hasTerminalEvidence) return index;
  }
  return -1;
}

export function extractRecentActionContinuationState(
  history: ActionContinuationHistoryItem[] | undefined, analysis?: ActionIntentAnalysis
): RecentActionContinuationState {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      goal: '',
      appTarget: '',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: false,
      evidenceTools: [],
    };
  }

  const anchorIndex = findTaskAnchorIndex(history, analysis);
  const relevant = anchorIndex >= 0 ? history.slice(anchorIndex) : history.slice(-12);
  const goal = anchorIndex >= 0 ? recordText(history[anchorIndex]) : '';
  const sourcePaths = new Set<string>();
  const evidenceTools: string[] = [];
  let appTarget = '';
  let latestBlocker = '';

  for (const item of relevant) {
    for (const call of parseToolCalls(item)) {
      const name = toolCallName(call);
      if (name) evidenceTools.push(name);
      collectPathValues(toolCallArguments(call), sourcePaths);
      if (resultCarriesDirectSourcePath(name)) {
        collectPathValues(toolCallResult(call), sourcePaths);
      }
      const openedTarget = successfulApplicationTarget(call);
      if (openedTarget) appTarget = openedTarget;
      const failure = toolCallFailure(call);
      if (failure) latestBlocker = failure;
    }
  }

  const assistantState = relevant
    .filter(item => ['assistant', 'agent'].includes(recordRole(item)))
    .map(recordText)
    .join('\n');
  // i18n-allow: Chinese execution-state recognition; not user-visible copy.
  const unfinished = Boolean(
    latestBlocker
    || /(?:还没|没有|未)(?:完成|执行|开始|画|写|保存)|(?:失败|受阻|阻塞|等待确认|没有真正)|not (?:completed|done|executed)|incomplete|blocked|failed/i.test(assistantState), // i18n-allow: Chinese execution-state recognition; not user-visible copy.
  );

  return {
    goal,
    appTarget,
    sourcePaths: Array.from(sourcePaths)
      .filter(candidate => !isUnconfirmedRuntimeCandidate(candidate, goal))
      .slice(0, 8),
    latestBlocker,
    unfinished,
    evidenceTools: Array.from(new Set(evidenceTools)).slice(-10),
  };
}
