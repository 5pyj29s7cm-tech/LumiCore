import './helpers';
import { initDatabase } from '../db_layer';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeConfirmedToolStep } from '../server/tools/confirmed_step';
import { recordPendingConfirmationDurably, clearAllPendingConfirmationsForTests, getPendingConfirmation } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import type { ToolContext, ToolExecutionRecord } from '../server/tools/types';

let sequence = 0;
beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); });
beforeEach(() => clearAllPendingConfirmationsForTests());
async function fixture() {
  const userId = 'confirmed-step-' + ++sequence;
  const scope = { domain: 'personal', orgId: '', channelId: 'confirmed-fixture-' + sequence };
  const args = { payload: { value: 'approved' } };
  const pending = await recordPendingConfirmationDurably(userId, 'confirmed_fixture', args, 'chat', scope);
  const observed: ToolExecutionRecord[] = [];
  const calls: any[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'confirmed_fixture', description: 'Isolated fixture', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { payload: { type: 'object' } }, required: ['payload'] },
    handler: async input => { calls.push(structuredClone(input)); return JSON.stringify({ ok: true }); },
  });
  const context: ToolContext = { userId, domain: 'personal', orgId: '', authenticated: true, localExecution: true,
    source: 'confirmed_fixture', currentTurnExecutionRequested: true,
    toolPolicy: { allowedTools: ['confirmed_fixture'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 },
    onToolRecord: record => observed.push(structuredClone(record)),
  };
  return { userId, scope, args, pending, registry, context, calls, observed };
}
describe('one-time confirmed execution owner', () => {
  it('archives the confirmed origin before the durable receipt observer runs', async () => {
    const f = await fixture();
    const record = await executeConfirmedToolStep(f);
    expect(record.error).toBeUndefined();
    expect(f.calls).toEqual([f.args]);
    expect(f.observed).toEqual(expect.arrayContaining([expect.objectContaining({ executionOrigin: 'confirmed_action_resume' })]));
    expect(getPendingConfirmation(f.userId)).toBeNull();
  });
  it('executes a competing pair of durable consumers only once', async () => {
    const f = await fixture();
    const records = await Promise.all([executeConfirmedToolStep({ ...f, id: 'claim-a' }), executeConfirmedToolStep({ ...f, id: 'claim-b' })]);
    expect(f.calls).toHaveLength(1);
    expect(records.filter(record => !record.error)).toHaveLength(1);
    const denied = records.find(record => record.error);
    expect(denied?.error).toContain('one-time confirmation');
    expect(denied?.adapterStarted).not.toBe(true);
  });
  it('leaves the grant available when the conversation scope does not match', async () => {
    const f = await fixture();
    const denied = await executeConfirmedToolStep({ ...f, scope: { ...f.scope, channelId: 'another-conversation' } });
    expect(denied.error).toContain('one-time confirmation');
    expect(f.calls).toHaveLength(0);
    expect((await executeConfirmedToolStep(f)).error).toBeUndefined();
    expect(f.calls).toHaveLength(1);
  });
  it('executes the approved snapshot even if transport progress mutates its old proposal object', async () => {
    const f = await fixture();
    const record = await executeConfirmedToolStep({ ...f, onReady: () => {
      f.pending.toolName = 'unapproved_tool';
      f.pending.exactArgs.payload.value = 'unapproved';
    } });
    expect(record.name).toBe('confirmed_fixture');
    expect(record.error).toBeUndefined();
    expect(f.calls).toEqual([{ payload: { value: 'approved' } }]);
  });
  it('rejects a mismatched execution owner before consuming the grant', async () => {
    const f = await fixture();
    await expect(executeConfirmedToolStep({ ...f, context: { ...f.context, userId: 'another-owner' } })).rejects.toThrow('owner');
    expect(f.calls).toHaveLength(0);
    expect(getPendingConfirmation(f.userId)).not.toBeNull();
  });
});
