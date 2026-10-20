import { readImplementationSource } from './implementation_source';
import { packetDraftFixture } from './legal_packet_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {installCivilCodeFixture,installMetadataOnlyFixtures,resetAuthorityFixture} from './fixtures/legal_authority_fixture';
beforeEach(()=>{resetAuthorityFixture();installCivilCodeFixture();});
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { legalToolDefinitions } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getWebLoginSitePreset, listWebLoginSitePresets } from '../server/web_login/legal_presets';

let cleanup = () => {};
let originalOpenAIKey: string | undefined;
let registerLegalTools: (registry: ToolRegistry) => void;
let registerWebLoginTools: (registry: ToolRegistry) => void;

beforeAll(async () => {
  originalOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  const app = await makeApp();
  cleanup = app.cleanup;
  ({ registerLegalTools } = await import('../server/tools/definitions/legal_tools'));
  ({ registerWebLoginTools } = await import('../server/tools/definitions/web_login_tools'));
});

afterAll(() => {
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  cleanup();
});

function createLegalRegistry() {
  const registry = new ToolRegistry();
  registerLegalTools(registry);
  return registry;
}

async function packetModelContext() {
  const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
  upsertUserPreferredLLM('vitest', { provider: 'relay', model: 'synthetic-packet-positive', selectionMode: 'pinned' });
  const create = vi.fn((request: any, options: any) => {
    const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
    const content = prompt.includes('## 当前文书\n')
      ? packetDraftFixture(prompt, { baseName: JSON.parse(prompt.split('## 当前文书\n')[1]).baseName, markdown: '仅作给定材料的条件分析；合同关系、实际交付与付款、主体及日期均尚待核验；未提供不代表没有约定或事实不存在，完整法律依据仍待核验。' })
      : { documents: JSON.parse(prompt.split('文书列表：')[1]).map((document: any) => ({ baseName: document.baseName, complete: true, unresolved: [], corrections: [] })) };
    return sdkCompletion(request, { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }, 0, options.signal);
  });
  return { create, context: { userId: 'vitest', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local' as const,
    source: 'legal-direct-tool', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } } };
}

async function reasoningModelContext() {
  const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
  upsertUserPreferredLLM('vitest', { provider: 'relay', model: 'synthetic-source-reasoning-positive', selectionMode: 'pinned' });
  const create = vi.fn((request: any, options: any) => {
    const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
    const statement = '需核实原件、付款条件与质量主张，证据尚待补证并由律师核验；不以陈述代替已证事实。';
    let content: any;
    if (prompt.includes('你是法律适用复核者')) {
      const entries = JSON.parse(prompt.split('\n待复核分析：')[1]);
      content = { reviews: entries.map((entry: any) => ({ index: entry.index, ruleId: entry.ruleId, checks: entry.checks })), uncoveredIssues: [] };
    } else if (prompt.includes('你在编写供律师复核的法律分析')) {
      const rules = JSON.parse(prompt.match(/^法条（同条各parts按原文次序合读）：(.+)$/m)![1]);
      const sources = JSON.parse(prompt.split('\n材料：')[1]);
      content = { entries: [{ issue: '争议焦点及法律分析：付款条件与质量主张核对', ruleId: rules[0].id,
        checks: rules[0].parts.map((part: any) => ({ partId: part.id, sourceIds: sources.map((source: any) => source.id),
          status: 'conditional', application: statement, conclusion: statement, missingPremises: ['原件及本案付款、质量对应关系尚待核实'] })) }] };
    } else {
      const sources = JSON.parse(prompt.split('\n材料：')[1]);
      content = { entries: [{ issue: '待核实原告付款主张及被告质量异议所涉问题', sourceIds: sources.map((source: any) => source.id) }] };
    }
    return sdkCompletion(request, { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }, 0, options.signal);
  });
  return { create, context: { userId: 'vitest', authenticated: true, authRole: 'user', localExecution: true,
    executionBoundary: 'trusted_local' as const, source: 'legal-direct-tool',
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } } };
}

async function traceableDeliveryInput(orgId: string, conclusion: string, caseId?: string, caseName = '有来源的交付测试案') {
  const cases = await import('../server/org/legal_cases');
  const { verifyCitation } = await import('../server/legal/kb');
  const caseFile = caseId ? cases.getCase(orgId, caseId)! : cases.createCase(orgId, 'vitest', { title: caseName });
  const source = cases.addMaterial(orgId, 'vitest', caseFile.id, { type: 'evidence', title: '虚构原始合同及签收记录', source: 'manual',
    content: '虚构合同及签收记录记载原告已经供货，被告签收后尚未支付剩余货款，违约金需要另行核算。' })!;
  return { caseId: caseFile.id, factDate: '2026-01-15', reasoningLinks: [{ issue: '虚构交易欠付款项与违约金的审查', ruleCitation: '《民法典》第五百八十五条',
    ruleQuote: verifyCitation('《民法典》第五百八十五条').sourceText!, fact: source.content,
    evidence: [{ materialId: source.id, quote: source.content, locator: '测试材料第1段' }],
    application: '需要结合合同约定及实际损失核算，付款及违约责任须以完整证据核实为条件。', conclusion,
    limitations: '仅测试关联来源，不判断法律适用或证据真实性；实际意见需要律师复核。' }] };
}

