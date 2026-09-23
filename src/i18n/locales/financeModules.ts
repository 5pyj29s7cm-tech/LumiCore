export type FinanceModuleId =
  | 'business-dashboard'
  | 'invoice-tax'
  | 'accounting'
  | 'tax-filing'
  | 'cash-risk'
  | 'report-delivery';

export interface FinanceModuleCopy {
  id: FinanceModuleId;
  eyebrow: string;
  title: string;
  description: string;
  inputTitle: string;
  inputs: string[];
  processTitle: string;
  process: string[];
  outputTitle: string;
  outputs: string[];
  reviewTitle: string;
  checks: string[];
  taskTitle: string;
  taskHint: string;
  taskPlaceholder: string;
  sourcePending: string;
  reviewPending: string;
  startLabel: string;
  executionTitle: string;
  executionRunning: string;
  executionWaiting: string;
  stopLabel: string;
}

const zhCommon = {
  executionTitle: 'Lumi 执行结果',
  executionRunning: 'Lumi 正在处理并核验结果…',
  executionWaiting: '任务已创建，等待首条执行结果。',
  stopLabel: '停止本次执行',
  inputTitle: '所需资料',
  processTitle: '处理流程',
  outputTitle: '结果交付',
  reviewTitle: '复核门禁',
  taskTitle: '说明本次工作',
  taskHint: '可以直接开始；Lumi 会创建持久任务，缺少资料时先向你确认，不会自行补数字。',
  sourcePending: '等待资料',
  reviewPending: '待复核',
  startLabel: '建立任务并交给 Lumi',
};

const enCommon = {
  executionTitle: 'Lumi execution result',
  executionRunning: 'Lumi is working and verifying the result…',
  executionWaiting: 'Task created; waiting for the first execution result.',
  stopLabel: 'Stop this run',
  inputTitle: 'Required records',
  processTitle: 'Processing flow',
  outputTitle: 'Deliverables',
  reviewTitle: 'Review gates',
  taskTitle: 'Describe this job',
  taskHint: 'You can start directly. Lumi creates a persistent task and asks for missing records instead of inventing figures.',
  sourcePending: 'Awaiting records',
  reviewPending: 'Review required',
  startLabel: 'Create task and hand off to Lumi',
};

