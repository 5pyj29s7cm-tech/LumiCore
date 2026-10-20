import { makeApp } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import originals from './fixtures/legal_bid_six_materials_164.json';
import actual from './fixtures/legal_bid_r24_actual_price_role.json';
import unit3Captured from './fixtures/legal_bid_phase9_unit3_draft.json';
import { buildMaterialSources, type Source, resolveSourceDraftEntries } from '../server/regions/packs/cn/legal_reasoning_generation';
import { assertBidMoneyClaims, BidMoneyVerificationError, buildBidMoneyContract, verifyBidMoneyClaims } from '../server/regions/packs/cn/legal_bid_money';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as documents from '../server/regions/packs/cn/legal_tools/documents';
import * as quality from '../server/regions/packs/cn/legal_work_product_quality';
import * as cases from '../server/org/legal_cases';
import { sdkCompletion } from './legal_bid_fixture';

const sources = buildMaterialSources(originals.materials);
const contract = buildBidMoneyContract(originals.materials, sources);
const bytes = JSON.stringify(originals);
const entry = (response: string, sourceIds: string[]) => ({ response, sources: sources.filter(source => sourceIds.includes(source.id)) });
const totalGross = contract.facts.find(fact => fact.role === 'total' && fact.basis === 'gross')!;
const lineNet = contract.facts.find(fact => fact.role === 'line' && fact.basis === 'net')!;
const field = (fact: typeof totalGross, label: string, amount = fact.amount) => '【' + fact.source.id + '|' + label + ':' + amount + '元】';
let app: Awaited<ReturnType<typeof makeApp>>;
let network: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { app = await makeApp(); });
beforeEach(() => { network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('OFFLINE_BID_MONEY_ROLE')); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); expect(JSON.stringify(originals)).toBe(bytes); vi.restoreAllMocks(); });
afterAll(() => app.cleanup());

