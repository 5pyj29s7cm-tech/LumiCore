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
    expect(output).toMatch(/律师|人工|确认/);
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
    expect(output).toMatch(/程序抗辩|时效|主体资格/);
    expect(output).toMatch(/提交|签字|盖章|发送/);
    expect(output).toMatch(/律师|人工|确认/);
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

    const output = await registry.execute('legal_external_research_plan', {
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
        content: [
          '# 代理词草稿',
          '根据《合同法》第六十条和《民法典》第五百八十五条，结合（2025）沪0101民初123号案件材料，形成如下意见。',
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
      expect(report).toMatch(/合同法|已废止/);
      expect(report).toContain('律师最终检索');
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
    process.env.PKULAW_API_KEY = 'test-pkulaw-key';
    process.env.PKULAW_BASE_URL = 'https://pkulaw.local/search';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        items: [{
          title: 'Contract dispute authority',
          caseNumber: '(2026) Test Case No.1',
          court: 'Supreme Test Court',
          summary: 'A controlled mocked authority result.',
          url: 'https://pkulaw.local/case/1',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const output = await registry.execute('legal_search_external_authorities', {
        query,
        type: 'case',
        sourceIds: ['pkulaw'],
        limit: 1,
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(output).toContain('Contract dispute authority');
      expect(output).toContain('(2026) Test Case No.1');
      expect(output).toContain('pkulaw');
      expect(output).toMatch(/授权|API|复核/);
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
        name: companyName,
        sourceIds: ['tianyancha'],
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(output).toContain(companyName);
      expect(output).toContain('Jane Test');
      expect(output).toContain('91310000TESTCODE');
      expect(output).toMatch(/天眼查|API|网页登录/);
    } finally {
      fetchMock.mockRestore();
      if (original.TIANYANCHA_API_KEY === undefined) delete process.env.TIANYANCHA_API_KEY;
      else process.env.TIANYANCHA_API_KEY = original.TIANYANCHA_API_KEY;
      if (original.TIANYANCHA_BASE_URL === undefined) delete process.env.TIANYANCHA_BASE_URL;
      else process.env.TIANYANCHA_BASE_URL = original.TIANYANCHA_BASE_URL;
    }
  });

  it('keeps triad reasoning as underlying logic rather than a standalone UI tab', () => {
    const registry = createLegalRegistry();
    const legalHubSource = fs.readFileSync(path.join(process.cwd(), 'src/components/org/LegalHub.tsx'), 'utf-8');
    const toolRouterSource = fs.readFileSync(path.join(process.cwd(), 'server/cognition/tool_router.ts'), 'utf-8');

    expect(legalHubSource).not.toContain("id: 'triad'");
    expect(legalHubSource).not.toContain('LegalTriadView');
    expect(legalHubSource).toContain('legal_generate_litigation_packet');
    expect(legalHubSource).toContain('legal_external_research_plan');
    expect(registry.get('legal_triad_analysis')).toBeUndefined();
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