const ZH: Record<FinanceModuleId, FinanceModuleCopy> = {
  'business-dashboard': {
    id: 'business-dashboard',
    ...zhCommon,
    eyebrow: '经营分析中心',
    title: '经营看板',
    description: '把收入、毛利、费用、现金和预算差异归一到同一期间与口径，形成管理层可直接阅读的经营摘要。',
    inputs: ['总账与业务收入明细', '预算、目标和上期对比数据', '银行流水、费用与现金流资料'],
    process: ['确认期间、币种与管理口径', '回勾收入、成本和费用总额', '计算利润、现金与预算差异', '定位异常并形成行动建议'],
    outputs: ['经营指标卡与趋势摘要', '重大差异和异常清单', '管理行动项与责任建议'],
    checks: ['每个数字可回到来源', '利润与现金流分开说明', '异常阈值和计算口径明确'],
    taskPlaceholder: '例如：整理 7 月经营数据，重点比较收入、毛利、费用和现金变化……',
  },
  'invoice-tax': {
    id: 'invoice-tax',
    ...zhCommon,
    eyebrow: '票据与税负复核',
    title: '票税管理',
    description: '集中核对销项、进项、收入与纳税底稿，识别重复、红字、税率和税负异常。',
    inputs: ['销项和进项发票清单', '收入、采购与合同明细', '纳税底稿和历史申报记录'],
    process: ['识别重复票、红字票与缺失字段', '按业务和期间核对收入', '核验税率、价税口径与抵扣状态', '汇总异常及待人工判断事项'],
    outputs: ['发票异常复核表', '进销项与税负摘要', '待补资料和待确认事项'],
    checks: ['不自行假设税率', '票据与业务记录逐项留痕', '申报前由责任人确认'],
    taskPlaceholder: '例如：复核本月进销项发票，找出重复票、税率异常和缺少业务依据的记录……',
  },
  accounting: {
    id: 'accounting',
    ...zhCommon,
    eyebrow: '账簿核对中心',
    title: '账务处理',
    description: '围绕总账、明细账、银行和往来资料形成可复核的对账结果，不直接替你修改账簿。',
    inputs: ['总账与科目明细账', '银行流水和回款记录', '合同、发票及应收应付明细'],
    process: ['统一会计期间、币种和借贷符号', '匹配账簿与银行记录', '分析应收应付账龄', '整理差异、证据和调账建议'],
    outputs: ['账银匹配结果', '未匹配与歧义清单', '应收应付账龄及建议'],
    checks: ['总账与明细账勾稽', '差异不被自动抹平', '调账建议必须人工复核'],
    taskPlaceholder: '例如：核对 7 月银行流水和总账，输出未匹配记录及应收应付账龄……',
  },
  'tax-filing': {
    id: 'tax-filing',
    ...zhCommon,
    eyebrow: '申报准备与日历',
    title: '税务申报',
    description: '按地区、纳税人、税种和期间组织申报准备，生成待复核申报包，但不替用户登录或提交。',
    inputs: ['司法辖区与纳税人类型', '税种、申报期间和截止日期', '账表、发票、历史申报及当地规则'],
    process: ['确认申报主体与税种范围', '检查期间资料完整性', '整理计算底稿和差异说明', '生成待复核申报清单与文件包'],
    outputs: ['申报日历与任务清单', '缺口资料和风险提示', '待复核申报包'],
    checks: ['截止日期来源可追溯', '地区规则已核对', '提交动作必须最终确认'],
    taskPlaceholder: '例如：准备本季度增值税申报资料，先检查缺口和截止日期，不执行最终提交……',
  },
  'cash-risk': {
    id: 'cash-risk',
    ...zhCommon,
    eyebrow: '资金预测与风险预警',
    title: '资金与风险',
    description: '基于期初现金、收付款计划、账龄和经营假设形成基准、乐观与压力情景。',
    inputs: ['银行余额与可用资金', '应收应付和收付款计划', '经营假设、授信及重大合同'],
    process: ['确认预测周期和期初现金', '建立收支与账龄时间轴', '计算多情景现金曲线', '识别缺口、集中度和到期风险'],
    outputs: ['多情景现金预测', '现金缺口与时间窗口', '客户集中度和风险行动表'],
    checks: ['事实与假设分开呈现', '压力参数清晰可调', '付款和资金动作不自动执行'],
    taskPlaceholder: '例如：做未来 13 周现金预测，加入回款延迟和成本上涨的压力情景……',
  },
  'report-delivery': {
    id: 'report-delivery',
    ...zhCommon,
    eyebrow: '财税文件交付中心',
    title: '报表交付',
    description: '复核报表勾稽关系，生成真实可打开、可追溯的本机 XLSX 复核工作簿。',
    inputs: ['总账、报表和附注', '计算底稿与差异说明', '期间、币种、业务类型和来源摘要'],
    process: ['检查资产负债与现金流勾稽', '核对期间、币种和来源', '生成固定格式的 XLSX 复核工作簿', '重新打开并验证工作表、请求绑定和关键内容'],
    outputs: ['已验证的 XLSX 复核工作簿', '来源、口径和差异说明', '待复核事项及本机文件路径'],
    checks: ['文件真实存在并可打开', '关键数字与底稿一致', '外发前必须最终确认'],
    taskPlaceholder: '可选：补充本次 XLSX 复核工作簿的口径或复核说明；当前不会生成 PDF/DOCX 或对外发送。',
  },
};

