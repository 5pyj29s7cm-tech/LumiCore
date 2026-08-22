import { buildActionContract } from './action_contract';
import { needsRecentActionContinuationContext } from './action_continuation';
import type { LumiTurnFlow } from './turn_flow';

const REFERENTIAL_EXECUTION_RE =
  /^(?:(?:\u4f60)?(?:\u7ee7\u7eed|\u63a5\u7740|\u5feb\u70b9|\u8d76\u7d27|\u9a6c\u4e0a|\u73b0\u5728|\u53bb).{0,20}(?:\u6267\u884c|\u5904\u7406|\u505a|\u5b8c\u6210|\u63a8\u8fdb|\u8fd9\u4e2a\u4efb\u52a1|\u5b83)|(?:continue|resume|proceed|do it|execute it|run it|finish it|go ahead).*)[.!?\u3002\uFF01\uFF1F]*$/iu;

const PRE_FINALIZATION_TERMINAL_PROGRESS_RE =
  /(?:\b(?:workflow|task|step|operation|action|write|open|send|save|transcription|verification|review)?\s*(?:completed|succeeded|successful|done|finished|saved|written|opened|sent|verified)\b|\b(?:workflow|task|operation|file|document|transcription|verification|review)\s+(?:is\s+)?(?:complete|completed|done|finished|saved|written|verified)\b|\b(?:i(?:'ve| have| am|'m)|we(?:'ve| have| are|'re))\b[^.!?\n]{0,48}\b(?:completed|finished|saved|written|opened|sent|created|generated|executing|processing)\b|\bsuccess(?:fully)?\b|\u5df2(?:\u7ecf)?(?:\u5b8c\u6210|\u5199\u597d|\u5199\u5b8c|\u6253\u5f00|\u521b\u5efa|\u65b0\u5efa|\u53d1\u9001|\u4fdd\u5b58|\u5199\u5165|\u5bfc\u51fa|\u751f\u6210|\u6267\u884c|\u5904\u7406)|(?:\u6587\u4ef6|\u6587\u6863|\u4efb\u52a1|\u5de5\u4f5c|\u8f6c\u5199|\u8bc6\u522b|\u590d\u6838|\u9a8c\u8bc1|\u4e0b\u8f7d|\u5904\u7406)[^\u3002\uff01\uff1f.!?\n]{0,18}(?:\u5df2(?:\u7ecf)?|\u6210\u529f)?(?:\u5b8c\u6210|\u5199\u5b8c|\u5199\u597d|\u641e\u5b9a|\u4fdd\u5b58|\u6210\u529f)(?:\u4e86)?|(?:\u5b8c\u6210|\u5199\u597d|\u5199\u5b8c|\u641e\u5b9a|\u4fdd\u5b58|\u6253\u5f00|\u521b\u5efa|\u65b0\u5efa|\u53d1\u9001|\u5bfc\u51fa|\u751f\u6210|\u6267\u884c|\u5904\u7406)(?:\u597d|\u5b8c)?\u4e86|\u6267\u884c\u6210\u529f|\u64cd\u4f5c\u6210\u529f|\u6210\u529f(?:\u5b8c\u6210|\u6253\u5f00|\u5199\u5165|\u521b\u5efa|\u53d1\u9001|\u4fdd\u5b58|\u5bfc\u51fa)|(?:\u6211|\u6211\u4eec|\u8fd9\u8fb9)[^\u3002\uff01\uff1f.!?\n]{0,24}(?:\u73b0\u5728|\u9a6c\u4e0a|\u6b63\u5728)[^\u3002\uff01\uff1f.!?\n]{0,18}(?:\u6267\u884c|\u5904\u7406|\u5199\u5165|\u6253\u5f00|\u4fdd\u5b58|\u53d1\u9001|\u751f\u6210))/iu;

// Keep only a short suffix while ordinary conversation is streaming. That
// suffix is enough to catch an execution/completion phrase split across model
// chunks, without holding an entire long sentence until its final punctuation.
const CJK_PARTIAL_STREAM_HOLDBACK = 12;
const LATIN_PARTIAL_STREAM_HOLDBACK = 32;

function partialStreamHoldback(value: string): number {
  return /[\u3400-\u9fff]/u.test(value)
    ? CJK_PARTIAL_STREAM_HOLDBACK
    : LATIN_PARTIAL_STREAM_HOLDBACK;
}

