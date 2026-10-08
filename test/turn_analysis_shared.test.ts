import './helpers';
import { beforeAll, expect, it, vi } from 'vitest';
vi.mock('../server/cognition/action_contract', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/cognition/action_contract')>();
  return { ...actual, buildActionContract: vi.fn(actual.buildActionContract) };
});
import { buildActionContract } from '../server/cognition/action_contract';
import { TurnAnalysis } from '../server/cognition/turn_analysis';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
beforeAll(async () => { const { initDatabase } = await import('../db_layer'); await initDatabase(); });

it('builds one shared contract through planning and cannot reuse a prior turn to override a current veto', () => {
  const registry = new ToolRegistry(); registerAllTools(registry);
  const text = '打开电脑上的 WPS';
  vi.mocked(buildActionContract).mockClear();
  const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'shared-analysis', channel: 'chat', text, operationMode: 'assistant' }, registry });
  expect(pipeline.executionRequested).toBe(true);
  expect(pipeline.modelToolProjection.toolNames).toContain('desktop_open');
  expect(vi.mocked(buildActionContract).mock.calls.filter(([input]) => input === text)).toHaveLength(1);
  const denied = buildLumiExecutionPipeline({ dispatch: { userId: 'shared-analysis', channel: 'chat', text: '不要调用工具，只解释 WPS 是什么。', operationMode: 'assistant' }, registry });
  expect(denied.executionRequested).toBe(false);
  expect(denied.modelToolProjection.toolNames).toEqual([]);
});

it('prevents downstream contract mutations from changing later planning decisions', () => {
  const analysis = new TurnAnalysis();
  const contract = analysis.contract('打开电脑上的 WPS');
  const expected = [...contract.verificationTools];
  expect(() => contract.verificationTools.push('execute_shell')).toThrow();
  expect(analysis.contract('打开电脑上的 WPS').verificationTools).toEqual(expected);
  expect(analysis.contract('不要调用工具，只解释 WPS 是什么。').applies).toBe(false);
});

it.each(['chat', 'ai-creation', 'voice'] as const)('carries the frozen accepted media contract into %s finalization', source => {
  const registry = new ToolRegistry(); registerAllTools(registry);
  const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'accepted-media-contract', channel: source === 'voice' ? 'voice' : 'chat', source,
    text: '生成30秒可播放的视频，画面里打开礼盒。', operationMode: 'assistant' }, registry,
    ...(source === 'ai-creation' ? { structuredMediaRequest: { operation: 'text_to_video' as const, prompt: 'Open the product box. English voiceover and background music.', duration: 30, size: '1920x1080' } } : {}) });
  const accepted = pipeline.turnIntent.flow.acceptedActionContract!;
  expect(accepted.taskText).toBe(pipeline.turnIntent.flow.routeText);
  expect(accepted.contract).toMatchObject({ kind: 'media_generation', mediaGeneration: { duration: 30, standalone: true } });
  expect(accepted.contract.mediaPlayback).toBeUndefined();
  expect(accepted.contract.mediaGeneration!.audioRequired).toBe(source === 'ai-creation');
  expect(() => accepted.contract.mediaGeneration!.duration = 5).toThrow();
  expect(() => accepted.contract.preferredTools.push('desktop_open')).toThrow();
});
