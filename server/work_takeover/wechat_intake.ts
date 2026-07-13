import { parseWorkTakeoverIndustryParameters, type WorkTakeoverIndustryParameters } from './industry_parameters';

export type WechatWorkCategory =
  | 'customer'
  | 'store'
  | 'account'
  | 'legal_case'
  | 'video_publish'
  | 'design_delivery'
  | 'general_work'
  | 'personal'
  | 'unknown';

export type WechatUrgency = 'low' | 'normal' | 'high' | 'urgent';

export interface WechatIntakeInput {
  message: string;
  contact?: string;
  source?: 'clipboard' | 'manual' | 'selected_text' | 'wechat' | string;
  userRules?: string | string[];
  takeoverMode?: WechatWorkCategory | 'auto';
}

export interface WechatIntakeResult {
  intakeId: string;
  receivedAt: string;
  source: string;
  contact?: string;
  category: WechatWorkCategory;
  confidence: number;
  urgency: WechatUrgency;
  summary: string;
  extracted: {
    amounts: string[];
    deadlines: string[];
    people: string[];
    topics: string[];
  };
  parameters: WorkTakeoverIndustryParameters;
  recommendedWorkflow: string;
  nextActions: string[];
  draftReply: string;
  artifactsToPrepare: string[];
  allowedNow: string[];
  confirmationRequired: string[];
  blockedBy: string[];
  safety: string;
}

const CATEGORY_KEYWORDS: Record<Exclude<WechatWorkCategory, 'unknown'>, string[]> = {
  customer: ['客户', '线索', '报价', '价格', '方案', '合同', '定金', '成交', '交付', '预算', '询价', '合作', '项目'],
  store: ['店铺', '抖店', '小店', '订单', '库存', '发货', '售后', '退款', '评价', '差评', '客服', '商品', '上架', '下架'],
  account: ['账号', '账户', '登录', '粉丝', '投放', '数据', '素材', '广告', '小红书', '抖音', '视频号', '抖店', '矩阵', '运营'],
  legal_case: ['立案', '起诉', '法院', '律师', '诉讼', '证据', '仲裁', '被告', '原告', '案由', '材料', '保全'],
  video_publish: ['视频', '剪辑', '发布', '标题', '封面', '脚本', '字幕', '口播', '账号发布', '投流', '审核'],
  design_delivery: ['装修', '户型', 'CAD', 'Revit', '施工图', '效果图', '平面图', '方案图', '量房', '设计', '预算表'],
  general_work: ['处理', '跟进', '整理', '推进', '安排', '对接', '确认', '回复', '交付', '执行'],
  personal: ['吃饭', '回家', '家里', '朋友', '生日', '孩子', '旅游', '休息', '生活'],
};

const WORKFLOW_BY_CATEGORY: Record<WechatWorkCategory, string> = {
  customer: 'customer_operations',
  store: 'store_operations_takeover',
  account: 'account_operations_takeover',
  legal_case: 'case_filing_takeover',
  video_publish: 'video_publish_takeover',
  design_delivery: 'design_delivery_takeover',
  general_work: 'general_work_takeover',
  personal: 'personal_assistance',
  unknown: 'message_triage',
};

const ARTIFACTS_BY_CATEGORY: Record<WechatWorkCategory, string[]> = {
  customer: ['客户需求摘要', '报价/方案草稿', '合同风险点', '微信回复草稿', '下一步推进清单'],
  store: ['订单/售后记录', '库存或发货核对项', '客服回复草稿', '风险升级清单'],
  account: ['账号现状摘要', '内容/投放任务清单', '数据核对项', '对外回复草稿'],
  legal_case: ['立案材料清单', '证据目录', '事实时间线', '风险提示', '待确认事项'],
  video_publish: ['视频发布清单', '标题/封面方向', '脚本或口播摘要', '平台发布确认项'],
  design_delivery: ['需求摘要', '客户可看的装修方案PPT/PDF', '预算与材料清单', 'CAD DXF初稿', 'Revit/Dynamo交接数据', '客户回复草稿'],
  general_work: ['任务摘要', '执行清单', '回复草稿', '待确认事项'],
  personal: ['事项摘要', '回复草稿', '提醒项'],
  unknown: ['消息摘要', '分类建议', '回复草稿'],
};

