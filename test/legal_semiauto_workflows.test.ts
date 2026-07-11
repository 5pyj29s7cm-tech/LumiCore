import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
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
    expect(output).toContain('web_login_run');
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
      });

      const packetPath = path.join(dir, '00_litigation-packet.md');
      const filingChecklistPath = path.join(dir, '01_filing-material-checklist.md');
      const authorizationChecklistPath = path.join(dir, '02_authorization-checklist.md');
      const evidenceMatrixPath = path.join(dir, '03_evidence-review-matrix.md');

      expect(output).toContain('诉讼文书包文件输出');
      expect(output).toContain('文书包总稿文件');
      expect(output).toContain('立案材料清单文件');
      expect(output).toContain('授权委托手续清单文件');
      expect(output).toContain('证据目录与三性矩阵文件');
      expect(fs.existsSync(packetPath)).toBe(true);
      expect(fs.existsSync(filingChecklistPath)).toBe(true);
      expect(fs.existsSync(authorizationChecklistPath)).toBe(true);
      expect(fs.existsSync(evidenceMatrixPath)).toBe(true);
      expect(fs.readFileSync(filingChecklistPath, 'utf8')).toContain('Filing Material Checklist');
      expect(fs.readFileSync(authorizationChecklistPath, 'utf8')).toContain('Authorization Checklist');
      expect(fs.readFileSync(evidenceMatrixPath, 'utf8')).toContain('Evidence Catalog And Three-Property Review');

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

  it('extracts dispute focuses from complaint, evidence, and trial notes', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_extract_dispute_focus', {
      caseName: 'Trial Focus Case',
      role: 'defendant',
      caseType: '买卖合同纠纷',
      complaint: '原告称双方合同成立，被告拖欠货款并应承担违约金。',
      evidence: '合同、发货单、签收单、质量异议函、聊天记录。',
      transcript: '庭审中双方争议付款条件是否成就、质量异议是否成立、违约金是否过高。',
    });

    expect(output).toContain('Trial Focus Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toMatch(/争议焦点|待证事实|质证|抗辩/);
    expect(output).toMatch(/已有证据|待补证据|外部检索关键词/);
    expect(output).toMatch(/律师|复核|确认/);
  });

  it('creates unified legal case workspaces with case state and search order', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workspace-${Date.now()}`;

    const output = await registry.execute('legal_case_workspace', {
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

    expect(output).toContain('案件工作台');
    expect(output).toContain('案件ID：');
    expect(output).toContain('闭环状态');
    expect(output).toContain('完成度：');
    expect(output).toContain('下一动作：');
    expect(output).toContain('推荐工具');
    expect(output).toContain('优先行动队列');
    expect(output).toContain('| 顺位 | 模块 | 状态 | 下一步 | 推荐工具 |');
    expect(output).toContain('Standard Legal Casework Sequence');
    expect(output).toContain('Intake / case space');
    expect(output).toContain('Major premise');
    expect(output).toContain('Minor premise');
    expect(output).toContain('Conclusion / subsumption');
    expect(output).toContain('Current-law gate');
    expect(output).toContain('legal_message_intake_to_case -> legal_case_workspace');
    expect(output).toContain('legal_generate_citation_verification_report -> legal_finalize_delivery_package');
    expect(output).toContain('三段论分析');
    expect(output).toContain('底层必经');
    expect(output).toContain('证据目录与三性审查矩阵');
    expect(output).toContain('三性审查矩阵');
    expect(output).toContain('真实性核验');
    expect(output).toContain('合法性核验');
    expect(output).toContain('关联性核验');
    expect(output).toContain('现行有效法律');
    expect(output).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
    expect(output).toContain('legal_case_reasoning_matrix');
    expect(output).toContain('legal_generate_litigation_packet');
    expect(output).toContain('legal_finalize_delivery_package');
    expect(output).toContain('人民法院在线服务');
  });

  it('marks blocked current-law steps in the case workflow state machine', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workflow-block-${Date.now()}`;

    const output = await registry.execute('legal_case_workspace', {
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

    expect(output).toContain('闭环状态');
    expect(output).toContain('阻断项：');
    expect(output).toMatch(/\| 现行有效法律 \| 阻断 \|/);
    expect(output).toContain('合同法');
    expect(output).toContain('legal_search_statute / legal_generate_citation_verification_report');
    expect(output).toContain('未通过现行有效法律硬门槛时自动阻断');
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
    const caseId = workspace.match(/案件ID：([0-9a-f-]+)/)?.[1];
    expect(caseId).toBeTruthy();

    const output = await registry.execute('legal_case_workflow_status', {
      orgId,
      caseId,
      legalAuthorities: '拟引用《合同法》第六十条。',
    });

    expect(output).toContain('案件闭环状态');
    expect(output).toContain('直接状态查询测试案');
    expect(output).toContain('完成度：');
    expect(output).toContain('下一动作：');
    expect(output).toContain('优先行动队列');
    expect(output).toContain('| 顺位 | 模块 | 状态 | 下一步 | 推荐工具 |');
    expect(output).toContain('Standard Legal Casework Sequence');
    expect(output).toContain('Major premise');
    expect(output).toContain('Minor premise');
    expect(output).toContain('Conclusion / subsumption');
    expect(output).toContain('Current-law gate');
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
      const caseId = workspace.match(/案件ID：([0-9a-f-]+)/)?.[1];
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
        orgId,
        userId: 'vitest',
        caseId,
        caseName: '案件归档闭环测试案',
        documentType: '代理词',
        outputDir: dir,
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

  it('turns legal meeting transcripts into archived case minutes', async () => {
    const registry = createLegalRegistry();
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
      expect(markdown).toContain('沟通要点');
      expect(markdown).toContain('证据线索与三性提示');
      expect(markdown).toContain('真实性');
      expect(markdown).toContain('合法性');
      expect(markdown).toContain('关联性');
      expect(markdown).toContain('期限和待办');
      expect(markdown).toContain('法律成果预检');
      expect(markdown).toContain('legal_case_workspace');
      expect(markdown).toContain('Live Meeting Workstream');
      expect(markdown).toContain('Rolling Summary');
      expect(fs.readFileSync(liveBriefPath, 'utf8')).toContain('Automatic Follow-Up');
      expect(fs.readFileSync(actionItemsPath, 'utf8')).toContain('Meeting Action Items');
      expect(fs.readFileSync(actionItemsPath, 'utf8')).toContain('Next Legal Workflow');
      expect(fs.readFileSync(caseUpdatePath, 'utf8')).toContain('Case Intake Update');
      expect(fs.readFileSync(caseUpdatePath, 'utf8')).toContain('Case Workspace Fields To Recheck');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'meeting'
        && material.type === 'consultation'
        && material.title.includes('法律会议纪要')
        && material.localPath === minutesPath
      ))).toBe(true);
      expect(caseFile?.materials.some(material => (
        material.source === 'meeting'
        && material.type === 'note'
        && material.title.includes('会议行动项与期限')
        && material.localPath === actionItemsPath
      ))).toBe(true);
      expect(caseFile?.materials.some(material => (
        material.source === 'meeting'
        && material.type === 'note'
        && material.title.includes('会议案件更新')
        && material.localPath === caseUpdatePath
      ))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates archived legal reasoning matrices for syllogism-style case analysis', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-reasoning-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_reasoning_'));
    const caseName = '三段论分析闭环测试案';

    try {
      const output = await registry.execute('legal_case_reasoning_matrix', {
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

      expect(output).toContain('法律分析三段论底稿已生成');
      expect(output).toContain('现行有效法律预检：通过');
      expect(output).toContain('底稿文件');
      expect(output).toContain('案件空间：已归档');

      const matrixPath = path.join(dir, 'legal-reasoning-matrix.md');
      expect(fs.existsSync(matrixPath)).toBe(true);
      const markdown = fs.readFileSync(matrixPath, 'utf8');
      expect(markdown).toContain('法律分析三段论底稿');
      expect(markdown).toContain('大前提：检索法律、解释法律、类案补强');
      expect(markdown).toContain('小前提：待证事实、证据材料、举证质证');
      expect(markdown).toContain('结论：涵摄、文书表达、风险');
      expect(markdown).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
      expect(markdown).toContain('legal_finalize_delivery_package');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'tool'
        && material.type === 'note'
        && material.title.includes('法律分析三段论底稿')
        && material.localPath === matrixPath
      ))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archives contract and bid work products into the case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-contract-bid-${Date.now()}`;
    const caseName = '合同标书闭环测试案';

    const review = await registry.execute('legal_review_contract', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '合同审查',
      contract: [
        '建设工程施工合同',
        '发包人逾期付款的，承包人每日按合同总价30%收取违约金。',
        '任一方可单方解除合同，无需通知对方。',
      ].join('\n'),
    });
    expect(review).toContain('案件归档与交付边界');
    expect(review).toContain('案件空间：已归档');
    expect(review).toContain('legal_finalize_delivery_package');

    const draft = await registry.execute('legal_draft_contract', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '合同起草',
      type: '建设工程施工合同',
      details: '项目名称：测试工程；工期：90日；价款：待填写；需要违约责任和付款节点。',
    });
    expect(draft).toContain('合同起草');
    expect(draft).toContain('案件空间：已归档');

    const bid = await registry.execute('legal_generate_bid', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '投标/招标文件响应',
      projectName: '测试工程投标项目',
      requirements: '招标要求：提交商务标、技术标、项目管理机构、施工组织设计、授权委托书和报价清单。',
    });
    expect(bid).toContain('投标书');
    expect(bid).toContain('案件空间：已归档');
    expect(bid).toContain('三段论核心基础');

    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile?.materials.some(material => (
      material.type === 'contract'
      && material.title.includes('合同审查报告')
    ))).toBe(true);
    expect(caseFile?.materials.some(material => (
      material.type === 'contract'
      && material.title.includes('合同起草底稿')
    ))).toBe(true);
    expect(caseFile?.materials.some(material => (
      material.type === 'note'
      && material.title.includes('投标书工作底稿')
    ))).toBe(true);
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
    expect(output).toContain('legal_finalize_delivery_package');
  });

  it('archives core litigation work products into the same case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-core-products-${Date.now()}`;
    const caseName = '核心办案产物闭环测试案';

    const packet = await registry.execute('legal_generate_litigation_packet', {
      orgId,
      userId: 'vitest',
      caseName,
      role: '原告',
      caseType: '买卖合同纠纷',
      facts: '被告收货后未付剩余货款。',
      evidence: '买卖合同；送货单；签收单；银行流水。',
    });
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

    for (const output of [packet, focus, argument, strategy]) {
      expect(output).toContain('案件归档与交付边界');
      expect(output).toContain('案件空间：已归档');
      expect(output).toContain('legal_finalize_delivery_package');
    }

    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    const titles = caseFile?.materials.map(material => material.title).join('\n') || '';
    expect(titles).toContain('半自动诉讼文书包');
    expect(titles).toContain('争议焦点提炼');
    expect(titles).toContain('代理词草稿');
    expect(titles).toContain('诉讼策略分析');
  });

  it('archives asset tracing and equity penetration reports into case workspaces', async () => {
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

      expect(assets).toContain('财产线索报告');
      expect(assets).toContain('案件空间：已归档');
      expect(equity).toContain('授权网页登录协作');
      expect(equity).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.type === 'evidence'
        && material.title.includes('财产线索报告')
      ))).toBe(true);
      expect(caseFile?.materials.some(material => (
        material.type === 'evidence'
        && material.title.includes('股权穿透')
      ))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('generates bid work products directly from local tender files', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-bid-file-${Date.now()}`;
    const caseName = '招标文件直读闭环测试案';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_bid_file_'));
    const tenderPath = path.join(dir, 'tender-requirements.txt');

    try {
      fs.writeFileSync(tenderPath, [
        '招标要求：提交商务标、技术标、项目管理机构、施工组织设计。',
        '评分标准：企业资质、类似业绩、技术方案、报价清单、授权委托书。',
        '合同条款：需响应付款节点、违约责任、工期、质量标准。',
      ].join('\n'), 'utf8');

      const output = await registry.execute('legal_generate_bid', {
        orgId,
        userId: 'vitest',
        caseName,
        caseType: '投标/招标文件响应',
        projectName: '直读招标文件测试项目',
        filePath: tenderPath,
      });

      expect(output).toContain('直读招标文件测试项目');
      expect(output).toContain('招标文件来源');
      expect(output).toContain('tender-requirements.txt');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.type === 'note'
        && material.title.includes('投标书工作底稿')
        && material.content.includes('招标文件来源')
        && material.content.includes('tender-requirements.txt')
      ))).toBe(true);
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
      material.source === 'import'
      && material.type === 'consultation'
      && material.title.includes('微信法律消息原文')
      && material.content.includes('court.example.test/notice/456')
      && material.content.includes('阿陆')
    ))).toBe(true);
  });

  it('generates argument and legal-opinion drafts as lawyer-reviewed work products', async () => {
    const registry = createLegalRegistry();

    const argument = await registry.execute('legal_generate_argument_or_opinion', {
      caseName: 'Argument Draft Case',
      role: 'plaintiff',
      documentType: '代理词',
      caseType: '买卖合同纠纷',
      facts: '双方签订买卖合同后，原告完成供货，被告以质量问题拒付剩余货款。',
      issues: ['付款条件是否成就', '质量异议抗辩是否成立', '违约金是否需要调整'],
      evidence: '合同、订单、发货单、签收单、发票、银行流水。',
      opponentArguments: '被告主张货物存在质量问题，拒绝支付剩余货款。',
      objective: '请求支持货款和违约金。',
    });
    const opinion = await registry.execute('legal_generate_argument_or_opinion', {
      caseName: 'Opinion Draft Case',
      role: 'defendant',
      documentType: '法律意见书',
      caseType: '买卖合同纠纷',
      facts: '客户收到起诉状后，需要评估质量异议抗辩、违约金调整和和解空间。',
      evidence: '验收异议函、退货沟通记录、检测报告。',
      opponentArguments: '原告主张已按约供货并要求支付全额货款。',
      objective: '形成应诉和谈判意见。',
    });

    for (const output of [argument, opinion]) {
      expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
      expect(output).toMatch(/争议焦点|法律分析|证据评价|复核清单/);
      expect(output).toMatch(/待检索|待核验|待补证|律师/);
    }
    expect(argument).toMatch(/代理词|结论请求/);
    expect(opinion).toMatch(/法律意见书|风险提示|处理建议/);
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
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
      expect(output).toContain('三段论推理链硬门槛未通过');
      expect(output).toContain('legal_case_reasoning_matrix');
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

  it('blocks formal legal delivery packages when statute citations are repealed or unverified', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_blocked_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', {
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
      expect(output).toContain('ocr_image_file');
      expect(output).toContain('legal_import_materials_to_kb');

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
    const legalHubSource = fs.readFileSync(path.join(process.cwd(), 'src/components/org/LegalHub.tsx'), 'utf-8');
    const toolRouterSource = fs.readFileSync(path.join(process.cwd(), 'server/cognition/tool_router.ts'), 'utf-8');
    const legalToolsSource = fs.readFileSync(path.join(process.cwd(), 'server/tools/definitions/legal_tools.ts'), 'utf-8');
    const chatRoutesSource = fs.readFileSync(path.join(process.cwd(), 'server/routes/chat_routes.ts'), 'utf-8');

    expect(legalHubSource).not.toContain("id: 'triad'");
    expect(legalHubSource).not.toContain('LegalTriadView');
    expect(legalHubSource).toContain('legal_generate_litigation_packet');
    expect(legalHubSource).toContain('legal_external_research_plan');
    expect(legalHubSource).toContain('buildLegalCaseReadiness');
    expect(legalHubSource).toContain('buildLegalCaseActionSummary');
    expect(legalHubSource).toContain('LEGAL_CASE_READINESS_TOOLS');
    expect(legalHubSource).toContain('Case Action Board');
    expect(legalHubSource).toContain('actionSummary.canDeliver');
    expect(legalHubSource).toContain('actionSummary.canDraft');
    expect(legalHubSource).toContain('actionSummary.primary.tool');
    expect(legalHubSource).toContain('actionSummary.blockers');
    expect(legalHubSource).toContain('actionSummary.gaps');
    expect(legalHubSource).toContain('legalCaseToolArgs');
    expect(legalHubSource).toContain("runLegalTool('legal_case_reasoning_matrix'");
    expect(legalHubSource).toContain('办案闭环');
    expect(legalHubSource).toContain('persistCase: true');
    expect(legalHubSource).toContain('legal_finalize_delivery_package');
    expect(legalHubSource).toContain('legal_process_notice_link');
    expect(legalHubSource).toContain('处理短信链接');
    expect(fs.readFileSync(path.join(process.cwd(), 'src/lib/legalToolClient.ts'), 'utf-8')).toContain('/api/legal/tool/');
    expect(chatRoutesSource).toContain('DIRECT_LEGAL_TOOL_ALLOWLIST');
    expect(chatRoutesSource).toContain('/legal/tool/:toolName');
    expect(chatRoutesSource).toContain('legal_generate_litigation_packet');
    expect(chatRoutesSource).toContain('legal_case_workflow_status');
    expect(chatRoutesSource).toContain('legal_message_intake_to_case');
    expect(chatRoutesSource).toContain('legal_finalize_delivery_package');
    expect(chatRoutesSource).toContain('legal_process_notice_link');
    expect(registry.get('legal_triad_analysis')).toBeUndefined();
    expect(registry.get('legal_case_reasoning_matrix')).toBeTruthy();
    expect(registry.get('legal_case_workflow_status')).toBeTruthy();
    expect(registry.get('legal_message_intake_to_case')).toBeTruthy();
    expect(legalToolsSource).toContain('三段论是 Lumi 法律工作的核心基础');
    expect(legalToolsSource).toContain('Standard Legal Casework Sequence');
    expect(legalToolsSource).toContain('Major premise');
    expect(legalToolsSource).toContain('Minor premise');
    expect(legalToolsSource).toContain('Conclusion / subsumption');
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
    expect(data.note).toContain('web_login_profile_save_from_preset');
  });
});
