import './helpers';
import { describe, expect, it } from 'vitest';
import { normalizeVoiceHistoryRecord } from '../server/socket/voice_history';
import { prepareLocalModelRequest } from '../server/llm/local_context_budget';
import { compactRecordForPrompt } from '../server/conversation/manager';
import { normalizeChatHistoryRecord } from '../server/socket/chat';
import { buildHistoricalFileObservations } from '../server/conversation/file_observation_history';

describe('verified file data survives into the next conversation turn', () => {
  const call = { name: 'read_docx', arguments: { filePath: 'D:/fixtures/meeting.docx' }, result: '会议：2026年9月23日15:00，6人，预算1200元。议题：交付时间、数据归属。会议结论留空。', receipt: { kind: 'text_readback_metadata', encoding: 'UTF-8', lineCount: 1, byteLength: 64, contentDigest: 'metadata-does-not-contain-the-document' }, terminalVerification: { status: 'verified' } };
  it('keeps actual file facts alongside original assistant dialogue, including under a local prompt budget', () => {
    const compacted = compactRecordForPrompt({ role: 'assistant', message: '错误总结：99人，预算99999元。', toolCalls: JSON.stringify([call]) } as any);
    const history = normalizeChatHistoryRecord(compacted, { serverOwned: true });
    const prepared = prepareLocalModelRequest({ contextTokens: 32768, toolDeclarations: [], messages: [
      { role: 'system', content: 'General runtime policy. '.repeat(5000) },
      { role: 'user', content: '请读取附件。' }, ...history,
      { role: 'user', content: '沿用刚才的会议材料，预算不变，每人平均多少？' },
    ] });
    const text = JSON.stringify(prepared.messages);
    expect(text).toContain('6人'); expect(text).toContain('1200元'); expect(text).toContain('untrusted document data');
    expect(text).toContain('错误总结：99人，预算99999元。');
    expect(JSON.stringify(normalizeChatHistoryRecord(compacted))).not.toContain('1200元');
  });
  it('retains structured result text and verified envelope readback beside receipt metadata', () => {
    const content = call.result;
    const wrapped = { ...call, result: JSON.stringify({ ok: true, text: content }) };
    const compacted = compactRecordForPrompt({ role: 'assistant', message: '错误总结：99人。', toolCalls: JSON.stringify([wrapped]) } as any);
    expect(JSON.stringify(normalizeChatHistoryRecord(compacted, { serverOwned: true }))).toContain(content);
    const restored = { ...call, result: JSON.stringify({ resultOmitted: true }), envelope: { status: 'verified_success', verification: { status: 'verified' }, result: content } };
    expect(buildHistoricalFileObservations([restored])).toContain(content);
    expect(buildHistoricalFileObservations([{ ...restored, envelope: { ...restored.envelope, status: 'failed' } }])).toBe('');
  });
  it('does not turn readback metadata or requested text into observed document content', () => {
    const metadataOnly = { ...call, result: JSON.stringify(call.receipt), arguments: { filePath: 'D:/fixtures/meeting.docx', text: 'UNOBSERVED_REQUEST_INSTRUCTION' } };
    expect(buildHistoricalFileObservations([metadataOnly])).toBe('');
    expect(buildHistoricalFileObservations([{ ...call, result: '', receipt: call.receipt }])).toBe('');
  });
  it.each([
    { ok: false }, { success: false }, { failed: true }, { status: 'failed' }, { verified: false },
  ])('excludes semantically failed document results even with a verified terminal receipt: %j', failure => {
    expect(buildHistoricalFileObservations([{ ...call, result: JSON.stringify({ ...failure, text: call.result }) }])).toBe('');
  });
  it('excludes failed or unverified reads, write arguments and bounded overflow', () => {
    const message = (calls: any[]) => JSON.stringify(normalizeVoiceHistoryRecord({ role: 'assistant', message: '', toolCalls: calls }));
    expect(message([{ ...call, terminalVerification: { status: 'unverified' } }])).not.toContain('1200元');
    expect(message([{ ...call, error: 'failed' }])).not.toContain('1200元');
    expect(message([{ ...call, name: 'create_docx' }])).not.toContain('1200元');
    const bounded = message([{ ...call, result: 'x'.repeat(50000) + 'OUTSIDE_OBSERVATION_BUDGET' }]);
    expect(bounded.length).toBeLessThan(5000); expect(bounded).not.toContain('OUTSIDE_OBSERVATION_BUDGET');
  });
});