describe('source-table monetary role contract', () => {
  it('keeps exact original row/column/text-version evidence separate from model labels', () => {
    expect(sources).toHaveLength(164);
    expect(contract.issues).toEqual([]);
    expect(totalGross.source.id).not.toBe(lineNet.source.id);
    expect(totalGross.column).toBeGreaterThan(0);
    const material = originals.materials.find(item => item.id === totalGross.source.materialId)!;
    expect(totalGross.materialSha256).toBe(crypto.createHash('sha256').update(material.content).digest('hex'));
    expect(material.content).toContain(totalGross.header.quote);
    expect(material.content).toContain(totalGross.source.quote);
  });

  it('keeps the unmodified R24 draft outside quotation-source scope and rejects its P01-as-total review', () => {
    const draft = entry(actual.draft.response, actual.draft.sourceIds);
    const reviewed = entry(actual.review.response, actual.review.sourceIds);
    expect(verifyBidMoneyClaims([draft], contract)).toMatchObject({ passed: true, code: 'not_applicable', claimCount: 0 });
    expect(verifyBidMoneyClaims([reviewed], contract)).toMatchObject({ passed: false, code: 'unverified' });
    expect(() => assertBidMoneyClaims([reviewed], contract)).toThrow(BidMoneyVerificationError);
    expect(reviewed.response).toBe(actual.review.response);
  });

  it.each(['plain', 'grouped'])('accepts a source-bound explicit gross total with %s numeric formatting', mode => {
    const value = mode === 'plain' ? totalGross.amount : totalGross.amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    expect(verifyBidMoneyClaims([entry(field(totalGross, '含税合计', value), [totalGross.source.id])], contract)).toMatchObject({ passed: true, claimCount: 1 });
  });

  it('checks every claim so a correct total beside the original wrong claim does not launder it', () => {
    const text = field(totalGross, '含税合计') + '。\n' + actual.review.response;
    expect(verifyBidMoneyClaims([entry(text, [...actual.review.sourceIds, totalGross.source.id])], contract)).toMatchObject({ passed: false, code: 'unverified' });
  });

  it('accepts an explicit source-selected line amount without treating it as a total', () => {
    expect(verifyBidMoneyClaims([entry(field(lineNet, '未税金额'), [lineNet.source.id])], contract).passed).toBe(true);
  });

  it('requires the matching role source and tax basis, not an amount found elsewhere', () => {
    expect(verifyBidMoneyClaims([entry(field(totalGross, '含税合计'), [lineNet.source.id])], contract).passed).toBe(false);
    expect(verifyBidMoneyClaims([entry('总报价为' + totalGross.amount + '元。', [totalGross.source.id])], contract).passed).toBe(false);
    expect(verifyBidMoneyClaims([entry('参考金额为' + totalGross.amount + '元。', [totalGross.source.id])], contract).passed).toBe(false);
  });

  it('does not let a model-supplied moneyFacts field override the original table role', () => {
    const candidate = { ...entry(actual.review.response, actual.review.sourceIds), moneyFacts: [{ role: 'total', amount: lineNet.amount }] };
    expect(verifyBidMoneyClaims([candidate], contract).passed).toBe(false);
  });

  it('does not treat the ceiling row as quotation total', () => {
    const ceiling = sources.find(source => source.quote.includes('不得当成我方报价'))!;
    const number = ceiling.quote.split(',').filter(Boolean).find(value => /^\d+\.\d{2}$/.test(value))!;
    expect(contract.facts.some(fact => fact.source.id === ceiling.id && fact.role !== 'auxiliary')).toBe(false);
    expect(contract.facts.find(fact => fact.source.id === ceiling.id)).toMatchObject({ role: 'auxiliary', basis: 'source' });
    expect(verifyBidMoneyClaims([entry('【' + ceiling.id + '|含税合计:' + number + '元】', [ceiling.id])], contract).passed).toBe(false);
  });

  const alternative = '代号,含税金额元,数量,服务项目,税额元,未税金额元,未税单价元\nX-73,32.86,2,服务甲,1.86,31.00,15.50\nY-04,31.80,3,服务乙,1.80,30.00,10.00\nZ-88,64.66,,报价合计,3.66,61.00,\n';
  const alternativeInput = (content = alternative) => {
    const materials = [{ id: 'arbitrary', title: 'Different quotation table', content }];
    const refs = buildMaterialSources(materials);
    return { materials, refs, contract: buildBidMoneyContract(materials, refs) };
  };
  it('supports different row codes, amounts and column order without sample constants', () => {
    const other = alternativeInput();
    expect(other.contract.issues).toEqual([]);
    const total = other.contract.facts.find(fact => fact.role === 'total' && fact.basis === 'gross')!;
    expect(verifyBidMoneyClaims([{ response: field(total, '含税合计'), sources: [total.source] }], other.contract).passed).toBe(true);
    const line = other.contract.facts.find(fact => fact.role === 'line' && fact.basis === 'net')!;
    expect(verifyBidMoneyClaims([{ response: field(line, '未税合计'), sources: [line.source] }], other.contract)).toMatchObject({ passed: false, code: 'line_amount_as_total' });
  });

  it.each(['bad-sum', 'missing-total', 'quoted-row', 'duplicate-total'])('keeps %s source structure unverified', mode => {
    const content = mode === 'bad-sum' ? alternative.replace('64.66', '65.66')
      : mode === 'missing-total' ? alternative.split('\n').slice(0, 3).join('\n')
        : mode === 'quoted-row' ? alternative.replace('服务甲', '"服务,甲"')
          : alternative + alternative.split('\n')[3] + '\n';
    const other = alternativeInput(content);
    expect(other.contract.issues.length).toBeGreaterThan(0);
    expect(verifyBidMoneyClaims([{ response: '含税总报价64.66元。', sources: other.refs }], other.contract).passed).toBe(false);
  });

  it('does not reuse an old source-row identity after its actual text changed', () => {
    const other = alternativeInput();
    const changed = alternativeInput(alternative.replace('服务甲', '服务甲版本二'));
    const oldTotal = other.contract.facts.find(fact => fact.role === 'total' && fact.basis === 'gross')!;
    const changedSource: Source = { ...oldTotal.source, quote: oldTotal.source.quote + ' changed' };
    expect(changed.contract.facts[0].materialSha256).not.toBe(other.contract.facts[0].materialSha256);
    expect(verifyBidMoneyClaims([{ response: '含税总报价64.66元。', sources: [changedSource] }], changed.contract).passed).toBe(false);
  });

  it.each(['含税总价254400.001元。', '含税总价-254400.00元。', '含税总价254400.00'])('does not silently coerce unsupported monetary syntax: %s', response => {
    expect(verifyBidMoneyClaims([entry(response, [totalGross.source.id])], contract).passed).toBe(false);
  });
});