describe('semi-automated legal workflows', () => {
  it('drafts plaintiff litigation packets with manual filing gates', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_litigation_packet', {
      caseName: 'Sales Contract Case',
      role: 'plaintiff',
      caseType: '买卖合同纠纷',
      court: '上海市黄浦区人民法院',
      parties: 'Plaintiff: Alpha Trading Co.; Defendant: Beta Retail Co.',
      claims: '请求支付货款及违约金',
      facts: '2026年1月签订买卖合同，Alpha 已供货，Beta 尚欠货款 350000 元。',
      evidence: '合同、订单、发货单、签收单、发票、银行流水。',
    });

    expect(output).toContain('Sales Contract Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toMatch(/起诉状|要素式诉状|诉讼文书包/);
    expect(output).toMatch(/证据目录|证明目的/);
    expect(output).toMatch(/三性审查|真实性|合法性|关联性/);
    expect(output).toMatch(/缺口|补强|质证风险/);
    expect(output).toMatch(/律师|人工|确认/);
    expect(output).toContain('法律成果预检');
    expect(output).toContain('现行有效法律预检');
    expect(output).toContain('人民法院在线服务');
    expect(output).toContain('https://zxfw.court.gov.cn/');
    expect(output).toMatch(/律师人工核对/);
    expect(output).not.toMatch(/web_login_run|web_login_profile_save_from_preset|已提交|立案成功/);
    expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
  });

  it('drafts defendant response packets without auto-submitting anything', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_litigation_packet', {
      caseName: 'Defense Contract Case',
      role: 'defendant',
      caseType: '买卖合同纠纷',
      facts: '原告主张被告拖欠货款，但货物存在严重质量问题且双方曾协商退货。',
      evidence: '验收异议函、聊天记录、退货沟通记录、原告起诉状。',
      opponentMaterials: '原告起诉状、证据目录、合同复印件。',
    });

    expect(output).toContain('Defense Contract Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toMatch(/答辩状|质证意见/);
    expect(output).toMatch(/真实性|合法性|关联性|证明目的/);
    expect(output).toMatch(/程序抗辩|时效|主体资格/);
    expect(output).toMatch(/提交|签字|盖章|发送/);
    expect(output).toMatch(/律师|人工|确认/);
    expect(output).toContain('法律成果预检');
  });

  it('writes litigation packet files and archives the packet path into the case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-litigation-files-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_litigation_packet_'));
    const caseName = '诉讼文书包文件输出测试案';

    const sdk = await packetModelContext();
    try {
      const output = await registry.execute('legal_generate_litigation_packet', {
        orgId,
        userId: 'vitest',
        caseName,
        role: '原告',
        caseType: '买卖合同纠纷',
        court: '上海市黄浦区人民法院',
        parties: '原告 Alpha；被告 Beta',
        claims: '请求支付货款及违约金',
        facts: '被告收货后未付剩余货款。',
        evidence: '买卖合同；送货单；签收单；银行流水。',
        outputDir: dir,
      }, sdk.context);

      const packetPath = path.join(dir, '00_litigation-packet.md');
      const filingChecklistPath = path.join(dir, '01_filing-material-checklist.md');
      const authorizationChecklistPath = path.join(dir, '02_authorization-checklist.md');
      const evidenceMatrixPath = path.join(dir, '03_evidence-review-matrix.md');
      const complaintPath = path.join(dir, '10_civil-complaint.md');
      const elementComplaintPath = path.join(dir, '11_element-complaint.md');
      const engagementPath = path.join(dir, '12_engagement-agreement.md');
      const powerOfAttorneyPath = path.join(dir, '12_power-of-attorney.md');
      const lawFirmLetterPath = path.join(dir, '12_law-firm-letter.md');
      const serviceAddressPath = path.join(dir, '15_service-address-confirmation.md');
      const evidenceCatalogPath = path.join(dir, '16_evidence-catalog.md');
      const manifestPath = path.join(dir, '99_manifest.md');

      expect(output).toContain('诉讼文书包文件输出');
      for (const file of [packetPath, filingChecklistPath, authorizationChecklistPath, evidenceCatalogPath, manifestPath]) expect(output).toContain(file);
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
      expect(sdk.create).toHaveBeenCalledTimes(4);
      expect(fs.readdirSync(dir).filter(name => name.endsWith('.md'))).toHaveLength(11);
      expect(fs.readdirSync(dir).filter(name => name.endsWith('.docx'))).toHaveLength(11);
      expect(output).toContain('DOCX 生成：全部成功');
      expect(fs.existsSync(packetPath)).toBe(true);
      expect(fs.existsSync(filingChecklistPath)).toBe(true);
      expect(fs.existsSync(authorizationChecklistPath)).toBe(true);
      expect(fs.existsSync(evidenceMatrixPath)).toBe(false);
      expect(fs.existsSync(complaintPath)).toBe(true);
      expect(fs.existsSync(elementComplaintPath)).toBe(true);
      expect(fs.existsSync(engagementPath)).toBe(true);
      expect(fs.existsSync(powerOfAttorneyPath)).toBe(true);
      expect(fs.existsSync(lawFirmLetterPath)).toBe(true);
      expect(fs.existsSync(serviceAddressPath)).toBe(true);
      expect(fs.existsSync(evidenceCatalogPath)).toBe(true);
      expect(fs.existsSync(manifestPath)).toBe(true);
      expect(fs.readFileSync(filingChecklistPath, 'utf8')).toContain('Filing Material Checklist');
      expect(fs.readFileSync(authorizationChecklistPath, 'utf8')).toContain('Authorization Checklist');
      for (const label of ['真实性：', '合法性：', '关联性：']) expect(fs.readFileSync(evidenceCatalogPath, 'utf8')).toContain(label);
      expect(fs.readFileSync(evidenceCatalogPath, 'utf8')).toContain('买卖合同；送货单；签收单；银行流水。');
      const complaint = fs.readFileSync(complaintPath, 'utf8');
      expect(complaint).toContain('民事起诉状（系统草稿）');
      expect(complaint).toContain('尚待核验');
      expect(complaint).toContain('正式交付前必须完成');
      expect(complaint).toContain('原告 Alpha；被告 Beta');
      expect(complaint).toContain('请求支付货款及违约金');
      expect(complaint).toContain('F1；');
      expect(complaint).toContain('买卖合同；送货单；签收单；银行流水。');
      expect(complaint).not.toMatch(/《[^》]+》第/);
      expect(fs.readFileSync(elementComplaintPath, 'utf8')).toContain('要素式诉状（系统草稿）');
      expect(fs.readFileSync(engagementPath, 'utf8')).toContain('委托代理合同（系统草稿）');
      expect(fs.readFileSync(powerOfAttorneyPath, 'utf8')).toContain('特别授权');
      expect(fs.readFileSync(lawFirmLetterPath, 'utf8')).toContain('律师事务所函（系统草稿）');
      expect(fs.readFileSync(serviceAddressPath, 'utf8')).toContain('电子送达意愿');
      expect(fs.readFileSync(evidenceCatalogPath, 'utf8')).toContain('原告证据目录（系统草稿）');
      expect(fs.readFileSync(manifestPath, 'utf8')).toContain('尚未通过正式交付核验');

      for (const baseName of [
        '00_litigation-packet',
        '10_civil-complaint',
        '11_element-complaint',
        '12_engagement-agreement',
        '12_power-of-attorney',
        '12_law-firm-letter',
        '15_service-address-confirmation',
        '16_evidence-catalog',
        '99_manifest',
      ]) {
        const docxPath = path.join(dir, `${baseName}.docx`);
        expect(fs.existsSync(docxPath), `${baseName}.docx should exist`).toBe(true);
        expect(fs.statSync(docxPath).size, `${baseName}.docx should not be empty`).toBeGreaterThan(1000);
      }

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'tool'
        && material.type === 'pleading'
        && material.title.includes('半自动诉讼文书包')
        && material.localPath === packetPath
      ))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['no-model', 'no-goal'])('keeps an incomplete %s packet unarchived even when persistence is requested', async mode => {
    const registry = createLegalRegistry();
    const caseName = 'Synthetic incomplete packet ' + mode + '-' + crypto.randomUUID();
    const orgId = 'partial-packet-' + crypto.randomUUID();
    const sdk = await packetModelContext();
    const output = await registry.execute('legal_generate_litigation_packet', {
      orgId, userId: 'vitest', caseName, role: 'plaintiff', parties: '虚构甲公司/虚构乙公司',
      facts: '甲方自述已付款，合同原件与入账日期待核验。', evidence: '仅提供虚构回单文字摘录；原件、主体和关联待核验。',
      ...(mode === 'no-model' ? { claims: '仅请求核对交货条件，不增加欠款或退款诉请。' } : {}),
      persistCase: true, writeFiles: false,
    }, mode === 'no-goal' ? sdk.context : { userId: 'vitest', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', source: 'legal-direct-tool' });
    expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(output).not.toContain('案件空间：已归档');
    expect(sdk.create).not.toHaveBeenCalled();
    const cases = await import('../server/org/legal_cases');
    expect(cases.listCases(orgId, caseName, 10, 'vitest')).toHaveLength(0);
  });

  it('writes separate defendant answer, cross-examination, procedural, and authorization documents', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_defendant_packet_'));

    const sdk = await packetModelContext();
    try {
      const output = await registry.execute('legal_generate_litigation_packet', {
        orgId: `test-legal-defendant-files-${Date.now()}`,
        userId: 'vitest',
        caseName: '被告独立文书输出测试案',
        role: '被告',
        caseType: '买卖合同纠纷',
        court: '上海市黄浦区人民法院',
        parties: '被告 Beta；原告 Alpha',
        claims: '请求驳回原告缺乏事实和证据依据的诉讼请求',
        facts: '被告认为货物存在质量问题，双方曾协商退货。',
        evidence: '质量异议函；退货沟通记录；检测记录。',
        opponentMaterials: '原告起诉状；合同复印件；送货单。',
        outputDir: dir,
      }, sdk.context);

      expect(output).toContain('DOCX 生成：全部成功');
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
      expect(sdk.create).toHaveBeenCalledTimes(8);
      const expected = [
        ['20_statement-of-defense', '民事答辩状（系统草稿）'],
        ['21_cross-examination-opinion', '质证意见（系统草稿）'],
        ['22_procedural-defense-checklist', '程序抗辩检查表（系统草稿）'],
        ['23_argument-outline', '代理词工作稿（系统草稿）'],
        ['24_engagement-agreement', '委托代理合同（系统草稿）'],
        ['24_power-of-attorney', '授权委托书（系统草稿）'],
        ['24_law-firm-letter', '律师事务所函（系统草稿）'],
        ['27_evidence-catalog', '被告证据目录与反证矩阵（系统草稿）'],
      ];

      for (const [baseName, heading] of expected) {
        const markdownPath = path.join(dir, `${baseName}.md`);
        const docxPath = path.join(dir, `${baseName}.docx`);
        expect(fs.existsSync(markdownPath), `${baseName}.md should exist`).toBe(true);
        expect(fs.readFileSync(markdownPath, 'utf8')).toContain(heading);
        expect(fs.existsSync(docxPath), `${baseName}.docx should exist`).toBe(true);
        expect(fs.statSync(docxPath).size, `${baseName}.docx should not be empty`).toBeGreaterThan(1000);
      }

      const answer = fs.readFileSync(path.join(dir, '20_statement-of-defense.md'), 'utf8');
      expect(answer).toContain('逐项答辩意见');
      expect(answer).toContain('完整法律依据仍待核验');
      for (const original of ['被告认为货物存在质量问题，双方曾协商退货。', '原告起诉状；合同复印件；送货单。', '请求驳回原告缺乏事实和证据依据的诉讼请求']) {
        expect(sdk.create.mock.calls.some(([request]) => String(request.messages.find((message: any) => message.role === 'user')?.content || '').includes(original))).toBe(true);
      }
      expect(answer).not.toContain('法律适用自动复核已完成');
      expect(answer).not.toMatch(/《[^》]+》第/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts source-bound dispute questions through the configured SDK and keeps no-model input incomplete', async () => {
    const registry = createLegalRegistry(); const cases = await import('../server/org/legal_cases');
    const orgId = 'focus-source-positive-' + crypto.randomUUID();
    const args = { orgId, userId: 'vitest', caseName: 'Trial Focus Case', role: 'defendant', caseType: '买卖合同纠纷',
      complaint: '原告称双方合同成立，被告拖欠货款并应承担违约金。',
      evidence: '合同、发货单、签收单、质量异议函、聊天记录。',
      transcript: '庭审中双方争议付款条件是否成就、质量异议是否成立、违约金是否过高。' };
    const sdk = await reasoningModelContext();
    const output = await registry.execute('legal_extract_dispute_focus', args, sdk.context);
    expect(decodeToolResult(output).receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(output).toContain('Trial Focus Case'); expect(output).toContain('拟检索问题');
    for (const original of [args.complaint, args.evidence, args.transcript]) expect(output).toContain(original);
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄|legal_finalize_delivery_package/);
    expect(output).toContain('尚未开展外部检索'); expect(output).toMatch(/律师|复核|确认/);
    const noModelArgs = { ...args, orgId: orgId + '-no-model', caseName: 'No model focus', persistCase: true };
    const partial = await registry.execute('legal_extract_dispute_focus', noModelArgs);
    expect(decodeToolResult(partial).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(partial).toContain('归集未完成'); expect(partial).not.toContain('案件空间：已归档');
    for (const original of [args.complaint, args.evidence, args.transcript]) expect(partial).toContain(original);
    expect(cases.listCases(noModelArgs.orgId, noModelArgs.caseName, 10, 'vitest')).toHaveLength(0);
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it('creates unified legal case workspaces with case state and search order', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workspace-${Date.now()}`;

    const rawOutput = await registry.execute('legal_case_workspace', {
      orgId,
      userId: 'vitest',
      caseName: '统一案件工作台测试案',
      stage: '立案',
      role: '原告',
      caseType: '买卖合同纠纷',
      court: '上海市黄浦区人民法院',
      parties: '原告 Alpha Trading Co.; 被告 Beta Retail Co.',
      claims: '请求支付货款及违约金',
      facts: '2026年1月签订买卖合同，被告收货后未按约付款。',
      evidence: '买卖合同；送货单；微信催款记录；银行流水',
      legalAuthorities: '拟引用《民法典》第五百八十五条。',
    });
    const output = decodeToolResult(rawOutput).content;

    expect(output).toContain('案件工作台');
    const CaseStore = await import('../server/org/legal_cases');
    const createdCases = CaseStore.listCases(orgId, "统一案件工作台测试案", 50, 'vitest')
      .filter(item => item.title === "统一案件工作台测试案");
    expect(createdCases).toHaveLength(1);
    const createdCase = createdCases[0];
    expect(createdCase).toMatchObject({ orgId, title: "统一案件工作台测试案", createdBy: 'vitest' });
    expect(createdCase.materials).toHaveLength(3);
    expect(output).toContain(createdCase.title);
    expect(output).toContain(`案件现有材料：共 ${createdCase.materials.length} 份`);
    expect(output).not.toContain(createdCase.id);
    expect(output).not.toContain(orgId);
    for (const material of createdCase.materials) {
      expect(output).not.toContain(material.id);
    }
    expect(output).toContain('闭环状态');
    expect(output).toContain('完成度：');
    expect(output).toContain('下一动作：');
    expect(output).not.toContain('推荐工具');
    expect(output).toContain('优先行动队列');
    expect(output).toContain('| 顺位 | 模块 | 状态 | 下一步 |');
    expect(output).not.toContain('Standard Legal Casework Sequence');
    expect(output).not.toContain('Intake / case space');
    expect(output).not.toContain('Major premise');
    expect(output).not.toContain('Minor premise');
    expect(output).not.toContain('Conclusion / subsumption');
    expect(output).not.toContain('Current-law gate');
    expect(output).not.toContain('legal_message_intake_to_case -> legal_case_workspace');
    expect(output).not.toContain('legal_generate_citation_verification_report -> legal_finalize_delivery_package');
    expect(output).toContain('三段论分析');
    expect(output).toContain('尚未形成完整法律分析底稿');
    expect(output).toContain('证据目录与三性审查矩阵');
    expect(output).toContain('三性审查矩阵');
    expect(output).toContain('真实性核验');
    expect(output).toContain('合法性核验');
    expect(output).toContain('关联性核验');
    expect(output).toContain('现行有效法律');
    expect(output).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
    expect(output).not.toContain('legal_case_reasoning_matrix');
    expect(output).not.toContain('legal_generate_litigation_packet');
    expect(output).not.toContain('legal_finalize_delivery_package');
    expect(output).toContain('人民法院在线服务');
  });

  it('marks blocked current-law steps in the case workflow state machine', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workflow-block-${Date.now()}`;

    const rawOutput = await registry.execute('legal_case_workspace', {
      orgId,
      userId: 'vitest',
      caseName: '闭环阻断测试案',
      role: '原告',
      caseType: '买卖合同纠纷',
      parties: '原告 Alpha；被告 Beta',
      facts: '双方签订买卖合同，被告收货后未付款。',
      evidence: '买卖合同；送货单；银行流水',
      legalAuthorities: '拟引用《合同法》第六十条作为请求权基础。',
    });
    const output = decodeToolResult(rawOutput).content;

    expect(output).toContain('闭环状态');
    expect(output).toContain('阻断项：');
    expect(output).toMatch(/\| 现行有效法律 \| 阻断 \|/);
    expect(output).toContain('合同法');
    expect(output).not.toContain('legal_search_statute / legal_generate_citation_verification_report');
    expect(output).toContain('正式交付');
    expect(output).not.toContain('正式交付包已生成');
  });

  it('reports legal case workflow status without creating work products', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workflow-status-${Date.now()}`;

    const workspace = await registry.execute('legal_case_workspace', {
      orgId,
      userId: 'vitest',
      caseName: '直接状态查询测试案',
      role: '原告',
      caseType: '买卖合同纠纷',
      parties: '原告 Alpha；被告 Beta',
      facts: '双方签订买卖合同，被告收货后未付款。',
      evidence: '买卖合同；送货单；银行流水',
    });
    const CaseStore = await import('../server/org/legal_cases');
    const createdCases = CaseStore.listCases(orgId, "直接状态查询测试案", 50, 'vitest')
      .filter(item => item.title === "直接状态查询测试案");
    expect(createdCases).toHaveLength(1);
    const createdCase = createdCases[0];
    expect(createdCase).toMatchObject({ orgId, title: "直接状态查询测试案", createdBy: 'vitest' });
    expect(createdCase.materials).toHaveLength(2);
    const caseId = createdCase.id;
    expect(caseId).toBeTruthy();

    const rawOutput = await registry.execute('legal_case_workflow_status', {
      orgId,
      caseId,
      legalAuthorities: '拟引用《合同法》第六十条。',
    });
    const output = decodeToolResult(rawOutput).content;

    expect(output).toContain('案件闭环状态');
    expect(output).toContain('直接状态查询测试案');
    expect(output).toContain(createdCase.title);
    expect(output).toContain(`案件现有材料：共 ${createdCase.materials.length} 份`);
    expect(output).not.toContain(createdCase.id);
    expect(output).not.toContain(orgId);
    for (const material of createdCase.materials) {
      expect(output).not.toContain(material.id);
    }
    expect(decodeToolResult(workspace).content).not.toContain(caseId);
    expect(CaseStore.getCase(orgId, caseId, 'vitest')?.materials).toEqual(createdCase.materials);
    expect(output).toContain('完成度：');
    expect(output).toContain('下一动作：');
    expect(output).toContain('优先行动队列');
    expect(output).toContain('| 顺位 | 模块 | 状态 | 下一步 |');
    expect(output).not.toContain('Standard Legal Casework Sequence');
    expect(output).not.toContain('Major premise');
    expect(output).not.toContain('Minor premise');
    expect(output).not.toContain('Conclusion / subsumption');
    expect(output).not.toContain('Current-law gate');
    expect(output).toMatch(/\| 现行有效法律 \| 阻断 \|/);
    expect(output).toContain('合同法');
    expect(output).not.toContain('正式交付包已生成');
  });

  it('archives filing handoffs and delivery packages into the same legal case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-archive-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_archive_'));

    try {
      const workspace = await registry.execute('legal_case_workspace', {
        orgId,
        userId: 'vitest',
        caseName: '案件归档闭环测试案',
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '被告收货后未付款。',
        evidence: '合同；送货单；银行流水',
      });
      const CaseStore = await import('../server/org/legal_cases');
      const createdCases = CaseStore.listCases(orgId, "案件归档闭环测试案", 50, 'vitest')
        .filter(item => item.title === "案件归档闭环测试案");
      expect(createdCases).toHaveLength(1);
      const createdCase = createdCases[0];
      expect(createdCase).toMatchObject({ orgId, title: "案件归档闭环测试案", createdBy: 'vitest' });
      expect(createdCase.materials).toHaveLength(2);
      const caseId = createdCase.id;
      expect(decodeToolResult(workspace).content).toContain(createdCase.title);
      expect(decodeToolResult(workspace).content).not.toContain(caseId);
      expect(caseId).toBeTruthy();

      const filing = await registry.execute('legal_prepare_filing_handoff', {
        orgId,
        userId: 'vitest',
        caseId,
        caseName: '案件归档闭环测试案',
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '被告收货后未付款。',
        evidence: '合同；送货单；银行流水',
      });
      expect(filing).toContain('已归档到案件空间');
      expect(filing).toContain('法律成果预检');

      const delivery = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        ...await traceableDeliveryInput(orgId, '被告应承担违约责任。', caseId),
        orgId,
        userId: 'vitest',
        caseId,
        caseName: '案件归档闭环测试案',
        documentType: '代理词',
        outputDir: dir,
        reasoningMatrix: 'Major premise: The cited civil statute provides a contractual damages remedy subject to proof.\nMinor premise: The synthetic contract and delivery records show an unpaid obligation.\nConclusion: Apply the contractual damages provision to proven delivery and nonpayment, subject to lawyer review.',
        includeDocx: false,
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条，被告应承担违约责任。',
        ].join('\n'),
      });
      expect(delivery).toContain('案件空间：已归档正式交付包');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.getCase(orgId, caseId!);
      expect(caseFile?.materials.some(material => material.title.includes('半自动立案交接单'))).toBe(true);
      expect(caseFile?.materials.some(material => material.title.includes('正式交付包'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archives an existing meeting report separately from the complete original transcript', async () => {
    const registry = createLegalRegistry();
    expect(registry.get('legal_meeting_minutes_to_case')?.parameters.properties).toHaveProperty('report');
    const orgId = `test-legal-meeting-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_meeting_'));
    const caseName = '法律会议闭环测试案';

    try {
      const output = await registry.execute('legal_meeting_minutes_to_case', {
        orgId,
        userId: 'vitest',
        caseName,
        caseType: '买卖合同纠纷',
        stage: '咨询',
        participants: '承办律师、原告法务、业务负责人',
        meetingTime: '2026-07-10 09:30',
        objective: '整理立案前事实、证据和期限',
        report: '已有模型会议报告：付款条件和质量争议需核对。证据核对真实性、合法性、关联性；7月15安排仅以会议原文为线索，法院期限待确认。',
        outputDir: dir,
        transcript: [
          '双方在2026年3月签订买卖合同，被告收货后只支付部分货款。',
          '现有证据包括合同原件、送货单、发票、银行流水和微信催款聊天记录。',
          '争议焦点是付款条件是否成就、逾期付款责任以及违约金是否过高。',
          '需要在7月15日前提交立案材料，并确认电子数据导出方式。',
        ].join('\n'),
      });

      expect(output).toContain('法律会议纪要已生成');
      expect(output).toContain('纪要文件');
      expect(output).toContain('实时摘要文件');
      expect(output).toContain('行动项文件');
      expect(output).toContain('案件更新文件');
      expect(output).toContain('案件空间：已归档');
      expect(output).toContain('法律成果预检');

      const minutesPath = path.join(dir, 'legal-meeting-minutes.md');
      const liveBriefPath = path.join(dir, 'legal-meeting-live-brief.md');
      const actionItemsPath = path.join(dir, 'legal-meeting-action-items.md');
      const caseUpdatePath = path.join(dir, 'legal-meeting-case-update.md');
      expect(fs.existsSync(minutesPath)).toBe(true);
      expect(fs.existsSync(liveBriefPath)).toBe(true);
      expect(fs.existsSync(actionItemsPath)).toBe(true);
      expect(fs.existsSync(caseUpdatePath)).toBe(true);
      const markdown = fs.readFileSync(minutesPath, 'utf8');
      expect(markdown).toContain('已有模型会议报告');
      expect(markdown).not.toContain('原始转写/沟通记录');
      expect(markdown).not.toContain('双方在2026年3月签订买卖合同');
      expect(markdown).not.toContain('需要在7月15日前提交立案材料');
      expect(markdown).toContain('法律成果预检');
      expect(markdown).not.toContain('legal_case_workspace');
      expect(fs.readFileSync(liveBriefPath, 'utf8')).toContain('已有模型会议报告');
      expect(fs.readFileSync(actionItemsPath, 'utf8')).toContain('已有模型会议报告');
      expect(fs.readFileSync(caseUpdatePath, 'utf8')).toContain('需要在7月15日前提交立案材料');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials).toHaveLength(2);
      expect(caseFile?.materials.some(material => (
        material.source === 'import' && material.type === 'consultation'
        && material.localPath === caseUpdatePath && material.content === fs.readFileSync(caseUpdatePath, 'utf8')
        && material.content.includes('双方在2026年3月签订买卖合同') && material.content.includes('需要在7月15日前提交立案材料')
      ))).toBe(true);
      expect(caseFile?.materials.some(material => (
        material.source === 'tool' && material.type === 'note'
        && material.localPath === minutesPath && material.content.includes('已有模型会议报告')
      ))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a transcript-only meeting as partial without inventing a summary or case archive', async () => {
    const registry = createLegalRegistry(); const cases = await import('../server/org/legal_cases');
    const orgId = 'meeting-no-report-' + crypto.randomUUID(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_meeting_no_report_'));
    const transcript = '仅为虚构验收。原告说已支付20万元，原件未核实。7月15日前收集资料只是内部安排，不是法院期限。尾句完整保留。';
    try {
      const output = await registry.execute('legal_meeting_minutes_to_case', { orgId, userId: 'vitest', caseName: 'No report meeting',
        transcript, outputDir: dir, persistCase: false });
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
      expect(output).toContain('法律会议原文已保存，尚未生成总结'); expect(output).not.toContain('法律会议纪要已生成');
      expect(fs.readFileSync(path.join(dir, 'legal-meeting-case-update.md'), 'utf8')).toBe(transcript);
      const minutes = fs.readFileSync(path.join(dir, 'legal-meeting-minutes.md'), 'utf8');
      expect(minutes).toContain('尚未生成总结'); expect(minutes).not.toContain('已支付20万元');
      expect(cases.listCases(orgId, 'No report meeting', 10, 'vitest')).toHaveLength(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps an unlinked reasoning template partial without creating a case', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-reasoning-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_reasoning_'));
    const caseName = '三段论分析闭环测试案';

    try {
      const output = await registry.execute('legal_case_reasoning_matrix', {
        factDate:'2026-01-15',
        orgId,
        userId: 'vitest',
        caseName,
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '双方签订买卖合同后，原告完成供货，被告收货后拖欠剩余货款。',
        evidence: '买卖合同；送货单；签收单；银行流水；微信催款记录',
        issues: ['付款条件是否成就', '被告是否应承担逾期付款违约责任'],
        legalAuthorities: '拟引用《民法典》第五百八十五条。',
        similarCases: '待检索最高人民法院、高级人民法院、中级人民法院和基层人民法院类案。',
        outputDir: dir,
      });

      expect(output).toContain('法律分析未完成');
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial', reasoningLinked: false });
      expect(output).toContain('现行有效法律预检：通过');
      expect(output).toContain('底稿文件');
      expect(output).toContain('案件空间：未归档');

      const matrixPath = path.join(dir, 'legal-reasoning-matrix.md');
      expect(fs.existsSync(matrixPath)).toBe(true);
      const markdown = fs.readFileSync(matrixPath, 'utf8');
      expect(markdown).toContain('法律分析三段论底稿');
      expect(markdown).toContain('大前提：检索法律、解释法律、类案补强');
      expect(markdown).toContain('小前提：待证事实、证据材料、举证质证');
      expect(markdown).toContain('结论：涵摄、文书表达、风险');
      expect(markdown).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
      expect(markdown).toContain('正式交付核验');
      expect(markdown).toContain('来源关联检查：未通过');
      expect(markdown).toContain('待逐项匹配法条');

      const LegalCases = await import('../server/org/legal_cases');
      expect(LegalCases.listCases(orgId, caseName, 100)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archives contract and bid work products into the case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = 'test-legal-contract-bid-' + Date.now();
    const caseName = '合同标书闭环测试案';
    const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
    const { contractStructuredReply } = await import('./legal_contract_fixture');
    const { bidStructuredReply } = await import('./legal_bid_fixture');
    upsertUserPreferredLLM('vitest', { provider: 'relay', model: 'synthetic-contract-bid-positive', selectionMode: 'pinned', allowCloudFallback: false });
    const create = vi.fn((request: any, options: any) => {
      const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
      const body = '本次仅依据已提供原文形成拟议工作稿；付款条件、签章、资质与实际履行尚待核对，未提供不表示没有约定，不作正式核验通过。';
      const content = /^指定栏目：/m.test(prompt) ? contractStructuredReply(prompt, body) : bidStructuredReply(prompt, body);
      return sdkCompletion(request, { choices: [{ message: { content }, finish_reason: 'stop' }] }, 0, options.signal);
    });
    const context = { userId: 'vitest', authenticated: true, authRole: 'user', localExecution: true,
      executionBoundary: 'trusted_local' as const, source: 'legal-direct-tool',
      llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
    const common = { orgId, userId: 'vitest', caseName };
    const reviewArgs = { ...common, caseType: '合同审查', contract: '建设工程施工合同\n发包人逾期付款的，承包人每日按合同总价30%收取违约金。\n任一方可单方解除合同，无需通知对方。' };
    const draftArgs = { ...common, caseType: '合同起草', type: '建设工程施工合同', details: '项目名称：测试工程；工期：90日；价款：待填写；需要违约责任和付款节点。' };
    const bidArgs = { ...common, caseType: '投标/招标文件响应', projectName: '测试工程投标项目', requirements: '招标要求：提交商务标、技术标、项目管理机构、施工组织设计、授权委托书和报价清单。' };
    const review = decodeToolResult(await registry.execute('legal_review_contract', reviewArgs, context));
    expect(review.receipt).toMatchObject({ ok: true, status: 'reviewed', persisted: true });
    expect(review.content).toContain('案件归档与交付边界');
    expect(review.content).toContain('案件空间：已归档');
    const draft = decodeToolResult(await registry.execute('legal_draft_contract', draftArgs, context));
    expect(draft.receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
    expect(draft.content).toContain('建设工程施工合同工作稿');
    expect(draft.content).toContain('案件空间：已归档');
    const bid = decodeToolResult(await registry.execute('legal_generate_bid', bidArgs, context));
    expect(bid.receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
    expect(bid.content).toContain('投标响应工作底稿'); expect(bid.content).toContain('案件空间：已归档');
    expect(bid.content).toContain('正式交付核验'); expect(bid.content).not.toContain('三段论核心基础');
    expect(create).toHaveBeenCalledTimes(8);
    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile?.materials.some(material => material.type === 'contract' && material.title.includes('合同审查报告'))).toBe(true);
    expect(caseFile?.materials.some(material => material.type === 'contract' && material.title.includes('合同起草底稿'))).toBe(true);
    expect(caseFile?.materials.some(material => material.type === 'note' && material.title.includes('投标书工作底稿'))).toBe(true);
    for (const [tool, args] of [['legal_review_contract', reviewArgs], ['legal_draft_contract', draftArgs], ['legal_generate_bid', bidArgs]] as const) {
      const missingName = caseName + '-无模型-' + tool;
      const incomplete = decodeToolResult(await registry.execute(tool, { ...args, caseName: missingName }));
      expect(incomplete.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
      expect(LegalCases.listCases(orgId, missingName, 10, 'vitest')).toHaveLength(0);
    }
    expect(create).toHaveBeenCalledTimes(8);
  });

  it('preflights draft legal work products before formal delivery', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_argument_or_opinion', {
      caseName: '草稿法源预检测试案',
      role: '原告',
      caseType: '买卖合同纠纷',
      facts: '双方发生买卖合同纠纷，草稿材料中仍写有根据《合同法》第六十条主张继续履行。',
      evidence: '买卖合同、发货单、聊天记录。',
      objective: '生成代理词草稿并提示法源风险。',
    });

    expect(output).toContain('法律成果预检');
    expect(output).toContain('现行有效法律预检：未通过');
    expect(output).toContain('合同法');
    expect(output).toContain('不得标记为正式成果');
    expect(output).toContain('正式交付核验');
    expect(output).not.toMatch(/legal_finalize_delivery_package|内部分析链路/);
  });

  it('archives core litigation work products into the same case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-core-products-${Date.now()}`;
    const caseName = '核心办案产物闭环测试案';
    const sdk = await packetModelContext();

    const packet = await registry.execute('legal_generate_litigation_packet', {
      orgId,
      userId: 'vitest',
      caseName,
      role: '原告',
      parties: '虚构供货方/虚构采购方', claims: '仅请求核对付款条件及交付，不增加欠款、退款或违约金诉请。',
      caseType: '买卖合同纠纷',
      facts: '被告收货后未付剩余货款。',
      evidence: '买卖合同；送货单；签收单；银行流水。',
    }, sdk.context);
    expect(decodeToolResult(packet).receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile).toBeDefined();
    const archivedPacketMaterials = JSON.stringify(caseFile.materials);
    const focus = await registry.execute('legal_extract_dispute_focus', {
      orgId,
      userId: 'vitest',
      caseName,
      role: '原告',
      caseType: '买卖合同纠纷',
      complaint: '请求支付货款及违约金。',
      evidence: '合同、送货单、签收单、银行流水。',
    });
    const argument = await registry.execute('legal_generate_argument_or_opinion', {
      orgId,
      userId: 'vitest',
      caseName,
      role: '原告',
      documentType: '代理词',
      caseType: '买卖合同纠纷',
      facts: '原告已完成供货，被告收货后拖欠货款。',
      issues: ['付款条件是否成就', '被告是否应承担违约责任'],
      evidence: '合同、送货单、签收单、银行流水。',
      objective: '请求支持货款和违约金。',
    });
    const strategy = await registry.execute('legal_case_strategy', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '买卖合同纠纷',
      facts: '原告已完成供货，被告以质量问题拒付剩余货款。',
    });

    for (const output of [focus, argument, strategy]) {
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
      expect(output).not.toContain('案件空间：已归档');
    }
    expect(JSON.stringify(LegalCases.getCase(orgId, caseFile.id)!.materials)).toBe(archivedPacketMaterials);
    expect(caseFile.materials.map(material => material.title).join('\n')).toContain('半自动诉讼文书包');
    expect(sdk.create).toHaveBeenCalledTimes(4);
  });

  it('keeps asset and equity queries incomplete and unarchived when external sources return no data', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-asset-equity-${Date.now()}`;
    const caseName = '执行财产线索闭环测试案';
    const subjectName = `测试被执行人${Date.now()}`;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    try {
      const assets = await registry.execute('legal_trace_assets', {
        orgId,
        userId: 'vitest',
        caseName,
        caseType: '执行/财产保全',
        name: subjectName,
      });
      const equity = await registry.execute('legal_equity_penetration', {
        orgId,
        userId: 'vitest',
        caseName,
        caseType: '主体/股权穿透',
        name: `${subjectName}有限公司`,
      });

      expect(assets).toContain('财产线索查询报告'); expect(equity).toContain('授权网页登录协作');
      for (const output of [assets, equity]) {
        expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial' });
        expect(output).not.toContain('案件空间：已归档'); expect(output).toMatch(/未取得|未通过|不能/);
      }
      const LegalCases = await import('../server/org/legal_cases');
      expect(LegalCases.listCases(orgId, caseName, 10, 'vitest')).toHaveLength(0);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('generates bid work products directly from local tender files', async () => {
    const registry = createLegalRegistry();
    const orgId = 'test-legal-bid-file-' + Date.now();
    const caseName = '招标文件直读闭环测试案';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_bid_file_'));
    const tenderPath = path.join(dir, 'tender-requirements.txt');
    const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
    const { bidStructuredReply } = await import('./legal_bid_fixture');
    upsertUserPreferredLLM('vitest', { provider: 'relay', model: 'synthetic-local-tender-positive', selectionMode: 'pinned', allowCloudFallback: false });
    const create = vi.fn((request: any, options: any) => {
      const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
      const content = bidStructuredReply(prompt, '仅按给定原件编制本节拟议响应；资质、业绩、报价及签章尚待核验，付款和实施方案仍需责任人确认，不等于已经投标。');
      return sdkCompletion(request, { choices: [{ message: { content }, finish_reason: 'stop' }] }, 0, options.signal);
    });
    const context = { userId: 'vitest', authenticated: true, authRole: 'user', localExecution: true,
      executionBoundary: 'trusted_local' as const, source: 'legal-direct-tool',
      llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
    try {
      const originalText = '招标要求：提交商务标、技术标、项目管理机构、施工组织设计。\n评分标准：企业资质、类似业绩、技术方案、报价清单、授权委托书。\n合同条款：需响应付款节点、违约责任、工期、质量标准。';
      fs.writeFileSync(tenderPath, originalText, 'utf8');
      const args = { orgId, userId: 'vitest', caseName, caseType: '投标/招标文件响应', projectName: '直读招标文件测试项目', filePath: tenderPath };
      const result = decodeToolResult(await registry.execute('legal_generate_bid', args, context));
      expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
      const output = result.content;
      expect(output).toContain('直读招标文件测试项目'); expect(output).toContain('招标文件来源');
      expect(output).toContain('tender-requirements.txt'); expect(output).toContain('案件空间：已归档');
      expect(output).toContain(originalText); expect(fs.readFileSync(tenderPath, 'utf8')).toBe(originalText);
      const docxPath = output.match(/- DOCX 文件：([^\r\n]+)/)![1];
      const artifact = fs.readFileSync(docxPath);
      expect(artifact.length).toBeGreaterThan(256); expect(artifact.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(create).toHaveBeenCalledTimes(6);
      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => material.type === 'note' && material.title.includes('投标书工作底稿')
        && material.content.includes('招标文件来源') && material.content.includes('tender-requirements.txt'))).toBe(true);
      const missingName = caseName + '-无模型';
      const incomplete = decodeToolResult(await registry.execute('legal_generate_bid', { ...args, caseName: missingName }));
      expect(incomplete.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
      expect(LegalCases.listCases(orgId, missingName, 10, 'vitest')).toHaveLength(0);
      expect(incomplete.content).toContain(originalText); expect(create).toHaveBeenCalledTimes(6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('processes SMS and court notice links with case archive records', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-notice-link-${Date.now()}`;
    const caseName = '短信通知链接闭环测试案';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>上海市黄浦区人民法院 开庭通知 （2026）沪0101民初123号 2026年7月15日开庭。</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    try {
      const output = await registry.execute('legal_process_notice_link', {
        orgId,
        userId: 'vitest',
        caseName,
        noticeText: '【人民法院】你有一份开庭通知，请查看 https://court.example.test/notice/123',
      });

      expect(output).toContain('短信/通知链接处理结果');
      expect(output).toContain('留痕报告');
      expect(output).toContain('案件空间归档');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.type === 'note'
        && material.title.includes('短信/法院通知链接材料')
        && material.content.includes('开庭通知')
      ))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('archives remote legal bot messages into the case workflow', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-message-intake-${Date.now()}`;
    const caseName = '远程消息入案闭环测试案';

    const output = await registry.execute('legal_message_intake_to_case', {
      orgId,
      userId: 'vitest',
      platform: 'wechat',
      sender: '阿陆',
      caseName,
      message: [
        '请发给 Lumi 入案：买卖合同纠纷。',
        '被告收货后未支付尾款，证据包括合同、送货单、微信催款记录。',
        '法院短信链接 https://court.example.test/notice/456',
      ].join('\n'),
      fileNames: ['微信聊天记录导出.pdf'],
      processLinks: false,
    });

    expect(output).toContain('远程法律消息已入案');
    expect(output).toContain('平台：微信');
    expect(output).toContain('发送人：阿陆');
    expect(output).toContain('案件闭环状态');
    expect(output).toContain('processLinks=false');
    expect(output).toContain('下一动作');

    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile).toBeTruthy();
    expect(caseFile.materials.some(material => (
      material.source === 'wechat'
      && material.type === 'consultation'
      && material.title.includes('微信法律消息原文')
      && material.content.includes('court.example.test/notice/456')
      && material.content.includes('阿陆')
    ))).toBe(true);
  });

  it('generates argument and legal-opinion drafts with real source binding and SDK review', async () => {
    const registry = createLegalRegistry(); const cases = await import('../server/org/legal_cases'); const sdk = await reasoningModelContext();
    const orgId = 'argument-source-positive-' + crypto.randomUUID();
    const inputs = [
      { caseName: 'Argument Draft Case', role: 'plaintiff', documentType: '代理词', caseType: '买卖合同纠纷',
        facts: '双方签订买卖合同后，原告完成供货，被告以质量问题拒付剩余货款。',
        issues: ['付款条件是否成就', '质量异议抗辩是否成立', '违约金是否需要调整'], evidence: '合同、订单、发货单、签收单、发票、银行流水。',
        opponentArguments: '被告主张货物存在质量问题，拒绝支付剩余货款。', objective: '请求支持货款和违约金。' },
      { caseName: 'Opinion Draft Case', role: 'defendant', documentType: '法律意见书', caseType: '买卖合同纠纷',
        facts: '客户收到起诉状后，需要评估质量异议抗辩、违约金调整和和解空间。', evidence: '验收异议函、退货沟通记录、检测报告。',
        opponentArguments: '原告主张已按约供货并要求支付全额货款。', objective: '形成应诉和谈判意见。' },
    ];
    const outputs: string[] = [];
    for (const input of inputs) {
      const caseFile = cases.createCase(orgId, 'vitest', { title: input.caseName });
      for (const [title, content] of Object.entries({ facts: input.facts, evidence: input.evidence, opponentArguments: input.opponentArguments })) {
        cases.addMaterial(orgId, 'vitest', caseFile.id, { type: 'evidence', source: 'manual', title: '虚构原始材料 ' + title, content });
      }
      const output = await registry.execute('legal_generate_argument_or_opinion', { ...input, orgId, userId: 'vitest', caseId: caseFile.id,
        factDate: '2026-09-01', legalAuthorities: '《民法典》第626条', persistCase: true }, sdk.context);
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: true, status: 'generated', reasoningLinked: true, reasoningReviewed: true, persisted: true });
      expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄|legal_finalize_delivery_package|内部分析链路/);
      expect(output).toContain('法律依据：'); expect(output).toContain('本案材料'); expect(output).toContain('规则原文衔接片段');
      expect(output).toContain('未经律师核准'); expect(output).toMatch(/待检索|待核验|待补证|律师/);
      for (const original of [input.facts, input.evidence, input.opponentArguments]) expect(output).toContain(original);
      expect(cases.getCase(orgId, caseFile.id, 'vitest')!.materials.filter(material => material.source === 'tool')).toHaveLength(1);
      outputs.push(output);
    }
    expect(sdk.create).toHaveBeenCalledTimes(4);
    expect(outputs[0]).toMatch(/代理词|结论请求/); expect(outputs[1]).toMatch(/法律意见书|风险提示|处理建议/);
  });

  it('keeps no-model ordinary legal drafts incomplete without replacing originals or archiving a result', async () => {
    const registry = createLegalRegistry(); const cases = await import('../server/org/legal_cases');
    const orgId = 'argument-no-model-' + crypto.randomUUID();
    for (const documentType of ['代理词', '法律意见书']) {
      const caseFile = cases.createCase(orgId, 'vitest', { title: 'No model ' + documentType });
      const original = '虚构原始材料原文含“三段论”和“大前提”字样，属于当事人引述；付款、主体及日期尚待核实。';
      cases.addMaterial(orgId, 'vitest', caseFile.id, { type: 'evidence', source: 'manual', title: '原始说明', content: original });
      const before = JSON.stringify(cases.getCase(orgId, caseFile.id, 'vitest')!.materials);
      const output = await registry.execute('legal_generate_argument_or_opinion', { orgId, userId: 'vitest', caseId: caseFile.id,
        caseName: caseFile.title, documentType, facts: original, persistCase: true });
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
      expect(output).toContain('拟议正文未完成'); expect(output).toContain(original);
      expect(output).not.toMatch(/大前提：|小前提：|legal_finalize_delivery_package|内部分析链路|案件空间：已归档/);
      expect(JSON.stringify(cases.getCase(orgId, caseFile.id, 'vitest')!.materials)).toBe(before);
    }
  });

  it('builds external research plans around authorized browser sessions', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-research-plan-${Date.now()}`;
    const caseName = '外部检索行动单归档测试案';

    const output = await registry.execute('legal_external_research_plan', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '买卖合同纠纷',
      facts: '合同履行后拖欠货款，争议集中在质量异议、付款条件和违约金调整。',
      issues: ['货款支付条件', '质量异议抗辩', '违约金调整'],
      companyNames: ['Beta Retail Co.', 'Alpha Trading Co.'],
    });

    expect(output).toContain('web_login_profile_save_from_preset');
    expect(output).toContain('web_login_run');
    expect(output).not.toMatch(/底层三段论|三段论检索框架|大前提|小前提|涵摄/);
    expect(output).toContain('"profileId":"court-online-service"');
    expect(output).toContain('people-court-case-library');
    expect(output).toContain('china-judgments-online');
    expect(output).toContain('fachan');
    expect(output).toContain('alpha-lawyer');
    expect(output).toContain('qichacha');
    expect(output).toContain('national-enterprise-credit');
    expect(output).toContain('court-online-service');
    expect(output).toMatch(/来源登记表|来源.*登记/);
    expect(output).toContain('案件空间：已归档');

    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile?.materials.some(material => (
      material.source === 'tool'
      && material.type === 'note'
      && material.title.includes('外部检索行动单')
    ))).toBe(true);
  });

  it('writes formal legal delivery packages with DOCX and citation reports', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_'));

    try {
      await registry.execute('legal_import_judgment', {
        orgId,
        userId: 'vitest',
        content: [
          '上海市黄浦区人民法院',
          '（2025）沪0101民初123号',
          '案由：买卖合同纠纷',
          '本院认为，买卖合同依法成立并生效，买受人应依约支付价款。',
          '裁判日期：二〇二五年六月一日',
        ].join('\n'),
      });

      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        ...await traceableDeliveryInput(orgId, '被告应支付货款并承担违约责任。', undefined, '正式交付测试案'),
        orgId,
        userId: 'vitest',
        caseName: '正式交付测试案',
        documentType: '代理词',
        caseType: '买卖合同纠纷',
        role: '原告',
        court: '上海市黄浦区人民法院',
        lawFirmName: '测试律师事务所',
        lawyerName: '测试律师',
        outputDir: dir,
        includeDocx: true,
        includePdf: false,
        reasoningSummary: [
          '大前提：依据《民法典》第五百八十五条及买卖合同违约责任规则。',
          '小前提：原告已供货，被告未按约付款，证据包括合同、送货单和付款记录。',
          '结论：被告应承担付款和违约责任，代理词围绕合同成立、履行和违约责任展开。',
        ].join('\n'),
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条，结合（2025）沪0101民初123号案件材料，形成如下意见。',
          '一、双方存在买卖合同关系。',
          '二、被告应支付货款并承担违约责任。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包已生成');
      expect(output).toContain('引用核验报告');
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(true);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('引用核验报告');
      expect(output).toContain('现行有效法律硬门槛：通过');
      expect(report).toContain('现行有效法律硬门槛：通过');
      expect(report).toMatch(/民法典|现行有效/);
      expect(report).not.toContain('合同法');
      expect(report).toContain('已废止/失效风险：0');
      expect(report).toContain('律师最终检索');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when the reasoning chain is missing', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_reasoning_blocked_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        caseName: '三段论阻断测试案',
        documentType: '法律意见书',
        outputDir: dir,
        includeDocx: true,
        content: [
          '# 法律意见书草稿',
          '根据《民法典》第五百八十五条，形成如下法律意见。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('推理底稿结构不完整');
      expect(output).toContain('来源关联未通过');
      expect(output).toContain('法律分析底稿');
      expect(fs.existsSync(path.join(dir, '00_reasoning-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when no current-law citation is present', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_no_statute_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        caseName: '无法条引用阻断测试案',
        documentType: '法律意见书',
        outputDir: dir,
        includeDocx: true,
        reasoningSummary: [
          '大前提：本意见需要补充现行有效法律依据后才能作为正式法律文书交付。',
          '小前提：原告已供货，被告未付款，证据包括合同、送货单和付款记录。',
          '结论：被告可能承担付款责任，但正式文书前必须补充可核验法条引用。',
        ].join('\n'),
        content: [
          '# 法律意见书草稿',
          '原告已供货，被告未支付剩余货款，建议主张付款责任。',
          '该草稿故意不写具体法条名称，用于验证正式交付 gate。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('正式法律交付包未检测到可核验的法条引用');
      expect(output).toContain('已识别法条数：0');
      expect(fs.existsSync(path.join(dir, '00_current-law-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('现行有效法律硬门槛：未通过');
      const gateReport = fs.readFileSync(path.join(dir, '00_current-law-gate-blocked.md'), 'utf-8');
      expect(gateReport).toContain('Missing statute citation: yes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when case citations are not source-verified', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-case-source-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_case_source_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        orgId,
        userId: 'vitest',
        caseName: '未核验类案阻断测试案',
        documentType: '代理词',
        outputDir: dir,
        includeDocx: true,
        reasoningSummary: [
          '大前提：依据《民法典》第五百八十五条，违约方应承担违约责任，并可结合已核验类案裁判规则补强。',
          '小前提：原告已供货，被告未付款，证据包括合同、送货单和付款记录。',
          '结论：被告应承担付款及违约责任，但类案引用必须先完成来源核验。',
        ].join('\n'),
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条，并参照（2026）沪0101民初999号裁判思路，原告请求应获支持。',
          '该案号故意未导入组织知识库，用于验证案例来源 gate。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('类案/案号来源硬门槛未通过');
      expect(output).toContain('未核验案例数：1');
      expect(output).toContain('（2026）沪0101民初999号');
      expect(fs.existsSync(path.join(dir, '00_case-source-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('现行有效法律硬门槛：通过');
      expect(report).toContain('类案/案号来源硬门槛：未通过');
      const gateReport = fs.readFileSync(path.join(dir, '00_case-source-gate-blocked.md'), 'utf-8');
      expect(gateReport).toContain('Missing Case Citations');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not block formal delivery when the only unarchived case number is the current case', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-own-case-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_own_case_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        ...await traceableDeliveryInput(orgId, '被告应承担违约责任。', undefined, '本案案号豁免测试案'),
        orgId,
        userId: 'vitest',
        caseName: '本案案号豁免测试案',
        caseNumber: '（2026）沪0101民初888号',
        documentType: '代理词',
        outputDir: dir,
        includeDocx: false,
        reasoningSummary: [
          '大前提：依据《民法典》第五百八十五条，违约方应承担违约责任。',
          '小前提：本案（2026）沪0101民初888号中，原告已供货，被告未付款。',
          '结论：被告应承担付款及违约责任。',
        ].join('\n'),
        content: [
          '# 代理词草稿',
          '本案案号为（2026）沪0101民初888号。根据《民法典》第五百八十五条，被告应承担违约责任。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包已生成');
      expect(fs.existsSync(path.join(dir, '00_case-source-gate-blocked.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(true);
      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('类案/案号来源硬门槛：通过');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses archived case reasoning matrices for formal delivery packages', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-archived-reasoning-${Date.now()}`;
    const reasoningDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_reasoning_for_delivery_'));
    const deliveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_archived_reasoning_'));
    const caseName = '归档三段论复用测试案';

    try {
      const LegalCases = await import('../server/org/legal_cases');
      const sourceCase = LegalCases.createCase(orgId, 'vitest', { title: caseName, factDate: '2026-01-15' });
      LegalCases.addMaterial(orgId, 'vitest', sourceCase.id, { type: 'evidence', source: 'manual', title: '虚构原始合同及签收记录', content: '原告已供货，被告签收后未支付剩余货款，违约金约定与实际损失待核实。' });
      const model = await reasoningModelContext();
      await registry.execute('legal_case_reasoning_matrix', {
        factDate:'2026-01-15',
        caseId: sourceCase.id,
        orgId,
        userId: 'vitest',
        caseName,
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '原告已供货，被告签收后未支付剩余货款。',
        evidence: '买卖合同、送货单、签收单、银行流水。',
        issues: ['被告是否应支付货款和违约金'],
        legalAuthorities: '引用《民法典》第五百八十五条。',
        outputDir: reasoningDir,
      }, model.context);
      expect(model.create).toHaveBeenCalledTimes(2);

      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.id).toBeTruthy();

      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        orgId,
        userId: 'vitest',
        caseId: caseFile.id,
        caseName,
        documentType: '代理词',
        outputDir: deliveryDir,
        includeDocx: false,
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条进行条件分析。',
          caseFile.materials.find(m => m.reasoningLinks?.length)!.reasoningLinks![0].conclusion,
        ].join('\n'),
      });

      expect(output).toContain('正式交付包已生成');
      expect(output).toContain('推理底稿结构检查：通过');
      expect(fs.existsSync(path.join(deliveryDir, '00_manifest.md'))).toBe(true);
      expect(fs.existsSync(path.join(deliveryDir, '00_reasoning-gate-blocked.md'))).toBe(false);
      const sourceRegister = fs.readFileSync(path.join(deliveryDir, '03_source-register.md'), 'utf-8');
      expect(sourceRegister).toContain('已归档三段论底稿');
      expect(sourceRegister).toContain('已复用');
    } finally {
      fs.rmSync(reasoningDir, { recursive: true, force: true });
      fs.rmSync(deliveryDir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when statute citations are repealed or unverified', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_blocked_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        caseName: '废止法阻断测试案',
        documentType: '代理词',
        caseType: '买卖合同纠纷',
        role: '原告',
        outputDir: dir,
        includeDocx: true,
        content: [
          '# 代理词草稿',
          '根据《合同法》第六十条，原告请求被告承担违约责任。',
          '本段故意引用已废止法律，用于验证正式交付包硬门槛。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('现行有效法律硬门槛未通过');
      expect(output).toContain('合同法');
      expect(fs.existsSync(path.join(dir, '00_current-law-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('现行有效法律硬门槛：未通过');
      expect(report).toMatch(/合同法|已废止/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when statute citations cannot be verified', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_unverified_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
        factDate:'2026-01-15',
        caseName: '未知法条阻断测试案',
        documentType: '法律意见书',
        outputDir: dir,
        includeDocx: true,
        content: [
          '# 法律意见书草稿',
          '根据《不存在特别保护法》第十条，形成如下法律意见。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('现行有效法律硬门槛未通过');
      expect(output).toContain('不存在特别保护法');
      expect(fs.existsSync(path.join(dir, '00_current-law-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes standalone citation verification reports', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_citation_'));

    try {
      const output = await registry.execute('legal_generate_citation_verification_report', {
        factDate:'2026-01-15',
        caseName: '引用核验测试案',
        outputDir: dir,
        text: '本案拟引用《合同法》第六十条、《民法典》第五百八十五条及（2025）沪0101民初123号。',
      });

      expect(output).toContain('引用核验报告已生成');
      expect(output).toContain('已废止/失效风险');
      const reportPath = path.join(dir, 'citation-verification-report.md');
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = fs.readFileSync(reportPath, 'utf-8');
      expect(report).toContain('引用总数');
      expect(report).toMatch(/合同法|已废止/);
      expect(report).toContain('未确认案例');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes external browser workspaces with source registers', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_browser_'));

    try {
      const output = await registry.execute('legal_prepare_external_browser_workspace', {
        caseName: '外部检索测试案',
        caseType: '买卖合同纠纷',
        issues: ['付款条件是否成就', '违约金是否过高'],
        companyNames: ['Beta Retail Co.'],
        sourceIds: ['people-court-case-library', 'china-judgments-online', 'fachan', 'alpha-lawyer', 'qichacha'],
        outputDir: dir,
      }, {
        requestConfirmation: async () => true,
      });

      expect(output).toContain('外部网页登录工作区已生成');
      expect(output).toContain('web_login_run');
      expect(output).toContain('不自动抓取');
      expect(fs.existsSync(path.join(dir, '00_browser-workspace.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_source-register.csv'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_web-login-commands.md'))).toBe(true);
      const commands = fs.readFileSync(path.join(dir, '02_web-login-commands.md'), 'utf-8');
      expect(commands).toContain('people-court-case-library');
      expect(commands).toContain('qichacha');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports local legal materials into the organization knowledge base', async () => {
    const registry = createLegalRegistry();
    const KB = await import('../server/org/kb');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_materials_'));

    try {
      fs.writeFileSync(path.join(dir, '起诉状.txt'), [
        '案由：买卖合同纠纷',
        '原告主张被告拖欠货款，争议包括付款条件是否成就。',
        '被告提出质量异议并要求扣减违约金。',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(path.join(dir, '证据目录.md'), [
        '# 证据目录',
        '1. 合同：证明买卖合同关系。',
        '2. 质量异议函：证明被告曾提出质量问题。',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(path.join(dir, '现场照片.png'), 'not a real image', 'utf-8');

      const output = await registry.execute('legal_import_materials_to_kb', {
        orgId: 'org-legal-material-import',
        userId: 'lawyer-1',
        folderPath: dir,
        caseName: '材料入库测试案',
        caseType: '买卖合同纠纷',
        materialType: '案件材料',
        tags: ['import-test'],
      });

      expect(output).toContain('法律材料导入知识库报告');
      expect(output).toMatch(/成功导入：2 份|成功导入：2/);
      expect(output).toMatch(/跳过\/失败：1 份|跳过\/失败：1/);
      expect(output).toContain('起诉状.txt');
      expect(output).toContain('证据目录.md');
      expect(output).toContain('图片文字识别');
      expect(output).not.toMatch(/ocr_image_file|legal_import_materials_to_kb/);
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial' });

      const results = await KB.searchKnowledgeBase('org-legal-material-import', '质量异议 付款条件', {
        limit: 5,
        status: 'published',
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.map(result => result.title)).toEqual(expect.arrayContaining(['起诉状.txt']));
      expect(results[0].chunk).toMatch(/质量异议|付款条件/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports external source capabilities without overstating web access', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_external_source_status', {});

    expect(output).toContain('外部法律数据源接入状态');
    expect(output).toContain('企查查');
    expect(output).toContain('api');
    expect(output).toMatch(/Alpha|法蝉|中国裁判文书网/);
    expect(output).toMatch(/授权网页登录协作|网页登录/);
    expect(output).toMatch(/不绕过验证码|不绕过/);
    expect(output).not.toMatch(/已接入.*法蝉|已接入.*Alpha|自动抓取.*已完成|批量同步.*已完成/);
  });

  it('queries configured external legal authority APIs', async () => {
    const registry = createLegalRegistry();
    const original = {
      PKULAW_API_KEY: process.env.PKULAW_API_KEY,
      PKULAW_BASE_URL: process.env.PKULAW_BASE_URL,
    };
    const query = `authority-api-test-${Date.now()}`;
    const orgId = `test-legal-authority-archive-${Date.now()}`;
    const caseName = '外部类案检索归档测试案';
    process.env.PKULAW_API_KEY = 'test-pkulaw-key';
    process.env.PKULAW_BASE_URL = 'https://pkulaw.local/search';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        items: [
          {
            title: '基层法院买卖合同案例',
            caseNumber: '(2026) Test Case No.4',
            court: '上海市黄浦区人民法院',
            summary: 'A controlled mocked basic court result.',
            url: 'https://pkulaw.local/case/4',
          },
          {
            title: '最高院买卖合同案例',
            caseNumber: '(2026) Test Case No.1',
            court: '最高人民法院',
            summary: 'A controlled mocked supreme court result.',
            url: 'https://pkulaw.local/case/1',
          },
          {
            title: '中院买卖合同案例',
            caseNumber: '(2026) Test Case No.3',
            court: '上海市第一中级人民法院',
            summary: 'A controlled mocked intermediate court result.',
            url: 'https://pkulaw.local/case/3',
          },
          {
            title: '高院买卖合同案例',
            caseNumber: '(2026) Test Case No.2',
            court: '上海市高级人民法院',
            summary: 'A controlled mocked high court result.',
            url: 'https://pkulaw.local/case/2',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const output = await registry.execute('legal_search_external_authorities', {
        orgId,
        userId: 'vitest',
        caseName,
        query,
        type: 'case',
        sourceIds: ['pkulaw'],
        limit: 4,
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(output).toContain('最高院买卖合同案例');
      expect(output).toContain('(2026) Test Case No.1');
      expect(output).toContain('pkulaw');
      expect(output).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
      expect(output.indexOf('最高院买卖合同案例')).toBeLessThan(output.indexOf('高院买卖合同案例'));
      expect(output.indexOf('高院买卖合同案例')).toBeLessThan(output.indexOf('中院买卖合同案例'));
      expect(output.indexOf('中院买卖合同案例')).toBeLessThan(output.indexOf('基层法院买卖合同案例'));
      expect(output).toMatch(/授权|API|复核/);
      expect(output).toContain('来源登记回填');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'tool'
        && material.type === 'judgment'
        && material.title.includes('外部法律数据库检索')
        && material.content.includes('(2026) Test Case No.1')
      ))).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (original.PKULAW_API_KEY === undefined) delete process.env.PKULAW_API_KEY;
      else process.env.PKULAW_API_KEY = original.PKULAW_API_KEY;
      if (original.PKULAW_BASE_URL === undefined) delete process.env.PKULAW_BASE_URL;
      else process.env.PKULAW_BASE_URL = original.PKULAW_BASE_URL;
    }
  });

  it('queries configured company database APIs', async () => {
    const registry = createLegalRegistry();
    const original = {
      TIANYANCHA_API_KEY: process.env.TIANYANCHA_API_KEY,
      TIANYANCHA_BASE_URL: process.env.TIANYANCHA_BASE_URL,
    };
    const companyName = `Demo Tech Co ${Date.now()}`;
    const orgId = `test-legal-company-archive-${Date.now()}`;
    const caseName = '企业主体查询归档测试案';
    process.env.TIANYANCHA_API_KEY = 'test-tyc-key';
    process.env.TIANYANCHA_BASE_URL = 'https://tianyancha.local/company';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        error_code: 0,
        result: {
          name: companyName,
          legalPersonName: 'Jane Test',
          regCapital: '1000万人民币',
          regStatus: '存续',
          creditCode: '91310000TESTCODE',
          businessScope: 'software services',
          id: 123456,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const output = await registry.execute('legal_company_database_lookup', {
        orgId,
        userId: 'vitest',
        caseName,
        name: companyName,
        sourceIds: ['tianyancha'],
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(output).toContain(companyName);
      expect(output).toContain('Jane Test');
      expect(output).toContain('91310000TESTCODE');
      expect(output).toMatch(/天眼查|API|网页登录/);
      expect(output).toContain('主体信息来源登记');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'tool'
        && material.type === 'evidence'
        && material.title.includes('企业/被执行主体数据库查询')
        && material.content.includes(companyName)
      ))).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (original.TIANYANCHA_API_KEY === undefined) delete process.env.TIANYANCHA_API_KEY;
      else process.env.TIANYANCHA_API_KEY = original.TIANYANCHA_API_KEY;
      if (original.TIANYANCHA_BASE_URL === undefined) delete process.env.TIANYANCHA_BASE_URL;
      else process.env.TIANYANCHA_BASE_URL = original.TIANYANCHA_BASE_URL;
    }
  });

  it('keeps triad reasoning as core legal logic rather than a standalone UI tab', () => {
    const registry = createLegalRegistry();
    const legalHubSource = readImplementationSource(path.join(process.cwd(), 'src/components/org/LegalHub.tsx'), 'utf-8');
    const toolRouterSource = fs.readFileSync(path.join(process.cwd(), 'server/cognition/tool_router.ts'), 'utf-8');
    const legalToolsShimSource = fs.readFileSync(path.join(process.cwd(), 'server/tools/definitions/legal_tools.ts'), 'utf-8');
    const legalToolDirectory = path.join(process.cwd(), 'server/regions/packs/cn/legal_tools');
    const legalToolsSource = [fs.readFileSync(path.join(process.cwd(), 'server/regions/packs/cn/legal_tools.ts'), 'utf8'),
      ...fs.readdirSync(legalToolDirectory).filter(file => file.endsWith('.ts')).sort()
        .map(file => fs.readFileSync(path.join(legalToolDirectory, file), 'utf8'))].join('\n');
    const uiMessagesSource = fs.readFileSync(path.join(process.cwd(), 'src/i18n/locales/ui.generated.json'), 'utf-8');
    const chatRoutesSource = fs.readFileSync(path.join(process.cwd(), 'server/routes/chat_routes.ts'), 'utf-8');

    expect(legalHubSource).not.toContain("id: 'triad'");
    expect(legalHubSource).not.toContain('LegalTriadView');
    expect(legalHubSource).toContain('legal_generate_litigation_packet');
    expect(legalHubSource).toContain('legal_external_research_plan');
    expect(legalHubSource).toContain('buildLegalCaseReadiness');
    expect(legalHubSource).toContain('LEGAL_CASE_READINESS_TOOLS');
    expect(legalHubSource).not.toContain('buildLegalCaseActionSummary');
    expect(legalHubSource).not.toContain('Case Action Board');
    expect(legalHubSource).not.toContain('案件行动面板');
    expect(legalHubSource).toContain('legalCaseToolArgs');
    expect(legalHubSource).not.toContain('办案闭环');
    expect(uiMessagesSource).toContain('办案闭环');
    expect(legalHubSource).toContain('persistCase: true');
    expect(legalHubSource).toContain('legal_finalize_delivery_package');
    expect(legalHubSource).toContain('legal_process_notice_link');
    expect(legalHubSource).not.toContain('处理短信链接');
    expect(uiMessagesSource).toContain('处理短信链接');
    expect(fs.readFileSync(path.join(process.cwd(), 'src/lib/legalToolClient.ts'), 'utf-8')).toContain('/api/legal/tool/');
    expect(chatRoutesSource).toContain('DIRECT_LEGAL_TOOL_ALLOWLIST');
    expect(chatRoutesSource).toContain('/legal/tool/:toolName');
    expect(chatRoutesSource).toContain('legalToolDefinitions().map(tool => tool.name)');
    const catalogNames = legalToolDefinitions().map(tool => tool.name);
    for (const name of ["legal_generate_litigation_packet","legal_case_workflow_status","legal_message_intake_to_case","legal_finalize_delivery_package","legal_refresh_authoritative_sources","legal_authority_source_status","legal_process_notice_link"]) {
      expect(catalogNames).toContain(name); expect(registry.get(name)?.name).toBe(name);
    }
    expect(registry.get('legal_triad_analysis')).toBeUndefined();
    expect(registry.get('legal_case_reasoning_matrix')).toBeTruthy();
    expect(registry.get('legal_case_workflow_status')).toBeTruthy();
    expect(registry.get('legal_message_intake_to_case')).toBeTruthy();
    expect(registry.get('legal_refresh_authoritative_sources')).toBeTruthy();
    expect(registry.get('legal_authority_source_status')).toBeTruthy();
    expect(legalToolsShimSource).toContain("../../regions/packs/cn/legal_tools");
    expect(legalToolsShimSource).not.toContain('三段论是 Lumi 法律工作的核心基础');
    expect(legalToolsSource).toContain('三段论是 Lumi 法律工作的核心基础');
    expect(legalToolsSource).not.toContain('Standard Legal Casework Sequence');
    expect(legalToolsSource).toContain('Major premise');
    expect(legalToolsSource).toContain('Minor premise');
    expect(legalToolsSource).not.toContain('Conclusion / subsumption');
    expect(toolRouterSource).toContain('legal_case_reasoning_matrix');
    expect(toolRouterSource).toContain('legal_case_workflow_status');
    expect(toolRouterSource).toContain('legal_message_intake_to_case');
    expect(toolRouterSource).not.toContain('legal_triad_analysis');
  });
});

describe('legal web login presets', () => {
  const requiredPresetIds = [
    'faxin',
    'china-judgments-online',
    'people-court-case-library',
    'court-online-service',
    'qichacha',
    'national-enterprise-credit',
    'fachan',
    'alpha-lawyer',
  ];

  it('exposes all legal research and filing presets', () => {
    const presets = listWebLoginSitePresets('legal');
    const ids = presets.map(preset => preset.id);

    expect(ids).toEqual(expect.arrayContaining(requiredPresetIds));
    for (const id of requiredPresetIds) {
      const preset = getWebLoginSitePreset(id);
      expect(preset).toBeTruthy();
      expect(preset?.loginUrl).toMatch(/^https:\/\//);
      expect(preset?.matchHosts.length).toBeGreaterThan(0);
      expect(preset?.notes).toMatch(/Lumi/);
      expect(preset?.notes).toMatch(/授权|登录|人工|验证码|限制/);
    }
  });

  it('lists legal presets through the web login tool without touching credentials', async () => {
    const registry = new ToolRegistry();
    registerWebLoginTools(registry);

    const output = await registry.execute(
      'web_login_site_presets',
      { category: 'legal' },
      { requestConfirmation: async () => true },
    );
    const data = JSON.parse(output);
    const ids = data.presets.map((preset: { id: string }) => preset.id);

    expect(ids).toEqual(expect.arrayContaining(requiredPresetIds));
    expect(data.note).toMatch(/select.*site.*authorized browser session/i);
    expect(data.note).not.toMatch(/web_login_profile_save_from_preset|password|apiKey|appSecret/i);
    for(const preset of data.presets){const actual=getWebLoginSitePreset(preset.id)!;expect(preset).toMatchObject({id:actual.id,loginUrl:actual.loginUrl,matchHosts:actual.matchHosts});if(actual.sourceUrl)expect(preset.sourceUrl).toBe(actual.sourceUrl);}
    expect(JSON.stringify(data)).not.toMatch(/password|appSecret|accessToken|Bearer /i);
  });
});

describe('formal delivery rejects incomplete legal authority without producing a deliverable',()=>{
 const reasoning='大前提：依据《民法典》第五百八十五条的违约金规则。\n小前提：本案合同、交货及付款材料仍需逐项核对。\n结论：仅在事实和来源核实后形成法律意见。';
 it.each(['metadata_only','missing_fact_date','quotation_mismatch'])('withholds formal files when %s',async scenario=>{const registry=createLegalRegistry();if(scenario==='metadata_only')installMetadataOnlyFixtures();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumi_legal_exact_gate_'));try{const output=await registry.execute('legal_finalize_delivery_package',{caseName:'证据硬门测试',documentType:'法律意见书',...(scenario==='missing_fact_date'?{}:{factDate:'2026-01-15'}),outputDir:dir,includeDocx:true,includePdf:false,reasoningSummary:reasoning,content:scenario==='quotation_mismatch'?'依据《民法典》第五百八十五条：“任何买卖都禁止约定违约金”。':'依据《民法典》第五百八十五条，对现有材料作待律师复核的意见。'});expect(output).toContain('正式交付包未生成');expect(output).not.toContain('正式交付包已生成');expect(fs.existsSync(path.join(dir,'01_formal-document.md'))).toBe(false);expect(fs.readdirSync(dir).some(file=>file.endsWith('.docx'))).toBe(false);expect(fs.existsSync(path.join(dir,'02_citation-verification-report.md'))).toBe(true);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
});