function compactText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()));
}

function scoreCategory(text: string, category: Exclude<WechatWorkCategory, 'unknown'>): number {
  const keywords = CATEGORY_KEYWORDS[category];
  let score = 0;
  for (const keyword of keywords) {
    if (text.toLowerCase().includes(keyword.toLowerCase())) score += keyword.length > 2 ? 2 : 1;
  }
  return score;
}

function classifyMessage(message: string, takeoverMode?: WechatIntakeInput['takeoverMode']): { category: WechatWorkCategory; confidence: number } {
  if (takeoverMode && takeoverMode !== 'auto' && takeoverMode !== 'unknown') {
    return { category: takeoverMode, confidence: 0.96 };
  }

  const candidates = (Object.keys(CATEGORY_KEYWORDS) as Array<Exclude<WechatWorkCategory, 'unknown'>>)
    .map(category => ({ category, score: scoreCategory(message, category) }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score <= 0) return { category: 'unknown', confidence: 0.2 };
  const second = candidates[1]?.score || 0;
  const confidence = Math.min(0.95, 0.45 + best.score * 0.08 + Math.max(0, best.score - second) * 0.05);
  return { category: best.category, confidence: Number(confidence.toFixed(2)) };
}

function extractMatches(text: string, patterns: RegExp[], limit = 8): string[] {
  const values: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = compactText(match[0]);
      if (value && !values.includes(value)) values.push(value);
      if (values.length >= limit) return values;
    }
  }
  return values;
}

function extractPeople(text: string, contact?: string): string[] {
  const values = new Set<string>();
  if (contact) values.add(contact);
  for (const match of text.matchAll(/(?:客户|联系人|对接人|负责人|老板|经理|总|律师|设计师)[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,12})/g)) {
    if (match[1]) values.add(match[1]);
  }
  for (const match of text.matchAll(/[\u4e00-\u9fa5]{1,4}(?:总|经理|律师|老师|老板)/g)) {
    values.add(match[0]);
  }
  return Array.from(values).slice(0, 8);
}

function extractTopics(message: string, category: WechatWorkCategory): string[] {
  const keywords = category === 'unknown'
    ? Object.values(CATEGORY_KEYWORDS).flat()
    : CATEGORY_KEYWORDS[category] || [];
  return keywords.filter(keyword => message.toLowerCase().includes(keyword.toLowerCase())).slice(0, 8);
}

function detectUrgency(message: string, deadlines: string[]): WechatUrgency {
  const text = message.toLowerCase();
  if (/(马上|立刻|现在|赶紧|急|加急|今天|今晚|asap|urgent)/i.test(text)) return 'urgent';
  if (/(明天|尽快|本周|周内|下班前|before|deadline)/i.test(text) || deadlines.length > 0) return 'high';
  if (/(下周|月底|确认一下|跟进|安排)/i.test(text)) return 'normal';
  return 'normal';
}

function summarize(message: string, category: WechatWorkCategory): string {
  const trimmed = compactText(message);
  if (!trimmed) return '没有可分析的微信内容。';
  const prefix = category === 'unknown' ? '这条微信需要先确认任务类型' : `这条微信已识别为${categoryLabel(category)}任务`;
  return `${prefix}：${trimmed.slice(0, 120)}${trimmed.length > 120 ? '...' : ''}`;
}

