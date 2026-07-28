import { describe, expect, it } from 'vitest';
import {
  buildModelGraphNodeReceipt,
  compileModelExecutionGraph,
  modelCandidateLocality,
  resolveAgentModelCandidates,
  type ModelGraphNode,
} from '../server/agents/model_execution_graph';

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

  it('creates a receipt whose verified flag follows terminal node status', () => {
    const compiled = compileModelExecutionGraph({ taskId: 'receipt-task', nodes: [node('answer')] });
    const receipt = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      output: 'verified answer',
    });

    expect(receipt).toMatchObject({
      taskId: 'receipt-task',
      nodeId: 'answer',
      verified: true,
      durationMs: 1000,
    });
    expect(receipt.outputDigest).toHaveLength(64);
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
});
