import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { hasExplicitNoMutationInstruction } from '../server/cognition/tool_intent';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';

describe('current-turn no-mutation boundary', () => {
  const registry = new ToolRegistry();

  beforeAll(async () => {
    await initDatabase();
    registerFileOpsTools(registry);
  });

  it('recognizes explicit read-only wording', () => {
    expect(hasExplicitNoMutationInstruction('先聊一句，不要修改文件')).toBe(true);
    expect(hasExplicitNoMutationInstruction('读取这个文件，但不要修改它')).toBe(true);
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

  it('keeps a conversational question with no-edit wording tool-free', () => {
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

    expect(pipeline.turnIntent.flow.allowToolUseForTurn).toBe(false);
    expect(pipeline.execution.allowToolUse).toBe(false);
    expect(pipeline.turnIntent.flow.completionEvidenceNeeded).toBe(false);
    expect(pipeline.turnIntent.flow.routeText).toBe('先聊一句：你认为这份方案当前最需要客户补充的唯一信息是什么？不要修改文件。');
    expect(pipeline.turnIntent.flow.promptOverlay).toContain('Current-turn read-only conversation boundary');
    expect(pipeline.turnIntent.flow.promptOverlay).toContain('Answer the question now');
  });
});