export interface PreFinalizationTextGateSnapshot {
  emittedText: string;
  withheldText: string;
  withheld: boolean;
}

export interface PreFinalizationTextGate {
  /**
   * Returns only complete, non-terminal sentence prefixes that are safe to
   * expose before the final evidence ledger is available.
   */
  push(chunk: string): string;
  /**
   * Seals the gate. An incomplete suffix is always withheld because a later
   * token could turn it into an execution/completion claim.
   */
  finish(): PreFinalizationTextGateSnapshot;
}

export interface FinalizedOutputGateInput {
  taskText: string;
  allowToolUse?: boolean;
  flow: Pick<
    LumiTurnFlow,
    | 'allowToolUseForTurn'
    | 'selfRepairTurn'
    | 'clientActionOnlyTurn'
    | 'completionEvidenceNeeded'
    | 'routeText'
    | 'specialWorkflow'
    | 'workSurfaceRoute'
    | 'workTakeover'
  >;
}

/**
 * Model text can describe an action before its execution ledger is available.
 * Buffer action-oriented output until the shared finalizer has compared the
 * wording with real tool evidence. Ordinary conversation can still stream.
 */
export function shouldDeferModelOutputUntilFinalized(
  input: FinalizedOutputGateInput,
): boolean {
  const taskText = String(input.taskText || '').trim();
  const routeText = String(input.flow.routeText || taskText).trim();
  const contract = buildActionContract(routeText);

  return Boolean(
    input.allowToolUse
    || input.flow.allowToolUseForTurn
    || input.flow.selfRepairTurn
    || input.flow.clientActionOnlyTurn
    || input.flow.specialWorkflow
    || input.flow.completionEvidenceNeeded
    || input.flow.workSurfaceRoute.directDesktop
    || input.flow.workSurfaceRoute.artifactFirst
    || input.flow.workTakeover.shouldResumeTask
    || (contract.applies && contract.kind !== 'none')
    || needsRecentActionContinuationContext(taskText)
    || REFERENTIAL_EXECUTION_RE.test(taskText)
  );
}

/**
 * Progress/status events bypass the final response guard, so they must stay
 * strictly non-terminal. Tool starts and numbered in-progress steps remain
 * visible; completion/success wording waits for the finalized response.
 */
export function shouldForwardPreFinalizationProgress(text: string): boolean {
  const value = String(text || '').trim();
  return Boolean(value) && !PRE_FINALIZATION_TERMINAL_PROGRESS_RE.test(value);
}

/**
 * Content-level stream gate for ordinary chat turns.
 *
 * Input classification alone is insufficient: a conversational prompt can
 * still make a model drift into "I already opened/saved/sent it". This gate
 * buffers across chunk boundaries, emits only complete safe sentences, and
 * latches closed after the first terminal execution claim so later text cannot
 * appear out of order before finalization.
 */
export function createPreFinalizationTextGate(): PreFinalizationTextGate {
  let buffer = '';
  let emittedText = '';
  let withheldText = '';
  let withholding = false;

  return {
    push(chunk: string): string {
      buffer += String(chunk || '');
      let safeOutput = '';

      while (buffer) {
        const match = buffer.match(/^([\s\S]*?[\u3002\uff01\uff1f.!?\n])/u);
        if (!match) break;
        const sentence = match[1];
        buffer = buffer.slice(sentence.length);

        if (withholding || !shouldForwardPreFinalizationProgress(sentence)) {
          withholding = true;
          withheldText += sentence;
          continue;
        }

        safeOutput += sentence;
        emittedText += sentence;
      }

      if (withholding && buffer) {
        withheldText += buffer;
        buffer = '';
      } else if (buffer) {
        // A terminal claim may arrive without punctuation. Latch before
        // exposing any part of the suspicious suffix.
        if (!shouldForwardPreFinalizationProgress(buffer)) {
          withholding = true;
          withheldText += buffer;
          buffer = '';
        } else {
          const holdback = partialStreamHoldback(buffer);
          if (buffer.length > holdback) {
            const prefix = buffer.slice(0, buffer.length - holdback);
            buffer = buffer.slice(-holdback);
            safeOutput += prefix;
            emittedText += prefix;
          }
        }
      }

      return safeOutput;
    },

    finish(): PreFinalizationTextGateSnapshot {
      if (buffer) {
        withheldText += buffer;
        buffer = '';
      }
      return {
        emittedText,
        withheldText,
        withheld: Boolean(withheldText),
      };
    },
  };
}
