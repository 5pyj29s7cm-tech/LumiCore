import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { formatGroundedArtifactResult, formatGroundedCadRunResult, formatRequestedDocumentObservation } from '../server/cognition/result_artifact_presenter';
import { buildActionContract } from '../server/cognition/action_contract';
import type { LumiResultFinalizerInput } from '../server/cognition/result_finalizer_types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function artifact(name: string, body: string, native = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-delivery-detail-')); roots.push(root);
  const target = path.join(root, name); fs.writeFileSync(target, body, 'utf8');
  const scope = { requestId: 'delivery-request', taskId: 'delivery-task', source: 'chat' };
  const writer = { name: native ? 'desktop_write_text_file' : 'write_file', arguments: { path: target, content: body },
    result: JSON.stringify({ ok: true, status: 'verified', path: target, ...(native ? { readBackMatched: true } : {}) }),
    ...scope, terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'synthetic saved file' } };
  const reader = { name: 'read_file', arguments: { path: target }, result: body, ...scope,
    terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'synthetic same-path read' } };
  return { target, body, writer, reader, scope };
}

describe('requested artifact delivery details', () => {
  it.each(['报告', '核验'])('delivers encoding, line count and full text after a Chinese create/readback request using %s', verb => {
    const f = artifact('report.md', '# Synthetic report\n\nThird line\n');
    const input = { taskText: `在 ${f.target} 创建报告，写入后重新读取，最后${verb}编码、总行数和全文。`,
      responseText: '已完成。', toolRecords: [f.writer, f.reader], ...f.scope };
    const result = finalizeLumiResponse(input);
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('编码：UTF-8'); expect(result.text).toContain('总行数：3');
    expect(result.text).toContain(f.target); expect(result.text).toContain(f.body.trimEnd());
  });

  it('returns the actual native saved path and requested readback body instead of only model acknowledgement', () => {
    const f = artifact('native-note.txt', 'native semantic write', true);
    const input = { taskText: `After creating the file, read it back and report the exact content. Target: ${f.target}`,
      responseText: 'The file and readback are complete.', toolRecords: [f.writer, f.reader], ...f.scope };
    const result = finalizeLumiResponse(input);
    expect(buildActionContract(input.taskText).kind).toBe('none');
    expect(result.blocked).toBe(false); expect(result.text).toContain(f.target); expect(result.text).toContain(f.body);
    expect(result.text).not.toMatch(/created|Encoding:/i);
  });

  it('reports a read-only exact body without inventing creation or encoding metadata', () => {
    const f = artifact('read-only.txt', 'Verified read body');
    const result = finalizeLumiResponse({ taskText: `Read ${f.target} and report the exact content.`, responseText: 'Read complete.',
      toolRecords: [f.reader], ...f.scope });
    expect(result.blocked).toBe(false); expect(result.text).toContain(f.target); expect(result.text).toContain(f.body);
    expect(result.text).not.toMatch(/Encoding:|Line count:|created|saved/i);
  });

  it.each(['Do not report the exact content.', 'The label is "report the exact content".'])('does not promote a prohibited or quoted display request: %s', suffix => {
    const f = artifact('private.txt', 'private fixture body');
    const observation = { text: 'Read complete.', blocked: false };
    expect(formatRequestedDocumentObservation({ taskText: `Read ${f.target}. ${suffix}`, responseText: observation.text,
      toolRecords: [f.reader], ...f.scope }, observation)).toBe(observation);
  });

  it('does not append the body for a metadata-only request with an explicit body prohibition', () => {
    const f = artifact('metadata-only.txt', 'Private fixture body');
    const observation = { text: 'No verified encoding metadata is available.', blocked: false };
    expect(formatRequestedDocumentObservation({ taskText: `Read ${f.target}; report encoding; do not report the full text.`,
      responseText: '', toolRecords: [f.reader], ...f.scope }, observation)).toBe(observation);
  });

  it('reports checked artifact metadata while respecting an explicit prohibition on showing the body', () => {
    const f = artifact('metadata-only.txt', 'Private fixture body');
    const taskText = `Create ${f.target}; after writing read it back and report encoding and full text; do not report the full text.`;
    const result = formatGroundedArtifactResult({ taskText, responseText: '', toolRecords: [f.writer, f.reader], ...f.scope });
    expect(result?.blocked).toBe(false); expect(result?.text).toContain('Encoding: UTF-8');
    expect(result?.text).not.toContain(f.body);
  });

  it('preserves an analysis blocker instead of promoting a source body to a completed answer', () => {
    const f = artifact('input.txt', 'Source only');
    const observation = { text: 'Analysis is not verified.', blocked: true, reason: 'analysis_missing' };
    expect(formatRequestedDocumentObservation({ taskText: `Read ${f.target} and report the full text and analysis.`, responseText: '',
      toolRecords: [f.reader], ...f.scope }, observation)).toBe(observation);
  });

  it('retains an already guarded analysis when enriching it with the requested exact source', () => {
    const f = artifact('analysis-source.txt', 'Source only');
    const observation = { text: 'The independently checked analysis is retained.', blocked: false, reason: 'verified' };
    const result = formatRequestedDocumentObservation({ taskText: `Read ${f.target} and report the full text and analysis.`, responseText: '',
      toolRecords: [f.reader], ...f.scope }, observation);
    expect(result.text).toContain(observation.text); expect(result.text).toContain(f.body);
    expect(result.blocked).toBe(false); expect(result.reason).toBe(observation.reason);
  });

  it.each(['stale', 'wrong-target', 'failed'] as const)('does not display unsupported source content: %s', mode => {
    const f = artifact('input.txt', 'Source only');
    const reader = { ...f.reader, ...(mode === 'stale' ? { requestId: 'old' } : {}),
      ...(mode === 'wrong-target' ? { arguments: { path: f.target + '.other.txt' } } : {}),
      ...(mode === 'failed' ? { terminalVerification: { ...f.reader.terminalVerification, status: 'failed' as const } } : {}) };
    const observation = { text: 'Unchanged.', blocked: false };
    expect(formatRequestedDocumentObservation({ taskText: `Read ${f.target} and report the full text.`, responseText: '',
      toolRecords: [reader], ...f.scope }, observation)).toBe(observation);
  });

  it('does not present requested file metadata without a successful post-write readback', () => {
    const f = artifact('missing.txt', 'Synthetic body');
    const result = formatGroundedArtifactResult({ taskText: `Create ${f.target}; after writing read it back and report encoding, line count and full text.`,
      responseText: '', toolRecords: [f.writer], ...f.scope });
    expect(result?.blocked).toBe(true); expect(result?.text).not.toContain('Encoding: UTF-8');
  });

  it('does not use an earlier read as post-write metadata evidence', () => {
    const f = artifact('before-write.txt', 'Synthetic body');
    const result = formatGroundedArtifactResult({ taskText: `Create ${f.target}; after writing read it back and report encoding, line count and full text.`,
      responseText: '', toolRecords: [f.reader, f.writer], ...f.scope });
    expect(result?.blocked).toBe(true); expect(result?.text).not.toContain('Encoding: UTF-8');
  });

  it('does not claim UTF-8 from a lossy decode of invalid bytes', () => {
    const f = artifact('invalid.txt', 'unused');
    fs.writeFileSync(f.target, Buffer.from([0xc3, 0x28]));
    const body = fs.readFileSync(f.target, 'utf8');
    const result = formatGroundedArtifactResult({ taskText: `Create ${f.target}; after writing read it back and report encoding, line count and full text.`,
      responseText: '', toolRecords: [f.writer, { ...f.reader, result: body }], ...f.scope });
    expect(result).toBeNull();
  });

  it('does not inherit a negated root metadata request into an artifact leaf', () => {
    const f = artifact('plain.txt', 'Synthetic body');
    const result = formatGroundedArtifactResult({ taskText: `Create ${f.target}.`, responseText: '',
      flow: { rootTaskText: `Create ${f.target}. Read it back. Do not report encoding or full text.` } as NonNullable<LumiResultFinalizerInput['flow']>,
      toolRecords: [f.writer, f.reader], ...f.scope });
    expect(result?.blocked).toBe(false); expect(result?.text).not.toContain('Encoding: UTF-8');
  });

  it('blocks inherited metadata when a readback disagrees with the current file', () => {
    const f = artifact('changed.txt', 'Original body');
    fs.writeFileSync(f.target, 'Changed after reading', 'utf8');
    const result = formatGroundedArtifactResult({ taskText: `Create ${f.target}.`, responseText: '',
      flow: { rootTaskText: `Create ${f.target}; after writing read it back and report encoding, line count and full text.` } as NonNullable<LumiResultFinalizerInput['flow']>,
      toolRecords: [f.writer, f.reader], ...f.scope });
    expect(result?.blocked).toBe(true); expect(result?.text).not.toContain('Encoding: UTF-8');
  });
});

