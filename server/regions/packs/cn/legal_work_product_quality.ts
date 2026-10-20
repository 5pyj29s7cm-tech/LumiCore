import { buildMaterialSources, resolveSourceDraftEntries, SourceDraftValidationError, type Source } from './legal_reasoning_generation';

export type BidDraftEntry = ReturnType<typeof resolveSourceDraftEntries>[number] & { monetaryResponse?: string };
export type BidChapter = { id: string; title: string; instruction: string; sections: Array<{ id: string; title: string }> };

function bidSourceNumber(source: Source): string | undefined {
  return source.quote.match(/^((?:[A-Za-z]+[-.]?)?\d+(?:[-.]\d+)*|[一二三四五六七八九十百]+)(?:【[^】]+】|[：:、.)）])/u)?.[0];
}

function bidNumberedSources(sources: Source[]): Source[] {
  return sources.filter(source => bidSourceNumber(source));
}

function bidSourceTitle(source: Source): string {
  return bidSourceNumber(source) || source.id + ' ' + source.title;
}

export function buildBidChapters(sources: Source[]): BidChapter[] {
  return [
    { id: 'business', title: '商务响应与报价',
      instruction: '按子节分工，不互抄：bid-letter仅投标函；business-response写主体、资格、授权、业绩、人员、报价组成、保证金与偏差；payment仅付款方案，引用报价和比例原句，逐期同一行列基数、比例、算式、金额及合计，不省任何一期。基数、条件未明保留待确认，计算待复算，缺证待补，不补签章。',
      sections: [{ id: 'bid-letter', title: '投标函工作稿' }, { id: 'business-response', title: '商务响应与报价' }, { id: 'payment', title: '付款方案与拟议计算' }] },
    { id: 'technical', title: '技术方案与实施计划',
      instruction: '技术方案只写服务边界、步骤与资源；实施计划只写阶段、触发及原文期限；交付、验收与风险只写交付物、验收指标和方法、风险措施。必要衔接不复制全文；拟议措施非既有事实，新承诺列建议待确认，工作日/自然日/小时不混改。',
      sections: [{ id: 'technical-plan', title: '技术方案与服务边界' }, { id: 'schedule', title: '实施计划与期限' }, { id: 'delivery-risk', title: '交付、验收与风险' }] },
    { id: 'response', title: '逐项响应与偏差',
      instruction: '每项仅答对应原文编号，sourceIds含同名来源ID，必要时补关联来源。按原文要求在response直接填明本项状态、商务或技术偏差性质及投标人立场；要求偏差表或逐编号响应矩阵时，在本项response直接填完整Markdown表，按原文列项及限定状态逐行填写，不能只承诺另表、归组概述或用内部覆盖工作表替代；资料缺失或前提未知如实列明，不据此认定不符合。不把背景自述作要求；保留本项数字、期限、澄清、评分、否决、格式及直接缺项，不搬整章方案或无关资格、保证金。涉及分期付款时逐期列基数、比例、算式、金额及合计；不能仅写参见或自称覆盖、资格、评分已核准。',
      sections: bidNumberedSources(sources).length
        ? bidNumberedSources(sources).map(source => ({ id: source.id, title: bidSourceTitle(source) }))
        : [{ id: 'source-response', title: '未编号材料的拟议响应' }] },
  ];
}