it('uses the same acceptance gate for fresh and cached review, retaining the original wrong draft then reviewing only that unit', async () => {
  const userId = 'bid-role-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-bid-money', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  const file = cases.createCase(orgId, userId, { title: 'Synthetic R24 role boundary' });
  const beforeFiles = new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
  vi.spyOn(documents, 'readBidRequirementInput').mockResolvedValue({ requirements: originals.materials.map(material => '# ' + material.title + '\n' + material.content).join('\n\n'), sources: originals.materials.map(material => material.title), materials: structuredClone(originals.materials), skipped: [] });
  const build = quality.buildBidChapters;
  vi.spyOn(quality, 'buildBidChapters').mockImplementation(input => {
    const chapter = build(input).find(item => item.id === 'response')!;
    return [{ ...chapter, sections: chapter.sections.filter(section => section.id === actual.review.sectionId) }];
  });
  const state = { correct: false };
  const phases: string[] = [];
  const create = vi.fn(async (request: any) => {
    const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
    const review = prompt.includes('待核对JSON草稿：'); phases.push(review ? 'review' : 'draft');
    expect(prompt).toContain('金额采用闭合字段合同');
    const response = state.correct ? actual.review.response.replace('总价以 P01 报价 120000.00 元为基准', field(totalGross, '含税合计') + '；') : actual.review.response;
    const value = review ? { complete: true, unresolved: [], entries: [{ ...actual.review, ...(state.correct ? { response, sourceIds: [...actual.review.sourceIds, totalGross.source.id] } : {}) }] } : { entries: [actual.draft] };
    return sdkCompletion(request, { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] });
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const context: import('../server/tools/types').ToolContext = { userId, domain: 'personal', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const run = () => registry.execute('legal_generate_bid', { caseId: file.id, projectName: 'R24 money ' + file.id, requirements: 'source provided by actual reader', persistCase: true }, { ...context, requestId: crypto.randomUUID() }).then(decodeToolResult);
  const cachePath = () => path.join(getDataDirectory('legal_document_progress'), fs.readdirSync(getDataDirectory('legal_document_progress')).find(name => !beforeFiles.has(name))!);
  const first = await run();
  expect(first.receipt).toMatchObject({ ok: false, status: 'partial' });
  expect(cases.getCase(orgId, file.id)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
  const saved = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  expect(saved.documents.response.reviewed).toBe(false);
  expect(JSON.parse(saved.documents.response.markdown).entries[0].response).toBe(actual.draft.response);
  expect(phases).toEqual(['draft', 'review']);
  // Reproduce an old model-reviewed cache; actual source and original failed response stay unchanged.
  saved.documents.response = { ...saved.documents.response, reviewed: true, markdown: JSON.stringify({ entries: [actual.review] }) };
  fs.writeFileSync(cachePath(), JSON.stringify(saved));
  state.correct = true;
  const next = phases.length;
  const delivered = await run();
  expect(delivered.receipt).toMatchObject({ ok: true, status: 'generated' });
  expect(delivered.content).toContain(totalGross.source.title + '的报价表含税合计：' + totalGross.amount + '元');
  expect(delivered.content).not.toContain('【' + totalGross.source.id + '|');
  expect(delivered.content).toContain(actual.review.response.split('总价以 P01 报价 120000.00 元为基准')[0]);
  expect(delivered.content).toContain(actual.review.response.split('总价以 P01 报价 120000.00 元为基准')[1]);
  expect(phases.slice(next)).toEqual(['review']);
  const accepted = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  expect(accepted.documents.response.reviewed).toBe(true);
  expect(JSON.parse(accepted.documents.response.markdown).entries[0].response).not.toBe(actual.review.response);
});


describe('closed monetary fields preserve full context without claiming general language proof', () => {
  const boundary = '总价以 P01 报价 120000.00 元为基准';
  it('keeps the complete original risk paragraph and server-renders only the declared monetary sentence', () => {
    const raw = actual.review.response.replace(boundary, field(totalGross, '含税合计') + '；');
    const candidate = entry(raw, [...actual.review.sourceIds, totalGross.source.id]);
    const [accepted] = assertBidMoneyClaims([candidate], contract);
    expect(verifyBidMoneyClaims([candidate], contract)).toMatchObject({ passed: true, code: 'closed_fields_checked', claimCount: 1 });
    expect(accepted.response).toBe(raw);
    expect(accepted.monetaryResponse).toBe(actual.review.response.replace(boundary, totalGross.source.title + '的报价表含税合计：' + totalGross.amount + '元；'));
    expect(accepted.monetaryResponse).not.toContain('【' + totalGross.source.id + '|');
    expect(verifyBidMoneyClaims([entry(actual.review.response.replace(boundary, '总价以报价表含税合计' + totalGross.amount + '元为基准'), [...actual.review.sourceIds, totalGross.source.id])], contract).passed).toBe(false);
  });

  it.each(['line', 'unit'] as const)('binds every %s value to the same selected source row', role => {
    const first = contract.facts.find(fact => fact.role === role && fact.basis === 'net')!;
    const second = contract.facts.find(fact => fact.role === role && fact.basis === 'net' && fact.source.id !== first.source.id && fact.amount !== first.amount)!;
    const label = role === 'line' ? '未税金额' : '未税单价';
    expect(verifyBidMoneyClaims([entry(field(first, label, second.amount), [first.source.id, second.source.id])], contract).passed).toBe(false);
    expect(verifyBidMoneyClaims([entry(field(first, label), [first.source.id, second.source.id])], contract).passed).toBe(true);
  });

  it('cannot relabel a valid source-line field through surrounding project-total prose', () => {
    const raw = '项目总价以' + field(lineNet, '未税金额') + '为基准。';
    expect(verifyBidMoneyClaims([entry(raw, [lineNet.source.id])], contract).passed).toBe(false);
    expect(verifyBidMoneyClaims([entry(field(lineNet, '未税合计'), [lineNet.source.id])], contract)).toMatchObject({ passed: false, code: 'line_amount_as_total' });
  });

  it.each(['含税总价二十五万元', '-1元', '254400.001元', '总价254400', '不含税总价254400元', '未税单价−2000元', '总价￥254400', '【invalid|含税合计】'])('does not hide unsupported syntax beside a valid field: %s', unsupported => {
    const raw = field(totalGross, '含税合计') + '。\n' + unsupported;
    expect(verifyBidMoneyClaims([entry(raw, [totalGross.source.id])], contract).passed).toBe(false);
    expect(verifyBidMoneyClaims([{ ...entry(field(totalGross, '含税合计'), [totalGross.source.id]), missing: unsupported }], contract).passed).toBe(false);
  });

  it('does not promote either of two quotation-table totals to the whole project', () => {
    const material = originals.materials.find(item => item.id === totalGross.source.materialId)!;
    const materials = [material, { ...material, id: 'another-table', title: 'Another independent price table' }];
    const refs = buildMaterialSources(materials), ambiguous = buildBidMoneyContract(materials, refs);
    expect(ambiguous.issues).toEqual([]);
    expect(ambiguous.uniqueTableTotalSourceId).toBeUndefined();
    const totals = ambiguous.facts.filter(fact => fact.role === 'total' && fact.basis === 'gross');
    expect(totals).toHaveLength(2);
    for (const total of totals) expect(verifyBidMoneyClaims([{ response: field(total, '含税合计'), sources: refs }], ambiguous).passed).toBe(false);
    const line = ambiguous.facts.find(fact => fact.role === 'line' && fact.basis === 'net')!;
    expect(verifyBidMoneyClaims([{ response: field(line, '未税金额'), sources: refs }], ambiguous).passed).toBe(true);
  });

  it('keeps non-monetary chapters usable when the quotation table itself remains unverified', () => {
    const material = originals.materials.find(item => item.id === totalGross.source.materialId)!;
    const materials = [{ ...material, content: material.content.replace(totalGross.source.quote, totalGross.source.quote.replace(totalGross.amount, 'broken')) }];
    const refs = buildMaterialSources(materials), bad = buildBidMoneyContract(materials, refs);
    expect(bad.issues.length).toBeGreaterThan(0);
    const raw = '人员按职责分工，巡检工单记录故障与处置；原件尚待责任人核实，不作无条件承诺。';
    expect(assertBidMoneyClaims([{ response: raw, sources: refs }], bad)[0].monetaryResponse).toBe(raw);
    expect(verifyBidMoneyClaims([{ response: field(totalGross, '含税合计'), sources: refs }], bad).passed).toBe(false);
  });

  it('uses independent decimal precision within the explicit input boundary and rejects larger values', () => {
    const value = '999999999999999999999.99';
    const input = (amount: string) => [{ id: 'precision', title: 'Exact decimal boundary', content: '代号,服务项目,数量,未税单价元,未税金额元,税额元,含税金额元\nA,服务甲,1,' + amount + ',' + amount + ',0.00,' + amount + '\nT,报价合计,,,' + amount + ',0.00,' + amount + '\n' }];
    const materials = input(value), refs = buildMaterialSources(materials), exact = buildBidMoneyContract(materials, refs);
    expect(exact.issues).toEqual([]);
    const total = exact.facts.find(fact => fact.role === 'total' && fact.basis === 'gross')!;
    expect(total.amount).toBe(value);
    expect(assertBidMoneyClaims([{ response: field(total, '含税合计'), sources: refs }], exact)[0].monetaryResponse).toContain(value);
    const tooLarge = input('9999999999999999999999.99');
    expect(buildBidMoneyContract(tooLarge, buildMaterialSources(tooLarge)).issues.length).toBeGreaterThan(0);
  });

  it('does not accept a model-owned rendering field and keeps internal fields out of the existing compiler', () => {
    const raw = field(totalGross, '含税合计');
    const [decoded] = resolveSourceDraftEntries({ entries: [{ sectionId: 'money', sourceIds: [totalGross.source.id], response: raw, missing: '', monetaryResponse: 'wrong model rendering' }] }, sources, ['money']);
    expect(decoded).not.toHaveProperty('monetaryResponse');
    const [accepted] = assertBidMoneyClaims([decoded], contract);
    const chapters = [{ id: 'business', title: 'Price test', instruction: '', sections: [{ id: 'money', title: 'Price field' }] }];
    const rendered = quality.buildGroundedBidDraft('Synthetic price projection', '', sources, chapters, new Map([['business', [accepted]]]));
    expect(rendered).toContain(totalGross.source.title + '的报价表含税合计：' + totalGross.amount + '元');
    expect(rendered).not.toContain(raw);
    expect(rendered).not.toContain('wrong model rendering');
    expect(accepted.sources[0]).toEqual(totalGross.source);
  });
});


describe('missing-value explanations remain non-monetary text', () => {
  it.each(['单价待确认', '未提供含税金额', '未税金额待核实，2份原始凭证待补', '含税总价尚未确定；数量为3，资料待补', '税额尚未提供，见附件2'])('does not treat a label without a monetary value as a verified or invalid claim: %s', response => {
    const candidate = { ...entry(response, [totalGross.source.id]), missing: response };
    expect(verifyBidMoneyClaims([candidate], contract)).toMatchObject({ passed: true, code: 'not_applicable', claimCount: 0 });
    expect(assertBidMoneyClaims([candidate], contract)[0].monetaryResponse).toBe(response);
  });

  it('preserves the exact existing legal_bid_source_draft non-monetary proposal', () => {
    const response = "这是根据所选原件形成的拟议方案，仅供责任人复核；未给资格、数量、签章及付款凭证保持待补，不能据此认定资格合格或正式递交。";
    const candidate = entry(response, [totalGross.source.id]);
    expect(verifyBidMoneyClaims([candidate], contract)).toMatchObject({ passed: true, code: 'not_applicable', claimCount: 0 });
    expect(assertBidMoneyClaims([candidate], contract)[0].monetaryResponse).toBe(response);
  });
});


describe('raw source cells cannot disappear through failed decimal parsing', () => {
  const material = originals.materials.find(item => item.id === totalGross.source.materialId)!;
  const columns = totalGross.header.quote.split(',');
  const at = (label: string) => columns.indexOf(label);
  const quantityAt = at('数量'), unitAt = at('未税单价元'), netAt = at('未税金额元'), taxAt = at('税额元'), grossAt = at('含税金额元');
  const addRow = (values: string[]) => {
    const materials = [{ ...material, content: material.content.replace(totalGross.source.quote, values.join(',') + '\n' + totalGross.source.quote) }];
    const refs = buildMaterialSources(materials), current = buildBidMoneyContract(materials, refs);
    const selected = refs.find(source => source.quote === totalGross.source.quote)!;
    return { refs, current, response: '【' + selected.id + '|含税合计:' + totalGross.amount + '元】' };
  };

  it.each(['bad-net-and-tax', 'detail-with-empty-amounts', 'bad-gross-only-auxiliary'])('keeps %s unverified even when the supplied total still sums the other valid rows', mode => {
    const values = lineNet.source.quote.split(','); values[0] = 'BROKEN-DETAIL';
    if (mode === 'bad-net-and-tax') { values[netAt] = 'not-a-number'; values[taxAt] = 'not-a-number'; }
    else if (mode === 'detail-with-empty-amounts') { values[netAt] = ''; values[taxAt] = ''; values[grossAt] = ''; }
    else { for (const index of [quantityAt, unitAt, netAt, taxAt]) values[index] = ''; values[grossAt] = 'not-a-number'; }
    const check = addRow(values);
    expect(check.current.issues.length).toBeGreaterThan(0);
    expect(verifyBidMoneyClaims([{ response: check.response, sources: check.refs }], check.current).passed).toBe(false);
    expect(() => assertBidMoneyClaims([{ response: check.response, sources: check.refs }], check.current)).toThrow(BidMoneyVerificationError);
  });

  it.each(['empty', 'gross-only'] as const)('keeps a genuinely auxiliary %s row outside quotation arithmetic and preserves only its declared amount', mode => {
    const values = lineNet.source.quote.split(','); values[0] = 'AUXILIARY';
    for (const index of [quantityAt, unitAt, netAt, taxAt, grossAt]) values[index] = '';
    if (mode === 'gross-only') values[grossAt] = sources.find(source => source.quote.includes('不得当成我方报价'))!.quote.split(',')[grossAt];
    const check = addRow(values);
    expect(check.current.issues).toEqual([]);
    expect(check.current.facts.some(fact => fact.rowKey === 'AUXILIARY' && fact.role !== 'auxiliary')).toBe(false);
    expect(check.current.facts.filter(fact => fact.rowKey === 'AUXILIARY' && fact.role === 'auxiliary')).toHaveLength(mode === 'gross-only' ? 1 : 0);
    expect(verifyBidMoneyClaims([{ response: check.response, sources: check.refs }], check.current)).toMatchObject({ passed: true, code: 'closed_fields_checked', claimCount: 1 });
  });
});


describe('the closed table gate does not replace ordinary monetary drafting', () => {
  const materials = [{ id: 'ordinary-payment', title: 'Unstructured payment terms', content: '合同约定价款为240000元，分期支付安排和付款条件仍待责任人核对。' }];
  const refs = buildMaterialSources(materials), noTable = buildBidMoneyContract(materials, refs);

  it('keeps ordinary monetary prose outside the closed-table verified subset without blocking its generation', () => {
    expect(noTable.tableCount).toBe(0);
    expect(noTable.required).toBe(true);
    expect(noTable.facts).toEqual([]);
    expect(noTable.issues.length).toBeGreaterThan(0);
    const response = '以下只是拟议付款演算：第一期120000元、第二期120000元，合计240000元；基数、税基及付款触发条件仍须责任人核对，未作金额事实核准。';
    const candidate = { response, missing: '金额和付款条件待核验', sources: refs };
    expect(verifyBidMoneyClaims([candidate], noTable)).toMatchObject({ passed: true, code: 'not_applicable', claimCount: 0 });
    expect(assertBidMoneyClaims([candidate], noTable)[0].monetaryResponse).toBe(response);
  });

  it.each(['【F1|含税合计:240000元】', '【F1|含税合计】'])('does not publish an internal monetary token without a supported source table: %s', response => {
    expect(verifyBidMoneyClaims([{ response, sources: refs }], noTable).passed).toBe(false);
    expect(() => assertBidMoneyClaims([{ response, sources: refs }], noTable)).toThrow(BidMoneyVerificationError);
  });

  it('counts an exact recognized header before rejecting malformed source rows', () => {
    const quote = originals.materials.find(item => item.id === totalGross.source.materialId)!;
    const corrupted = [{ ...quote, content: quote.content.replace(lineNet.source.quote, lineNet.source.quote.replace(lineNet.amount, 'invalid-number')) }];
    const currentRefs = buildMaterialSources(corrupted), bad = buildBidMoneyContract(corrupted, currentRefs);
    expect(bad.tableCount).toBe(1);
    expect(bad.facts).toEqual([]);
    expect(bad.issues.length).toBeGreaterThan(0);
    expect(verifyBidMoneyClaims([{ response: actual.review.response, sources: currentRefs }], bad).passed).toBe(false);
  });
});


describe('quote applicability follows the actual complete source records, not every monetary sentence', () => {
  const captured = unit3Captured.entries.find(item => item.sectionId === 'F78')!;

  it('preserves the exact captured historical-performance statement without treating it as a verified quotation field', () => {
    const candidate = entry(captured.response, captured.sourceIds);
    expect(contract.tableCount).toBe(1);
    expect(candidate.sources.every(source => !contract.tableSources.some(table => table.id === source.id))).toBe(true);
    expect(verifyBidMoneyClaims([candidate], contract)).toMatchObject({ passed: true, code: 'not_applicable', claimCount: 0 });
    expect(assertBidMoneyClaims([candidate], contract)[0].monetaryResponse).toBe(captured.response);
  });

  it.each(['bad-decimal', 'missing-delimiter'] as const)('keeps later physical source rows scoped after an earlier %s row makes the table invalid', mode => {
    const material = originals.materials.find(item => item.id === totalGross.source.materialId)!;
    const first = lineNet.source.quote.split(','), columns = totalGross.header.quote.split(',');
    first[columns.indexOf('未税金额元')] = 'bad'; first[columns.indexOf('税额元')] = 'bad';
    const badRow = mode === 'missing-delimiter' ? lineNet.source.quote.replace(/,/g, '') : first.join(',');
    const materials = [{ ...material, content: material.content.replace(lineNet.source.quote, badRow) }];
    const refs = buildMaterialSources(materials), invalid = buildBidMoneyContract(materials, refs);
    const later = contract.facts.find(fact => fact.role === 'line' && fact.basis === 'net' && fact.source.id !== lineNet.source.id)!;
    const selected = refs.find(source => source.quote === later.source.quote)!;
    expect(invalid.facts).toEqual([]);
    expect(invalid.tableSources).toEqual(expect.arrayContaining([selected]));
    expect(verifyBidMoneyClaims([{ response: '未税金额' + later.amount + '元。', sources: [selected] }], invalid).passed).toBe(false);
  });

  it('does not use an ID-only or stale row quote as a non-quotation escape', () => {
    const stale: Source = { ...totalGross.source, quote: totalGross.source.quote + ' stale' };
    expect(verifyBidMoneyClaims([{ response: '含税合计' + totalGross.amount + '元。', sources: [stale] }], contract).passed).toBe(false);
    const headerOnly = entry('含税合计' + totalGross.amount + '元。', [totalGross.header.id]);
    expect(verifyBidMoneyClaims([headerOnly], contract).passed).toBe(false);
  });

  it('still validates an internal field even when the entry has no quotation source selected', () => {
    expect(verifyBidMoneyClaims([entry(field(totalGross, '含税合计'), captured.sourceIds)], contract).passed).toBe(false);
  });

  it('keeps an unresolved mixed quote and historical-money paragraph pending instead of inventing an amount-role classifier', () => {
    const response = captured.response + '；' + field(totalGross, '含税合计');
    expect(verifyBidMoneyClaims([entry(response, [...captured.sourceIds, totalGross.source.id])], contract).passed).toBe(false);
  });
});


describe('source-only auxiliary amounts never become quotation arithmetic', () => {
  const material = originals.materials.find(item => item.id === totalGross.source.materialId)!;
  const auxSource = sources.find(source => source.quote.includes('不得当成我方报价'))!;

  it('retains the exact auxiliary source row and renders its full original label without assigning a quotation tax basis', () => {
    const auxiliary = contract.facts.find(fact => fact.source.id === auxSource.id && fact.role === 'auxiliary')!;
    const columns = auxiliary.header.quote.split(',');
    expect(auxiliary).toMatchObject({ source: auxSource, header: totalGross.header, role: 'auxiliary', basis: 'source', column: columns.indexOf('含税金额元') + 1 });
    expect(auxiliary.amount).toBe(auxSource.quote.split(',')[columns.indexOf('含税金额元')]);
    expect(auxiliary.rowLabel).toBe(auxSource.quote.split(',')[columns.indexOf('服务项目')]);
    expect(auxiliary.materialSha256).toBe(crypto.createHash('sha256').update(material.content).digest('hex'));
    const candidate = entry(field(auxiliary, '原表附列金额'), [auxSource.id]);
    expect(verifyBidMoneyClaims([candidate], contract)).toMatchObject({ passed: true, code: 'closed_fields_checked', claimCount: 1 });
    const [rendered] = assertBidMoneyClaims([candidate], contract);
    expect(rendered.response).toBe(candidate.response);
    expect(rendered.monetaryResponse).toBe(auxSource.title + '中的“' + auxiliary.rowLabel + '”（原表附列金额）：' + auxiliary.amount + '元');
    expect(rendered.monetaryResponse).not.toContain('【' + auxSource.id + '|');
    expect(contract.uniqueTableTotalSourceId).toBe(totalGross.source.id);
  });

  it.each(['未税单价', '未税金额', '税额', '含税金额', '未税合计', '税额合计', '含税合计'])('does not consume an auxiliary source as a quotation %s field', label => {
    const auxiliary = contract.facts.find(fact => fact.source.id === auxSource.id && fact.role === 'auxiliary')!;
    expect(verifyBidMoneyClaims([entry(field(auxiliary, label), [auxSource.id])], contract).passed).toBe(false);
  });

  const input = (prefix: string, mode = '') => {
    const content = '代号,税额元,含税金额元,服务项目,数量,未税金额元,未税单价元\n'
      + prefix + '-a,,7.30,原表附注甲,,,\n'
      + prefix + '-b,,' + (mode === 'bad-aux-value' ? 'bad' : '9.40') + ',原表附注乙,,,\n'
      + prefix + '-d,0.12,2.12,任意服务,2,' + (mode === 'bad-core-row' ? 'bad' : '2.00') + ',1.00\n'
      + prefix + '-t,0.12,2.12,报价合计,,2.00,\n';
    const materials = [{ id: 'independent-auxiliary', title: 'Independent physical source', content }];
    const refs = buildMaterialSources(materials);
    return { materials, refs, current: buildBidMoneyContract(materials, refs) };
  };

  it('binds an auxiliary amount to that same source row rather than another auxiliary with a different value', () => {
    const value = input('different-rows');
    const first = value.current.facts.find(fact => fact.rowKey.endsWith('-a'))!;
    const second = value.current.facts.find(fact => fact.rowKey.endsWith('-b'))!;
    expect(value.current.issues).toEqual([]);
    expect(first.amount).not.toBe(second.amount);
    expect(verifyBidMoneyClaims([{ response: field(first, '原表附列金额', second.amount), sources: [first.source, second.source] }], value.current).passed).toBe(false);
    expect(verifyBidMoneyClaims([{ response: field(first, '原表附列金额'), sources: [first.source] }], value.current).passed).toBe(true);
  });

  it.each(['bad-core-row', 'bad-aux-value'])('publishes no auxiliary fact from a table whose %s fails actual validation', mode => {
    const value = input('unverified', mode);
    const physicalAux = value.refs.find(source => source.quote.startsWith('unverified-a,'))!;
    expect(value.current.issues.length).toBeGreaterThan(0);
    expect(value.current.facts).toEqual([]);
    expect(value.current.tableSources).toEqual(expect.arrayContaining([physicalAux]));
    expect(verifyBidMoneyClaims([{ response: '【' + physicalAux.id + '|原表附列金额:7.30元】', sources: [physicalAux] }], value.current).passed).toBe(false);
  });

  it.each(['unfamiliar-code', 'Q9'])('preserves source-only roles under arbitrary row code %s and reordered columns', prefix => {
    const value = input(prefix);
    expect(value.current.issues).toEqual([]);
    const auxiliaries = value.current.facts.filter(fact => fact.role === 'auxiliary');
    expect(auxiliaries).toHaveLength(2);
    expect(auxiliaries.every(fact => fact.basis === 'source')).toBe(true);
    const total = value.current.facts.find(fact => fact.role === 'total' && fact.basis === 'gross')!;
    expect(total.amount).toBe('2.12');
    expect(value.current.uniqueTableTotalSourceId).toBe(total.source.id);
    for (const auxiliary of auxiliaries) {
      expect(verifyBidMoneyClaims([{ response: field(auxiliary, '原表附列金额'), sources: [auxiliary.source] }], value.current).passed).toBe(true);
    }
  });

  it('does not let surrounding project-total prose relabel a valid auxiliary field', () => {
    const auxiliary = contract.facts.find(fact => fact.source.id === auxSource.id && fact.role === 'auxiliary')!;
    expect(verifyBidMoneyClaims([entry('项目总价以' + field(auxiliary, '原表附列金额') + '为基准。', [auxSource.id])], contract).passed).toBe(false);
  });

  it.each(['total', 'line', 'unit'] as const)('does not reinterpret a real quotation %s source as auxiliary', role => {
    const fact = contract.facts.find(item => item.role === role && item.basis === 'net')!;
    expect(verifyBidMoneyClaims([entry(field(fact, '原表附列金额'), [fact.source.id])], contract).passed).toBe(false);
  });
});