function categoryLabel(category: WechatWorkCategory): string {
  const labels: Record<WechatWorkCategory, string> = {
    customer: '客户推进',
    store: '店铺运营',
    account: '账号运营',
    legal_case: '半自动立案/法律材料',
    video_publish: '视频生成发布',
    design_delivery: '装修/CAD/Revit交付',
    general_work: '通用工作',
    personal: '个人事务',
    unknown: '待分类',
  };
  return labels[category];
}

function buildNextActions(category: WechatWorkCategory, urgency: WechatUrgency): string[] {
  const common = ['生成微信回复草稿', '列出需要用户确认的边界'];
  const byCategory: Record<WechatWorkCategory, string[]> = {
    customer: ['提取客户需求和预算', '准备报价/方案草稿', '标记合同和交付风险', '形成客户推进结果'],
    store: ['核对订单/库存/售后状态', '准备客服回复', '标记退款、差评或投诉风险'],
    account: ['识别账号运营目标', '准备内容/投放执行清单', '标记登录、发布和投放确认项'],
    legal_case: ['整理事实时间线', '列出立案材料', '标记证据缺口和法律风险'],
    video_publish: ['整理视频目标和素材需求', '生成标题/封面/发布清单', '标记发布确认项'],
    design_delivery: ['提取户型、风格、预算和交付要求', '生成客户方案PPT/PDF和预算材料清单', '生成CAD DXF初稿并准备Revit/Dynamo交接数据', '标记尺寸、结构、水电、合同和发送风险'],
    general_work: ['拆分任务步骤', '准备执行清单'],
    personal: ['整理事项', '准备简短回复'],
    unknown: ['询问任务归属', '等待用户补充背景'],
  };
  const urgencyAction = urgency === 'urgent' || urgency === 'high' ? ['优先进入待处理队列'] : [];
  return [...urgencyAction, ...(byCategory[category] || []), ...common].slice(0, 8);
}

function buildDraftReply(input: WechatIntakeInput, category: WechatWorkCategory, urgency: WechatUrgency): string {
  const contact = compactText(input.contact || '');
  const prefix = contact ? `${contact}，` : '';
  const urgencyLine = urgency === 'urgent' ? '我先按紧急事项处理，' : '我先整理关键信息，';
  switch (category) {
    case 'customer':
      return `${prefix}收到，${urgencyLine}这边会把需求、报价、交付周期和合同风险先梳理出来。我先给你一版正式方案和报价口径，关键价格和最终承诺我确认后再发。`;
    case 'store':
      return `${prefix}收到，${urgencyLine}我先核对订单、库存、售后状态和风险点，再给你一版客服回复。涉及退款、赔付或公开回复的动作我会先确认。`;
    case 'account':
      return `${prefix}收到，${urgencyLine}我先把账号目标、素材、数据和发布/投放动作拆出来。已登录的窗口我可以直接接着用；首次登录、切号、发布和投放预算我会先确认。`;
    case 'legal_case':
      return `${prefix}收到，${urgencyLine}我先整理事实时间线、证据目录和立案材料清单。涉及提交、签名、付款或正式法律意见的部分我会先确认。`;
    case 'video_publish':
      return `${prefix}收到，${urgencyLine}我先整理脚本、标题、封面和发布清单。已登录账号可继续准备发布；正式发布、首次登录和切号我会等你确认后再执行。`;
    case 'design_delivery':
      return `${prefix}收到，${urgencyLine}我先把户型、风格、预算和交付要求整理成方案包，准备客户可看的PPT/PDF、CAD初稿、Revit交接数据和回复草稿。涉及正式报价、合同、生产图纸和发送动作我会先确认。`;
    case 'personal':
      return `${prefix}收到，我先帮你整理成待办和回复草稿，需要提醒或发送时我再等你确认。`;
    case 'general_work':
      return `${prefix}收到，${urgencyLine}我先把这件事拆成任务清单、回复草稿和待确认事项，能直接准备的材料我先准备。`;
    default:
      return `${prefix}收到，我先判断这条消息属于哪类工作，再整理回复草稿和下一步动作。需要发送或提交的部分我会先确认。`;
  }
}

