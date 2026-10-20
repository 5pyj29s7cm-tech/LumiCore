import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { hasExplicitNoMutationInstruction } from '../server/cognition/tool_intent';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { executeToolCall } from '../server/tools/execution_engine';
import type { ToolContext } from '../server/tools/types';

describe('current-turn no-mutation boundary', () => {
  const registry = new ToolRegistry();

  beforeAll(async () => {
    await initDatabase();
    registerFileOpsTools(registry);
  });

  it('recognizes explicit read-only wording', () => {
    expect(hasExplicitNoMutationInstruction('先聊一句，不要修改文件')).toBe(true);
    expect(hasExplicitNoMutationInstruction('读取这个文件，但不要修改它')).toBe(true);
    expect(hasExplicitNoMutationInstruction('不要重新修改文件')).toBe(true);
    expect(hasExplicitNoMutationInstruction('不是不要重新修改文件')).toBe(false);
    expect(hasExplicitNoMutationInstruction('把这个文件修改一下')).toBe(false);
  });

  it('keeps inspection available while forbidding file mutation', () => {
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'no-mutation-policy',
        text: '读取 D:\\work\\brief.txt 并告诉我唯一风险，但不要修改文件',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.execution.toolPolicy.forbiddenTools).toContain('write_file');
    expect(pipeline.execution.toolRoute?.toolNames || []).not.toContain('write_file');
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('read_file');
  });


  it.each(['chat', 'voice'] as const)('forbids reoperation but preserves a saved-file read for the original %s status question', async channel => {
    const text = '刚才报表实际改好了吗？新总额多少？只根据已经保存的结果回答，不要重新操作文件。';
    const original = '已保存报表：合计 120 元。';
    const filePath = path.join(process.env.LUMI_DATA_DIR!, `no-reoperation-${channel}.txt`);
    fs.writeFileSync(filePath, original, 'utf8');
    const writeHandler = vi.spyOn(registry.get('write_file')!, 'handler');
    const readHandler = vi.spyOn(registry.get('read_file')!, 'handler');
    try {
      const pipeline = buildLumiExecutionPipeline({
        dispatch: { userId: `no-reoperation-${channel}`, text, channel, source: channel,
          operationMode: 'assistant', targetIsLumi: true },
        registry,
      });
      const context: ToolContext = {
        userId: `no-reoperation-${channel}`, requestId: `no-reoperation-${channel}`,
        actionIntent: text, toolPolicy: pipeline.authorizationPolicy,
        currentTurnExecutionRequested: pipeline.executionRequested,
        acceptedActionContract: pipeline.turnIntent.flow.acceptedActionContract,
        localExecution: true, allowLocalFileWrites: true,
      };
      const write = await executeToolCall({ registry, name: 'write_file',
        arguments: { path: filePath, content: 'This mutation must not run.' }, context });
      const read = await executeToolCall({ registry, name: 'read_file',
        arguments: { path: filePath }, context });

      expect(hasExplicitNoMutationInstruction(text)).toBe(true);
      expect(pipeline.authorizationPolicy.forbiddenTools).toContain('write_file');
      expect(pipeline.modelToolProjection.toolNames).not.toContain('write_file');
      expect(pipeline.authorizationPolicy.allowedTools).toContain('read_file');
      expect(write.error).toMatch(/forbidden/i);
      expect(writeHandler).not.toHaveBeenCalled();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
      expect(read.error).toBeUndefined();
      expect(read.envelope?.status).toBe('verified_success');
      expect(read.result).toContain(original);
      expect(readHandler).toHaveBeenCalledOnce();
    } finally {
      writeHandler.mockRestore(); readHandler.mockRestore();
      fs.rmSync(filePath, { force: true });
    }
  });

  it('keeps a conversational no-edit question read-only without closing inspection', () => {
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'no-mutation-chat',
        text: '先聊一句：你认为这份方案当前最需要客户补充的唯一信息是什么？不要修改文件。',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('write_file');
    expect(pipeline.modelToolProjection.toolNames).not.toContain('write_file');
    expect(pipeline.authorizationPolicy.allowedTools).toContain('read_file');
    expect(pipeline.turnIntent.flow.completionEvidenceNeeded).toBe(false);
    expect(pipeline.turnIntent.flow.routeText).toBe('先聊一句：你认为这份方案当前最需要客户补充的唯一信息是什么？不要修改文件。');
    expect(pipeline.turnIntent.flow.promptOverlay).toContain('Current-turn read-only conversation boundary');
    expect(pipeline.turnIntent.flow.promptOverlay).toContain('Do not write, resume prior work, or mutate state');
  });
});
