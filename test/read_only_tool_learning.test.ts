import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolExecutionRecord } from '../server/tools/types';

function verifiedReadRecord(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    id: `record_${Math.random()}`,
    requestId: `request_${Math.random()}`,
    name: 'knowledge_lookup',
    arguments: { query: 'sensitive customer wording', limit: 3 },
    result: JSON.stringify({ ok: true, items: ['private result'] }),
    capability: {
      capabilityId: 'knowledge.lookup',
      lane: 'knowledge',
      operation: 'observe',
      risk: 'none',
      sideEffects: [{ type: 'network_read', scope: 'authorized knowledge', reversible: true }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['ok'],
        successSignals: ['ok'],
        limitations: [],
      },
    },
    terminalVerification: { status: 'verified', strategy: 'provider_ack', reason: 'provider acknowledged read' },
    envelope: {
      version: 1,
      status: 'verified_success',
      toolName: 'knowledge_lookup',
      taskId: 'task',
      turnId: 'turn',
      requestId: 'request',
      idempotencyKey: 'read-key',
      targetIdentity: 'knowledge',
      completedAt: new Date().toISOString(),
      verification: { status: 'verified', reason: 'provider acknowledged read' },
    },
    ...overrides,
  };
}

describe('verified read-only tool pattern learning', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('learns only after verified successes and stores no raw text, values, or results', async () => {
    const { readDB, flushDBOrThrow, querySQL } = await import('../db_layer');
    const { recordReadOnlyToolPattern, rankReadOnlyToolPatterns } = await import('../server/context/read_only_tool_learning');
    const userId = `readonly_user_${Date.now()}`;
    const userText = '读取客户甲的秘密项目资料';
    for (let index = 0; index < 4; index += 1) {
      const outcome = recordReadOnlyToolPattern({
        userId,
        userText,
        toolRecords: [verifiedReadRecord()],
        observationRef: `turn_${index}`,
      });
      expect(outcome.recorded).toBe(true);
    }

    const rows = readDB().readOnlyToolPatterns.filter((row: any) => row.userId === userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ successCount: 4, confidence: 0.93 });
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(userText);
    expect(serialized).not.toContain('sensitive customer wording');
    expect(serialized).not.toContain('private result');
    expect(rows[0].toolSequence).toEqual([{ name: 'knowledge_lookup', argumentKeys: ['limit', 'query'] }]);

    const ranked = rankReadOnlyToolPatterns({ userId, userText, availableTools: ['knowledge_lookup'] });
    expect(ranked[0]).toMatchObject({ action: 'direct_prefetch', toolNames: ['knowledge_lookup'] });

    await flushDBOrThrow();
    const persisted = await querySQL<any>('SELECT payload FROM read_only_tool_patterns WHERE userId = ?', [userId]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].payload).not.toContain(userText);
    expect(persisted[0].payload).not.toContain('private result');
  });

  it('rejects mixed, mutating, desktop, external, failed, and unverified chains', async () => {
    const { recordReadOnlyToolPattern } = await import('../server/context/read_only_tool_learning');
    const userId = `readonly_reject_${Date.now()}`;
    const unsafe = [
      verifiedReadRecord({ capability: { ...verifiedReadRecord().capability!, operation: 'mutate' } }),
      verifiedReadRecord({ capability: { ...verifiedReadRecord().capability!, sideEffects: [{ type: 'desktop_control', scope: 'desktop', reversible: true }] } }),
      verifiedReadRecord({ capability: { ...verifiedReadRecord().capability!, sideEffects: [{ type: 'external_communication', scope: 'recipient', reversible: false }] } }),
      verifiedReadRecord({ error: 'failed' }),
      verifiedReadRecord({ terminalVerification: { status: 'unverified', strategy: 'provider_ack', reason: 'no evidence' } }),
    ];
    for (const [index, record] of unsafe.entries()) {
      const result = recordReadOnlyToolPattern({
        userId,
        userText: `unsafe ${index}`,
        toolRecords: index === 0 ? [verifiedReadRecord(), record] : [record],
        observationRef: `unsafe_${index}`,
      });
      expect(result).toMatchObject({ recorded: false, reason: 'chain_not_strict_read_only' });
    }
  });

  it('isolates patterns by user and organization and never returns partial chains', async () => {
    const { recordReadOnlyToolPattern, rankReadOnlyToolPatterns } = await import('../server/context/read_only_tool_learning');
    const userId = `readonly_scope_${Date.now()}`;
    const text = '查看本组织的项目状态';
    for (let index = 0; index < 4; index += 1) {
      recordReadOnlyToolPattern({
        userId,
        userText: text,
        domain: 'work',
        orgId: 'org-a',
        observationRef: `org_a_${index}`,
        toolRecords: [verifiedReadRecord(), verifiedReadRecord({ name: 'status_lookup' })],
      });
    }
    expect(rankReadOnlyToolPatterns({ userId, userText: text, domain: 'work', orgId: 'org-b', availableTools: ['knowledge_lookup', 'status_lookup'] })).toEqual([]);
    expect(rankReadOnlyToolPatterns({ userId: `${userId}_other`, userText: text, domain: 'work', orgId: 'org-a', availableTools: ['knowledge_lookup', 'status_lookup'] })).toEqual([]);
    expect(rankReadOnlyToolPatterns({ userId, userText: text, domain: 'work', orgId: 'org-a', availableTools: ['knowledge_lookup'] })).toEqual([]);
    expect(rankReadOnlyToolPatterns({ userId, userText: text, domain: 'work', orgId: 'org-a', availableTools: ['knowledge_lookup', 'status_lookup'] })[0]?.toolNames).toEqual(['knowledge_lookup', 'status_lookup']);
  });

  it('only reorders an already-authorized read tool in the unified execution pipeline', async () => {
    const { recordReadOnlyToolPattern } = await import('../server/context/read_only_tool_learning');
    const { buildLumiExecutionPipeline } = await import('../server/cognition/execution_pipeline');
    const { ToolRegistry } = await import('../server/tools/registry');
    const registry = new ToolRegistry();
    registry.register({
      name: 'project_status_lookup',
      description: 'Read and check project status from the authorized knowledge service',
      parameters: { query: { type: 'string', required: true } },
      permission: 'public',
      securityLevel: 'safe',
      routingHints: ['check project status', 'project status lookup'],
      capability: {
        id: 'knowledge.project-status.read',
        family: 'knowledge',
        lane: 'knowledge',
        source: 'builtin',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'network_read', scope: 'authorized project status', reversible: true }],
        verification: {
          strategy: 'provider_ack',
          required: true,
          requiredFields: ['ok'],
          successSignals: ['ok'],
          limitations: [],
        },
      },
      evidence: { capability: 'knowledge.project-status.read', operation: 'observe', assurance: 'verified' },
      handler: async () => JSON.stringify({ ok: true }),
    });
    const userId = `readonly_pipeline_${Date.now()}`;
    const userText = 'check project status';
    for (let index = 0; index < 4; index += 1) {
      recordReadOnlyToolPattern({
        userId,
        userText,
        observationRef: `pipeline_${index}`,
        toolRecords: [verifiedReadRecord({ name: 'project_status_lookup' })],
      });
    }
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId,
        text: userText,
        channel: 'task',
        source: 'task',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['project_status_lookup'],
        forbiddenTools: [],
        requireConfirmation: [],
        maxIterations: 4,
      },
    });
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('project_status_lookup');
    expect(pipeline.capabilityPlan.preferredTools[0]).toBe('project_status_lookup');
    expect(pipeline.capabilityPlan.readOnlyPattern).toMatchObject({
      action: 'direct_prefetch',
      toolNames: ['project_status_lookup'],
    });

    const externalCommit = buildLumiExecutionPipeline({
      dispatch: {
        userId,
        text: 'send to Alice: check project status',
        channel: 'task',
        source: 'task',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['project_status_lookup'],
        forbiddenTools: [],
        requireConfirmation: [],
        maxIterations: 4,
      },
    });
    expect(externalCommit.normalizedIntent.sideEffectClass).toBe('external_commit');
    expect(externalCommit.capabilityPlan.readOnlyPattern).toBeUndefined();
  });
});
