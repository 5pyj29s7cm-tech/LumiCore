import { describe, expect, it } from 'vitest';
import type { ToolExecutionEnvelope, ToolExecutionRecord } from '../server/tools/types';
import { sanitizeToolRecordsForPersistence } from '../server/cognition/user_output_protection';

function record(payload: Record<string, unknown>, status: ToolExecutionEnvelope['status'] = 'verified_success'): ToolExecutionRecord {
  return {
    id: 'public-profile-call', name: 'url_fetch_logged_in', arguments: { profileId: 'test-profile' },
    result: JSON.stringify(payload, null, 2),
    requestId: 'profile-request', taskId: 'profile-task', turnRowId: 'profile-turn-row',
    envelope: { version: 1, toolName: 'url_fetch_logged_in', status,
      taskId: 'profile-task', turnId: 'profile-turn', turnRowId: 'profile-turn-row', requestId: 'profile-request',
      idempotencyKey: 'profile-read', targetIdentity: 'https://example.test/', completedAt: '2026-10-20T00:00:00.000Z',
      verification: { status: status === 'verified_success' ? 'verified' : 'unverified', reason: 'fixture projection only' }, result: payload },
  };
}

function persist(input: ToolExecutionRecord) {
  const rows = sanitizeToolRecordsForPersistence([input]);
  expect(rows).toHaveLength(1);
  return rows![0];
}

