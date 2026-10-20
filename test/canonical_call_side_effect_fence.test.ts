import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import type { ToolContext } from '../server/tools/types';
beforeAll(() => initDatabase());
let sequence = 0;
function probe(fail = false) {
  const registry = new ToolRegistry();
  const handler = vi.fn(async (args: Record<string, unknown>) => { if (fail) throw new Error('Synthetic handler failed after local state might have changed.'); return JSON.stringify({ ok: true, status: 'completed', target: args.target }); });
  registry.register({ name: 'canonical_local_write', description: 'Synthetic local state write', parameters: { type: 'object', properties: {} }, permission: 'public', securityLevel: 'safe',
    capability: { lane: 'knowledge', operation: 'mutate', sideEffects: [{ type: 'local_state_change', scope: 'synthetic', reversible: true }] },
    evidence: { capability: 'synthetic', operation: 'mutate', assurance: 'observed' }, handler });
  const context: ToolContext = { userId: 'canonical-fence-' + ++sequence, taskId: 'task-' + sequence, requestId: 'request-' + sequence, domain: 'work', orgId: 'org-' + sequence };
  return { registry, handler, context };
}
describe('canonical local call identity reaches the existing side effect fence', () => {
  it('does not invoke the same canonical call twice', async () => {
    const p = probe(); const input = { registry: p.registry, context: p.context, id: 'call-a', name: 'canonical_local_write', arguments: { target: 'exact' } };
    const first = await executeToolCall(input), second = await executeToolCall(input);
    expect(first.envelope?.status).toBe('verified_success'); expect(second.envelope?.status).toBe('verified_success');
    expect(second.idempotencyKey).toBe(first.idempotencyKey); expect(p.handler).toHaveBeenCalledTimes(1);
  });
  it('allows two distinct canonical calls in one accepted request', async () => {
    const p = probe(); const input = { registry: p.registry, context: p.context, name: 'canonical_local_write', arguments: { target: 'exact' } };
    const first = await executeToolCall({ ...input, id: 'call-a' }), second = await executeToolCall({ ...input, id: 'call-b' });
    expect(first.envelope?.status).toBe('verified_success'); expect(second.envelope?.status).toBe('verified_success');
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey); expect(p.handler).toHaveBeenCalledTimes(2);
  });
  it('allows a later accepted request even if its provider reuses the same call id', async () => {
    const p = probe(); const input = { registry: p.registry, context: p.context, id: 'call-a', name: 'canonical_local_write', arguments: { target: 'exact' } };
    const first = await executeToolCall(input), second = await executeToolCall({ ...input, context: { ...p.context, requestId: p.context.requestId + '-later' } });
    expect(first.envelope?.status).toBe('verified_success'); expect(second.envelope?.status).toBe('verified_success');
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey); expect(p.handler).toHaveBeenCalledTimes(2);
  });
  it('does not replay a canonical call after the handler failed with an uncertain local outcome', async () => {
    const p = probe(true); const input = { registry: p.registry, context: p.context, id: 'call-a', name: 'canonical_local_write', arguments: { target: 'exact' } };
    const first = await executeToolCall(input), second = await executeToolCall(input);
    expect(first.envelope?.status).not.toBe('verified_success'); expect(second.envelope?.status).not.toBe('verified_success');
    expect(second.error).toMatch(/unknown prior outcome/i); expect(p.handler).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed payload under the same canonical call id instead of issuing a fresh write', async () => {
    const p = probe(); const input = { registry: p.registry, context: p.context, id: 'call-a', name: 'canonical_local_write', arguments: { target: 'exact' } };
    await executeToolCall(input); const changed = await executeToolCall({ ...input, arguments: { target: 'changed' } });
    expect(changed.envelope?.status).not.toBe('verified_success'); expect(changed.error).toMatch(/target mismatch/i); expect(p.handler).toHaveBeenCalledTimes(1);
  });
  it('keeps an already assigned server action identity authoritative', async () => {
    const p = probe(); const context = { ...p.context, idempotencyKey: 'existing-server-key-' + sequence };
    const input = { registry: p.registry, context, name: 'canonical_local_write', arguments: { target: 'exact' } };
    const first = await executeToolCall({ ...input, id: 'call-a' }), second = await executeToolCall({ ...input, id: 'call-b' });
    expect(first.idempotencyKey).toBe(context.idempotencyKey); expect(second.idempotencyKey).toBe(context.idempotencyKey);
    expect(p.handler).toHaveBeenCalledTimes(1);
  });
  it('preserves external commit identity and exact confirmation ahead of adapter admission', async () => {
    const registry = new ToolRegistry(), handler = vi.fn(async () => JSON.stringify({ sent: true, verified: true }));
    registry.register({ name: 'canonical_external_send', description: 'Synthetic external send', parameters: { type: 'object', properties: {} }, permission: 'public', securityLevel: 'confirm',
      capability: { operation: 'communicate', lane: 'messaging', sideEffects: [{ type: 'external_communication', scope: 'synthetic', reversible: false }] }, handler });
    const onAdapterStart = vi.fn(), requestConfirmation = vi.fn(async () => false);
    const context: ToolContext = { userId: 'external-' + ++sequence, taskId: 'external-task-' + sequence, requestId: 'external-request-' + sequence, requestConfirmation, onAdapterStart };
    const first = await executeToolCall({ registry, context, id: 'external-call-a', name: 'canonical_external_send', arguments: { target: 'exact', confirmed: true } });
    const second = await executeToolCall({ registry, context: { ...context, requestId: context.requestId + '-later' }, id: 'external-call-b', name: 'canonical_external_send', arguments: { target: 'exact', confirmed: true } });
    expect(first.envelope?.status).toBe('waiting_confirmation'); expect(second.envelope?.status).toBe('waiting_confirmation');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(requestConfirmation).toHaveBeenCalledTimes(2); expect(onAdapterStart).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });

});
