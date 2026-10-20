// Leave time after bounded model work for document writing and case receipts.
export const LEGAL_BATCH_MODEL_BUDGET_MS = 90_000;
export const LEGAL_DOCUMENT_MODEL_TIMEOUT_MS = 45_000;
// Reasoning and visible JSON share max_tokens on the official reasoning model.
// A 3,200-token cap exhausted the entire budget before any answer was emitted.
export const LEGAL_STRUCTURED_MAX_TOKENS = 8_192;
export const LEGAL_REASONING_MODEL_TIMEOUT_MS = 90_000;
export const LEGAL_REASONING_WORKFLOW_BUDGET_MS = LEGAL_REASONING_MODEL_TIMEOUT_MS * 2;
export const LEGAL_REASONING_TOOL_TIMEOUT_MS = LEGAL_REASONING_WORKFLOW_BUDGET_MS + 15_000;
export const LEGAL_BATCH_TOOL_TIMEOUT_MS = 120_000;

// Bid units reuse two workers and at most two model phases per unit; time is finite.
export const LEGAL_BID_MAX_MODEL_BUDGET_MS = LEGAL_REASONING_MODEL_TIMEOUT_MS * 8;
export const LEGAL_BID_TOOL_TIMEOUT_MS = LEGAL_BID_MAX_MODEL_BUDGET_MS + LEGAL_BATCH_TOOL_TIMEOUT_MS - LEGAL_BATCH_MODEL_BUDGET_MS;
export const LEGAL_CONTRACT_MODEL_TIMEOUT_MS = LEGAL_BATCH_MODEL_BUDGET_MS * 2;
export const LEGAL_CONTRACT_TOOL_TIMEOUT_MS = LEGAL_BATCH_TOOL_TIMEOUT_MS * 2;
export function legalBatchModelBudgetMs(remainingPhases: number): number {
  return remainingPhases > 0 ? Math.min(LEGAL_BID_MAX_MODEL_BUDGET_MS, remainingPhases * LEGAL_CONTRACT_MODEL_TIMEOUT_MS) : 0;
}
