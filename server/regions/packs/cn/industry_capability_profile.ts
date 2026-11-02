// Shared backend design capability identity, not the installed application's brand.
// Retain the Designer preference namespace for imported existing guidance settings.
export const DESIGN_CAPABILITY_IDENTITY = { variantId: 'designer-client', displayName: 'Lumi Design workspaces', productLine: 'design' } as const;
import {
  getIndustryWorkflowContracts,
  normalizeIndustryProductLine,
  type IndustryProductLine,
  type IndustryWorkflowContract,
} from '../../../industry/workflow_contracts';

export type IndustryAutomationLevel = 'automatic' | 'review_required' | 'confirmation_required';

export interface IndustryCapabilityEntry {
  entryId: string;
  displayName: string;
  summary: string;
  routingTerms: string[];
  automationLevel: IndustryAutomationLevel;
  contract: IndustryWorkflowContract;
}

export interface IndustryCapabilityProfile {
  schemaVersion: 1;
  variantId: string;
  displayName: string;
  productLine: IndustryProductLine;
  positioning: string;
  automaticActions: string[];
  reviewRequiredActions: string[];
  optionalExtensions: Array<{ id: string; label: string; defaultEnabled: false }>;
  entries: IndustryCapabilityEntry[];
}

export interface IndustryWorkflowMatch {
  profile: IndustryCapabilityProfile;
  entry: IndustryCapabilityEntry;
  score: number;
  matchedTerms: string[];
}

interface EntryCopy {
  displayName: string;
  summary: string;
  routingTerms: string[];
  routingPatterns?: RegExp[];
  automationLevel?: IndustryAutomationLevel;
}

interface ProfileCopy {
  positioning: string;
  automaticActions: string[];
  reviewRequiredActions: string[];
  optionalExtensions?: Array<{ id: string; label: string; defaultEnabled: false }>;
  entries: Record<string, EntryCopy>;
}

