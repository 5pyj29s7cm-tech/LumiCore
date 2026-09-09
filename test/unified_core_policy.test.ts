import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
import { getGateConfig, saveGateConfig, isAutonomousWorkAllowed, recordAutonomousTokens } from '../server/autonomy/safety_gate';
import { getStoredOperationMode, saveStoredOperationMode } from '../server/cognition/operation_mode_store';
import { readDB, writeDB, initDatabase } from '../db_layer';

const registry = new ToolRegistry();
beforeAll(async () => { await initDatabase(); registerAllTools(registry); });
const postures = ['chat', 'assistant', 'autonomous'] as const;
const policy = { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 };
function run(text: string, channel: 'chat' | 'voice', mode: string) {
  return buildLumiExecutionPipeline({ registry, personalityToolPolicy: policy,
    dispatch: { userId: 'single-core-test', text, channel, source: channel, operationMode: mode, targetIsLumi: true } });
}

describe('one Lumi core across legacy inputs', () => {
  it.each(['chat', 'voice'] as const)('keeps %s file execution and no-tool boundaries independent of persisted posture', channel => {
    const executions = postures.map(mode => run('读取 C:/Users/Administrator/Documents/orders.csv，计算每项金额和总额。', channel, mode));
    for (const pipeline of executions) {
      expect(pipeline.executionRequested).toBe(true);
      expect(pipeline.modelToolProjection.toolNames).toContain('read_file');
      expect(pipeline.turnIntent.flow.effectiveOperationMode).toBe('assistant');
      expect(pipeline.turnIntent.flow.autoPromoteToAssistant).toBe(false);
      expect(pipeline.authorizationPolicy).toEqual(executions[0].authorizationPolicy);
      expect(pipeline.modelToolProjection.toolNames).toEqual(executions[0].modelToolProjection.toolNames);
    }
    for (const mode of postures) {
      const answer = run('不要调用工具，也不要执行任务。陪我聊聊今天的心情。', channel, mode);
      expect(answer.executionRequested).toBe(false);
      expect(answer.turnIntent.flow.modelToolAccess).toBe('hard_off');
      const recall = run('你还记得项目标记吗？不要搜索聊天记录。', channel, mode);
      expect(recall.executionRequested).toBe(false);
      expect(recall.turnIntent.flow.modelToolAccess).toBe('hard_off');
    }
  });

  it('normalizes old stored choices without resetting permissions, budgets or memory', () => {
    const uid = 'old-posture-user';
    saveGateConfig({ autoProcessEnabled: false, maxTokensPerHour: 4567, messagingSendRequiresConfirmation: true }, uid);
    const before = getGateConfig(uid);
    const db = readDB();
    db.settings.push({ key: `op_mode_${uid}`, value: JSON.stringify({ mode: 'autonomous' }) });
    writeDB(db);
    expect(getStoredOperationMode(uid)).toBe('assistant');
    for (const mode of postures) {
      expect(saveStoredOperationMode(uid, mode)).toEqual({ mode: 'assistant' });
      expect(getGateConfig(uid)).toEqual(before);
      expect(isAutonomousWorkAllowed(uid).allowed).toBe(false);
    }
  });

  it('enforces resource and idle limits even with a legacy full preset', () => {
    const uid = 'full-budget-user';
    saveGateConfig({ autonomyLevel: 'full', maxTokensPerHour: 1000 }, uid);
    expect(isAutonomousWorkAllowed(uid).allowed).toBe(true);
    recordAutonomousTokens(uid, 1001);
    expect(isAutonomousWorkAllowed(uid)).toMatchObject({ allowed: false, reason: expect.stringContaining('Token budget') });
    saveGateConfig({ autonomyLevel: 'full', requireIdle: true }, 'idle-limit-user');
    expect(isAutonomousWorkAllowed('idle-limit-user').allowed).toBe(false);
  });

  it('can resume an explicitly enabled background policy without switching a legacy reactive posture', () => {
    const uid = 'resume-background-user';
    saveGateConfig({ autonomyLevel: 'reactive' }, uid);
    expect(isAutonomousWorkAllowed(uid).allowed).toBe(false);
    saveGateConfig({ autoProcessEnabled: true, requireIdle: false, allowedHours: [{ start: 0, end: 24 }] }, uid);
    expect(isAutonomousWorkAllowed(uid).allowed).toBe(true);
    expect(getStoredOperationMode(uid)).toBe('assistant');
  });
});
