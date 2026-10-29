import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { actionInstructionClauses, affirmativeActionInstructionClauses } from '../server/cognition/action_instruction_clauses';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { buildActionEvidenceContract } from '../server/cognition/action_contract';
import { requestedArtifactInstructions } from '../server/cognition/artifact_progress';
import { hasUnscopedArtifactWriteProhibition, preservedSourceWriteBlockReason, requestedArtifactFormatBlockReason, requestedSingleArtifact } from '../server/cognition/artifact_write_scope';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { foregroundPipeline } from './foreground_pipeline_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { executeToolCall } from '../server/tools/execution_engine';

describe('coordinated quoted source and artifact instructions', () => {
  const request = (source: string, output: string) => `请读取“${source}”并创建“${output}”，在新文件中保留来源的全部文字，末尾追加一行两仓合计袋数。然后完整回读新文件，将全部正文直接发到本聊天。不要修改原文件。`;

  it.each([
    ['D:/fixtures/source.txt', 'D:/fixtures/output.txt'],
    ['D:\\fixtures\\source.txt', 'D:\\fixtures\\output.txt'],
    ['/tmp/source notes.txt', '/tmp/output notes.txt'],
  ])('retains both operations and binds only the output for %s', (source, output) => {
    const text = request(source, output);
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', target: output });
    expect(requestedSingleArtifact(text)).toMatchObject({ path: output, producer: 'write_file', reader: 'read_file' });
    expect(requestedArtifactInstructions(text).map(item => item.path)).toEqual([output]);
    const contract = buildActionEvidenceContract(text);
    expect(contract.components).toHaveLength(2);
    expect(contract.components?.find(item => item.text.includes(source))?.contract.label).toBe('Exact read-only file inspection');
    const outputComponent = contract.components?.find(item => item.text.includes(output));
    expect(outputComponent).toBeDefined();
    expect(outputComponent?.text).not.toContain(source);
    expect(requestedArtifactFormatBlockReason(text, 'write_file', { path: source })).toBeTruthy();
    expect(requestedArtifactFormatBlockReason(text, 'write_file', { path: output })).toBeNull();
  });

  it('projects English coordination through the same quoted-path boundary', () => {
    const text = 'Please read "D:/fixtures/source.txt" and create "D:/fixtures/output.txt".';
    expect(affirmativeActionInstructionClauses(text).map(item => item.probe.trim()).filter(Boolean)).toEqual([
      'Please read "D:/fixtures/source.txt"', 'create "D:/fixtures/output.txt".',
    ]);
    expect(requestedArtifactInstructions(text).map(item => item.path)).toEqual(['D:/fixtures/output.txt']);
    expect(buildActionEvidenceContract(text).components).toHaveLength(2);
  });

  it.each([
    '不要读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”。',
    '请勿读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”。',
    '如果读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”，会怎样？',
    '例如读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”。',
    '原文写着「读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”」，只解释。',
    'Do not read "D:/fixtures/source.txt" and create "D:/fixtures/output.txt".',
    'If you read "D:/fixtures/source.txt" and create "D:/fixtures/output.txt", what happens?',
  ])('does not turn a prohibition, hypothesis or quotation into output authority: %s', text => {
    expect(requestedArtifactInstructions(text)).toEqual([]);
    expect(requestedSingleArtifact(text)).toBeNull();
    expect(normalizeActionIntent(text).operation).not.toBe('create');
  });

  it('retains an affirmative read when only the following creation is prohibited', () => {
    const text = '请读取“D:/fixtures/source.txt”并不要创建“D:/fixtures/output.txt”。';
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'read', target: 'D:/fixtures/source.txt' });
    expect(requestedArtifactInstructions(text)).toEqual([]);
  });

  it('does not split creation words inside a quoted filename or literal content', () => {
    const text = '读取“D:/fixtures/并创建 output.txt”。';
    expect(actionInstructionClauses(text).filter(item => item.probe.trim())).toHaveLength(1);
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'read', target: 'D:/fixtures/并创建 output.txt' });
    expect(requestedArtifactInstructions(text)).toEqual([]);
    expect(requestedArtifactInstructions('创建“D:/fixtures/quote.txt”，内容为「读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”」。').map(item => item.path)).toEqual(['D:/fixtures/quote.txt']);
  });

  it('keeps the exact source protected when creation names the same file', () => {
    const text = '读取“D:/fixtures/source.txt”并创建“D:/fixtures/source.txt”，不要修改原文件。';
    expect(preservedSourceWriteBlockReason({ text, toolName: 'write_file', arguments: { path: 'D:/fixtures/source.txt' } })).toContain('original file');
  });

  it.each([
    '读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”，但不要写入任何文件。',
    '读取“D:/fixtures/source.txt”；创建“D:/fixtures/output.txt”，但不要写入任何文件。',
    '读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”，禁止写入任何文件。',
    '读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”，别写入任何文件。',
    '读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”，不得写入任何文件。',
    'Read "D:/fixtures/source.txt" and create "D:/fixtures/output.txt", but do not write to any files.',
    'Read "D:/fixtures/source.txt" and create "D:/fixtures/output.txt", but never write to any files.',
  ])('keeps an unscoped write prohibition above the explicit creation exception: %s', text => {
    const pipeline = foregroundPipeline(text, 'chat');
    expect(hasUnscopedArtifactWriteProhibition(text)).toBe(true);
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('write_file');
    expect(pipeline.modelToolProjection.toolNames).not.toContain('write_file');
  });

  it('allows the separate output while a source-only restriction remains enforced', () => {
    const text = '读取“D:/fixtures/source.txt”并创建“D:/fixtures/output.txt”，不要修改原文件。';
    expect(foregroundPipeline(text, 'chat').modelToolProjection.toolNames).toContain('write_file');
    expect(preservedSourceWriteBlockReason({ text, toolName: 'write_file', arguments: { path: 'D:/fixtures/source.txt' } })).toContain('original file');
    expect(preservedSourceWriteBlockReason({ text, toolName: 'write_file', arguments: { path: 'D:/fixtures/output.txt' } })).toBeNull();
    expect(hasUnscopedArtifactWriteProhibition('创建“D:/fixtures/output.txt”，内容为“不要写入任何文件”。')).toBe(false);
  });

  it('preserves every named source and allows every separately named output', () => {
    const text = '读取“D:/fixtures/source.txt”；读取“D:/fixtures/source-two.txt”；创建“D:/fixtures/output.txt”；创建“D:/fixtures/second.txt”；不要修改原文件。';
    for (const file of ['source.txt', 'source-two.txt']) {
      expect(preservedSourceWriteBlockReason({ text, toolName: 'write_file', arguments: { path: `D:/fixtures/${file}` } })).toContain('original file');
    }
    for (const file of ['output.txt', 'second.txt']) {
      expect(preservedSourceWriteBlockReason({ text, toolName: 'write_file', arguments: { path: `D:/fixtures/${file}` } })).toBeNull();
    }
    expect(preservedSourceWriteBlockReason({ text, toolName: 'write_file', arguments: { path: 'D:/fixtures/unrelated.txt' } })).toContain('output path');
    const overlap = text.replace('创建“D:/fixtures/second.txt”', '创建“D:/fixtures/source-two.txt”');
    expect(preservedSourceWriteBlockReason({ text: overlap, toolName: 'write_file', arguments: { path: 'D:/fixtures/source-two.txt' } })).toContain('original file');
  });

  const turn = { requestId: 'coordinated-artifact-request', taskId: 'coordinated-artifact-task' };
  const sourceBody = '甲仓有17袋。\n乙仓有26袋。';
  const outputBody = `${sourceBody}\n两仓合计袋数：43袋。`;
  let source: string, output: string;
  const read = (filePath: string, content: string) => ({ ...turn, name: 'read_file', arguments: { path: filePath }, result: content,
    terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Synthetic isolated readback' } });
  beforeAll(() => {
    const root = path.join(process.env.LUMI_DATA_DIR!, 'coordinated-artifact-fixture');
    fs.mkdirSync(root, { recursive: true });
    source = path.join(root, 'source.txt'); output = path.join(root, 'output.txt');
    fs.writeFileSync(source, sourceBody); fs.writeFileSync(output, outputBody);
  });
  const records = () => [read(source, sourceBody), {
    ...turn, name: 'write_file', arguments: { path: output, content: outputBody }, result: JSON.stringify({ ok: true, path: output }),
    terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'Synthetic isolated output exists' },
  }, read(output, outputBody)];

  it('rejects both conflicting writes before a file handler is invoked', async () => {
    const registry = new ToolRegistry(); registerFileOpsTools(registry);
    const handler = vi.spyOn(registry.get('write_file')!, 'handler').mockResolvedValue('Unexpected handler call');
    try {
      for (const conflict of ['same-source', 'global-ban']) {
        const target = conflict === 'same-source' ? source : output;
        const text = `读取“${source}”并创建“${target}”，${conflict === 'same-source' ? '不要修改原文件' : '不要写入任何文件'}。`;
        const pipeline = foregroundPipeline(text, 'chat');
        const result = await executeToolCall({ registry, name: 'write_file', arguments: { path: target, content: 'Must not write.' }, context: {
          userId: 'coordinated-scope-fixture', taskId: `scope-${conflict}`, requestId: `scope-${conflict}`, authenticated: true,
          authRole: 'admin', localExecution: true, userConfirmed: true, allowLocalFileWrites: true, actionIntent: text,
          toolPolicy: pipeline.authorizationPolicy,
        } });
        expect(result.error).toMatch(conflict === 'same-source' ? /original file/i : /forbidden/i);
      }
      expect(handler).not.toHaveBeenCalled();
      expect(fs.readFileSync(source, 'utf8')).toBe(sourceBody);
      expect(fs.readFileSync(output, 'utf8')).toBe(outputBody);
    } finally { handler.mockRestore(); }
  });

  it('preserves full artifact readback without calling an unverified calculation complete', () => {
    const text = request(source, output);
    expect(buildActionEvidenceContract(text).components).toHaveLength(2);
    const result = finalizeLumiResponse({ ...turn, taskText: text, responseText: '', toolRecords: records(), source: 'chat' });
    expect(result.blocked, JSON.stringify(result)).toBe(true);
    expect(result.text).toContain(sourceBody);
    expect(result.text).toContain(outputBody);
    expect(fs.readFileSync(source, 'utf8')).toBe(sourceBody);
  });

  it.each(['only-source', 'missing-source', 'missing-output-readback', 'stale-output-readback'])(
    'keeps the whole request incomplete for %s', missing => {
      const complete = records();
      const toolRecords = missing === 'only-source' ? complete.slice(0, 1)
        : missing === 'missing-source' ? complete.slice(1)
          : missing === 'missing-output-readback' ? complete.slice(0, 2)
            : [...complete.slice(0, 2), { ...complete[2], requestId: 'older-request' }];
      expect(finalizeLumiResponse({ ...turn, taskText: request(source, output), responseText: '全部完成。', toolRecords, source: 'chat' }).blocked).toBe(true);
    },
  );
});