const PROFILE_COPY: Record<IndustryProductLine, ProfileCopy> = {
  ecommerce: {
    positioning: '面向电商经营者的轻量经营与交付智能体，优先把店铺资料转化为可复核的经营结果。',
    automaticActions: ['读取已授权的店铺资料', '指标计算与异常分析', '生成经营、商品、内容与客服草稿', '归档来源、口径和本地结果'],
    reviewRequiredActions: ['选品决策', '商品动作队列', '客户回复与内容定稿', '任何发布、改价、上下架、退款、广告花费或外发动作'],
    entries: {
      'today-operations': { displayName: '今日经营', summary: '汇总本期订单、销售、投放、库存和售后，输出异常与行动清单。', routingTerms: ['今日经营', '今日经营台', '经营日报', '今日数据', '今天店铺', '销售日报', '订单异常', 'daily operations', 'daily business'] },
      'trend-discovery': { displayName: '爆款雷达', summary: '收集有日期和来源的趋势信号，形成候选机会与小规模验证方案。', routingTerms: ['爆款雷达', '爆品', '选品', '趋势机会', '热点商品', '市场趋势', 'trend discovery', 'product opportunity'] },
      'store-data': { displayName: '店铺数据', summary: '标准化经营报表并保留来源、期间、币种、字段映射和计算口径。', routingTerms: ['店铺数据', '店铺报表', '经营数据', '订单报表', '投放报表', '库存分析', 'store data', 'store report'] },
      'listing-automation': { displayName: '商品管理', summary: '核验 SKU、库存、毛利、退货和合规资料，准备待审批商品动作。', routingTerms: ['商品管理', '商品上架', '商品下架', '商品优化', 'sku 管理', '库存商品', 'listing management', 'product management'] },
      'ai-customer-service': { displayName: '内容与客服', summary: '处理内容、售前、售后和升级事项，生成待审核草稿。', routingTerms: ['内容与客服', '客服回复', '售前回复', '售后回复', '内容运营', '商品文案', '客户工单', 'customer service', 'content operations'] },
    },
  },
  design: {
    positioning: '面向设计项目交付的轻量智能体，围绕同一项目、真实文件和专业复核组织工作。',
    automaticActions: ['读取项目 Brief 和已归档资料', '整理范围、约束、风险与缺失信息', '生成本地方案草稿和可复核文件', '核验文件路径、大小、版本和项目归属'],
    reviewRequiredActions: ['未核验尺寸和结构机电条件', '最终方案和报价', '覆盖源图', '版权素材使用', '客户交付与专业签认'],
    entries: {
      project: { displayName: '设计项目', summary: '绑定项目 Brief 与资料，形成范围、方向、风险和下一步。', routingTerms: ['设计项目', '项目 brief', '设计需求', '空间方案', '项目方案', 'design project', 'project brief'] },
      cad: { displayName: 'CAD 方案', summary: '基于已核验源图和几何生成 CAD 成果，并验证几何与文件。', routingTerms: ['cad 方案', 'cad图', 'cad 图', 'dwg', 'dxf', '施工图', '平面图', 'cad scheme', 'cad drawing'] },
      visualization: { displayName: '效果图', summary: '基于确认的布局、相机、材质和灯光生成并归档真实图像。', routingTerms: ['效果图', '室内渲染', '空间渲染', '设计效果', 'rendering', 'visualization', 'render image'] },
      presentation: { displayName: '提案 PPT', summary: '从已核验项目事实生成、渲染检查并归档提案文件。', routingTerms: ['提案 ppt', '方案 ppt', '设计汇报', '汇报 ppt', 'proposal ppt', 'proposal presentation'] },
      handoff: { displayName: '交付中心', summary: '汇集图纸、清单、视觉成果与说明，检查完整性和版本。', routingTerms: ['交付中心', '设计交付', '交付包', '图纸交付', '项目交付', 'handoff', 'delivery package'] },
    },
  },
  legal: {
    positioning: '面向律师和法律团队的案件交付智能体，所有结论保留事实、证据、法源、时效与律师复核边界。',
    automaticActions: ['整理案件与材料', '生成内部文书和研究草稿', '检索已授权法源与类案', '归档证据、引用、版本和核验记录'],
    reviewRequiredActions: ['法律结论和正式法律意见', '签署、立案、付款和报送', '客户外发与正式交付', '任何需要执业律师承担责任的决定'],
    entries: {
      workspace: { displayName: '案件工作台', summary: '统一案件事实、证据、争点、材料、状态和下一步。', routingTerms: ['案件工作台', '新建案件', '案件整理', '案件状态', '案件材料', 'case workspace', 'case intake'] },
      packet: { displayName: '文书生成', summary: '基于当前案件生成可复核文书并保留版本和引用。', routingTerms: ['文书生成', '起诉状', '答辩状', '代理词', '法律意见书', '法律文书', 'legal document', 'litigation packet'] },
      'contract-review': {
        displayName: '合同审查',
        summary: '识别条款风险、法律依据和修改建议，保留复核记录。',
        routingTerms: ['合同审查', '审合同', '审核合同', '协议审查', '合同风险', '条款审查', '合同修改', 'contract review'],
        routingPatterns: [
          /(?:审查|审核|检查|复核|修改|看(?:一下|一看)?).{0,10}(?:合同|协议)|(?:合同|协议).{0,10}(?:审查|审核|检查|复核|风险|条款|修改)/u,
        ],
      },
      research: { displayName: '法条与类案', summary: '检索现行法源和相似案例，记录来源、日期、适用范围与不确定性。', routingTerms: ['法条与类案', '类案检索', '法条检索', '法律研究', '司法案例', 'law and cases', 'legal research'] },
      'asset-trace': { displayName: '财产线索', summary: '整理公开财产与主体线索，标记证据等级和人工核验项。', routingTerms: ['财产线索', '被执行人财产', '股权穿透', '执行线索', '查财产', 'asset trace', 'asset clues'] },
      verify: { displayName: '交付核验', summary: '核验事实、引用、时效、管辖、文件和律师复核状态。', routingTerms: ['交付核验', '引用核验', '法条核验', '文书核验', '交付检查', 'delivery verification', 'citation verification'] },
      bid: { displayName: '标书制作', summary: '形成响应矩阵、缺口清单和可复核标书文件。', routingTerms: ['标书制作', '投标书', '法律服务标书', '投标文件', 'bid production', 'tender document'] },
    },
  },
  finance: {
    positioning: '面向企业财务与税务工作的轻量智能体，优先处理票税、账务、申报准备、资金风险和报表交付，不默认承担证券行情或交易任务。',
    automaticActions: ['读取已授权账簿、票据、银行和业务资料', '执行可审计计算、核对和异常识别', '生成本地财税底稿、清单和报表草稿', '归档来源、期间、币种、口径和复核状态'],
    reviewRequiredActions: ['税率、会计政策和申报口径判断', '记账过账和账套变更', '申报、报送、付款、签署和资金移动', '对外报告与专业结论'],
    optionalExtensions: [
      { id: 'market-research', label: '证券行情研究', defaultEnabled: false },
      { id: 'paper-trading', label: '模拟交易', defaultEnabled: false },
    ],
    entries: {
      'business-dashboard': { displayName: '经营看板', summary: '汇总收入、利润、费用、现金和预算差异，输出经营异常与行动清单。', routingTerms: ['经营看板', '财务经营分析', '管理报表', '利润分析', '预算差异', 'business dashboard', 'management report'] },
      'invoice-tax': { displayName: '票税管理', summary: '核验发票、税负和异常，形成带依据的复核底稿。', routingTerms: ['票税管理', '发票管理', '发票核验', '税负测算', '进销项', 'invoice tax', 'invoice review'] },
      accounting: {
        displayName: '账务处理',
        summary: '核对总账、明细账、银行和往来，输出差异与处理建议，不自动过账。',
        routingTerms: ['账务处理', '账务资料', '财务核账', '账簿核对', '总账核对', '银行对账', '应收应付', '会计处理', '对账', 'accounting', 'ledger reconciliation'],
        routingPatterns: [
          /(?:处理|整理|核对|复核|检查|分析).{0,10}(?:账务|账簿|总账|明细账|流水|往来|对账)|(?:账务|账簿|总账|明细账|流水|往来).{0,10}(?:处理|整理|核对|复核|检查|分析|差异)/u,
        ],
      },
      'tax-filing': { displayName: '税务申报', summary: '按辖区、纳税人、税种和期间准备待复核申报清单与文件包。', routingTerms: ['税务申报', '纳税申报', '报税', '申报资料', '税务申报表', 'tax filing', 'tax return'] },
      'cash-risk': { displayName: '资金与风险', summary: '预测现金流、往来集中度和缺口，输出多情景风险预警。', routingTerms: ['资金与风险', '现金流预测', '资金风险', '现金缺口', '应收风险', 'cash risk', 'cash forecast'] },
      'report-delivery': { displayName: '报表交付', summary: '核验报表勾稽关系并生成可打开、可追溯的财税交付文件。', routingTerms: ['报表交付', '财务报表', '报表核验', '财税报告', '交付报表', 'report delivery', 'financial statement'] },
    },
  },
};

