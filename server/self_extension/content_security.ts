/**
 * Fail-closed scanner for model-readable or autonomously generated source
 * content. Matches credential assignments with or without quotes plus common
 * provider token formats. A false positive belongs in the supervised review
 * lane; autonomous source inspection/staging must not bypass this gate.
 */
export const SELF_IMPROVEMENT_SECRET_CONTENT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[:=]\s*["']?[a-z0-9._~+/=-]{12,}["']?|\bbearer\s+[a-z0-9._~+/=-]{12,}|\bsk-[a-z0-9_-]{12,}|\bgh[pousr]_[a-z0-9]{20,}|\bgithub_pat_[a-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[a-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i;

export function containsSelfImprovementSecret(value: string | Buffer): boolean {
  return SELF_IMPROVEMENT_SECRET_CONTENT.test(
    Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''),
  );
}
