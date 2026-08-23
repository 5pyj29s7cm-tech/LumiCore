import { describe, expect, it } from 'vitest';
import {
  buildModelGraphNodeReceipt,
  arbitrateModelGraphResults,
  compileModelExecutionGraph,
  modelCandidateLocality,
  resolveAgentModelCandidates,
  reuseVerifiedModelGraphNodeReceipt,
  type ModelGraphNode,
} from '../server/agents/model_execution_graph';
import { compileWorkerModelCandidates } from '../server/agents/orchestrator';

function node(nodeId: string, dependsOn: string[] = [], provider = 'ollama'): ModelGraphNode {
  return {
    nodeId,
    type: 'internal_agent',
    role: 'reasoning',
    candidates: [{
      provider,
      model: provider === 'ollama' ? 'qwen3:8b' : 'gpt-example',
      locality: modelCandidateLocality(provider),
      priority: 0,
    }],
    dependsOn,
    inputRefs: dependsOn.map(id => `receipt:${id}`),
    outputSchema: { type: 'string' },
    timeoutMs: 30_000,
    maxRetries: 1,
  };
}

function verifiedToolEvidence(nodeId: string) {
  return {
    evidenceKind: 'tool_terminal_verification' as const,
    evidenceRefs: [`tool:${nodeId}-terminal-receipt`],
  };
}

