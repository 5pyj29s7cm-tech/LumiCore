export type EcommerceOutcomeId =
  | 'today-operations'
  | 'trend-discovery'
  | 'store-data'
  | 'listing-automation'
  | 'ai-customer-service';

export interface EcommerceModuleCopy {
  id: EcommerceOutcomeId;
  eyebrow: string;
  title: string;
  subtitle: string;
  objective: string;
  inputLabel: string;
  inputPlaceholder: string;
  prompt: string;
  confirmation: string;
  inputs: string[];
  process: string[];
  outputs: string[];
  checks: string[];
}

export interface EcommerceModuleCommonCopy {
  semiAutomated: string;
  humanApproval: string;
  sourcePending: string;
  reviewPending: string;
  taskBrief: string;
  inputTitle: string;
  processTitle: string;
  outputTitle: string;
  start: string;
  starting: string;
  openConnections: string;
  openStoreData: string;
  taskCreated: string;
  actionQueue: string;
  signalBoard: string;
  skuQueue: string;
  contentPlan: string;
  serviceQueue: string;
  metricLabels: string[];
  trendChannels: string[];
  skuHeaders: string[];
  liveResult: string;
  stop: string;
  running: string;
  noResultYet: string;
  overviewTitle: string;
  overviewSubtitle: string;
  dataReady: string;
  sourceCoverage: string;
  riskItems: string;
  emptyTitle: string;
  emptyDescription: string;
  openWorkspace: string;
  ordersEntry: string;
  ordersEntryDescription: string;
  productsEntry: string;
  productsEntryDescription: string;
  inventoryEntry: string;
  inventoryEntryDescription: string;
  marketingEntry: string;
  marketingEntryDescription: string;
  serviceEntry: string;
  serviceEntryDescription: string;
}

const zhCommon: EcommerceModuleCommonCopy = {
  semiAutomated: '半自动工作流',
  humanApproval: '关键动作人工确认',
  sourcePending: '等待真实数据',
  reviewPending: '等待负责人复核',
  taskBrief: '本次工作说明',
  inputTitle: '需要的数据与约束',
  processTitle: '处理流程',
  outputTitle: '结果与证据',
  start: '交给 Lumi 开始处理',
  starting: '正在创建任务…',
  openConnections: '平台连接设置',
  openStoreData: '进入店铺数据台',
  taskCreated: '任务已进入账本',
  actionQueue: '今日行动队列',
  signalBoard: '机会信号板',
  skuQueue: 'SKU 审核队列',
  contentPlan: '内容排期',
  serviceQueue: '客服工单',
  metricLabels: ['销售额', '订单数', '贡献利润', '投放回报', '退款率', '断货风险'],
  trendChannels: ['需求增长', '竞争强度', '店铺适配'],
  skuHeaders: ['SKU / 商品', '库存与毛利', '风险', '建议动作', '状态'],
  liveResult: 'Lumi 执行结果',
  stop: '停止本次执行',
  running: 'Lumi 正在处理并核验结果…',
  noResultYet: '任务已创建，等待首条执行结果。',
  overviewTitle: '经营工作台',
  overviewSubtitle: '从真实报表到商品、库存、营销和客服的可追溯执行入口。',
  dataReady: '已读取真实数据',
  sourceCoverage: '数据源覆盖',
  riskItems: '待处理风险',
  emptyTitle: '尚未加载本轮经营数据',
  emptyDescription: '指标保持为空，不使用演示值或推测值。先进入店铺数据台，导入订单、投放、库存、售后或评价报表。',
  openWorkspace: '进入工作区',
  ordersEntry: '订单与利润',
  ordersEntryDescription: '导入订单和售后报表，核对销售额、利润、退款和数据缺口。',
  productsEntry: '商品管理',
  productsEntryDescription: '根据 SKU 事实、库存、毛利、退货和合规状态生成待审核动作。',
  inventoryEntry: '库存预警',
  inventoryEntryDescription: '导入库存数据，计算可售天数、补货点和建议数量。',
  marketingEntry: '营销与趋势',
  marketingEntryDescription: '将有日期的需求、竞争和店铺适配信号转成有预算上限的小规模验证方案。',
  serviceEntry: '内容与客服',
  serviceEntryDescription: '基于品牌、订单和店铺规则准备内容或回复草稿，发送前停下复核。',
};

