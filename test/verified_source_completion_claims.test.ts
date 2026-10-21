import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import sample from './fixtures/nda_existing_public_delivery_20261021.json';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { artifactReadbackText } from '../server/tools/artifact_evidence';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolExecutionRecord } from '../server/tools/types';
const scope = { taskId: 'exact-source-task', requestId: 'exact-source-request' };
const body = sample.body;
let task: string, record: ToolExecutionRecord, other: ToolExecutionRecord, failed: ToolExecutionRecord;
const clone = (): ToolExecutionRecord => JSON.parse(JSON.stringify(record));
function project(response: string, rows: ToolExecutionRecord[] = [record], current: { taskId?: string; requestId?: string } = scope) {
  const guard = guardCompletionClaims({ task, response, toolCalls: rows, source: 'chat', ...current });
  const final = finalizeLumiResponse({ taskText: task, responseText: guard.text, completionGuard: guard, toolRecords: rows, source: 'chat', ...current });
  return { guard, final };
}
beforeAll(async () => {
  expect(body.length).toBe(sample.bodyCharacters);
  expect(createHash('sha256').update(body).digest('hex')).toBe(sample.bodySha256);
  const dir = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'exact-source-'));
  const source = path.join(dir, 'existing-complete-nda.md'), otherSource = path.join(dir, 'other.md'), missing = path.join(dir, 'missing.md');
  fs.writeFileSync(source, body); fs.writeFileSync(otherSource, body);
  task = sample.originalPrompt.replace(sample.originalSourcePath, source);
  const registry = new ToolRegistry(); registerFileOpsTools(registry);
  const read = (file: string, id: string) => executeToolCall({ registry, id, name: 'read_file', arguments: { path: file },
    context: { ...scope, turnId: scope.requestId, userId: 'exact-source-user', source: 'chat', domain: 'personal', authenticated: true, authRole: 'admin', localExecution: true,
      executionBoundary: 'trusted_local', actionIntent: task.replace(source, file), routedTaskText: task.replace(source, file) } });
  record = await read(source, 'exact-source-read'); other = await read(otherSource, 'other-source-read'); failed = await read(missing, 'failed-source-read');
  expect(isCanonicalToolExecutionRecord(record)).toBe(true); expect(isCanonicalToolExecutionRecord(other)).toBe(true); expect(isCanonicalToolExecutionRecord(failed)).toBe(true);
  expect(record.envelope?.status).toBe('verified_success'); expect(record.result).toBe(body);
  expect(failed.envelope?.status).toBe('failed');
});
describe('complete verified source ranges are data, assistant claims still require evidence', () => {
  it('keeps the actual full NDA source bytes after a real canonical file read', () => {
    const r = project(body); expect(r.guard).toMatchObject({ blocked: false, text: body }); expect(r.final).toMatchObject({ blocked: false, text: body });
  });
  it('does not exempt isolated source excerpts', () => {
    const excerpt = body.split('\n').filter((_, index) => [13, 129].includes(index)).join('\n'); expect(project(excerpt).guard.blocked).toBe(true);
  });
  it('does not exempt matching source head and tail', () => { expect(project(body.slice(0, 180) + '\n' + body.slice(-180) + '\n我已经保存文件。').guard.blocked).toBe(true); });
  it('rejects forged verified-looking receipt data without canonical execution', () => { expect(project(body, [clone()]).guard.blocked).toBe(true); });
  it.each(['requestId', 'taskId'] as const)('does not exempt a foreign %s source', key => { expect(project(body, [record], { ...scope, [key]: 'foreign' }).guard.blocked).toBe(true); });
  it('rejects content changed after canonical execution', () => { const modified = clone(); modified.result += '伪造尾句'; expect(project(body, [modified]).guard.blocked).toBe(true); });
  it('rejects a shortened readback with the original full-content digest', () => {
    const modified = clone(); modified.result = body.slice(0, 180); if (modified.envelope) modified.envelope.result = modified.result;
    modified.receipt = { kind: 'text_readback_metadata', contentDigest: sample.bodySha256, encoding: 'UTF-8' };
    expect(artifactReadbackText(modified)).toBeUndefined(); expect(project(body, [modified]).guard.blocked).toBe(true);
  });
  it('still rejects a save claim outside the complete source range', () => { const r = project(body + '\n我已经保存文件。'); expect(r.guard.blocked).toBe(true); expect(r.final.blocked).toBe(true); });
  it('still rejects a send claim outside the complete source range', () => { const r = project(body + '\n我已经发送该协议给对方。'); expect(r.guard.blocked).toBe(true); expect(r.final.blocked).toBe(true); });
  it('does not exempt without both current request and task identity', () => { expect(project(body, [record], {}).guard.blocked).toBe(true); });
  it('rejects a real canonical failed file read', () => { expect(project(body, [failed]).guard.blocked).toBe(true); });
  it('rejects a real canonical read of another exact source', () => { expect(project(body, [other]).guard.blocked).toBe(true); });
  it('preserves a source-external denial without inventing a send', () => { const r = project(body + '\n我没有发送文件。'); expect(r.guard.blocked).toBe(false); expect(r.final.blocked).toBe(false); });
});
