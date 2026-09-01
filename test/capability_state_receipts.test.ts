import './helpers';
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveGateConfig } from '../server/autonomy/safety_gate';
import { registerAutonomyTools } from '../server/tools/definitions/autonomy_tools';
import { registerExternalControlTools } from '../server/tools/definitions/external_control_tools';
import { registerSelfExtensionTools } from '../server/tools/definitions/self_extension_tools';
import { registerSleepTools } from '../server/tools/definitions/sleep_tools';
import { registerWorkProductTools } from '../server/tools/definitions/work_product_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { LLM_GETTERS } from './helpers';

describe('state-changing capability receipts', () => {
  it('rereads autonomy policy and workflow mutations before verifying success', async () => {
    await initDatabase();
    const registry = new ToolRegistry();
    registerAutonomyTools(registry);
    const userId = `autonomy-receipt-${Date.now()}`;

    const policyRecord = await executeToolCall({
      registry,
      name: 'autonomy_update_policy',
      arguments: { autonomyLevel: 'reactive', reason: 'receipt test' },
      context: { userId, userConfirmed: true },
    });
    expect(policyRecord.error).toBeUndefined();
    expect(policyRecord.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(policyRecord.result)).toMatchObject({
      ok: true,
      status: 'updated',
      persisted: true,
      persistedPolicy: { autonomyLevel: 'reactive' },
    });

    const createRecord = await executeToolCall({
      registry,
      name: 'autonomy_register_workflow',
      arguments: {
        title: 'Receipt test workflow',
        description: 'Verify persisted workflow state.',
        trigger: 'manual test',
        enabled: true,
      },
      context: { userId, userConfirmed: true },
    });
    expect(createRecord.terminalVerification?.status).toBe('verified');
    const created = JSON.parse(createRecord.result);
    expect(created).toMatchObject({ ok: true, status: 'registered', persisted: true });

    const disableRecord = await executeToolCall({
      registry,
      name: 'autonomy_set_workflow_enabled',
      arguments: { id: created.workflow.id, enabled: false },
      context: { userId, userConfirmed: true },
    });
    expect(disableRecord.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(disableRecord.result)).toMatchObject({
      ok: true,
      status: 'disabled',
      persisted: true,
      workflow: { id: created.workflow.id, enabled: false },
    });
  });

  it('distinguishes read-only extension planning from persisted capability learning', async () => {
    await initDatabase();
    const registry = new ToolRegistry();
    registerSelfExtensionTools(registry);
    const userId = `extension-receipt-${Date.now()}`;

    const planRecord = await executeToolCall({
      registry,
      name: 'self_extension_plan',
      arguments: { goal: 'inspect current file capabilities', domain: 'files' },
      context: { userId },
    });
    expect(planRecord.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(planRecord.result)).toMatchObject({ ok: true, status: 'planned', domain: 'files' });
    expect(registry.getCapabilityManifestEntry('self_extension_plan')?.sideEffects).toEqual([
      { type: 'none', scope: 'read-only capability planning', reversible: true },
    ]);
  });

  it('verifies persisted work-product plans without claiming work completion', async () => {
    await initDatabase();
    const registry = new ToolRegistry();
    registerWorkProductTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'work_product_plan',
      arguments: { task: 'Create a verified project report' },
      context: { userId: `work-product-receipt-${Date.now()}`, userConfirmed: true },
    });

    expect(record.terminalVerification?.status).toBe('verified');
    const receipt = JSON.parse(record.result);
    expect(receipt).toMatchObject({ ok: true, status: 'persisted', persisted: true });
    expect(receipt.plan.id).toBe(receipt.id);
    expect(receipt.plan.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('treats a gated sleep cycle as a verified skipped no-op', async () => {
    await initDatabase();
    const registry = new ToolRegistry();
    registerSleepTools(registry);
    const userId = `sleep-receipt-${Date.now()}`;
    saveGateConfig({ alwaysOnline: false }, userId);

    const record = await executeToolCall({
      registry,
      name: 'lumi_sleep_cycle',
      arguments: { reason: 'receipt test' },
      context: { userId, llmGetters: LLM_GETTERS },
    });

    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'skipped',
      persisted: true,
      state: { status: 'skipped', lastReport: { status: 'skipped' } },
    });
  });

  it('reports native external-control candidates as an explicit no-write result', async () => {
    const registry = new ToolRegistry();
    registerExternalControlTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'external_control_configure_candidate',
      arguments: { candidateId: 'native-accessibility' },
      context: {
        userId: 'external-control-receipt',
        authenticated: true,
        authRole: 'admin',
        localExecution: true,
        executionBoundary: 'trusted_local',
        userConfirmed: true,
      },
    });

    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'not_applicable',
      configured: false,
      persisted: false,
      candidate: { id: 'native-accessibility' },
    });
  });
});
