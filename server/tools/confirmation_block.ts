import type { ToolExecutionRecord } from './types';

const CONFIRMATION_REQUIRED_ERROR_RE =
  /requires user confirmation|requires confirmation|user confirmation|用户确认|需要确认/i; // i18n-allow: reviewed bilingual tool-error recognition.
const CONFIRMATION_BLOCK_RESULT_RE =
  /^Tool\s+"[^"]+"\s+requires user confirmation(?:\s+and was not approved\.|:\s*[^\n]+)$/i;

/**
 * Registry confirmation denials sometimes arrive in result rather than error.
 * Keep the recognition narrow so capability documentation mentioning
 * confirmation is not misclassified as a live blocked execution.
 */
export function isConfirmationBlockedToolRecord(record: ToolExecutionRecord): boolean {
  const error = String(record.error || '').trim();
  if (error && CONFIRMATION_REQUIRED_ERROR_RE.test(error)) return true;
  return CONFIRMATION_BLOCK_RESULT_RE.test(String(record.result || '').trim());
}