function normalizeRules(rules?: string | string[]): string[] {
  if (!rules) return [];
  if (Array.isArray(rules)) return rules.map(rule => compactText(String(rule))).filter(Boolean).slice(0, 12);
  return compactText(rules)
    .split(/[;\n；。]+/)
    .map(rule => compactText(rule))
    .filter(Boolean)
    .slice(0, 12);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(compactText).filter(Boolean)));
}

export function analyzeWechatIntake(input: WechatIntakeInput): WechatIntakeResult {
  const message = compactText(input.message || '');
  if (!message) {
    throw new Error('message is required for WeChat intake analysis.');
  }

  const { category, confidence } = classifyMessage(message, input.takeoverMode);
  const amounts = extractMatches(message, [
    /(?:￥|¥|RMB\s*)?\d+(?:[,.]\d+)*(?:\.\d+)?\s*(?:万|w|W|元|块|rmb)?/gi,
  ]);
  const deadlines = extractMatches(message, [
    /(今天|今晚|明天|后天|本周|周内|下周|月底|月初|尽快|马上|立刻|下班前)/g,
    /\d{1,2}[月\/.-]\d{1,2}日?/g,
    /\d{1,2}:\d{2}/g,
  ]);
  const people = extractPeople(message, input.contact);
  const topics = extractTopics(message, category);
  const urgency = detectUrgency(message, deadlines);
  const rules = normalizeRules(input.userRules);
  const parameters = parseWorkTakeoverIndustryParameters(message, category);
  const allowedNow = [
    '读取用户提供或剪贴板中的消息内容',
    '分类任务类型',
    '生成回复草稿',
    '准备材料清单',
    '打开或恢复已经登录的微信、浏览器、店铺后台或创作平台窗口',
    '复制草稿到剪贴板（需要确认工具）',
  ];
  const confirmationRequired = [
    '发送微信消息',
    '首次登录、扫码、验证码、人脸/短信验证、切换外部账号或授权第三方',
    '提交立案/发布/下单/付款/签约',
    '对外承诺最终价格、交付周期或法律意见',
  ];
  const blockedBy = category === 'unknown'
    ? ['任务类型不明确，需要用户补充背景或指定接管方向']
    : [];

  return {
    intakeId: `wechat-intake-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    receivedAt: new Date().toISOString(),
    source: input.source || 'manual',
    contact: input.contact || people[0],
    category,
    confidence,
    urgency,
    summary: summarize(message, category),
    extracted: { amounts, deadlines, people, topics },
    parameters,
    recommendedWorkflow: WORKFLOW_BY_CATEGORY[category],
    nextActions: [
      ...buildNextActions(category, urgency),
      ...parameters.summaryLines.slice(0, 4).map(line => `按任务参数：${line}`),
      ...rules.map(rule => `按用户规则：${rule}`),
    ].slice(0, 12),
    draftReply: buildDraftReply(input, category, urgency),
    artifactsToPrepare: uniqueStrings([
      ...ARTIFACTS_BY_CATEGORY[category],
      ...parameters.requiredArtifactLabels,
    ]),
    allowedNow,
    confirmationRequired: uniqueStrings([
      ...confirmationRequired,
      ...parameters.confirmationBoundaries,
    ]),
    blockedBy,
    safety: 'Lumi can triage, draft, prepare files, copy drafts, and restore already logged-in app/browser sessions. First-time login, QR/OTP/biometric verification, account switching, sending messages, publishing, payment, signing, submitting, or making external commitments remains confirmation-gated.',
  };
}

export function isLikelyWechatTakeoverRequest(text: string): boolean {
  const compact = compactText(text);
  if (!compact) return false;
  return includesAny(compact, ['微信', '消息', '聊天', '客户信息', '线索'])
    && includesAny(compact, ['接管', '处理', '回复', '推进', '跟进', '分类']);
}
