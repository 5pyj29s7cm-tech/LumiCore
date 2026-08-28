import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

describe('Lumi learning interface', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('persists model-independent learning instructions into memory and capability records', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { persistLumiLearningTurn } = await import('../server/cognition/learning_interface');
    const { queryMemories } = await import('../server/memory/store');
    const { listCapabilityLearningRecords } = await import('../server/self_extension/capability_memory');

    const userText = 'Lumi 的人格核心和学习要沉淀，大模型只是学习接口，我不希望换了模型就遗忘。';
    const flow = buildLumiTurnFlow({
      userId: 'learning_interface_user',
      text: userText,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    const result = persistLumiLearningTurn({
      userId: 'learning_interface_user',
      userText,
      assistantText: '明白，我会把这类要求沉淀到 LumiCore 本地层。',
      channel: 'chat',
      flow,
      toolNames: ['capability_learning_list', 'self_extension_plan', 'adapter_registry_list', 'capability_gap_autofix'],
      sourceInteractionId: 'learn_turn_1',
    });

    expect(result.shouldPersist).toBe(true);
    expect(result.storedMemories).toBeGreaterThan(0);
    expect(result.capabilityRecord?.selectedRoute.id).toBe('lumi.model_independent_learning_interface');
    expect(['hypothesis', 'needs_core_work']).toContain(result.capabilityRecord?.status);
    expect(result.capabilityRecord?.planReadiness).not.toBe('ready_to_reuse_or_test');
    expect(result.capabilityRecord?.experiment.verification.every(item => item.passed)).toBe(false);

    const memories = queryMemories({
      userId: 'learning_interface_user',
      query: '换模型 大模型 学习接口',
      limit: 5,
      minConfidence: 0.1,
    });
    expect(memories.some(memory => memory.content.includes('不能因为换模型而遗忘'))).toBe(true);

    const records = listCapabilityLearningRecords({
      userId: 'learning_interface_user',
      goal: '模型无关 学习接口',
      limit: 5,
    });
    expect(records.some(record => record.selectedRoute.id === 'lumi.model_independent_learning_interface')).toBe(true);
  });

  it('never treats persistence or a prepared experiment as verified capability learning', async () => {
    const {
      isCapabilityLearningRecordVerified,
      upsertCapabilityLearningRecord,
    } = await import('../server/self_extension/capability_memory');
    const { buildSelfExtensionPlan } = await import('../server/self_extension/pipeline');
    const userId = `learning_truth_${Date.now()}`;
    const route = {
      id: 'test.outcome_grounded_route',
      label: 'Outcome-grounded route',
      interfacePattern: 'skill' as const,
      preferredTools: ['verified_probe_tool'],
      fallbackTools: [],
      avoid: [],
      reason: 'Test route',
      confirmationRequired: [],
    };
    const base = {
      userId,
      scopeDomain: 'personal' as const,
      orgId: '',
      domain: 'outcome_grounded_test',
      goal: 'outcome grounded capability',
      selectedRoute: route,
      existingTools: ['verified_probe_tool'],
      nextUse: {
        triggerHints: ['outcome grounded capability'],
        preferredTools: ['verified_probe_tool'],
        firstStep: 'verified_probe_tool',
        reportRule: 'Report verified outcomes only.',
      },
      safety: [],
    };

    const candidate = upsertCapabilityLearningRecord({
      ...base,
      status: 'experiment_prepared',
      planReadiness: 'candidate_needs_experiment',
      experiment: {
        status: 'prepared',
        summary: 'Only persisted.',
        toolCalls: [],
        artifacts: [],
        verification: [{ label: 'database write', passed: true, detail: 'Persisted only.' }],
      },
    });
    expect(isCapabilityLearningRecordVerified(candidate)).toBe(false);
    expect(buildSelfExtensionPlan({
      userId,
      goal: base.goal,
      domain: base.domain,
      tools: [],
    }).resolution.decision).not.toBe('reuse_learned_route');

    const verified = upsertCapabilityLearningRecord({
      ...base,
      id: candidate.id,
      status: 'experiment_passed',
      planReadiness: 'verified_reusable',
      experiment: {
        status: 'passed',
        summary: 'Real experiment completed.',
        toolCalls: [{ name: 'verified_probe_tool', args: {}, status: 'success', result: 'ok' }],
        artifacts: [],
        verification: [{ label: 'terminal receipt', passed: true, detail: 'Verified.' }],
      },
    });
    expect(isCapabilityLearningRecordVerified(verified)).toBe(true);
    expect(buildSelfExtensionPlan({
      userId,
      goal: base.goal,
      domain: base.domain,
      tools: [],
    }).resolution.decision).toBe('reuse_learned_route');
  });

  it('plans natural autonomy learning without writing ordinary chat', async () => {
    const { planLumiLearningTurn } = await import('../server/cognition/learning_interface');

    const ordinary = planLumiLearningTurn({
      userId: 'learning_interface_user',
      userText: '今天有点累，随便聊两句吧',
      channel: 'chat',
    });
    expect(ordinary.shouldPersist).toBe(false);

    const durable = planLumiLearningTurn({
      userId: 'learning_interface_user',
      userText: 'Lumi 以后一定要文字和语音都自然顺畅，不要像固定脚本。',
      channel: 'voice',
      toolNames: ['self_extension_plan'],
    });
    expect(durable.shouldPersist).toBe(true);
    expect(durable.memoryCandidates.some(item => item.content.includes('自然顺畅'))).toBe(true);
    expect(durable.capabilityCandidate?.route.id).toBe('lumi.natural_autonomy_flow');
  });

  it('persists through the shared post-turn adapter and isolates adapter errors', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { persistLumiPostTurnLearning } = await import('../server/cognition/post_turn_learning');

    const userText = 'Lumi 以后一定要记住，大模型只是学习接口，不要换模型就遗忘。';
    const flow = buildLumiTurnFlow({
      userId: 'post_turn_learning_user',
      text: userText,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    const outcome = persistLumiPostTurnLearning(
      {
        userId: 'post_turn_learning_user',
        userText,
        defaultChannel: 'chat',
        flow,
        getToolNames: () => ['self_extension_plan', 'capability_gap_autofix'],
        defaultSourceInteractionId: 'post_turn_learning_1',
        log: { info: () => {}, warn: () => {} },
      },
      '明白，我会沉淀到 LumiCore 本地层。',
      { logLabel: 'unit post turn' },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.shouldPersist).toBe(true);

    const failed = persistLumiPostTurnLearning(
      {
        userId: 'post_turn_learning_user',
        userText,
        defaultChannel: 'chat',
        flow,
        getToolNames: () => { throw new Error('tool registry unavailable'); },
        log: { info: () => {}, warn: () => {} },
      },
      '这次学习适配器失败也不能打断主流程。',
      { logLabel: 'unit post turn failure' },
    );

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('tool registry unavailable');
  });

  it('does not let acceptance probes mutate durable learning state', async () => {
    const { persistLumiPostTurnLearning } = await import('../server/cognition/post_turn_learning');
    const outcome = persistLumiPostTurnLearning({
      userId: 'learning_interface_acceptance_user',
      userText: 'Lumi 以后一定要记住，大模型只是学习接口。',
      defaultChannel: 'chat',
      getToolNames: () => ['self_extension_plan'],
      source: 'acceptance-main',
    }, '收到。');

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      shouldPersist: false,
      storedMemories: 0,
      reasons: ['ephemeral_source'],
    });
  });

  it('keeps model-owned chat and voice terminal paths wired into post-turn learning', () => {
    const chatSource = readFileSync(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');
    const voiceSource = readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');
    const taskSource = readFileSync(path.join(process.cwd(), 'server/socket/task.ts'), 'utf8');
    const postTurnSource = readFileSync(path.join(process.cwd(), 'server/cognition/post_turn_learning.ts'), 'utf8');

    expect(postTurnSource).toContain('export function persistLumiPostTurnLearning');
    expect(postTurnSource).toContain('persistLumiLearningTurn');

    expect(chatSource).toContain('const persistChatLearning');
    expect(chatSource).toContain('persistLumiPostTurnLearning');
    expect(chatSource).not.toContain('workflow quick path');
    expect(chatSource).not.toContain('chat quick command');
    expect(chatSource).not.toContain('registerBackgroundTask');
    expect(chatSource.match(/persistChatLearning\(/g)?.length || 0).toBeGreaterThanOrEqual(2);

    expect(voiceSource).toContain('const persistVoiceLearning');
    expect(voiceSource).toContain('persistLumiPostTurnLearning');
    expect(voiceSource).toContain("channel: 'workflow'");
    expect(voiceSource).toContain('voice quick command');
    expect(voiceSource).toContain('voice cognition direct');
    expect(voiceSource).toContain('voice confirmation');
    expect(voiceSource).not.toContain('voice music execution');
    expect(voiceSource).not.toContain('voice music shortcut');
    expect(voiceSource.match(/persistVoiceLearning\(/g)?.length || 0).toBeGreaterThanOrEqual(8);

    expect(taskSource).toContain('const persistTaskLearning');
    expect(taskSource).toContain('persistLumiPostTurnLearning');
    expect(taskSource).toContain('task confirmation');
    expect(taskSource).toContain('task direct cognition');
    expect(taskSource).toContain('task cancelled');
    expect(taskSource).toContain("logLabel: 'task'");
    expect(taskSource.match(/persistTaskLearning\(/g)?.length || 0).toBeGreaterThanOrEqual(4);
  });
});