const EN: Record<FinanceModuleId, FinanceModuleCopy> = {
  'business-dashboard': {
    id: 'business-dashboard', ...enCommon, eyebrow: 'Management analytics', title: 'Business dashboard',
    description: 'Normalize revenue, margin, expenses, cash, and budget variance to one period and management basis.',
    inputs: ['General ledger and operating revenue detail', 'Budget, targets, and prior-period comparisons', 'Bank, expense, and cash-flow records'],
    process: ['Confirm period, currency, and basis', 'Tie revenue, cost, and expense totals', 'Calculate profit, cash, and variance', 'Identify anomalies and actions'],
    outputs: ['Management KPI and trend summary', 'Material variance and exception list', 'Action list with accountable owners'],
    checks: ['Every figure ties to a source', 'Profit and cash flow remain distinct', 'Thresholds and formulas are explicit'],
    taskPlaceholder: 'Example: review July operations with emphasis on revenue, margin, expenses, and cash changes…',
  },
  'invoice-tax': {
    id: 'invoice-tax', ...enCommon, eyebrow: 'Invoice and tax review', title: 'Invoice & tax management',
    description: 'Reconcile output/input invoices, revenue, and tax workpapers to find duplicates, credits, rate, and tax-position anomalies.',
    inputs: ['Sales and purchase invoice lists', 'Revenue, procurement, and contract detail', 'Tax workpapers and prior filings'],
    process: ['Detect duplicates, credits, and missing fields', 'Tie invoices to revenue by period', 'Review rate, gross/net basis, and deduction status', 'Summarize exceptions for human judgment'],
    outputs: ['Invoice exception workbook', 'Input/output tax summary', 'Missing-record and review list'],
    checks: ['Never assume tax rates', 'Keep evidence for every review item', 'Accountable approval before filing'],
    taskPlaceholder: 'Example: review this month’s invoices for duplicates, rate exceptions, and missing business evidence…',
  },
  accounting: {
    id: 'accounting', ...enCommon, eyebrow: 'Ledger reconciliation', title: 'Accounting',
    description: 'Reconcile ledgers, bank records, and counterparties without directly posting or changing books.',
    inputs: ['General ledger and account detail', 'Bank and receipt records', 'Contracts, invoices, and AR/AP detail'],
    process: ['Normalize period, currency, and signs', 'Match book and bank entries', 'Analyze AR/AP aging', 'Document differences and proposed adjustments'],
    outputs: ['Bank-to-book match result', 'Unmatched and ambiguous items', 'AR/AP aging and actions'],
    checks: ['Ledger and subledger tie-out', 'Differences are never silently removed', 'Adjustments require human review'],
    taskPlaceholder: 'Example: reconcile July bank and ledger records and produce unmatched items plus AR/AP aging…',
  },
  'tax-filing': {
    id: 'tax-filing', ...enCommon, eyebrow: 'Filing preparation calendar', title: 'Tax filing preparation',
    description: 'Prepare filings by jurisdiction, taxpayer, tax, and period without signing in or submitting.',
    inputs: ['Jurisdiction and taxpayer type', 'Tax, filing period, and deadline', 'Accounts, invoices, prior filings, and local rules'],
    process: ['Confirm filing entity and tax scope', 'Check period-record completeness', 'Prepare workpapers and differences', 'Assemble a review-ready filing packet'],
    outputs: ['Filing calendar and task list', 'Missing records and risk warnings', 'Review-ready filing packet'],
    checks: ['Deadline source is traceable', 'Local rules are reviewed', 'Submission requires final confirmation'],
    taskPlaceholder: 'Example: prepare the quarterly VAT packet, checking gaps and deadlines without submitting…',
  },
  'cash-risk': {
    id: 'cash-risk', ...enCommon, eyebrow: 'Cash forecast and risk alerts', title: 'Cash & risk',
    description: 'Build base, upside, and stress scenarios from opening cash, payment plans, aging, and operating assumptions.',
    inputs: ['Bank balances and available funds', 'AR/AP and payment schedules', 'Operating assumptions, facilities, and major contracts'],
    process: ['Confirm horizon and opening cash', 'Build receipt/payment timeline', 'Calculate scenario cash curves', 'Flag gaps, concentration, and maturities'],
    outputs: ['Multi-scenario cash forecast', 'Cash gaps and timing windows', 'Concentration and risk action list'],
    checks: ['Facts and assumptions stay separate', 'Stress parameters are explicit', 'No payment or cash action is automatic'],
    taskPlaceholder: 'Example: prepare a 13-week forecast with delayed receipts and higher-cost stress scenarios…',
  },
  'report-delivery': {
    id: 'report-delivery', ...enCommon, eyebrow: 'Finance delivery center', title: 'Report delivery',
    description: 'Review statement consistency and create a real, openable, traceable local XLSX review workbook.',
    inputs: ['Ledger, statements, and notes', 'Workpapers and difference explanations', 'Period, currency, business type, and source summary'],
    process: ['Check balance-sheet and cash-flow ties', 'Confirm period, currency, and sources', 'Generate the fixed-format XLSX review workbook', 'Reopen and verify sheets, request binding, and key content'],
    outputs: ['Verified XLSX review workbook', 'Source, basis, and difference notes', 'Review items and local file path'],
    checks: ['Files exist and reopen successfully', 'Key figures agree to workpapers', 'External sending requires final confirmation'],
    taskPlaceholder: 'Optional: add basis or review notes for this XLSX workbook. PDF/DOCX generation and external sending are not part of this flow.',
  },
};

export function financeModuleCopy(language: string, id: string): FinanceModuleCopy | null {
  const modules = language === 'zh' ? ZH : EN;
  return modules[id as FinanceModuleId] || null;
}