function currentProductLine(): IndustryProductLine | null {
  return normalizeIndustryProductLine(DESIGN_CAPABILITY_IDENTITY.productLine);
}

function normalizeText(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[\s\-_—–/\\]+/g, ' ').trim();
}

function normalizeCompactMatchText(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function stripNegatedRoutingClauses(value: unknown): string {
  return String(value || '')
    .replace(/(?:\u4e0d\u8981|\u4e0d\u7528|\u65e0\u9700|\u4e0d\u5fc5|\u7981\u6b62|\u4e0d\u5f97|\u5207\u52ff|\u8bf7\u52ff)[^\uff0c\u3002\uff1b!?\uff01\uff1f]{0,120}/gu, ' ')
    .replace(/\b(?:do\s+not|don't|dont|must\s+not|never)\b[^.!?;]{0,160}/gi, ' ');
}

function isExplicitWorkflowTarget(normalizedText: string, normalizedTerm: string): boolean {
  if (!normalizedText || !normalizedTerm) return false;
  let offset = 0;
  while (offset < normalizedText.length) {
    const index = normalizedText.indexOf(normalizedTerm, offset);
    if (index < 0) return false;
    const prefix = normalizedText.slice(Math.max(0, index - 56), index);
    if (/(?:\u5f00\u59cb|\u542f\u52a8|\u7ee7\u7eed|\u6267\u884c|\u8fdb\u5165|\u63a8\u8fdb|\u5904\u7406|\u5236\u4f5c|\u751f\u6210|start|enter|continue|advance|execute|run|build|create)[^\uff0c\u3002\uff1b!?\uff01\uff1f]{0,36}$/iu.test(prefix)) {
      return true;
    }
    offset = index + Math.max(1, normalizedTerm.length);
  }
  return false;
}

export function getCurrentIndustryCapabilityProfile(): IndustryCapabilityProfile | null {
  const productLine = currentProductLine();
  if (!productLine) return null;
  const copy = PROFILE_COPY[productLine];
  const contracts = getIndustryWorkflowContracts(productLine);
  return {
    schemaVersion: 1,
    variantId: DESIGN_CAPABILITY_IDENTITY.variantId,
    displayName: DESIGN_CAPABILITY_IDENTITY.displayName,
    productLine,
    positioning: copy.positioning,
    automaticActions: [...copy.automaticActions],
    reviewRequiredActions: [...copy.reviewRequiredActions],
    optionalExtensions: [...(copy.optionalExtensions || [])],
    entries: contracts.map(contract => {
      const entryCopy = copy.entries[contract.entryId];
      if (!entryCopy) throw new Error(`Missing industry capability copy: ${productLine}/${contract.entryId}`);
      return {
        entryId: contract.entryId,
        displayName: entryCopy.displayName,
        summary: entryCopy.summary,
        routingTerms: Array.from(new Set([entryCopy.displayName, contract.title, ...entryCopy.routingTerms])),
        automationLevel: entryCopy.automationLevel || (contract.requiresFileArtifact ? 'review_required' : 'automatic'),
        contract,
      };
    }),
  };
}

export function matchCurrentIndustryWorkflow(text: unknown): IndustryWorkflowMatch | null {
  const profile = getCurrentIndustryCapabilityProfile();
  const affirmativeText = stripNegatedRoutingClauses(text);
  const normalized = normalizeText(affirmativeText);
  const compactNormalized = normalizeCompactMatchText(affirmativeText);
  if (!profile || !normalized) return null;

  const candidates = profile.entries.map(entry => {
    const matchedTerms: string[] = [];
    let score = 0;
    const displayTerm = normalizeText(entry.displayName);
    for (const rawTerm of entry.routingTerms) {
      const term = normalizeText(rawTerm);
      const compactTerm = normalizeCompactMatchText(rawTerm);
      if (!term || (!normalized.includes(term) && !compactNormalized.includes(compactTerm))) continue;
      matchedTerms.push(rawTerm);
      score += normalized === term ? 100 : 18 + Math.min(term.length, 16);
      // A visible workspace label such as “效果图” or “合同审查” is a
      // stronger routing signal than generic context such as “项目 Brief”.
      // Negated clauses were removed above, so a guard like “不要生成效果图”
      // cannot steal the route from the explicitly requested stage.
      if (term === displayTerm) score += 40;
      if (isExplicitWorkflowTarget(normalized, term)) score += 160;
    }
    const semanticPatterns = PROFILE_COPY[profile.productLine].entries[entry.entryId]?.routingPatterns || [];
    if (semanticPatterns.some(pattern => pattern.test(normalized))) {
      matchedTerms.push(`semantic:${entry.entryId}`);
      score += 42;
    }
    return { profile, entry, score, matchedTerms };
  }).filter(candidate => candidate.score >= 20)
    .sort((left, right) => right.score - left.score || right.matchedTerms.length - left.matchedTerms.length);

  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0];
}

export function isCurrentIndustryMultiWorkspaceLedgerStatusRequest(text: unknown): boolean {
  const normalized = String(text || '').trim();
  const profile = getCurrentIndustryCapabilityProfile();
  if (!normalized || !profile) return false;
  const requestedWorkspaceCount = profile.entries
    .filter(entry => normalized.includes(entry.displayName)).length;
  return requestedWorkspaceCount >= 2
    && /(?:分别|逐项|各自|行业任务账本|最终回执|最近任务)/u.test(normalized)
    && /(?:状态|进度|结果|关键结果|交付物|确认边界|回执)/u.test(normalized);
}

export function isCurrentIndustryWorkflowExecutionRequest(text: unknown): boolean {
  const normalized = String(text || '').trim();
  const workflowMatch = matchCurrentIndustryWorkflow(normalized);
  if (!workflowMatch) return false;
  if (isCurrentIndustryMultiWorkspaceLedgerStatusRequest(normalized)) return false;

  // A local source folder followed by visible AutoCAD work is a reusable CAD
  // operation, not the Designer delivery workflow. Keep the industry overlay
  // only when the user binds the request to a durable project or stage.
  if (workflowMatch.profile.productLine === 'design' && workflowMatch.entry.entryId === 'cad') {
    const hasLocalSource = /(?:\u684c\u9762|\u672c\u5730).{0,40}(?:\u6587\u4ef6\u5939|\u76ee\u5f55|\u56fe\u7247|\u56fe\u7eb8|\u8349\u56fe|\u6587\u4ef6)|(?:\u6587\u4ef6\u5939|\u76ee\u5f55).{0,40}(?:\u8bfb\u53d6|\u6574\u7406|\u91cc\u9762)/u.test(normalized);
    const requestsVisibleAutoCad = /(?:auto\s*cad|\bcad\b).{0,40}(?:\u5b9e\u9645|\u53ef\u89c1|\u91cc\u9762).{0,16}(?:\u753b|\u7ed8\u5236)|(?:\u5b9e\u9645|\u53ef\u89c1).{0,24}(?:auto\s*cad|\bcad\b)/iu.test(normalized);
    const hasDurableProjectContext = /(?:\u5f53\u524d|\u5df2\u6fc0\u6d3b|\u5df2\u6709|\u8fd9\u4e2a|\u8be5).{0,16}(?:\u8bbe\u8ba1)?\u9879\u76ee|\u9879\u76ee(?:\u7f16\u53f7|\u540d\u79f0|\u5f52\u5c5e|\u9636\u6bb5|\s*brief)|\u65b9\u6848\u9636\u6bb5|\u5f52\u6863|\u884c\u4e1a\u4efb\u52a1|\u5de5\u4f5c\u6d41/iu.test(normalized);
    if (hasLocalSource && requestsVisibleAutoCad && !hasDurableProjectContext) return false;
  }
  if (/(?:做完|完成|进度|状态|结果).{0,10}(?:吗|呢|如何|怎样|怎么|没有)|(?:是否|是不是).{0,20}(?:完成|做完)/u.test(normalized)) return false;

  // Negative constraints belong to their own clause. A request such as
  // “执行方案阶段；不要新建第二个项目；不要生成 CAD” is still an execution
  // request for the scheme stage, with two explicit forbidden side effects.
  const affirmativeText = normalized
    .replace(/(?:不要|不用|无需|不需要|不必|禁止|不得|切勿|请勿)[^，。；!?！？]{0,80}/gu, ' ')
    .replace(/\b(?:do\s+not|don't|dont|must\s+not|never)\b[^.!?;]{0,120}/gi, ' ')
    .trim();
  if (!affirmativeText) return false;

  if (/(?:是什么|有哪些|能做什么|会做什么|怎么用|如何使用|介绍一下|支持吗|能不能|可不可以|可以吗|会不会|为什么|怎么回事|what\s+(?:is|are|can)|how\s+(?:to|do|does)|can\s+(?:you|it)|status|progress)[？?。.!！]*$/iu.test(affirmativeText)) return false;
  return /(?:开始|启动|继续|执行|处理|整理|生成|制作|创建|输出|分析|汇总|核对|检查|审查|审核|检索|查找|预测|准备|导入|归档|做一|做个|做份|看一|算一|review|analy[sz]e|generate|create|prepare|start|run|check|audit|draft|build|produce|reconcile|forecast|file)/iu.test(affirmativeText);
}

export function isDesignProjectCreationRequest(text: unknown): boolean {
  if (currentProductLine() !== 'design') return false;
  const normalized = String(text || '').trim();
  // A stage request commonly contains a negative guard such as
  // “不要新建第二个项目”. Remove only those negated creation mentions so a
  // real positive creation request elsewhere in the same turn still wins.
  const affirmativeText = normalized
    .replace(/(?:\u4e0d\u8981|\u4e0d\u7528|\u65e0\u9700|\u4e0d\u5fc5|\u7981\u6b62|\u4e0d\u5f97|\u5207\u52ff|\u8bf7\u52ff).{0,10}(?:\u65b0\u5efa|\u521b\u5efa|\u65b0\u589e|\u5efa\u4e00\u4e2a).{0,16}(?:\u5ba4\u5185|\u88c5\u4fee|\u8bbe\u8ba1)?\u9879\u76ee/gu, ' ')
    .replace(/\b(?:do\s+not|don't|dont|must\s+not|never)\b.{0,28}\b(?:create|start|new)\b.{0,24}\b(?:interior\s+)?design\s+project\b/gi, ' ');
  return /\b(?:create|start|new)\b.{0,24}\b(?:interior\s+)?design\s+project\b/i.test(affirmativeText)
    || /(?:\u65b0\u5efa|\u521b\u5efa|\u65b0\u589e|\u5efa\u4e00\u4e2a).{0,12}(?:\u5ba4\u5185|\u88c5\u4fee|\u8bbe\u8ba1)\u9879\u76ee/u.test(affirmativeText);
}

export function formatIndustryCapabilityProfilePrompt(text?: unknown): string {
  const profile = getCurrentIndustryCapabilityProfile();
  if (!profile) return '';
  const match = text == null ? null : matchCurrentIndustryWorkflow(text);
  const createDesignProject = text == null ? false : isDesignProjectCreationRequest(text);
  return [
    '## Design Workspace Capability Profile (authoritative)',
    `Capability scope: ${profile.displayName}; productLine=${profile.productLine}. This does not change the application identity.`,
    `Positioning: ${profile.positioning}`,
    'Outcome workspaces:',
    ...profile.entries.map(entry => `- ${entry.displayName} [${entry.entryId}/${entry.automationLevel}]: ${entry.summary}`),
    `Automatic preparation: ${profile.automaticActions.join('; ')}.`,
    `Professional review or confirmation boundary: ${profile.reviewRequiredActions.join('; ')}.`,
    profile.optionalExtensions.length
      ? `Optional non-default extensions: ${profile.optionalExtensions.map(item => `${item.label}(${item.id})`).join(', ')}. Do not route ordinary ${profile.productLine} work to these extensions unless the user explicitly asks for them.`
      : '',
    match
      ? `Current request matches ${match.entry.displayName} [${match.entry.entryId}] from terms: ${match.matchedTerms.join(', ')}.`
      : '',
    createDesignProject
      ? 'This request creates a new durable project container. Call interior_design_project_create first with the explicit project name and known brief fields. If the name is missing, ask one short question. Do not substitute industry_workflow_start for project creation.'
      : match
      ? `When this is an execution request and no existing industry task is named, call industry_workflow_start exactly once with entryId=${match.entry.entryId}. The server binds the current request from trusted turn context; never copy raw business text into tool arguments. Continue the returned task with real domain tools and verify it before claiming completion.`
      : 'For an industry execution request, select exactly one matching outcome workspace. If the target is genuinely ambiguous, ask one short clarification instead of creating multiple tasks.',
    'If a wt_task_* industry task is already named, continue that task and never create a duplicate. Capability questions and self-introductions explain this profile without starting business work.',
    'Usage and teaching questions follow the industry guidance contract: use the exact edition and active business context, explain at most three steps, and never create a task or perform a side effect unless the user explicitly asks to proceed.',
    'Automatic means local reading, analysis, preparation and archival inside the stated scope. It never bypasses the confirmation boundary or turns a draft/model statement into proof of external completion.',
  ].filter(Boolean).join('\n');
}

export function formatIndustryWorkflowRoutingPrompt(text: unknown): string {
  if (isDesignProjectCreationRequest(text)) {
    return [
      '## Design Project Creation Route',
      'Create exactly one durable project with interior_design_project_create. Require an explicit project name and keep known brief fields on that project.',
      'Do not call industry_workflow_start as a substitute for creating the project container. Stage execution begins only after the project exists and is active.',
    ].join('\n');
  }
  if (!isCurrentIndustryWorkflowExecutionRequest(text)) return '';
  const match = matchCurrentIndustryWorkflow(text);
  if (!match) return '';
  return [
    '## Industry Workflow Route',
    `The current request matches this edition's ${match.entry.displayName} outcome workspace [${match.entry.entryId}].`,
    `Matched terms: ${match.matchedTerms.join(', ')}.`,
    `Start exactly one persistent task with industry_workflow_start(entryId=${match.entry.entryId}). The server binds and hashes the current request; do not copy raw business text into tool arguments.`,
    'Then use real domain capabilities. Before claiming completion, call industry_workflow_complete with the returned task id; it will bind current-turn tool receipts and run the server verifier.',
    `Confirmation boundary: ${match.entry.contract.confirmationBoundaries.join(' ')}`,
    'If an existing wt_task_* id is already present, continue it instead of starting another task. If the user is only asking about capability, explain the profile and do not execute tools.',
  ].join('\n');
}