describe('CAD presentation respects host verification', () => {
  function input(): LumiResultFinalizerInput {
    return { taskText: 'Draw the supplied geometry in AutoCAD with visible stroke-by-stroke playback.', responseText: '', source: 'chat',
      requestId: 'cad-request', taskId: 'cad-task', toolRecords: [{ name: 'mcp_cad-drafting_autocad_playback_file', arguments: {},
        requestId: 'cad-request', taskId: 'cad-task', result: JSON.stringify({ status: 'completed', transport: 'mcp_autocad_com',
          visiblePlayback: true, completionMarkerExists: true, geometryVerified: true, entityCountMatches: true,
          operationCount: 3, expectedEntityCount: 3, entitiesAdded: 3, operationSetId: 'synthetic-ops' }),
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic host fixture; no CAD executed' } }] };
  }
  it('still presents a verified current CAD receipt', () => {
    expect(formatGroundedCadRunResult(input())?.blocked).toBe(false);
  });
  it('retains the concrete blocker from a failed composite CAD workflow', () => {
    const value = input(); value.toolRecords![0].result = JSON.stringify({ status: 'blocked', completed: false,
      blocker: 'Entity-count verification failed after operation 33.' });
    value.toolRecords![0].terminalVerification!.status = 'failed';
    const result = formatGroundedCadRunResult(value);
    expect(result?.blocked).toBe(true); expect(result?.text).toContain('operation 33');
  });
  it.each(['failed', 'unverified'] as const)('does not override terminal verification %s with payload flags', status => {
    const value = input(); value.toolRecords![0].terminalVerification!.status = status;
    expect(formatGroundedCadRunResult(value)).toBeNull();
  });
  it.each(['unknown_outcome', 'failed', 'timeout'] as const)('does not override envelope %s with payload flags', status => {
    const value = input(); value.toolRecords![0].envelope = { version: 1, status, toolName: value.toolRecords![0].name,
      requestId: 'cad-request', taskId: 'cad-task', turnId: 'turn', idempotencyKey: 'key', targetIdentity: 'cad', completedAt: new Date(0).toISOString(),
      verification: { status: 'unverified', reason: 'Synthetic unresolved adapter outcome' } };
    expect(formatGroundedCadRunResult(value)).toBeNull();
  });
});
