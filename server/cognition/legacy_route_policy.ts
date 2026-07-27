/**
 * One-release read-only compatibility flag. Legacy classifiers may still emit
 * hints for diagnostics, but no chat, voice, task, workflow, or cognition path
 * may execute a tool from those hints. Semantic capability plans own execution.
 */
export const LEGACY_DIRECT_EXECUTION_ENABLED = false as const;

export function shouldRunLegacyDirectExecution(): boolean {
  return LEGACY_DIRECT_EXECUTION_ENABLED;
}