describe('model execution graph', () => {
  it('compiles serial/parallel fan-out and fan-in into deterministic waves', () => {
    const compiled = compileModelExecutionGraph({
      taskId: 'task-1',
      nodes: [
        node('collect'),
        node('analyze-a', ['collect']),
        node('analyze-b', ['collect']),
        node('join', ['analyze-a', 'analyze-b']),
      ],
      budgets: { maxParallel: 2 },
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.waves).toEqual([
      ['collect'],
      ['analyze-a', 'analyze-b'],
      ['join'],
    ]);
    expect(compiled.graph.edges).toHaveLength(4);
    expect(compiled.graph.taskId).toBe('task-1');
  });

  it('fails closed on missing dependencies, cycles, and budget violations', () => {
    const missing = compileModelExecutionGraph({ nodes: [node('a', ['missing'])] });
    const cycle = compileModelExecutionGraph({ nodes: [node('a', ['b']), node('b', ['a'])] });
    const overBudget = compileModelExecutionGraph({
      nodes: [node('a'), node('b')],
      budgets: { maxNodes: 1 },
    });

    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toContain('missing node');
    expect(cycle.ok).toBe(false);
    expect(cycle.errors.join(' ')).toContain('cycle');
    expect(overBudget.ok).toBe(false);
    expect(overBudget.errors.join(' ')).toContain('budget allows 1');
  });

  it('preserves an explicit zero-retry budget instead of replacing it with the default', () => {
    const compiled = compileModelExecutionGraph({
      nodes: [{ ...node('no-retry'), maxRetries: 0 }],
      budgets: { maxRetriesPerNode: 0 },
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.graph.budgets.maxRetriesPerNode).toBe(0);
    expect(compiled.graph.nodes[0].maxRetries).toBe(0);
  });

  it('enforces local-only privacy before any node can run', () => {
    const compiled = compileModelExecutionGraph({
      nodes: [node('local', [], 'ollama'), node('remote', ['local'], 'openai')],
      privacyPolicy: 'local_only',
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.errors).toContain('node remote violates local-only data routing');
  });

  it('normalizes task, agent and fallback model choices in explicit priority order', () => {
    const candidates = resolveAgentModelCandidates({
      agentId: 'worker-a',
      agentName: 'Worker A',
      runtimeConfig: JSON.stringify({
        modelCandidates: [
          { provider: 'qwen', model: 'qwen-plus', priority: 20 },
          { provider: 'openai', model: 'gpt-5-mini', priority: 10 },
        ],
      }),
      modelPreference: 'ollama/qwen3:8b',
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
    });

    expect(candidates.map(candidate => `${candidate.provider}/${candidate.model}`)).toEqual([
      'openai/gpt-5-mini',
      'qwen/qwen-plus',
      'ollama/qwen3:8b',
      'deepseek/deepseek-v4-flash',
    ]);
    expect(candidates.every(candidate => candidate.agentId === 'worker-a')).toBe(true);
  });

  it('requires terminal tool evidence instead of treating successful model prose as verified', () => {
    const compiled = compileModelExecutionGraph({ taskId: 'receipt-task', nodes: [node('answer')] });
    const reasoningOnly = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      output: 'Done',
    });
    const receipt = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      output: 'verified answer',
      ...verifiedToolEvidence('answer'),
    });

    expect(reasoningOnly).toMatchObject({
      status: 'succeeded',
      verified: false,
      evidenceKind: 'reasoning_only',
      evidenceRefs: [],
      outputSummary: 'Done',
    });
    expect(receipt).toMatchObject({
      taskId: 'receipt-task',
      nodeId: 'answer',
      verified: true,
      evidenceKind: 'tool_terminal_verification',
      durationMs: 1000,
    });
    expect(receipt.outputDigest).toHaveLength(64);
    expect(receipt.nodeFingerprint).toHaveLength(64);
    expect(receipt.outputSummary).toBe('verified answer');
  });

  it('records the model actually selected by the executor', () => {
    const compiled = compileModelExecutionGraph({ taskId: 'fallback-task', nodes: [node('answer')] });
    const selectedCandidate = {
      provider: 'lmstudio',
      model: 'local-fallback',
      locality: 'local' as const,
      priority: 1,
      agentId: 'worker-a',
    };
    const receipt = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      selectedCandidate,
      output: 'fallback result',
    });

    expect(receipt.selectedCandidate).toEqual(selectedCandidate);
  });

  it('reuses only a verified receipt for the same task and semantic node fingerprint', () => {
    const first = compileModelExecutionGraph({ taskId: 'resume-task', nodes: [node('answer')] });
    const prior = buildModelGraphNodeReceipt({
      graph: first.graph,
      node: first.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: 'password=hunter2 verified result',
      ...verifiedToolEvidence('answer'),
    });
    const resumed = compileModelExecutionGraph({ taskId: 'resume-task', nodes: [node('answer')] });
    const reused = reuseVerifiedModelGraphNodeReceipt({
      graph: resumed.graph,
      node: resumed.graph.nodes[0],
      prior,
      recoveredAt: '2026-01-01T00:01:00.000Z',
    });

    expect(reused).toMatchObject({
      taskId: 'resume-task',
      nodeId: 'answer',
      verified: true,
      durationMs: 0,
      reusedFromReceipt: `${prior.graphId}:answer`,
    });
    expect(reused?.outputDigest).toBe(prior.outputDigest);
    expect(reused?.outputSummary).toContain('password=[redacted]');
    expect(reused?.outputSummary).not.toContain('hunter2');

    const changedNode = { ...resumed.graph.nodes[0], role: 'different-role' };
    expect(reuseVerifiedModelGraphNodeReceipt({ graph: resumed.graph, node: changedNode, prior })).toBeNull();
    expect(reuseVerifiedModelGraphNodeReceipt({
      graph: { ...resumed.graph, taskId: 'other-task' },
      node: resumed.graph.nodes[0],
      prior,
    })).toBeNull();

    const legacyStatusOnlyReceipt = { ...prior } as any;
    delete legacyStatusOnlyReceipt.evidenceKind;
    delete legacyStatusOnlyReceipt.evidenceRefs;
    expect(reuseVerifiedModelGraphNodeReceipt({
      graph: resumed.graph,
      node: resumed.graph.nodes[0],
      prior: legacyStatusOnlyReceipt,
    })).toBeNull();
  });

  it('arbitrates only verified outputs and honors deterministic first-result policy', () => {
    const compiled = compileModelExecutionGraph({
      taskId: 'arbitration-task',
      nodes: [node('first'), node('second'), node('failed')],
      arbitration: 'first_verified',
    });
    const receipts = compiled.graph.nodes.map(graphNode => buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: graphNode,
      status: graphNode.nodeId === 'failed' ? 'failed' : 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: `${graphNode.nodeId} output`,
      ...(graphNode.nodeId === 'failed' ? {} : verifiedToolEvidence(graphNode.nodeId)),
    }));
    const result = arbitrateModelGraphResults({
      graph: compiled.graph,
      receipts,
      outputByNodeId: new Map([
        ['first', 'first output'],
        ['second', 'second output'],
        ['failed', 'failed output'],
      ]),
    });

    expect(result).toMatchObject({
      policy: 'first_verified',
      status: 'succeeded',
      verification: 'verified',
      selectedNodeIds: ['first'],
      verifiedNodeIds: ['first'],
    });
    expect(result.outputDigest).toHaveLength(64);
  });

  it('requires a verified judge that consumes every candidate result', () => {
    const invalid = compileModelExecutionGraph({
      taskId: 'judge-task',
      nodes: [node('candidate-a'), { ...node('judge'), type: 'judge' }],
      arbitration: 'judge',
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join(' ')).toContain('judge node must depend on every candidate node');

    const compiled = compileModelExecutionGraph({
      taskId: 'judge-task',
      nodes: [
        node('candidate-a'),
        node('candidate-b'),
        { ...node('judge', ['candidate-a', 'candidate-b']), type: 'judge' },
      ],
      arbitration: 'judge',
    });
    const receipts = compiled.graph.nodes.map(graphNode => buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: graphNode,
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: `${graphNode.nodeId} output`,
      ...verifiedToolEvidence(graphNode.nodeId),
    }));
    const result = arbitrateModelGraphResults({
      graph: compiled.graph,
      receipts,
      outputByNodeId: new Map(compiled.graph.nodes.map(graphNode => [
        graphNode.nodeId,
        `${graphNode.nodeId} output`,
      ])),
    });

    expect(compiled.ok).toBe(true);
    expect(result).toMatchObject({
      policy: 'judge',
      status: 'succeeded',
      verification: 'verified',
      selectedNodeIds: ['judge'],
      verifiedNodeIds: ['judge', 'candidate-a', 'candidate-b'],
    });

    const incompleteEvidenceReceipts = compiled.graph.nodes.map(graphNode => buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: graphNode,
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: `${graphNode.nodeId} output`,
      ...(graphNode.nodeId === 'candidate-a' ? {} : verifiedToolEvidence(graphNode.nodeId)),
    }));
    expect(arbitrateModelGraphResults({
      graph: compiled.graph,
      receipts: incompleteEvidenceReceipts,
      outputByNodeId: new Map(compiled.graph.nodes.map(graphNode => [
        graphNode.nodeId,
        `${graphNode.nodeId} output`,
      ])),
    })).toMatchObject({
      status: 'succeeded',
      verification: 'unverified',
      selectedNodeIds: ['judge'],
    });
  });

  it('requires a strict verified majority and blocks ties', () => {
    const compiled = compileModelExecutionGraph({
      taskId: 'vote-task',
      nodes: [node('a'), node('b'), node('c')],
      arbitration: 'majority_vote',
    });
    const receipts = compiled.graph.nodes.map(graphNode => buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: graphNode,
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: graphNode.nodeId === 'c' ? 'different' : 'Same answer',
      ...verifiedToolEvidence(graphNode.nodeId),
    }));
    const majority = arbitrateModelGraphResults({
      graph: compiled.graph,
      receipts,
      outputByNodeId: new Map([['a', 'Same answer'], ['b', ' same   answer '], ['c', 'different']]),
    });
    expect(majority).toMatchObject({
      status: 'succeeded',
      verification: 'verified',
      selectedNodeIds: ['a'],
      verifiedNodeIds: ['a', 'b'],
    });

    const reasoningMajorityReceipts = compiled.graph.nodes.map(graphNode => buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: graphNode,
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: graphNode.nodeId === 'c' ? 'different' : 'Same answer',
      ...(graphNode.nodeId === 'c' ? verifiedToolEvidence(graphNode.nodeId) : {}),
    }));
    const reasoningMajority = arbitrateModelGraphResults({
      graph: compiled.graph,
      receipts: reasoningMajorityReceipts,
      outputByNodeId: new Map([['a', 'Same answer'], ['b', ' same   answer '], ['c', 'different']]),
    });
    expect(reasoningMajority).toMatchObject({
      status: 'succeeded',
      verification: 'unverified',
      selectedNodeIds: ['a'],
      verifiedNodeIds: [],
    });

    const tie = arbitrateModelGraphResults({
      graph: { ...compiled.graph, nodes: compiled.graph.nodes.slice(0, 2) },
      receipts: receipts.slice(0, 2),
      outputByNodeId: new Map([['a', 'one'], ['b', 'two']]),
    });
    expect(tie).toMatchObject({
      status: 'blocked',
      verification: 'unverified',
      selectedNodeIds: [],
    });
  });

  it('enforces reflection dependencies plus context and estimated cost budgets', () => {
    const reflectionWithoutInput = compileModelExecutionGraph({
      nodes: [{ ...node('reflect'), role: 'reflection' }],
    });
    expect(reflectionWithoutInput.ok).toBe(false);
    expect(reflectionWithoutInput.errors.join(' ')).toContain('requires at least one dependency');

    const expensive = compileModelExecutionGraph({
      nodes: [{
        ...node('remote', [], 'openai'),
        estimatedInputTokens: 2_000,
        estimatedOutputTokens: 2_000,
        candidates: [{
          ...node('remote', [], 'openai').candidates[0],
          estimatedCostPer1kTokensUsd: 1,
        }],
      }],
      budgets: { maxInputTokens: 1_000, maxEstimatedCostUsd: 1 },
    });
    expect(expensive.ok).toBe(false);
    expect(expensive.errors.join(' ')).toContain('input context estimate');
    expect(expensive.errors.join(' ')).toContain('estimated cost');
  });

  it('does not silently append fallback models when the task pins a model', () => {
    const candidates = compileWorkerModelCandidates({
      subTask: {
        id: 'pinned-node',
        description: 'Use the exact requested model',
        requiredSkill: 'analysis',
        executionMode: 'lumi',
      },
      agent: {
        id: 'worker-pinned',
        name: 'Pinned Worker',
        category: 'analysis',
        status: 'idle',
        runtime: 'internal',
        modelPreference: 'ollama/other-model',
      } as any,
    }, {
      userId: 'pinned-user',
      modelSelectionMode: 'pinned',
      modelCandidates: [{ provider: 'openai', model: 'exact-model' }],
    }, { provider: 'deepseek', model: 'fallback-model' });

    expect(candidates.map(candidate => `${candidate.provider}/${candidate.model}`))
      .toEqual(['openai/exact-model']);
  });
});