const enCommon: EcommerceModuleCommonCopy = {
  semiAutomated: 'Semi-automated workflow',
  humanApproval: 'Human approval for critical actions',
  sourcePending: 'Waiting for real data',
  reviewPending: 'Waiting for accountable review',
  taskBrief: 'Work brief',
  inputTitle: 'Required data and constraints',
  processTitle: 'Workflow',
  outputTitle: 'Results and evidence',
  start: 'Start with Lumi',
  starting: 'Creating task…',
  openConnections: 'Platform connections',
  openStoreData: 'Open store data',
  taskCreated: 'Task recorded in ledger',
  actionQueue: 'Today action queue',
  signalBoard: 'Opportunity signals',
  skuQueue: 'SKU review queue',
  contentPlan: 'Content schedule',
  serviceQueue: 'Service tickets',
  metricLabels: ['Sales', 'Orders', 'Contribution', 'ROAS', 'Refund rate', 'Stockout risk'],
  trendChannels: ['Demand growth', 'Competition', 'Store fit'],
  skuHeaders: ['SKU / product', 'Inventory & margin', 'Risk', 'Proposed action', 'State'],
  liveResult: 'Lumi execution result',
  stop: 'Stop this run',
  running: 'Lumi is working and verifying the result…',
  noResultYet: 'Task created; waiting for the first execution result.',
  overviewTitle: 'Commerce operations workspace',
  overviewSubtitle: 'Traceable entry points from real reports to product, inventory, marketing, and service work.',
  dataReady: 'Real data loaded',
  sourceCoverage: 'Source coverage',
  riskItems: 'Risks to review',
  emptyTitle: 'No operating data loaded for this session',
  emptyDescription: 'Metrics stay empty instead of using demo or forecast values. Open Store data and import orders, campaigns, inventory, after-sales, or review reports first.',
  openWorkspace: 'Open workspace',
  ordersEntry: 'Orders & profit',
  ordersEntryDescription: 'Import order and after-sales reports to reconcile sales, contribution, refunds, and data gaps.',
  productsEntry: 'Product management',
  productsEntryDescription: 'Build review-ready SKU actions from facts, inventory, margin, returns, and compliance status.',
  inventoryEntry: 'Inventory alerts',
  inventoryEntryDescription: 'Import inventory data to calculate days of cover, reorder points, and suggested quantities.',
  marketingEntry: 'Marketing & trends',
  marketingEntryDescription: 'Turn dated demand, competition, and store-fit signals into bounded tests with explicit budget caps.',
  serviceEntry: 'Content & service',
  serviceEntryDescription: 'Prepare content or reply drafts from brand, order, and store rules, then stop for review before sending.',
};