export function resolveBidChapter(value: unknown, sources: Source[], chapter: BidChapter, deferUnregisteredSources = false): BidDraftEntry[] {
  const entries = resolveSourceDraftEntries(value, sources, chapter.sections.map(section => section.id), deferUnregisteredSources);
  if (!deferUnregisteredSources && chapter.id === 'response' && entries.some(entry => entry.sectionId !== 'source-response' && !entry.sources.some(source => source.id === entry.sectionId))) {
    throw new SourceDraftValidationError('逐项响应未引用该项实际原文。');
  }
  if (entries.map(entry => entry.response.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')).join('\n').trim().length < 40) {
    throw new SourceDraftValidationError('章节未返回足够的拟议正文。');
  }
  return entries;
}

/** Compile only actual proposals and server-owned originals, never model self-assessments. */
export function buildGroundedBidDraft(
  projectName: string, requirements: string,
  sources = buildMaterialSources([{ id: 'requirements', title: '提供的招标材料', content: requirements }]),
  chapters = buildBidChapters(sources), drafts = new Map<string, BidDraftEntry[]>(),
): string {
  const tableCell = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const responseEntries = drafts.get('response') || [];
  const rows = bidNumberedSources(sources);
  const covered = rows.filter(source => responseEntries.some(entry => entry.sectionId === source.id
    && entry.sources.some(selected => selected.id === source.id))).length;
  const actualSections = chapters.flatMap(chapter => chapter.sections.filter(section => (drafts.get(chapter.id) || []).some(entry => entry.sectionId === section.id)).map(section =>
    ({ chapterId: chapter.id, sectionId: section.id, title: chapter.title + ' / ' + section.title })));
  return [
    '# ' + projectName + ' 投标响应工作底稿',
    '虚构或真实项目属性以原件为准。本文件为内部工作草稿；来源引用、结构完整或计算列示不等于事实、资格、评分、法律或正式提交已核准。',
    '## 实际正文目录',
    actualSections.length ? actualSections.map((section, index) => '- ' + (index + 1) + '. ' + section.title).join('\n')
      : '尚未取得章节正文；下方原件清单不是已经完成的投标函或标书。',
    ...chapters.flatMap(chapter => {
      const entries = drafts.get(chapter.id);
      if (!entries) return [];
      return ['## ' + chapter.title, ...chapter.sections.flatMap(section => {
        const entry = entries.find(item => item.sectionId === section.id);
        if (!entry) return [];
        return ['### ' + section.title,
          '#### 对应原始材料（程序原句）',
          ...entry.sources.map(source => '- ' + source.id + '；' + source.title + '；' + source.locator + '\n> ' + source.quote),
          '#### 拟议响应（模型工作稿，未作事实认定或核准）', entry.monetaryResponse ?? entry.response,
          '#### 待补与核验', entry.missing || '模型未列其他缺项；仍需责任人核对原件、方案和计算，不能据此认定没有缺项。',
        ].join('\n\n');
      })];
    }),
    '## 已识别编号条目响应覆盖与补料工作表',
    '下表为内部响应、偏差及补料工作表；原文仅表示提供的资料，不代表证明已核验。责任人及时点未指定时保持待指定、待确认。',
    rows.length ? '- 已识别编号条目的来源绑定拟议响应：' + covered + '/' + rows.length + ' 项；仅表示所列编号原句与响应结构存在，所有内容仍待核验。'
      : '- 未识别到明确编号条目，不据此断言全文件要求已逐项响应。',
    '- 未进入编号集合的原文段落：' + (sources.length - rows.length) + '/' + sources.length + '；全文仍保留在已读取来源原文附录，未将标题或背景段落自动认定为要求。',
    '- 未入集合的来源范围：' + sources.filter(source => !rows.includes(source)).map(source => source.id + '（' + source.title + '；' + source.locator + '）').join('；'),
    [
    '| 原件编号 | 来源/位置 | 原始编号条目 | 拟议响应状态及正文位置 | 待补事项及动作 | 责任人及时点 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(source => {
      const entry = responseEntries.find(item => item.sectionId === source.id && item.sources.some(selected => selected.id === source.id));
      const position = actualSections.findIndex(section => section.chapterId === 'response' && section.sectionId === source.id);
      return '| ' + tableCell(bidSourceTitle(source)) + ' | ' + tableCell((entry?.sources || [source]).map(selected => selected.id + '；' + selected.title + '；' + selected.locator).join('\n'))
        + ' | ' + tableCell(source.quote) + ' | ' + (entry ? '已取得拟议响应；内容待核验，未核准' : '尚未取得来源绑定的逐项响应，待补')
        + '；' + (position >= 0 ? '实际正文第' + (position + 1) + '节' : '尚未编排对应正文')
        + ' | ' + tableCell(entry?.missing.trim() ? entry.missing : '模型未列其他缺项；不代表没有缺项')
        + '；待补动作：核对上述事项，补充原件或确认前提。 | 责任人待指定；时点待确认 |';
    }),
    ].join('\n'),
    '## 正式使用边界',
    '- 缺失证照、授权、业绩、付款凭证及提交条件保持待补；不生成证明或签认。',
    '- 原文中的金额、税率、比例和日期仍以原件为准；模型拟议算式须逐项复算，不是程序算术核准。',
    '- 尚未上传、发送、投标或签署；正式使用需责任人完成材料、方案与适用法律复核。',
  ].join('\n\n');
}