describe('persisted structured tool redaction', () => {
  it.each([false, true])('preserves only typed public password presence (%s) in display JSON and envelope', hasPassword => {
    const payload = { status: 'content_accessible', authenticationVerified: false, loginState: 'uncertain',
      profile: { id: 'test-profile', domain: 'personal', ownerUid: 'test-owner', hasPassword } };
    const original = record(payload);
    const stored = persist(original);
    expect(() => JSON.parse(stored.result)).not.toThrow();
    expect(JSON.parse(stored.result)).toEqual(payload);
    expect(stored.envelope.result).toEqual(payload);
    expect(JSON.parse(stored.result)).toEqual(stored.envelope.result);
    expect(stored.envelope.status).toBe('verified_success');
    expect(stored.requestId).toBe(original.requestId);
    expect(stored.taskId).toBe(original.taskId);
    expect(stored.turnRowId).toBe(original.turnRowId);
  });

  it('does not exempt string-valued metadata or other sensitive booleans', () => {
    const stored = persist(record({ profile: { hasPassword: 'META_SECRET' }, password: false, token: false,
      nested: { secret: 'NESTED_SECRET', passphrase: 'PHRASE_SECRET', captcha: 'CAPTCHA_SECRET' } }));
    const display = JSON.parse(stored.result);
    expect(display).toEqual(stored.envelope.result);
    expect(display.profile.hasPassword).toBe('[redacted]');
    expect(display.password).toBe('[redacted]');
    expect(display.token).toBe('[redacted]');
    for (const key of ['secret', 'passphrase', 'captcha']) expect(display.nested[key]).toBe('[redacted]');
    expect(JSON.stringify(stored)).not.toMatch(/META_SECRET|NESTED_SECRET|PHRASE_SECRET|CAPTCHA_SECRET/);
  });

  it('redacts escaped secret keys and quoted values without breaking valid JSON', () => {
    const payload = { password: 'ESCAPED_SECRET "quoted" \\ tail', token: 'TOKEN_SECRET',
      description: 'ordinary "quoted" text', profile: { hasPassword: false },
      nested: { apiKey: 'API_SECRET', cookie: 'COOKIE_SECRET' } };
    const input = record(payload);
    input.result = input.result.replace('"password"', '"pass\\u0077ord"');
    const stored = persist(input);
    const display = JSON.parse(stored.result);
    expect(display).toEqual(stored.envelope.result);
    expect(display.password).toBe('[redacted]');
    expect(display.token).toBe('[redacted]');
    expect(display.description).toBe(payload.description);
    expect(display.profile.hasPassword).toBe(false);
    expect(JSON.stringify(stored)).not.toMatch(/ESCAPED_SECRET|TOKEN_SECRET|API_SECRET|COOKIE_SECRET/);
  });


  it.each(['password', String.raw`pass\u0077ord`])('never restores discarded duplicate-key bytes for %s', key => {
    const input = record({ password: '[redacted]', profile: { hasPassword: false } });
    input.result = '{"' + key + '":"DUPLICATE_SECRET","password":"[redacted]","profile":{"hasPassword":false}}';
    const stored = persist(input);
    expect(() => JSON.parse(stored.result)).not.toThrow();
    expect(JSON.parse(stored.result)).toEqual({ password: '[redacted]', profile: { hasPassword: false } });
    expect(JSON.parse(stored.result)).toEqual(stored.envelope.result);
    expect(JSON.stringify(stored)).not.toContain('DUPLICATE_SECRET');
  });

  it('keeps signed URL and embedded credential redaction on structured string leaves', () => {
    const stored = persist(record({ url: 'https://example.test/page?access_token=URL_SECRET&plain=ok',
      message: 'Bearer BEARER_SECRET', nested: JSON.stringify({ password: 'INNER_SECRET' }) }));
    const display = JSON.parse(stored.result);
    expect(new URL(display.url).searchParams.get('access_token')).toBe('[redacted]');
    expect(new URL(display.url).origin + new URL(display.url).pathname).toBe('https://example.test/page');
    expect(display.message).toBe('Bearer [redacted]');
    expect(JSON.parse(display.nested).password).toBe('[redacted]');
    expect(JSON.stringify(stored)).not.toMatch(/URL_SECRET|BEARER_SECRET|INNER_SECRET/);
  });

  it('leaves malformed input as text rather than repairing it into purported structured evidence', () => {
    const input = record({});
    input.result = '{"password":"BROKEN_SECRET",broken';
    delete input.envelope;
    const stored = persist(input);
    expect(() => JSON.parse(stored.result)).toThrow();
    expect(stored.result).toContain('[redacted]');
    expect(stored.result).not.toContain('BROKEN_SECRET');
  });

  it('retains the existing bounded JSON summary and binary omission safeguards', () => {
    const long = persist(record({ body: 'ordinary prose '.repeat(1000) }));
    expect(JSON.parse(long.result)).toMatchObject({ kind: 'structured_result_summary', resultOmitted: true });
    expect(long.result.length).toBeLessThanOrEqual(4000);
    const binary = persist(record({ image_base64: 'A'.repeat(20000), password: 'BINARY_SECRET' }));
    expect(binary.result).toContain('binary image omitted');
    expect(JSON.stringify(binary)).not.toMatch(/AAAAA|BINARY_SECRET/);
  });

  it.each(['failed', 'unknown_outcome', 'waiting_confirmation'] as const)('never promotes a %s receipt while repairing display shape', status => {
    const input = record({ profile: { hasPassword: false }, authenticationVerified: false, status: 'manual_required' }, status);
    const stored = persist(input);
    expect(stored.envelope.status).toBe(status);
    expect(stored.envelope.verification.status).toBe('unverified');
    expect(JSON.parse(stored.result).authenticationVerified).toBe(false);
    expect(stored.envelope.result.authenticationVerified).toBe(false);
  });

  it('is idempotent and keeps ordinary short JSON semantic content', () => {
    const input = record({ profile: { hasPassword: true }, password: 'ONCE_SECRET', count: 2 });
    const once = persist(input);
    const twice = sanitizeToolRecordsForPersistence([once]);
    expect(twice).toEqual([once]);
    expect(JSON.stringify(twice)).not.toContain('ONCE_SECRET');
    const ordinary = record({ count: 2, message: 'source content and whitespace stay intact' });
    ordinary.result = JSON.stringify({ count: 2, message: 'source content and whitespace stay intact' }, null, 4);
    expect(JSON.parse(persist(ordinary).result)).toEqual(ordinary.envelope?.result);
  });
});