const ZH: Record<EcommerceOutcomeId, EcommerceModuleCopy> = {
  'today-operations': {
    id: 'today-operations',
    eyebrow: '每日经营驾驶舱',
    title: '今日经营',
    subtitle: '把订单、投放、库存、售后和评价汇总成今天必须处理的经营动作。',
    objective: '先核对当天数据和异常，再生成带负责人、优先级和依据的行动清单；不会直接改店铺。',
    inputLabel: '日期、店铺、目标与重点问题',
    inputPlaceholder: '例如：分析今天抖店经营情况，重点看退款率、投放回报和断货风险，输出负责人行动清单…',
    prompt: '请执行今日经营分析。核对数据期间和来源，汇总经营指标，识别异常并生成带依据、优先级和负责人的行动清单。没有真实数据时先列出缺口，不要编造指标或执行店铺修改。',
    confirmation: '改价、上下架、广告预算、退款、客户发送等外部动作必须逐项确认并取得平台回执。',
    inputs: ['当天订单与销售', '投放消耗与转化', '库存、售后与评价'],
    process: ['核对期间与来源', '计算经营快照', '识别异常和影响', '生成负责人行动清单'],
    outputs: ['今日经营快照', '异常与风险清单', '分级行动队列'],
    checks: ['指标可追溯到来源', '异常阈值有明确口径', '外部动作未获确认不执行'],
  },
  'trend-discovery': {
    id: 'trend-discovery',
    eyebrow: '市场信号与小规模验证',
    title: '爆款雷达',
    subtitle: '把热点、需求、竞争和店铺适配度变成可解释的机会排名。',
    objective: '只输出候选机会和有预算上限的验证实验，不把热度预测包装成确定销量。',
    inputLabel: '类目、平台、人群和预算边界',
    inputPlaceholder: '例如：小红书家居收纳，客单价 80–200 元，关注近 7 天增长和低竞争长尾词…',
    prompt: '请研究以下类目的当前趋势和爆款机会。标注来源日期，区分事实与推断，并按需求增长、竞争度、店铺适配和可验证性排序，只输出候选与小规模验证方案。',
    confirmation: '选品采购、投放和内容发布前必须人工复核来源、知识产权、平台规则和预算。',
    inputs: ['有日期的搜索与内容信号', '竞品、价格和竞争强度', '店铺人群、毛利与供应能力'],
    process: ['收集并去重信号', '区分事实与推断', '计算机会与置信度', '设计小规模验证'],
    outputs: ['机会排名与来源', '反证和风险说明', '验证实验及预算上限'],
    checks: ['来源和时间可追溯', '预测不写成确定销量', '先验证再扩大投入'],
  },
  'store-data': {
    id: 'store-data',
    eyebrow: '真实报表与计算口径',
    title: '店铺数据',
    subtitle: '导入订单、投放、库存、售后和评价报表，完成字段映射、计算与归档。',
    objective: '保留来源、期间、币种、字段映射和计算口径，形成可复核的店铺数据诊断。',
    inputLabel: '数据范围与分析要求',
    inputPlaceholder: '导入真实报表后补充平台、期间、币种和需要重点核对的问题…',
    prompt: '请基于已导入的店铺报表进行标准化、核对和诊断，保留来源、期间、字段映射和计算口径，明确数据缺口与风险。',
    confirmation: '只读分析可自动执行；任何店铺修改、发送或提交仍需确认和平台回执。',
    inputs: ['订单与销售报表', '投放与库存报表', '售后与评价数据'],
    process: ['导入和字段映射', '核对期间与口径', '计算指标与差异', '核验并归档诊断'],
    outputs: ['标准化数据快照', '字段映射和缺口', '可追溯经营诊断'],
    checks: ['原始文件不被覆盖', '计算口径明确', '归档内容可回到来源'],
  },
  'listing-automation': {
    id: 'listing-automation',
    eyebrow: '商品事实核验与动作审批',
    title: '商品管理',
    subtitle: '按库存、毛利、退款、合规和素材完整度生成 SKU 待办队列。',
    objective: '形成发布、保留、优化或暂停候选，所有店铺变更停在逐项审核之前。',
    inputLabel: '商品范围与业务规则',
    inputPlaceholder: '例如：抖店夏季女装；库存少于 20 不上架；毛利低于 15% 暂停；先生成审核清单…',
    prompt: '请核对商品事实、库存、毛利、退款和平台规则，生成逐 SKU 的待审核动作队列、文案草稿与风险说明。不要执行发布、改价、上架或下架。',
    confirmation: '上架、下架、改价和发布必须由负责人逐项确认，并以平台回执作为完成证据。',
    inputs: ['SKU 主数据和素材', '库存、毛利与退款', '类目资质和平台规则'],
    process: ['核对商品事实', '计算经营与合规风险', '生成动作和文案草稿', '进入逐项审批队列'],
    outputs: ['SKU 动作队列', '标题与卖点草稿', '缺失字段和风险说明'],
    checks: ['商品事实来源明确', '动作理由可复核', '未批准项目不进入平台'],
  },
  'ai-customer-service': {
    id: 'ai-customer-service',
    eyebrow: '内容运营与客户沟通',
    title: '内容与客服',
    subtitle: '内容排期、发布草稿、工单分流和客服回复在同一审核边界内协作。',
    objective: '基于品牌和店铺规则生成可审核草稿，拦截侵权、错误承诺和敏感信息泄露。',
    inputLabel: '内容任务、工单、脱敏聊天或店铺规则',
    inputPlaceholder: '输入选题和素材，或粘贴脱敏后的客户问题，并补充品牌、平台、退换货和禁用承诺…',
    prompt: '请识别内容或客服任务类型并先脱敏。内容必须基于已提供素材和品牌规则，客服回复必须依据店铺政策。只生成草稿和升级建议，不要发布或发送。',
    confirmation: '客户发送、退款、赔付、改址、订单修改和内容发布必须人工确认并核对目标会话。',
    inputs: ['品牌素材与内容计划', '脱敏工单与订单事实', '售后政策和禁用承诺'],
    process: ['识别内容或服务场景', '核对素材、订单与规则', '生成草稿和风险标记', '分流人工审核或升级'],
    outputs: ['内容排期与发布草稿', '客服回复草稿', '风险与升级队列'],
    checks: ['隐私信息已脱敏', '承诺均有规则依据', '发送和发布前核对目标'],
  },
};

