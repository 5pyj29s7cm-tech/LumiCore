import { describe, expect, it } from 'vitest';
import { sanitizeToolRecordsForPersistence, sanitizeUserFacingExecutionOutput } from '../server/cognition/user_output_protection';

describe('existing persisted secret matcher boundaries', () => {
  it.each([false, 'SINGLE_TOKEN_SECRET'])('redacts bare token %s while retaining token accounting fields', token => {
    const payload = { token, tokens: 0, prompt_tokens: 7, tokenCount: 3, totalTokens: 10, profile: { hasPassword: false } };
    const rows = sanitizeToolRecordsForPersistence([{ name: 'redaction_projection_probe', arguments: {}, result: JSON.stringify(payload),
      envelope: { result: payload, status: 'unknown_outcome' } }]);
    expect(rows).toHaveLength(1);
    const display = JSON.parse(rows![0].result);
    expect(display).toEqual({ token: '[redacted]', tokens: 0, prompt_tokens: 7, tokenCount: 3, totalTokens: 10, profile: { hasPassword: false } });
    expect(rows![0].envelope.result).toEqual(display);
    expect(rows![0].envelope.status).toBe('unknown_outcome');
    expect(JSON.stringify(rows)).not.toContain('SINGLE_TOKEN_SECRET');
  });

  it.each([
    ['password=first&SECOND_SECRET', ['first', 'SECOND_SECRET']],
    ['message: password=first&SECOND_SECRET', ['first', 'SECOND_SECRET']],
    ['password=https://example.test/private/URL_VALUE_SECRET', ['https://', 'URL_VALUE_SECRET']],
    ['message: password=https://example.test/private/URL_VALUE_SECRET', ['https://', 'URL_VALUE_SECRET']],
    ['Bearer https://example.test/private/BEARER_URL_SECRET', ['https://', 'BEARER_URL_SECRET']],
    ['https://example.test/sk-PATHSECRET123', ['PATHSECRET123']],
  ] as const)('retains original complete secret protection for %s', (text, forbidden) => {
    const rows = sanitizeToolRecordsForPersistence([{ name: 'redaction_projection_probe', arguments: {}, result: text }]);
    expect(rows).toHaveLength(1);
    for (const output of [rows![0].result, sanitizeUserFacingExecutionOutput(text)]) {
      expect(output).toContain('[redacted]');
      for (const secret of forbidden) expect(output).not.toContain(secret);
    }
  });
});
