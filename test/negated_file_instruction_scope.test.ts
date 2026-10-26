import './helpers';
import { describe, expect, it } from 'vitest';
import { requestsExactReadOnlyArtifactInspection, documentReadMatchesRequestedTarget } from '../server/cognition/action_desktop_evidence';
import { buildActionEvidenceContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { normalizeActionIntent, hasNegatedMessagingSendIntent } from '../server/cognition/normalized_action_intent';
import { needsCompletionEvidence, guardCompletionClaims } from '../server/work_product/completion_guard';

// The request is inline analysis; a forbidden or quoted file operand is not a read target.
const inlineTasks = [
  '请列出三种常见云的名称。直接在聊天回答，不生成文件。',
  '请分析以下文本：春雨使幼苗发芽。直接回答，不生成文件。',
  '请分析并列出理由；不要读取“secret.docx”，不生成文件。',
  '请列出两个观点。文件格式另说，不生成文件。',
  '不生成文件；请计算十二加十九，并列出计算步骤。',
  '请分析两段论证的差别，列出理由，不创建文档。',
  '请判断一笔买卖的责任主体，列出适用条文。直接在聊天回答，不生成文件。',
  '不要读取附件。请列出等腰三角形的性质。',
  '请说明侵权责任的构成，列出具体条文；不要读取或生成任何文件。',
  '请总结光合作用的过程。文中提到“读取文件并分析内容”，只解释这句话。',
  '请列出两种排序算法。假如读取文件，需要先检查权限。',
  'List three causes of tides. Do not generate a file.',
  'Do not read any files; calculate 14 + 8 and list the steps.',
  'Explain the difference between tort and contract liability, list relevant principles; do not create documents.',
  'List the numbers in ascending order. The quotation says "Read the file and summarize its contents".',
  'Explain this sentence. For example, inspect a file and list the contents.',
];

describe('file evidence follows affirmative instruction scope', () => {
  it.each(inlineTasks)('does not join an analysis predicate with a non-instruction file topic: %s', task => {
    expect(normalizeActionIntent(task).sideEffectClass).toBe('none');
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
    expect(buildActionEvidenceContract(task)).toMatchObject({ kind: 'none', applies: false });
    expect(needsCompletionEvidence(task)).toBe(false);
    const answer = '分析如下：结论和理由均在当前聊天中说明。';
    expect(guardCompletionClaims({ task, response: answer, toolCalls: [] })).toMatchObject({ blocked: false, text: answer });
  });

  it.each([
    '请列出相关条文。文件有不同格式。',
    '文件有不同格式。请计算二加三并列出步骤。',
    'List the relevant principles. A file has a name.',
  ])('does not splice an unrelated positive file topic into another sentence predicate: %s', task => {
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
    expect(buildActionEvidenceContract(task)).toMatchObject({ kind: 'none', applies: false });
    expect(needsCompletionEvidence(task)).toBe(false);
  });

  it.each([
    '请读取 D:/case-source/financial-notes.docx，列出全部正文。不生成文件。',
    '不生成文件。请读取 D:/case-source/financial-notes.docx，列出全部正文。',
    '请分析附件中的金额；不创建或修改文件。',
    '这是一份文件。请读取其中的完整内容，不修改原件。',
    'Read D:/case-source/notes.pdf; do not create or modify files.',
    'The file is already provided. Please inspect its complete contents; do not save anything.',
    '第二份文件名有误，实际是桌面的“source-corrected.docx”。请只补读这份，不创建文件。',
    '桌面有 annual.xlsx；请计算其中的合计金额，不修改文件。',
    '材料是 report.docx。请总结其主要内容，不创建文件。',
    'The material is report.docx. Summarize its key contents; do not create a file.',
  ])('keeps a real source read, including a referential clause, subject to present evidence: %s', task => {
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    const contract = buildActionEvidenceContract(task);
    expect(contract).toMatchObject({ kind: 'artifact_work', applies: true, label: 'Exact read-only file inspection' });
    expect(hasCoreActionEvidence(contract, [], task)).toBe(false);
    expect(needsCompletionEvidence(task)).toBe(true);
  });

  it.each([
    '请创建 D:/case-source/new-note.txt，不读取原件。',
    '请把 D:/case-source/source.docx 修改为三段，不生成其他文件。',
    '读取 D:/case-source/source.docx，再导出 D:/case-source/copy.pdf，不修改原件。',
    'Create D:/case-source/notes.txt; do not read another file.',
    'Read D:/case-source/source.csv. Do not modify it, but export D:/case-source/result.csv.',
  ])('does not turn an affirmative create, edit or export into read-only analysis: %s', task => {
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
    const contract = buildActionEvidenceContract(task);
    expect(contract.applies).toBe(true);
    expect(hasCoreActionEvidence(contract, [], task)).toBe(false);
    expect(needsCompletionEvidence(task)).toBe(true);
  });
});

describe('read receipt targets share the affirmative source projection', () => {
  const receipt = (name: string) => ({ name: 'read_docx', arguments: { filePath: 'D:/case-source/' + name }, result: 'Complete source text', terminalVerification: { status: 'verified', strategy: 'terminal_receipt' } } as any);
  it.each([
    '请读取“source-a.docx”，不要读取“source-b.docx”，不修改文件。',
    '请读取“source-a.docx”；不要读取“source-b.docx”，不修改文件。',
    '请读取“source-a.docx”。原文写着“读取 source-b.docx”。',
    'Read "source-a.docx"; do not read "D:/private/source-b.docx".',
  ])('never promotes a prohibited or quoted second filename into a read target: %s', task => {
    expect(documentReadMatchesRequestedTarget(receipt('source-a.docx'), task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(receipt('source-b.docx'), task)).toBe(false);
  });
  it('retains a confirmed exact target for an otherwise unresolved relative source', () => {
    const task = '请读取“source-a.docx”，不要读取“source-b.docx”。';
    const accepted = { target: { status: 'confirmed', path: 'D:/case-source/source-a.docx' } } as any;
    expect(documentReadMatchesRequestedTarget(receipt('source-a.docx'), task, accepted)).toBe(true);
    expect(documentReadMatchesRequestedTarget({ ...receipt('source-a.docx'), arguments: { filePath: 'D:/other/source-a.docx' } }, task, accepted)).toBe(false);
    expect(documentReadMatchesRequestedTarget(receipt('source-a.docx'), task, { target: { ...accepted.target, status: 'rejected' } } as any)).toBe(false);
  });
});


describe('source inspection requires a directed predicate, not a report about reading', () => {
  it.each([
    '这里只提供文件名称，不代表你已读取文件。请仅说明需要什么信息。',
    '这里列的是材料名称清单，文件内容尚未取得。请说明还需补什么。',
    '这不是你已经阅读文档的证据。请在聊天解释两种材料的用途。',
    '文件是否已读取仍未知。请仅根据这份名称清单说明下一步。',
    '没有声称你查看过附件。请说明这些材料名称的含义。',
    'Only file names are supplied; this does not establish that you read the files. Explain the list only.',
    'The document contents have not been supplied. Explain the names of the required materials.',
    'The attachment may contain a quantity, but no one has inspected it. Answer from the supplied list.',
  ])('does not promote a source-description clause to a new read: %s', task => {
    expect(normalizeActionIntent(task).sideEffectClass).toBe('none');
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
    expect(buildActionEvidenceContract(task)).toMatchObject({ kind: 'none', applies: false });
    expect(needsCompletionEvidence(task)).toBe(false);
  });

  it.each([
    '请读取新附件的完整正文，不修改文件。',
    '请分析附件中的金额，不创建文件。',
    'Read the attached document and return its complete contents.',
    'Inspect the provided file and report its contents.',
  ])('keeps a directed fresh source read dependent on its actual receipt: %s', task => {
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    const contract = buildActionEvidenceContract(task);
    expect(contract).toMatchObject({ kind: 'artifact_work', applies: true, label: 'Exact read-only file inspection' });
    expect(hasCoreActionEvidence(contract, [], task)).toBe(false);
  });
});


describe('message-send negation stays with its own predicate', () => {
  it.each([
    '不要读取文件。然后给张三发送消息“收到”。',
    '不要创建文件；给张三发送消息“收到”。',
    '不要打开浏览器，但请给张三发送消息“收到”。',
    'Do not read files. Send a message to Alice: received.',
    'Do not open apps, but send a message to Alice: received.',
    'Do not create a document; send a message to Alice: received.',
  ])('keeps a subsequent affirmative send after a different prohibited action: %s', task => {
    expect(hasNegatedMessagingSendIntent(task)).toBe(false);
    expect(normalizeActionIntent(task)).toMatchObject({kind: 'messaging_send', sideEffectClass: 'external_commit'});
    const contract = buildActionEvidenceContract(task);
    expect(contract).toMatchObject({kind: 'messaging_send', applies: true});
    expect(hasCoreActionEvidence(contract, [], task)).toBe(false);
  });

  it.each([
    '不要给张三发送消息。',
    '请勿发送任何消息。',
    '不要再给张三发消息。',
    'Do not send a message to Alice.',
    'Never reply to Bob.',
    'Do not open apps, click, type, or send messages.',
    'Do not open apps or send messages.',
    'Do this without sending a message.',
  ])('retains a real prohibition on sending: %s', task => {
    expect(hasNegatedMessagingSendIntent(task)).toBe(true);
    expect(normalizeActionIntent(task).kind).not.toBe('messaging_send');
  });

  it.each([
    '原文写着“不要发送消息”。请只解释原文。',
    '假设不要发送消息，只说明这个例子。',
    'The source says "Do not send messages." Explain the quotation.',
    'For example, do not send a message. Explain the example.',
  ])('does not turn a quoted or hypothetical prohibition into a current send veto: %s', task => {
    expect(hasNegatedMessagingSendIntent(task)).toBe(false);
    expect(normalizeActionIntent(task).sideEffectClass).toBe('none');
  });
});


it('preserves the actual quoted recipient and exact message payload after predicate projection', () => {
  const task = '请给“协议收件人”发送消息“保留，原文不要改动”。';
  expect(normalizeActionIntent(task)).toMatchObject({kind: 'messaging_send', target: '协议收件人', payload: '保留，原文不要改动', sideEffectClass: 'external_commit'});
});


it('does not carry a retrospective denial of reading into a later affirmative send', () => {
  const task = '我没有读取文件。然后给张三发送消息“收到”。';
  expect(hasNegatedMessagingSendIntent(task)).toBe(false);
  expect(normalizeActionIntent('然后给张三发送消息“收到”。')).toMatchObject({kind: 'messaging_send', sideEffectClass: 'external_commit'});
});
it('keeps an actual denial of authorization to send', () => {
  const task = '我没让你给张三发消息。';
  expect(hasNegatedMessagingSendIntent(task)).toBe(true);
  expect(normalizeActionIntent(task).kind).not.toBe('messaging_send');
});


it('keeps write-then-readback verification out of a read-only source contract', () => {
  const task = 'After creating the file, read it back and verify the exact content. Target: D:/safe-output/note.txt';
  expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
});
