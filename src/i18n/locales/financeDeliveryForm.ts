export type FinanceDeliveryField = {
  name: string;
  label: string;
  placeholder: string;
  required: boolean;
  multiline?: boolean;
};

export type FinanceDeliveryFormCopy = {
  title: string;
  hint: string;
  requiredHint: string;
  fields: FinanceDeliveryField[];
};

const TAX_FIELDS = {
  zh: [
    ['period', '申报期间', '例如：2026-Q2', true],
    ['jurisdiction', '司法辖区', '例如：CN', true],
    ['taxpayerType', '纳税人类型', '例如：增值税一般纳税人', true],
    ['dueDate', '申报截止日', '例如：2026-07-15', true],
    ['taxes', '税种（逗号分隔）', '例如：增值税，企业所得税预缴', true],
    ['businessType', '业务类型', '例如：软件服务', false],
    ['currency', '币种', '例如：CNY', true],
    ['revenue', '本期收入', '仅输入真实账面金额', true],
    ['deductibleCost', '可扣除成本', '仅输入真实账面金额', true],
    ['deductibleExpense', '可扣除费用', '仅输入真实账面金额', true],
    ['incomeTaxRate', '所得税率', '例如：0.25；必须由你提供', true],
    ['vatOutputTax', '销项税额', '可选；没有请留空', false],
    ['vatInputTax', '进项税额', '可选；没有请留空', false],
    ['surchargeRate', '附加税率', '可选；必须由你提供', false],
  ],
  en: [
    ['period', 'Filing period', 'Example: 2026-Q2', true],
    ['jurisdiction', 'Jurisdiction', 'Example: CN', true],
    ['taxpayerType', 'Taxpayer type', 'Example: general VAT taxpayer', true],
    ['dueDate', 'Filing deadline', 'Example: 2026-07-15', true],
    ['taxes', 'Taxes (comma-separated)', 'Example: VAT, corporate income tax prepayment', true],
    ['businessType', 'Business type', 'Example: software services', false],
    ['currency', 'Currency', 'Example: CNY', true],
    ['revenue', 'Period revenue', 'Enter the actual ledger amount only', true],
    ['deductibleCost', 'Deductible cost', 'Enter the actual ledger amount only', true],
    ['deductibleExpense', 'Deductible expense', 'Enter the actual ledger amount only', true],
    ['incomeTaxRate', 'Income-tax rate', 'Example: 0.25; must be supplied by you', true],
    ['vatOutputTax', 'Output VAT', 'Optional; leave empty when not applicable', false],
    ['vatInputTax', 'Input VAT', 'Optional; leave empty when not applicable', false],
    ['surchargeRate', 'Surcharge rate', 'Optional; must be supplied by you', false],
  ],
} satisfies Record<'zh' | 'en', Array<[string, string, string, boolean]>>;

const REPORT_FIELDS = {
  zh: [
    ['period', '报告期间', '例如：2026-07', true],
    ['currency', '币种', '例如：CNY', true],
    ['businessType', '业务类型', '例如：软件服务', true],
    ['dataSummary', '来源与数据摘要', '写明总账/报表来源、版本和本期口径；不要粘贴密钥', true, true],
    ['totalAssets', '资产总额', '仅输入真实报表金额', true],
    ['totalLiabilities', '负债总额', '仅输入真实报表金额', true],
    ['totalEquity', '所有者权益总额', '仅输入真实报表金额', true],
    ['tolerance', '勾稽容差', '可选，例如：0.01', false],
  ],
  en: [
    ['period', 'Reporting period', 'Example: 2026-07', true],
    ['currency', 'Currency', 'Example: CNY', true],
    ['businessType', 'Business type', 'Example: software services', true],
    ['dataSummary', 'Source and data summary', 'Identify the ledger/statement source, version, and period basis; do not paste secrets', true, true],
    ['totalAssets', 'Total assets', 'Enter the actual statement amount only', true],
    ['totalLiabilities', 'Total liabilities', 'Enter the actual statement amount only', true],
    ['totalEquity', 'Total equity', 'Enter the actual statement amount only', true],
    ['tolerance', 'Tie-out tolerance', 'Optional, for example: 0.01', false],
  ],
} satisfies Record<'zh' | 'en', Array<[string, string, string, boolean, boolean?]>>;

function fields(rows: Array<[string, string, string, boolean, boolean?]>): FinanceDeliveryField[] {
  return rows.map(([name, label, placeholder, required, multiline]) => ({
    name,
    label,
    placeholder,
    required,
    multiline,
  }));
}

export function financeDeliveryFormCopy(language: string, entryId: string): FinanceDeliveryFormCopy | null {
  const locale = language === 'zh' ? 'zh' : 'en';
  if (entryId === 'tax-filing') {
    return {
      title: locale === 'zh' ? '申报包结构化数据' : 'Structured filing data',
      hint: locale === 'zh'
        ? '以下数据会直接绑定本次任务与回执。Lumi 不会补写缺失金额，也不会登录税局或提交申报。'
        : 'These values bind directly to this task and its receipts. Lumi will not invent missing figures, sign in, or submit a filing.',
      requiredHint: locale === 'zh' ? '请先填写所有必填财税字段。' : 'Complete every required finance field before delivery.',
      fields: fields(TAX_FIELDS[locale]),
    };
  }
  if (entryId === 'report-delivery') {
    return {
      title: locale === 'zh' ? '报表交付结构化数据' : 'Structured report data',
      hint: locale === 'zh'
        ? '当前最小闭环核验资产负债表勾稽关系，并生成本机 XLSX。外部报送、签字和发送保持禁用。'
        : 'The minimum verified flow checks the balance-sheet equation and creates a local XLSX. External reporting, signing, and sending stay disabled.',
      requiredHint: locale === 'zh' ? '请先填写所有必填报表字段。' : 'Complete every required statement field before delivery.',
      fields: fields(REPORT_FIELDS[locale]),
    };
  }
  return null;
}
