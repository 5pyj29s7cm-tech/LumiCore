import {
  CN_VOICE_TRANSCRIPT_GUARD_MESSAGES,
  containsCnAction,
  endsWithCnDanglingConnector,
  isCnBareAction,
  isCnQuotedOrDiscussedText,
} from '../regions/packs/cn/voice_transcript_guard_messages';

export type VoiceTranscriptGuardReason =
  | 'device_prompt_contamination'
  | 'truncated_action';

export type VoiceTranscriptGuardDecision =
  | { action: 'allow' }
  | {
      action: 'clarify';
      reason: VoiceTranscriptGuardReason;
      responseText: string;
    };

const DEVICE_PROMPT_CLARIFICATION_EN =
  'That sounded like a device prompt mixed into your request, so I did not run anything. Please say the action once more.';
const TRUNCATED_ACTION_CLARIFICATION_EN =
  'That request sounded incomplete, so I did not run anything. Please say what you want me to operate.';

function normalizedTranscript(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsHan(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function isQuotedOrDiscussedText(text: string): boolean {
  return isCnQuotedOrDiscussedText(text)
    || /(?:translate|explain|rewrite|quote|what\s+does\s+.+mean)/iu.test(text);
}

/**
 * Detect the concrete contamination shape observed in real voice receipts:
 * an STT/device boilerplate sentence followed by an unrelated request and a
 * dangling repetition of the same terminal label.  Mixed language alone is
 * intentionally never suspicious; real bilingual CLI commands must pass.
 */
function containsRepeatedDevicePrompt(text: string): boolean {
  if (isQuotedOrDiscussedText(text)) return false;
  const terminalMentions = text.match(/\bterminal\b/giu)?.length || 0;
  if (terminalMentions < 2) return false;
  if (!/\b(?:screen\s+)?recording\s+(?:on|from)\s+(?:the\s+|this\s+)?device\b/iu.test(text)) return false;
  if (!/\bterminal\s*[.!?。！？]*\s*$/iu.test(text)) return false;
  return /\bterminal\b[\s\S]*\brecording\b[\s\S]*\bdevice\b/iu.test(text);
}

/** Only an action verb with no object, or a dangling connector, is blocked. */
function isClearlyTruncatedAction(text: string): boolean {
  const compact = text.replace(/[\s，,。.!！？?～~]+/gu, '');
  if (!compact) return false;

  if (isCnBareAction(compact)) {
    return true;
  }
  if (/^(?:please)?(?:open|close|delete|send|run|execute|create|read|check|analyze|modify|save|upload|download|switch|set)(?:the|a|an)?$/iu.test(compact)) {
    return true;
  }

  const hasAction = containsCnAction(text)
    || /\b(?:open|close|delete|send|run|execute|create|read|check|analyze|modify|save|upload|download|switch|set)\b/iu.test(text);
  if (!hasAction || text.length > 28) return false;
  return endsWithCnDanglingConnector(text)
    || /(?:and\s+then|then|with|using)\s*[,\s.!?]*$/iu.test(text);
}

/**
 * Conservative admission guard for final STT text. It does not try to judge
 * grammar, accents, ordinary code-switching, or short conversational replies.
 * A clarification is returned only for a high-signal contamination pattern or
 * an unmistakably unfinished action request.
 */
export function assessVoiceTranscriptForExecution(value: unknown): VoiceTranscriptGuardDecision {
  const text = normalizedTranscript(value);
  if (!text) return { action: 'allow' };

  if (containsRepeatedDevicePrompt(text)) {
    return {
      action: 'clarify',
      reason: 'device_prompt_contamination',
      responseText: containsHan(text)
        ? CN_VOICE_TRANSCRIPT_GUARD_MESSAGES.devicePromptContamination
        : DEVICE_PROMPT_CLARIFICATION_EN,
    };
  }

  if (isClearlyTruncatedAction(text)) {
    return {
      action: 'clarify',
      reason: 'truncated_action',
      responseText: containsHan(text)
        ? CN_VOICE_TRANSCRIPT_GUARD_MESSAGES.truncatedAction
        : TRUNCATED_ACTION_CLARIFICATION_EN,
    };
  }

  return { action: 'allow' };
}
