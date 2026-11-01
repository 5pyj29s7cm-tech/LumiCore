import './helpers';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { encodeToolResult } from '../server/tools/result_envelope';
import { buildVerifiedToolCheckpoint } from '../server/llm/tool_loop/checkpoints';

describe('checkpoint source bodies respect the actual capability role', () => {
  it.each(['observe', 'create'] as const)('only projects a declared observation body: %s', async operation => {
    const registry = new ToolRegistry();
    const content = 'Synthetic source content for capability-role verification.';
    const target = 'C:/synthetic/source-role.txt'; const task = 'Read the full text of ' + target;
    registry.register({ name: 'read_file', description: 'Synthetic current capability-role fixture',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }, permission: 'public', securityLevel: 'safe',
      capability: { id: 'fixture.reader-role-' + operation, family: 'fixture', lane: 'files', operation, risk: 'low',
        sideEffects: [{ type: operation === 'observe' ? 'local_read' : 'local_state_change', scope: 'synthetic fixture', reversible: true }],
        verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status'], requiredValues: { ok: true },
          successStatuses: [operation === 'observe' ? 'observed' : 'generated'], successSignals: [], limitations: [] } },
      handler: async () => encodeToolResult(content, { ok: true, status: operation === 'observe' ? 'observed' : 'generated' }) });
    const context: any = { authenticated: true, authRole: 'admin', userId: 'checkpoint-fixture', domain: 'personal', orgId: '',
      requestId: 'checkpoint-' + operation, taskId: 'role-' + operation, currentTurnExecutionRequested: true, actionIntent: task, localExecution: true };
    const record = await executeToolCall({ registry, name: 'read_file', arguments: { path: target }, context });
    expect(isCanonicalToolExecutionRecord(record)).toBe(true);
    expect(record.envelope?.status).toBe('verified_success');
    const result = buildVerifiedToolCheckpoint([record], task, context);
    expect(result.blocked).toBe(true);
    if (operation === 'observe') expect(result.text).toContain(content);
    else expect(result.text).not.toContain(content);
  });
});
