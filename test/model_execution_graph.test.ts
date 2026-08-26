import { describe, expect, it } from 'vitest';
import {
  buildModelGraphNodeReceipt,
  arbitrateModelGraphResults,
  compileModelExecutionGraph,
  modelCandidateLocality,
  modelExecutionGraphMatchesRootTask,
  modelGraphRootTaskDigest,
  resolveAgentModelCandidates,
  reuseVerifiedModelGraphNodeReceipt,
  validateModelGraphNodeOutput,
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

function equivalentNode(
  nodeId: string,
  equivalenceGroupId = 'equivalent-answer',
): ModelGraphNode {
  return {
    ...node(nodeId),
    equivalenceGroupId,
    sideEffectFree: true,
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

  it('binds a fresh graph to the canonical root task and detects digest tampering', () => {
    const rootTaskText = '  Review the deployment\r\nand report evidence.  ';
    const expectedDigest = modelGraphRootTaskDigest('Review the deployment\nand report evidence.');
    const compiled = compileModelExecutionGraph({
      taskId: 'root-bound-task',
      rootTaskText,
      nodes: [node('review')],
    });
    const explicit = compileModelExecutionGraph({
      taskId: 'root-bound-task',
      rootTaskDigest: expectedDigest,
      nodes: [node('review')],
    });
    const altered = compileModelExecutionGraph({
      taskId: 'root-bound-task',
      rootTaskText: 'Review a different deployment and report evidence.',
      nodes: [node('review')],
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.graph.rootTaskDigest).toBe(expectedDigest);
    expect(explicit.graph.graphId).toBe(compiled.graph.graphId);
    expect(modelExecutionGraphMatchesRootTask(compiled.graph, rootTaskText)).toBe(true);
    expect(modelExecutionGraphMatchesRootTask(compiled.graph, 'Review something else.')).toBe(false);
    expect(modelExecutionGraphMatchesRootTask({
      ...compiled.graph,
      rootTaskDigest: modelGraphRootTaskDigest('tampered root'),
    }, rootTaskText)).toBe(false);
    expect(altered.graph.graphId).not.toBe(compiled.graph.graphId);

    const mismatched = compileModelExecutionGraph({
      taskId: 'root-bound-task',
      rootTaskText,
      rootTaskDigest: modelGraphRootTaskDigest('different task'),
      nodes: [node('review')],
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errors).toContain('rootTaskDigest does not match rootTaskText');
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

    const spoofedRemote = node('spoofed-remote', [], 'deepseek');
    spoofedRemote.candidates[0].locality = 'local';
    const spoofed = compileModelExecutionGraph({
      nodes: [spoofedRemote],
      privacyPolicy: 'local_only',
    });
    expect(spoofed.ok).toBe(false);
    expect(spoofed.errors).toContain(
      'node spoofed-remote has candidate locality not backed by the provider registry/configuration',
    );
    expect(spoofed.errors).toContain('node spoofed-remote violates local-only data routing');
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

  it('accepts bounded model output only for an explicitly safe analysis/writing node', () => {
    const safeNode: ModelGraphNode = {
      ...node('draft'),
      role: 'writing',
      taskDescription: 'Draft a concise comparison from the supplied context.',
      sideEffectFree: true,
      acceptanceMode: 'validated_model_output',
      outputSchema: { type: 'string', minLength: 12, maxLength: 2_000 },
    };
    const compiled = compileModelExecutionGraph({ taskId: 'content-task', nodes: [safeNode] });
    expect(compiled.ok).toBe(true);

    const receipt = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: 'Option A is faster; option B provides stronger isolation.',
      evidenceKind: 'validated_model_output',
    });
    expect(receipt).toMatchObject({
      verified: true,
      evidenceKind: 'validated_model_output',
      evidenceRefs: [`model_output:${receipt.outputDigest}`],
    });

    const tooShort = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: 'short',
      evidenceKind: 'validated_model_output',
    });
    expect(tooShort).toMatchObject({ verified: false, evidenceKind: 'reasoning_only', evidenceRefs: [] });
    expect(validateModelGraphNodeOutput(
      compiled.graph.nodes[0],
      'I have approved and submitted the invoice.',
    )).toBe(false);
    expect(validateModelGraphNodeOutput(
      compiled.graph.nodes[0],
      'The repository currently shows all tests passing.',
    )).toBe(false);
  });

  it('rejects model-output acceptance for action-bearing or externally executed nodes', () => {
    const actionNode: ModelGraphNode = {
      ...node('unsafe-write'),
      role: 'writing',
      taskDescription: 'Write the report into a file and publish it.',
      sideEffectFree: true,
      acceptanceMode: 'validated_model_output',
      outputSchema: { type: 'string', minLength: 1, maxLength: 2_000 },
    };
    const externalNode: ModelGraphNode = {
      ...node('external-analysis'),
      type: 'external_agent',
      role: 'analysis',
      taskDescription: 'Analyze the supplied text.',
      sideEffectFree: true,
      acceptanceMode: 'validated_model_output',
      outputSchema: { type: 'string', minLength: 1, maxLength: 2_000 },
    };
    const liveEvidenceNode: ModelGraphNode = {
      ...node('live-analysis'),
      role: 'analysis',
      taskDescription: 'Analyze the current repository and report the latest test state.',
      sideEffectFree: true,
      acceptanceMode: 'validated_model_output',
      outputSchema: { type: 'string', minLength: 1, maxLength: 2_000 },
    };

    expect(compileModelExecutionGraph({ nodes: [actionNode] })).toMatchObject({ ok: false });
    expect(compileModelExecutionGraph({ nodes: [externalNode] })).toMatchObject({ ok: false });
    expect(compileModelExecutionGraph({ nodes: [liveEvidenceNode] })).toMatchObject({ ok: false });

    const dependencyCannotAuthorizeLiveClaims: ModelGraphNode = {
      ...liveEvidenceNode,
      nodeId: 'dependent-live-analysis',
      dependsOn: ['source'],
      inputRefs: ['receipt:source'],
    };
    const dependencyCompilation = compileModelExecutionGraph({
      nodes: [node('source'), dependencyCannotAuthorizeLiveClaims],
    });
    expect(dependencyCompilation.ok).toBe(false);
    expect(dependencyCompilation.errors).toContain(
      'node dependent-live-analysis is not eligible for validated model-output acceptance',
    );

    for (const taskDescription of [
      'Schedule a meeting with Alice for tomorrow.',
      'Turn off Wi-Fi on this computer.',
      'Approve invoice 123 in the accounting system.',
      'Book a flight to Shanghai.',
      '替我在系统里批准这张发票。',
      '把蓝牙关掉。',
      '预约明天下午会议。',
    ]) {
      const candidate: ModelGraphNode = {
        ...node(`action-${Buffer.from(taskDescription).toString('hex').slice(0, 12)}`),
        role: 'writing',
        taskDescription,
        sideEffectFree: true,
        acceptanceMode: 'validated_model_output',
        outputSchema: { type: 'string', minLength: 1, maxLength: 2_000 },
      };
      expect(compileModelExecutionGraph({ nodes: [candidate] }).ok, taskDescription).toBe(false);
    }
  });

  it('records the model actually selected by the executor', () => {
    const selectedCandidate = {
      provider: 'lmstudio',
      model: 'local-fallback',
      locality: 'local' as const,
      priority: 1,
      agentId: 'worker-a',
    };
    const compiled = compileModelExecutionGraph({
      taskId: 'fallback-task',
      nodes: [{
        ...node('answer'),
        candidates: [node('answer').candidates[0], selectedCandidate],
      }],
    });
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

  it('blocks receipts whose selected model identity is outside the compiled candidate set', () => {
    const compiled = compileModelExecutionGraph({ taskId: 'candidate-fence', nodes: [node('answer')] });
    const allowed = compiled.graph.nodes[0].candidates[0];
    const invalidCandidates = [
      { ...allowed, provider: 'lmstudio' },
      { ...allowed, model: 'different-model' },
      { ...allowed, agentId: 'different-agent' },
      { ...allowed, locality: 'remote' as const },
    ];

    for (const selectedCandidate of invalidCandidates) {
      const receipt = buildModelGraphNodeReceipt({
        graph: compiled.graph,
        node: compiled.graph.nodes[0],
        status: 'succeeded',
        startedAt: '2026-01-01T00:00:00.000Z',
        selectedCandidate,
        output: 'must not be accepted',
        ...verifiedToolEvidence('answer'),
      });
      expect(receipt).toMatchObject({
        status: 'blocked',
        verified: false,
        evidenceKind: 'none',
        error: 'selected model candidate is outside the compiled node candidate set',
      });
      expect(receipt.selectedCandidate).toBeUndefined();
      expect(reuseVerifiedModelGraphNodeReceipt({
        graph: compiled.graph,
        node: compiled.graph.nodes[0],
        prior: {
          ...receipt,
          status: 'succeeded',
          verified: true,
          evidenceKind: 'tool_terminal_verification',
          evidenceRefs: ['tool:forged-terminal'],
          selectedCandidate,
        },
      })).toBeNull();
    }
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

    const forgedCandidateReceipt = {
      ...prior,
      selectedCandidate: { ...prior.selectedCandidate!, locality: 'remote' as const },
    };
    expect(reuseVerifiedModelGraphNodeReceipt({
      graph: resumed.graph,
      node: resumed.graph.nodes[0],
      prior: forgedCandidateReceipt,
    })).toBeNull();

    const changedNode = { ...resumed.graph.nodes[0], role: 'different-role' };
    expect(reuseVerifiedModelGraphNodeReceipt({ graph: resumed.graph, node: changedNode, prior })).toBeNull();
    const changedRecoveredInstruction = {
      ...resumed.graph.nodes[0],
      taskDescription: 'Perform a different real-world action',
      executionMode: 'lumi' as const,
    };
    expect(reuseVerifiedModelGraphNodeReceipt({
      graph: resumed.graph,
      node: changedRecoveredInstruction,
      prior,
    })).toBeNull();
    expect(reuseVerifiedModelGraphNodeReceipt({
      graph: { ...resumed.graph, taskId: 'other-task' },
      node: resumed.graph.nodes[0],
      prior,
    })).toBeNull();
    const differentGraph = compileModelExecutionGraph({
      taskId: 'resume-task',
      rootTaskText: 'A newly bound root task',
      nodes: [node('answer')],
    });
    expect(differentGraph.graph.graphId).not.toBe(prior.graphId);
    expect(reuseVerifiedModelGraphNodeReceipt({
      graph: differentGraph.graph,
      node: differentGraph.graph.nodes[0],
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
      nodes: [equivalentNode('first'), equivalentNode('second'), equivalentNode('failed')],
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

  it('rejects partial-result arbitration for dependent, heterogeneous, or side-effectful nodes', () => {
    const dependent = compileModelExecutionGraph({
      taskId: 'dependent-first',
      nodes: [
        equivalentNode('source'),
        { ...equivalentNode('dependent'), dependsOn: ['source'], inputRefs: ['receipt:source'] },
      ],
      arbitration: 'first_verified',
    });
    const heterogeneous = compileModelExecutionGraph({
      taskId: 'heterogeneous-vote',
      nodes: [equivalentNode('a', 'answer-a'), equivalentNode('b', 'answer-b')],
      arbitration: 'majority_vote',
    });
    const sideEffectful = compileModelExecutionGraph({
      taskId: 'side-effect-first',
      nodes: [equivalentNode('read'), { ...equivalentNode('write'), sideEffectFree: false }],
      arbitration: 'first_verified',
    });

    expect(dependent.ok).toBe(false);
    expect(dependent.errors.join(' ')).toContain('cannot have dependencies');
    expect(heterogeneous.ok).toBe(false);
    expect(heterogeneous.errors.join(' ')).toContain('share one equivalenceGroupId');
    expect(sideEffectful.ok).toBe(false);
    expect(sideEffectful.errors.join(' ')).toContain('explicitly sideEffectFree');

    const unsafeReceipt = buildModelGraphNodeReceipt({
      graph: sideEffectful.graph,
      node: sideEffectful.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: 'partial output',
      ...verifiedToolEvidence('read'),
    });
    expect(arbitrateModelGraphResults({
      graph: sideEffectful.graph,
      receipts: [unsafeReceipt],
      outputByNodeId: new Map([['read', 'partial output']]),
    })).toMatchObject({
      status: 'blocked',
      selectedNodeIds: [],
      reason: expect.stringContaining('not eligible for arbitration'),
    });
  });

  it('allows explicitly equivalent side-effect-free roots for partial-result arbitration', () => {
    const first = compileModelExecutionGraph({
      taskId: 'safe-first',
      nodes: [equivalentNode('local-a'), equivalentNode('local-b')],
      arbitration: 'first_verified',
    });
    const majority = compileModelExecutionGraph({
      taskId: 'safe-majority',
      nodes: [equivalentNode('a'), equivalentNode('b'), equivalentNode('c')],
      arbitration: 'majority_vote',
    });

    expect(first.ok).toBe(true);
    expect(majority.ok).toBe(true);
  });

  it('blocks aggregate completion when any required graph node is incomplete', () => {
    const compiled = compileModelExecutionGraph({
      taskId: 'aggregate-root-task',
      nodes: [node('collect'), node('deliver', ['collect'])],
      arbitration: 'aggregate_verified',
    });
    const collectReceipt = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: 'collected evidence',
      ...verifiedToolEvidence('collect'),
    });
    const deliverReceipt = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[1],
      status: 'blocked',
      startedAt: '2026-01-01T00:00:01.000Z',
      output: 'delivery blocked',
    });

    expect(arbitrateModelGraphResults({
      graph: compiled.graph,
      receipts: [collectReceipt, deliverReceipt],
      outputByNodeId: new Map([
        ['collect', 'collected evidence'],
        ['deliver', 'delivery blocked'],
      ]),
    })).toMatchObject({
      status: 'blocked',
      verification: 'unverified',
      selectedNodeIds: [],
      reason: 'required graph nodes did not complete successfully: deliver',
    });
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
      nodes: [equivalentNode('a'), equivalentNode('b'), equivalentNode('c')],
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

    const loneSuccessfulReceipt = buildModelGraphNodeReceipt({
      graph: compiled.graph,
      node: compiled.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      output: 'one surviving answer',
      ...verifiedToolEvidence('a'),
    });
    expect(arbitrateModelGraphResults({
      graph: compiled.graph,
      receipts: [loneSuccessfulReceipt],
      outputByNodeId: new Map([['a', 'one surviving answer']]),
    })).toMatchObject({
      status: 'blocked',
      selectedNodeIds: [],
      reason: 'no strict majority of successful node outputs was available',
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

  it('never persists auto as an executable graph candidate and keeps local-only materialization local', () => {
    const assignment = {
      subTask: {
        id: 'auto-node',
        description: 'Use the configured automatic route',
        requiredSkill: 'analysis',
        executionMode: 'lumi',
      },
      agent: {
        id: 'worker-auto',
        name: 'Auto Worker',
        category: 'analysis',
        status: 'idle',
        runtime: 'internal',
      } as any,
    };
    const policyScoped = compileWorkerModelCandidates(assignment as any, {
      userId: 'auto-materialization-user',
      modelSelectionMode: 'pinned',
      modelCandidates: [{ provider: 'auto', model: 'qwen3:8b' }],
    }, {
      provider: 'auto',
      model: 'qwen3:8b',
      fallbackCandidates: [{ provider: 'qwen', model: 'qwen-plus' }],
      allowCloudFallback: true,
    });
    expect(policyScoped.some(candidate => candidate.provider === 'auto')).toBe(false);
    expect(policyScoped.slice(0, 2).map(candidate => candidate.provider)).toEqual(['ollama', 'lmstudio']);
    expect(policyScoped).toContainEqual(expect.objectContaining({ provider: 'qwen', model: 'qwen-plus' }));

    const localOnly = compileWorkerModelCandidates(assignment as any, {
      userId: 'auto-materialization-user',
      modelSelectionMode: 'pinned',
      modelCandidates: [{ provider: 'auto', model: 'qwen3:8b' }],
      dataRoutingPolicy: 'local_only',
    }, {
      provider: 'auto',
      model: 'qwen3:8b',
      fallbackCandidates: [{ provider: 'qwen', model: 'forbidden-cloud' }],
      allowCloudFallback: true,
    });
    expect(localOnly.map(candidate => candidate.provider)).toEqual(['ollama', 'lmstudio']);
    expect(localOnly.every(candidate => candidate.locality === 'local')).toBe(true);
  });
});