export interface ContractReviewPart { index: number; start: number; end: number; text: string }

/** Exact offsets in the submitted text; overlapping windows preserve clause boundaries. */
export function splitContractForReview(text: string, size = 6000, overlap = 300): ContractReviewPart[] {
  if (size < 100 || overlap < 0 || overlap >= size) throw new Error('Invalid contract review window');
  const parts: ContractReviewPart[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + size / 2) end = boundary + 1;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    parts.push({ index: parts.length + 1, start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = end - overlap;
    if (/[\uDC00-\uDFFF]/u.test(text[start])) start++;
  }
  return parts;
}

export function contractCoverageReport(text: string, parts: ContractReviewPart[], reviewed: Set<number>, sourceOnly: boolean): string {
  return `## 审查覆盖范围
- 输入全文：${text.length} 字符；共 ${parts.length} 段（相邻段保留重叠条款）。
- 原文输入覆盖：全文；${sourceOnly ? '按要求仅保留原文，未进行模型深度审查。' : `模型深度审查：${reviewed.size}/${parts.length} 段。`}
- 未提供的附件未审查；栏目与来源结构通过不等于事实、法律或跨段一致性已经核准。
| 段落 | 原文字符位置 | 模型深度审查 |
| --- | --- | --- |
${parts.map(part => `| ${part.index} | ${part.start + 1}–${part.end} | ${sourceOnly ? '未请求' : reviewed.has(part.index) ? '已返回分析，待律师复核' : '未完成，需继续审查'} |`).join('\n')}`;
}

export const CONTRACT_DRAFT_SECTIONS = [
  '主体与角色', '合同目的与范围', '双方权利义务', '履行与期限',
  '对价与费用适用性', '责任、终止与争议处理', '签署、生效与待确认事项',
].map(title => ({ id: title, title }));
export const CONTRACT_REVIEW_SECTIONS = [
  { id: 'analysis', title: '原文分析' }, { id: 'revisions', title: '修改建议' }, { id: 'pending', title: '待核对事项' },
];
export const CONTRACT_WORK_PRODUCT_FORMAT = '仅输出 JSON {"complete":true,"entries":[{"sectionId":"指定栏目ID","sourceIds":["已有来源ID"],"response":"本栏目实际条款或分析正文","missing":""}]}。每个指定栏目恰好一项，仅使用已有来源ID，不复述原件为新事实。不输出说明、提纲或拒答冒充正文；无法形成完整工作稿时complete:false。complete只说明栏目正文已生成，不表示法律、事实或正式使用已核准。';

/** Compile the existing source-bound entries; completeness is structural, not legal approval. */
export function resolveContractWorkProduct(raw: string, sources: Source[], sections: Array<{id:string;title:string}>, options: { proposedDraft?: boolean } = {}): string {
  const value = JSON.parse(raw.replace(/^\s*\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60\s*$/, ''));
  if (value?.complete !== true || (value.unresolved !== undefined && (!Array.isArray(value.unresolved) || value.unresolved.length))) throw new SourceDraftValidationError('合同工作稿未完整生成。');
  const entries = resolveSourceDraftEntries(value, sources, sections.map(section=>section.id))
    .map(entry=>({...entry,response:entry.response.trim(),missing:entry.missing.trim()}));
  const bodies = entries.map(entry=>entry.response.split('\n').filter(line=>!/^\s*#/.test(line)).join('\n').trim());
  if (bodies.some(body=>body.length < 2) || bodies.join('').length < 40) throw new SourceDraftValidationError('合同工作稿缺少实际条款或分析正文。');
  return sections.map(section=>{const entry=entries.find(item=>item.sectionId===section.id)!;
    return ['## '+section.title,...(options.proposedDraft ? ['本栏以下全部为拟议条款，须双方确认；不得替代另列的原始要求。'] : []),entry.response,...(entry.missing ? ['待核对：'+entry.missing] : [])].join('\n\n');}).join('\n\n');
}
