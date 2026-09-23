export type FinanceWorkbenchLanguage = 'zh' | 'en';

export interface FinanceWorkflowCopy {
  id: string;
  title: string;
  description: string;
  evidence: string;
  prompt: string;
}

export interface FinanceWorkbenchCopy {
  title: string;
  shortTitle: string;
  subtitle: string;
  ready: string;
  checking: string;
  runtimeAttention: string;
  enabled: string;
  connected: string;
  unavailable: string;
  personalScope: string;
  organizationScope: string;
  sourceFiles: string;
  manageSkills: string;
  workflowTitle: string;
  workflowSubtitle: string;
  start: string;
  evidenceLabel: string;
  marketTitle: string;
  marketDescription: string;
  marketRules: string[];
  safetyTitle: string;
  safetyDescription: string;
  workflows: FinanceWorkflowCopy[];
}

const COPY: Record<FinanceWorkbenchLanguage, FinanceWorkbenchCopy> = {
  zh: {
    title: 'Lumi 财税工作台',
    shortTitle: '财税工作台',
    subtitle: '围绕企业经营、票税、账务、申报、资金风险和报表交付工作。所有数字保留来源、期间、币种、口径和复核边界。',
    ready: '本地财税运行时已就绪',
    checking: '正在核验财税运行时',
    runtimeAttention: '财税运行时需要检查',
    enabled: '已启用',
    connected: '已连接',
    unavailable: '未发现',
    personalScope: '个人数据域',
    organizationScope: '组织数据域',
    sourceFiles: '财税资料',
    manageSkills: '财税能力设置',
    workflowTitle: '财税结果入口',
    workflowSubtitle: '选择要交付的结果，Lumi 会逐项确认资料、期间和口径，再进入可追溯的处理与复核流程。',
    start: '开始任务',
    evidenceLabel: '交付依据',
    marketTitle: '扩展：市场研究与模拟盘',
    marketDescription: '这不是财税主流程。需要时可以查询最新可用行情、K 线、板块与新闻；模拟组合按个人或组织数据域隔离。',
    marketRules: [
      '每次行情结果显示数据源、源时间与获取时间。',
      '行情不可用时明确标记成本回退，不伪装成当前价格。',
      '只支持观察、研究和模拟盘，不连接券商真实下单。',
    ],
    safetyTitle: '财税安全边界',
    safetyDescription: 'Lumi 提供分析、底稿和待审交付物，不替代会计师、税务师或持牌投资顾问。申报、报送、付款和真实交易必须由负责人确认并以外部回执验收。',
    workflows: [
      {
        id: 'business-dashboard',
        title: '经营看板',
        description: '汇总收入、毛利、费用、现金流和预算差异，形成管理层今日或周期摘要。',
        evidence: '总账、预算表、银行及业务明细',
        prompt: '请启动财税版“经营看板”流程。先确认报告期间、币种和管理口径，再引导我添加总账、预算、银行流水或业务明细；使用管理报表与盈利指标能力，输出经营摘要、异常和行动清单，所有数字必须注明来源和计算口径。',
      },
      {
        id: 'invoice-tax',
        title: '票税管理',
        description: '核对发票、收入和税务底稿，识别重复、红字、税率与税负异常。',
        evidence: '发票清单、收入明细与纳税底稿',
        prompt: '请启动财税版“票税管理”流程。先确认地区、纳税人类型和期间，再引导我添加发票、收入和税务底稿；使用发票复核与税负测算能力，输出异常清单和复核依据，不要自行假设税率或申报截止日。',
      },
      {
        id: 'accounting',
        title: '账务处理',
        description: '执行总账核对、应收应付账龄分析，并形成可复核差异清单。',
        evidence: '总账、明细账、合同、发票、银行和回款记录',
        prompt: '请启动财税版“账务处理”流程。先确认会计期间、币种和会计口径，再引导我添加总账、明细账和银行或往来资料；使用账簿核对与应收应付账龄能力，输出差异、异常、证据和建议，不直接改账。',
      },
      {
        id: 'tax-filing',
        title: '税务申报',
        description: '按地区、税种和期间整理申报任务、资料缺口与待确认申报包。',
        evidence: '税种信息、期间账表、发票、历史申报和当地规则',
        prompt: '请启动财税版“税务申报”准备流程。先确认司法辖区、纳税人类型、税种和申报期间，再使用税务期间检查清单核验资料完整性；只生成待复核的申报清单和申报包，不登录税局、不提交申报。',
      },
      {
        id: 'cash-risk',
        title: '资金与风险',
        description: '基于现金、收付款计划和往来集中度生成多情景预测与风险预警。',
        evidence: '银行余额、应收应付、资金计划与经营假设',
        prompt: '请启动财税版“资金与风险”流程。先确认预测期间、期初现金、应收应付和经营假设，再使用现金流预测与账龄分析能力，分别输出基准、乐观和压力情景、集中度以及现金缺口预警。',
      },
      {
        id: 'report-delivery',
        title: '报表交付',
        description: '复核报表勾稽关系，生成可打开、可追溯的表格、报告和交付说明。',
        evidence: '总账、报表、附注、计算底稿与交付要求',
        prompt: '请启动财税版“报表交付”流程。先确认报告期间、币种、会计口径和文件格式，再执行报表一致性复核；需要文件时生成真实 XLSX、DOCX 或 PDF，并验证文件可打开，列出来源、勾稽差异、待复核项和交付路径。',
      },
    ],
  },
  en: {
    title: 'Lumi Finance & Tax Workbench',
    shortTitle: 'Finance & Tax',
    subtitle: 'Business operations, invoices, accounting, tax filing preparation, cash risk, and report delivery. Every number retains its source, period, currency, basis, and review boundary.',
    ready: 'Local finance and tax runtime ready',
    checking: 'Checking finance and tax runtime',
    runtimeAttention: 'Finance and tax runtime needs attention',
    enabled: 'Enabled',
    connected: 'Connected',
    unavailable: 'Not found',
    personalScope: 'Personal data scope',
    organizationScope: 'Organization data scope',
    sourceFiles: 'Finance & tax records',
    manageSkills: 'Capability settings',
    workflowTitle: 'Finance & tax outcomes',
    workflowSubtitle: 'Choose the result you need. Lumi will confirm records, period, and basis before entering a traceable processing and review flow.',
    start: 'Start task',
    evidenceLabel: 'Evidence',
    marketTitle: 'Extension: market research and paper trading',
    marketDescription: 'This is not a core finance and tax workflow. When needed, review latest available quotes, K-lines, sectors, and news. Simulated portfolios remain scope-isolated.',
    marketRules: [
      'Every market result includes provider, source time, and retrieval time.',
      'Unavailable quotes are labeled as cost fallback and never presented as current prices.',
      'Observation, research, and paper trading only; no real brokerage execution.',
    ],
    safetyTitle: 'Finance and tax safety boundary',
    safetyDescription: 'Lumi produces analysis, workpapers, and review-ready deliverables; it does not replace accountants, tax professionals, or licensed investment advisers. Filing, reporting, money movement, and real trades require accountable approval and external receipts.',
    workflows: [
      {
        id: 'business-dashboard',
        title: 'Business dashboard',
        description: 'Summarize revenue, margin, expenses, cash flow, and budget variance for management.',
        evidence: 'Ledger, budget, bank, and operating detail',
        prompt: 'Start the Finance & Tax “Business dashboard” workflow. Confirm period, currency, and management basis, then collect ledger, budget, bank, or operating data. Use management-report and profitability capabilities to produce a summary, anomalies, and actions with sources and calculations.',
      },
      {
        id: 'invoice-tax',
        title: 'Invoice & tax management',
        description: 'Reconcile invoices, revenue, and tax workpapers and identify duplicates, credits, rate, and tax-position anomalies.',
        evidence: 'Invoice list, revenue detail, and tax workpapers',
        prompt: 'Start the Finance & Tax “Invoice & tax management” workflow. Confirm jurisdiction, taxpayer type, and period, then collect invoice, revenue, and tax data. Use invoice review and tax-position capabilities. Do not assume rates or deadlines.',
      },
      {
        id: 'accounting',
        title: 'Accounting',
        description: 'Reconcile ledgers and analyze AR/AP aging with a reviewable difference list.',
        evidence: 'General ledger, subledgers, contracts, invoices, bank, and receipts',
        prompt: 'Start the Finance & Tax “Accounting” workflow. Confirm period, currency, and accounting basis, then collect ledger, bank, and counterparty records. Use ledger reconciliation and AR/AP aging capabilities. Produce differences and evidence without posting entries.',
      },
      {
        id: 'tax-filing',
        title: 'Tax filing preparation',
        description: 'Organize filing tasks, missing records, and a review-ready filing packet by jurisdiction, tax, and period.',
        evidence: 'Tax profile, period records, invoices, prior filings, and local rules',
        prompt: 'Start the Finance & Tax “Tax filing preparation” workflow. Confirm jurisdiction, taxpayer type, tax, and period, then use the tax-period checklist to verify completeness. Prepare a review packet only; do not sign in or file.',
      },
      {
        id: 'cash-risk',
        title: 'Cash & risk',
        description: 'Create scenario forecasts and risk alerts from cash, payment plans, and counterparty concentration.',
        evidence: 'Bank balances, AR/AP, cash plan, and operating assumptions',
        prompt: 'Start the Finance & Tax “Cash & risk” workflow. Confirm the forecast period, opening cash, AR/AP, and operating assumptions. Use cash-flow forecasting and aging analysis to produce base, upside, and stress scenarios, concentration, and cash-gap alerts.',
      },
      {
        id: 'report-delivery',
        title: 'Report delivery',
        description: 'Review statement consistency and generate openable, traceable spreadsheets, reports, and delivery notes.',
        evidence: 'Ledger, statements, notes, workpapers, and delivery requirements',
        prompt: 'Start the Finance & Tax “Report delivery” workflow. Confirm period, currency, accounting basis, and file formats, then review statement consistency. Generate real XLSX, DOCX, or PDF files when requested and verify they open, with sources, differences, review items, and output paths.',
      },
    ],
  },
};

export function financeWorkbenchCopy(language: string): FinanceWorkbenchCopy {
  return COPY[language === 'zh' ? 'zh' : 'en'];
}
