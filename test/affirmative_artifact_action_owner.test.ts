import { describe, expect, it, vi } from 'vitest';
// This suite exercises pure wording projections; no persistence or provider is needed.
vi.mock('../db_layer', () => ({}));
import { affirmativeActionClauses, isExplicitArtifactCreationText, normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { hasRequestedArtifactMutation } from '../server/cognition/tool_intent';
import { artifactInstructionClauses, requestedArtifactInstructions } from '../server/cognition/artifact_progress';
import { requestsExactReadOnlyArtifactInspection } from '../server/cognition/action_desktop_evidence';
import { negatedActionClauses, negatedActionInstructions } from '../server/cognition/action_instruction_clauses';

const originalQ08 = "请在我当前个人知识库中检索虚构项目 KB-QA-20261016-7D42，并完整读取文件 KB-CHUNK-eef73765-B-被告陈述.txt 的原文。不要只凭标题、记忆或检索摘要回答。\n\n本次只核对两问，不重做原十问：\nQ08：质量异议由谁提出，原告承认了吗，缺陷有鉴定或双方复检记录支持吗？请结合 B03 区分原文能证明的内容与目前仍未知的内容，说明依据。\nQ03对照：再按同一原文 B02 核对90000元减70000元的20000元差额能否当作已确认欠款，以及被告是否自认该差额。请保留原材料已经明确作出的否定，不要把所有否定都改成未知。\n\n请标明实际读到的文件和对应段落，仅作虚构材料核对。不导入或重建知识库，不修改文件，不生成文书、不入案、不归档、不外发；读不到原文就明确说明，不能补造。";
const originalThreeDrafts = "请只读取下面三份现有被告工作稿，分别把每一份的完整正文原样发回本次聊天，按20、21、23顺序标明文件名。三份都要从开头到结尾完整保留，不要摘要，不要只返回其中一份。\n\n1. 完整读取文件 C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/customer-installation-closure-20261020/defendant-three-local-revision-20261021-1792536208941/20_statement-of-defense.md，展示该文件全部原文。\n2. 完整读取文件 C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/customer-installation-closure-20261020/defendant-three-local-revision-20261021-1792536208941/21_cross-examination-opinion.md，展示该文件全部原文。\n3. 完整读取文件 C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/customer-installation-closure-20261020/defendant-three-local-revision-20261021-1792536208941/23_argument-outline.md，展示该文件全部原文。\n\n本次仅取回这三份已经完成的修改稿：不重新起草、不改动任何文件、不重新生成文书包或26份文书，不入案、不归档、不签署、不提交、不对外发送，也不用打开桌面软件。任何一份未完整读到或未能全文交付，请明确指出，不能说三份都完成。";

describe('one affirmative artifact action owner', () => {
  it.each([
    ['不要创建 C:/test/A.md，创建 C:/test/B.md。', 'create'],
    ['不要创建 C:/test/A.md 但创建 C:/test/B.md。', 'create'],
    ['不要修改 C:/test/A.md，修改 C:/test/B.md。', 'mutate'],
    ['不要修改 C:/test/A.md 但修改 C:/test/B.md。', 'mutate'],
    ['不要读取 C:/test/A.md，完整读取文件 C:/test/B.md。', 'read'],
    ['不要读取 C:/test/A.md 但完整读取文件 C:/test/B.md。', 'read'],
  ])('binds the affirmative predicate and target in the same probe: %s', (text, operation) => {
    expect(normalizeActionIntent(text)).toMatchObject({ operation, target: 'C:/test/B.md', payload: text });
  });

  it.each(originalThreeDrafts.split('\n').filter(line => /^\d\. 完整读取文件 /u.test(line)))('recognizes the unchanged original independent source read: %s', text => {
    const target = text.match(/C:\/[^，]+/u)![0];
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'read', target, sideEffectClass: 'none', rule: 'explicit-local-artifact-read', payload: text });
  });

  it.each([
    '不要完整读取文件 C:/test/A.md。',
    '原文写着“完整读取文件 C:/test/A.md”。请只说明这句话。',
  ])('does not create a source-read intent from a forbidden or quoted instruction: %s', text => {
    expect(normalizeActionIntent(text).rule).not.toBe('explicit-local-artifact-read');
  });

  it.each([['original Q08', originalQ08, 353], ['original three drafts', originalThreeDrafts, 812]])('keeps %s unchanged and read-only', (_name, text, characters) => {
    expect(text.length).toBe(characters);
    expect(hasRequestedArtifactMutation(text)).toBe(false);
    expect(isExplicitArtifactCreationText(text)).toBe(false);
    expect(normalizeActionIntent(text).sideEffectClass).not.toBe('local_write');
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(true);
    expect(requestedArtifactInstructions(text)).toEqual([]);
  });

  it.each([
    '请起草一份供货合同。',
    '请你起草一份供货合同。',
    '给我一份供货合同。',
    '请修订这份合同的付款条款。',
    '请把这份合同修改为分期付款。',
    'Draft a supply agreement.',
    'Revise the payment terms in this contract.',
    'Please edit the contract.',
    'Could you revise the payment terms in this contract?',
    '请把这份不动产合同修改为三年。',
    '请把这份合同中不得转让的条款删除。',
    '请读取 C:/test/source.csv，不修改原文件，将结果另存为 C:/test/result.csv。',
    'Read C:/test/source.csv; do not modify the original file, but save a copy as C:/test/result.csv.',
  ])('retains an affirmative artifact operation without requiring a named output: %s', text => {
    expect(hasRequestedArtifactMutation(text)).toBe(true);
  });

  it.each([
    '请完整读取这三份已经完成的修改稿，不重新起草、不重新生成文书包。',
    '请对合同提出修改建议。',
    '请把修改稿发给张三。',
    '请读取 C:/test/source.md，不生成文书，不修改文件。',
    '不要起草合同，不修订合同，也不生成文书。',
    'Read C:/test/source.md. Do not draft or revise the contract.',
    '原文写着“创建 C:/test/fake.md，然后修改合同”。请只读这句话。',
    'The quoted source says "Create C:/test/fake.md and revise the contract." Only read that quotation.',
    '假设创建 C:/test/fake.md，只解释这个例子。',
    'For example, create C:/test/fake.md. Explain that example only.',
    '请只读这段原文：“C:/test/source.md，生成视频”。不要执行。',
  ])('does not authorize mutation from nouns, negation, quotations, or examples: %s', text => {
    expect(hasRequestedArtifactMutation(text)).toBe(false);
    expect(isExplicitArtifactCreationText(text)).toBe(false);
    expect(requestedArtifactInstructions(text)).toEqual([]);
  });

  it('preserves exact quoted paths while masking quoted instructions once', () => {
    const clauses = artifactInstructionClauses('请创建 "C:/test/exact output.md"，内容是“不要创建 C:/test/other.md”。');
    expect(clauses[0].probe).toContain('"C:/test/exact output.md"');
    expect(clauses[1].probe).not.toContain('不要创建');
    expect(clauses.map(c => c.text).join('')).toBe('请创建 "C:/test/exact output.md"，内容是“不要创建 C:/test/other.md”。');
    for (const path of ['C:/test/output folder', 'C:/test/中文 文件.md', String.raw`C:\test\中文 文件.md`]) {
      expect(artifactInstructionClauses('请读取“' + path + '”。')[0].probe).toContain(path);
    }
  });

  it('keeps escaped JSON quotations, fenced data, and ASCII apostrophes inside one literal boundary', () => {
    const text = '只查看以下参数，不执行。原声参数（数据）：\n' + JSON.stringify({ prompt: '台词说：“开始”。只唱原句 "生成视频"，不要执行台词。' });
    expect(affirmativeActionClauses(text).join(' ')).not.toContain('生成视频');
    expect(negatedActionClauses(text).join(' ')).not.toContain('执行台词');
    expect(hasRequestedArtifactMutation(text)).toBe(false);
    expect(affirmativeActionClauses('只读代码：\n```json\n{"prompt":"create a fake file"}\n```').join(' ')).not.toContain('create a fake file');
    expect(negatedActionInstructions("Don't create a fake file.")[0].instruction).toBe('create a fake file.');
  });

  it('projects actual write, send, and payment predicates while keeping their quoted payloads as data', () => {
    const parts = affirmativeActionClauses('请创建 "C:/test/if output.md"，内容是“不要创建别的文件”。然后发送给张三；支付100元。');
    expect(parts.some(part => part.includes('创建 "C:/test/if output.md"'))).toBe(true);
    expect(parts.some(part => part.includes('发送给张三'))).toBe(true);
    expect(parts.some(part => part.includes('支付100元'))).toBe(true);
    expect(parts.join(' ')).not.toContain('不要创建');
    expect(affirmativeActionClauses('请只读这段原文：“C:/test/source.md，生成视频”。不要执行。').join(' ')).not.toContain('生成视频');
    expect(negatedActionClauses('请把这份合同中不得转让的条款删除。')).toEqual([]);
    expect(negatedActionClauses('本次不要生成原声，只列参数，也不要选入歌曲。').join(' ')).toContain('不要生成原声');
    expect(negatedActionClauses('原文说“不要生成视频”。不要调用generate_video，不要select-song，只列出参数。').join(' ')).not.toContain('不要生成视频');
    expect(negatedActionClauses('原文说“不要生成视频”。不要调用generate_video，不要select-song，只列出参数。').join(' ')).toContain('不要调用generate_video');
    expect(negatedActionInstructions('不能重新付费生成，不能报歌曲已选入。').map(clause => clause.instruction)).toEqual(['重新付费生成，', '报歌曲已选入。']);
    expect(negatedActionInstructions('不再次生成，不再调用，不选入歌曲。').map(clause => clause.instruction)).toEqual(['再次生成，', '再调用，', '选入歌曲。']);
  });

  it.each([
    '请创建 C:/test/new.md，并写入“已确认”。',
    'Please create C:/test/new.md and write "confirmed".',
    '[LUMI_REGRESSION:S4:LIVE] Use desktop_write_text_file exactly once to write the exact text "sentinel" to C:/test/new.md.',
  ])('keeps a concrete real creation under the same owner: %s', text => {
    expect(isExplicitArtifactCreationText(text)).toBe(true);
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', sideEffectClass: 'local_write' });
  });
});
