import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  formatClientSelfPrompt,
  getClientHealthReport,
  getClientState,
  updateClientState,
} from '../server/client/self_model';
import { getAdapterRegistry } from '../server/adapters/registry';
import { ToolRegistry } from '../server/tools/registry';
import { registerClientSelfTools } from '../server/tools/definitions/client_self_tools';
import { registerAdapterTools } from '../server/tools/definitions/adapter_tools';
import {
  redactDiagnosticSecrets,
  sanitizeDiagnosticValue,
} from '../server/client/diagnostic_sanitizer';

const USER_ID = 'diagnostic_secret_redaction_user';

describe('public client diagnostics secret redaction', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
    updateClientState(USER_ID, {
      platform: 'desktop',
      mode: 'assistant',
      workDomain: 'personal',
      runtime: { lastError: 'backend failed: Bearer TOPSECRET' },
      runtimeLog: { open: true, status: 'attention', lastError: 'token=TOPSECRET' },
      knowledge: { domain: 'personal', lastError: 'password: TOPSECRET' },
      errors: [{ source: 'provider', message: 'secret=TOPSECRET', code: 'auth' }],
    });
  });

  it('sanitizes health, prompt, and adapter reports while retaining internal evidence', () => {
    const rawState = getClientState(USER_ID);
    const health = JSON.stringify(getClientHealthReport(USER_ID));
    const prompt = formatClientSelfPrompt(USER_ID);
    const adapters = JSON.stringify(getAdapterRegistry({ userId: USER_ID, clientState: rawState }));

    expect(rawState?.runtime?.lastError).toContain('TOPSECRET');
    for (const output of [health, prompt, adapters]) {
      expect(output).not.toContain('TOPSECRET');
      expect(output).toContain('[redacted]');
    }
  });

  it('sanitizes client state, health, adapter, and self-repair tool output', async () => {
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    registerAdapterTools(registry);

    const outputs = await Promise.all([
      registry.execute('client_get_state', {}, { userId: USER_ID }),
      registry.execute('client_health_check', {}, { userId: USER_ID }),
      registry.execute('adapter_registry_list', {}, { userId: USER_ID }),
      registry.execute('adapter_health_check', {}, { userId: USER_ID }),
    ]);
    const selfRepair = registry.execute('client_self_repair', { action: 'refresh_client_state' }, {
        userId: USER_ID,
        desktopRelay: async () => JSON.stringify({ ok: false, error: 'Bearer TOPSECRET' }),
      });

    for (const output of outputs) {
      expect(output).not.toContain('TOPSECRET');
    }
    await expect(selfRepair).rejects.not.toThrow(/TOPSECRET/);
    expect(outputs.join('\n')).toContain('[redacted]');
  });

  it('redacts explicit credential fields in nested diagnostic payloads', () => {
    const sanitized = sanitizeDiagnosticValue({
      nested: { token: 'TOPSECRET', password: 'TOPSECRET' },
      message: 'Authorization failed with api-key=TOPSECRET',
    });

    expect(JSON.stringify(sanitized)).not.toContain('TOPSECRET');
    expect(sanitized.nested.token).toBe('[redacted]');
  });

  it('keeps raw JSON diagnostics parseable while redacting quoted secrets', () => {
    const redacted = redactDiagnosticSecrets(JSON.stringify({
      ok: false,
      api_key: 'TOPSECRET',
      authorizationError: 'Bearer TOPSECRET',
      rawAuthorization: 'Authorization: Basic TOPSECRET',
      nested: { password: 'TOPSECRET' },
    }));

    expect(() => JSON.parse(redacted)).not.toThrow();
    expect(redacted).not.toContain('TOPSECRET');
    expect(JSON.parse(redacted)).toMatchObject({
      api_key: '[redacted]',
      authorizationError: 'Bearer [redacted]',
      rawAuthorization: 'Authorization: Basic [redacted]',
      nested: { password: '[redacted]' },
    });
  });

  it.each([
    ['OPENAI_API_KEY=TOPSECRET', 'OPENAI_API_KEY=[redacted]'],
    ['DEEPSEEK_API_KEY: TOPSECRET', 'DEEPSEEK_API_KEY: [redacted]'],
    ['Authorization: Basic TOPSECRET', 'Authorization: Basic [redacted]'],
  ])('redacts provider-prefixed and authorization credentials: %s', (input, expected) => {
    const redacted = redactDiagnosticSecrets(input);

    expect(redacted).toBe(expected);
    expect(redacted).not.toContain('TOPSECRET');
  });

  it('redacts provider-prefixed credential fields in structured diagnostics', () => {
    const sanitized = sanitizeDiagnosticValue({
      OPENAI_API_KEY: 'TOPSECRET',
      nested: { deepseek_access_token: 'TOPSECRET' },
    });

    expect(sanitized).toEqual({
      OPENAI_API_KEY: '[redacted]',
      nested: { deepseek_access_token: '[redacted]' },
    });
  });
});