const EN: Record<EcommerceOutcomeId, EcommerceModuleCopy> = {
  'today-operations': { id: 'today-operations', eyebrow: 'Daily operations cockpit', title: "Today's operations", subtitle: 'Turn orders, ads, inventory, after-sales, and reviews into accountable actions for today.', objective: 'Verify current-period data before producing a prioritized, evidence-backed owner action list.', inputLabel: 'Date, store, goals, and focus', inputPlaceholder: 'Example: review today’s TikTok Shop operations, focusing on refund rate, ROAS, and stockout risk…', prompt: 'Run today operations analysis. Verify period and sources, calculate the snapshot, identify exceptions, and prepare an evidence-backed action list. Do not invent metrics or mutate the store.', confirmation: 'Pricing, listing, ad spend, refunds, and customer sends require item-level approval and provider receipts.', inputs: ['Orders and sales', 'Advertising and conversion', 'Inventory, after-sales, and reviews'], process: ['Verify period and sources', 'Calculate operating snapshot', 'Identify exceptions', 'Create owner action list'], outputs: ['Daily operating snapshot', 'Exception and risk list', 'Prioritized action queue'], checks: ['Metrics tie to sources', 'Thresholds are explicit', 'No external action without approval'] },
  'trend-discovery': { id: 'trend-discovery', eyebrow: 'Market signals and bounded tests', title: 'Trend radar', subtitle: 'Rank demand, competition, and store-fit signals with explainable confidence.', objective: 'Produce candidates and budget-capped tests without presenting forecasts as guaranteed sales.', inputLabel: 'Category, platform, audience, and budget', inputPlaceholder: 'Example: home organization on Instagram; $15–30 AOV; prioritize 7-day growth and low-competition terms…', prompt: 'Research current trend opportunities. Cite dated sources, separate facts from inference, rank by growth, competition, store fit, and testability, and propose bounded tests only.', confirmation: 'Sourcing, advertising, and publishing require review of sources, IP, platform policy, and budget.', inputs: ['Dated search and content signals', 'Competitors, price, and saturation', 'Audience, margin, and supply fit'], process: ['Collect and deduplicate signals', 'Separate facts and inference', 'Score opportunity and confidence', 'Design bounded validation'], outputs: ['Ranked opportunities and sources', 'Counter-evidence and risks', 'Tests with budget caps'], checks: ['Sources and dates are traceable', 'Forecasts stay uncertain', 'Validate before scaling'] },
  'store-data': { id: 'store-data', eyebrow: 'Real reports and calculation basis', title: 'Store data', subtitle: 'Import, map, calculate, and archive orders, campaigns, inventory, after-sales, and reviews.', objective: 'Preserve source, period, currency, field mapping, and formulas for an auditable diagnosis.', inputLabel: 'Data scope and analysis request', inputPlaceholder: 'Import real reports, then add platform, period, currency, and the questions to investigate…', prompt: 'Normalize and diagnose the imported store reports while preserving sources, periods, mappings, formulas, data gaps, and risks.', confirmation: 'Read-only analysis may run automatically; store mutations, sends, and submissions require approval and receipts.', inputs: ['Orders and sales reports', 'Campaign and inventory reports', 'After-sales and reviews'], process: ['Import and map fields', 'Reconcile periods and basis', 'Calculate metrics and gaps', 'Verify and archive diagnosis'], outputs: ['Normalized data snapshot', 'Mappings and gaps', 'Traceable diagnosis'], checks: ['Source files stay unchanged', 'Formulas are explicit', 'Archive ties back to sources'] },
  'listing-automation': { id: 'listing-automation', eyebrow: 'Product facts and action approval', title: 'Product management', subtitle: 'Build an SKU action queue from inventory, margin, returns, compliance, and asset readiness.', objective: 'Prepare publish, keep, optimize, or pause candidates while stopping before every store mutation.', inputLabel: 'Product scope and business rules', inputPlaceholder: 'Example: summer apparel; do not list under 20 units; pause below 15% margin; prepare review queue first…', prompt: 'Verify product facts, stock, margin, returns, and platform rules. Prepare item-level actions, copy drafts, and risks. Do not publish, reprice, list, or delist.', confirmation: 'Listing, delisting, repricing, and publishing require item-level approval and provider receipts.', inputs: ['SKU master data and assets', 'Inventory, margin, and returns', 'Category credentials and platform rules'], process: ['Verify product facts', 'Calculate commercial and policy risks', 'Draft actions and copy', 'Enter item-level approval queue'], outputs: ['SKU action queue', 'Title and selling-point drafts', 'Missing fields and risks'], checks: ['Facts have sources', 'Actions have reviewable reasons', 'Unapproved items never reach platform'] },
  'ai-customer-service': { id: 'ai-customer-service', eyebrow: 'Content operations and customer communication', title: 'Content & service', subtitle: 'Coordinate schedules, publishing drafts, ticket routing, and reply review within one safety boundary.', objective: 'Ground drafts in brand and store rules while blocking IP, unsupported promises, and privacy leaks.', inputLabel: 'Content task, tickets, masked chat, or store rules', inputPlaceholder: 'Provide topics and sources, or privacy-safe customer questions plus brand, platform, and service rules…', prompt: 'Classify the content or service task and mask personal data. Ground drafts in supplied sources, brand rules, order facts, and store policy. Do not publish or send.', confirmation: 'Customer sends, refunds, compensation, address or order changes, and publishing require approval and target verification.', inputs: ['Brand assets and content plan', 'Masked tickets and order facts', 'Service policy and prohibited promises'], process: ['Classify content or service work', 'Verify assets, order, and policy', 'Draft and flag risks', 'Route to review or escalation'], outputs: ['Content schedule and drafts', 'Customer reply drafts', 'Risk and escalation queue'], checks: ['Personal data is masked', 'Promises have policy support', 'Target is checked before send'] },
};

export function ecommerceModuleCopy(language: string, id: EcommerceOutcomeId): EcommerceModuleCopy {
  return (language === 'en' ? EN : ZH)[id];
}

export function ecommerceModuleCommonCopy(language: string): EcommerceModuleCommonCopy {
  return language === 'en' ? enCommon : zhCommon;
}
