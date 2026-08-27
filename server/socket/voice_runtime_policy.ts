import { DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS } from '../llm/request_context_budget';

/** Voice must stay responsive even when the generic text channel can afford a larger prompt. */
export const VOICE_CHAT_INPUT_BUDGET_TOKENS = 10_000;
export const VOICE_MODEL_INPUT_BUDGET_TOKENS = 16_000;
export const VOICE_DESKTOP_LEASE_WAIT_MS = 5_000;

// i18n-allow: multilingual input-recognition pattern; not user-visible copy.
const EXPLICIT_FULL_AUDIT = /(?:full|complete|comprehensive|entire|overall|deep)\s+(?:audit|review|inspection)|(?:全面|完整|整体|彻底|深度|仔细(?:地|的)?)(?:审计|检查|核实|复核)/iu;

export function resolveVoiceModelInputBudget(input: {
  text?: string;
  allowToolUse?: boolean;
}): number {
  if (EXPLICIT_FULL_AUDIT.test(String(input.text || ''))) {
    return DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS;
  }
  return input.allowToolUse
    ? VOICE_MODEL_INPUT_BUDGET_TOKENS
    : VOICE_CHAT_INPUT_BUDGET_TOKENS;
}

export function canReuseSpeculativeVoiceSpeech(input: {
  preparedVoiceId: string;
  currentVoiceId: string;
  preparedSwitchGeneration: number;
  currentSwitchGeneration: number;
}): boolean {
  return Boolean(input.preparedVoiceId)
    && input.preparedVoiceId === input.currentVoiceId
    && input.preparedSwitchGeneration === input.currentSwitchGeneration;
}
