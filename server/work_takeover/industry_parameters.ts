import type { WechatWorkCategory } from './wechat_intake';

export interface WorkTakeoverDeliverableFlags {
  needsCad?: boolean;
  needsRevit?: boolean;
  needsQuote?: boolean;
  needsWechatReply?: boolean;
  needsVideo?: boolean;
  needsImageText?: boolean;
  needsPublishDraft?: boolean;
  needsExternalTools?: boolean;
}

export interface WorkTakeoverIndustryParameters {
  category: WechatWorkCategory;
  extractedAt: string;
  sourceMessage: string;
  brandName?: string;
  productName?: string;
  platform?: string;
  audience?: string;
  target?: string;
  budgetLabel?: string;
  areaSqm?: number;
  layout?: string;
  style?: string;
  clientFocus: string[];
  caseType?: string;
  parties?: string;
  evidence: string[];
  deadlines: string[];
  deliverableFlags: WorkTakeoverDeliverableFlags;
  requiredArtifactLabels: string[];
  expectedContentTerms: string[];
  expectedSurfaces: string[];
  confirmationBoundaries: string[];
  summaryLines: string[];
}

export function getTaskIndustryParameters(task: any): WorkTakeoverIndustryParameters | undefined {
  const params = task?.metadata?.industryParameters;
  return params && typeof params === 'object' ? params as WorkTakeoverIndustryParameters : undefined;
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(items: Array<string | undefined>): string[] {
  return Array.from(new Set(items.map(compact).filter(Boolean)));
}

function pickFirst(text: string, patterns: RegExp[], fallback = ''): string {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = compact(match?.[1] || '');
    if (value) return value.replace(/[，。；;,.]$/g, '').slice(0, 42);
  }
  return fallback;
}

function includesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(keyword => lower.includes(keyword.toLowerCase()));
}

function extractDeadlines(text: string): string[] {
  return unique([
    ...Array.from(text.matchAll(/(今天|今晚|明天|后天|本周|周内|下周|月底|月初|尽快|马上|立刻|下班前)/g)).map(match => match[0]),
    ...Array.from(text.matchAll(/\d{1,2}[月\/.-]\d{1,2}日?/g)).map(match => match[0]),
    ...Array.from(text.matchAll(/\d{1,2}:\d{2}/g)).map(match => match[0]),
  ]).slice(0, 8);
}

function parseBudgetLabel(text: string): string | undefined {
  const match = text.match(/(?:预算|投流|广告费|报价|造价|总价|费用|日预算)\D{0,8}(\d+(?:\.\d+)?)\s*(万|千|元|块|w|W)?/);
  if (!match) return undefined;
  return `${match[1]}${match[2] || '元'}`;
}

function parsePlatform(text: string): string | undefined {
  const platforms = [
    ['抖店', /抖店|巨量|fxg/i],
    ['抖音', /抖音|douyin/i],
    ['小红书', /小红书|xiaohongshu/i],
    ['视频号', /视频号/i],
    ['淘宝/天猫', /淘宝|天猫/i],
    ['京东', /京东/i],
    ['拼多多', /拼多多|pdd/i],
    ['Shopify', /shopify/i],
  ] as const;
  return platforms.find(([, pattern]) => pattern.test(text))?.[0];
}

function parseAudience(text: string, productName?: string): string | undefined {
  return pickFirst(text, [
    /(?:人群|用户|受众|客群|面向)\s*[:：]?\s*([^，。；;,.]{2,36})/,
    /(?:卖给|给)\s*([^，。；;,.]{2,26}?)(?:人群|用户|客户|宝妈|白领|老板|学生|家庭)/,
  ], productName ? `${productName} 的潜在购买用户` : '');
}

function parseTarget(text: string, fallback: string): string {
  return pickFirst(text, [
    /(?:目标|目的|要做到|希望)\s*[:：]?\s*([^，。；;,.]{2,42})/,
    /(?:提升|提高|拉动|增加)\s*([^，。；;,.]{2,28})/,
  ], fallback);
}

function parseProductName(text: string): string | undefined {
  return pickFirst(text, [
    /(?:主推商品|主推品|商品|产品|卖|推广)\s*[:：]?\s*([^，。；;,.、]{2,32})/,
    /(?:围绕|关于)\s*([^，。；;,.、]{2,32}?)(?:做|生成|制作|发布|运营|推广)/,
    /(?:短视频|图文|笔记|素材)\s*[:：]?\s*([^，。；;,.、]{2,32})/,
  ]);
}

function parseBrandName(text: string): string | undefined {
  return pickFirst(text, [
    /(?:品牌|店铺|账号|门店)\s*[:：]?\s*([^，。；;,.]{2,28})/,
    /(?:接管|运营|管理)\s*([^，。；;,.]{2,24})(?:店|账号|店铺)/,
  ]);
}

function parseAreaSqm(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:㎡|平|平方|平方米)/);
  return match ? Number(match[1]) : undefined;
}

function parseLayout(text: string): string | undefined {
  return pickFirst(text, [
    /([一二两三四五六七八九十\d]+室[一二两三四五六七八九十\d]?厅[一二两三四五六七八九十\d]?卫?)/,
    /(?:户型|格局)\s*[:：]?\s*([^，。；;,.]{2,24})/,
  ]);
}

function parseStyle(text: string): string | undefined {
  return pickFirst(text, [
    /(?:风格|设计风格)\s*[:：]?\s*([^，。；;,.]{2,24})/,
    /(现代简约|现代轻奢|原木|奶油风|侘寂|新中式|北欧|工业风|法式|中古)/,
  ]);
}

function parseFocus(text: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ['收纳', /收纳|储物/i],
    ['采光', /采光|明亮/i],
    ['动线', /动线|流线/i],
    ['预算控制', /预算|省钱|性价比/i],
    ['干湿分离', /干湿分离/i],
    ['转化', /转化|成交|下单/i],
    ['涨粉', /涨粉|粉丝/i],
    ['发布效率', /发布|矩阵|日更/i],
    ['客服承接', /客服|私信|微信|回复/i],
    ['证据完整', /证据|材料|合同|流水/i],
  ];
  const seeded = rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const explicit = pickFirst(text, [
    /(?:重点|关注|要求|需求)\s*[:：]?\s*([^。；;]{2,80})/,
  ]);
  return unique([
    ...seeded,
    ...explicit.split(/[、,，\s]+/).filter(item => item.length >= 2),
  ]).slice(0, 8);
}

function parseEvidence(text: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ['合同', /合同|协议/i],
    ['聊天记录', /聊天记录|微信记录|沟通记录/i],
    ['转账/流水', /转账|流水|付款|收款/i],
    ['发票/收据', /发票|收据/i],
    ['订单/发货', /订单|发货|签收|物流/i],
    ['照片/截图', /照片|截图|图片/i],
  ];
  const evidence = rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  return unique(evidence).slice(0, 8);
}

function parseLegalParties(text: string): string | undefined {
  return pickFirst(text, [
    /(?:原告|申请人|我方)\s*[:：]?\s*([^，。；;,.]{2,32}).{0,20}(?:被告|对方|被申请人)\s*[:：]?\s*([^，。；;,.]{2,32})/,
    /(?:对方|被告|被申请人)\s*[:：]?\s*([^，。；;,.]{2,32})/,
  ]);
}

function parseCaseType(text: string): string | undefined {
  return pickFirst(text, [
    /(买卖合同纠纷|借款合同纠纷|劳动争议|服务合同纠纷|民间借贷|租赁合同纠纷|侵权纠纷|离婚纠纷)/,
    /(?:案由|类型)\s*[:：]?\s*([^，。；;,.]{2,30})/,
  ]);
}

function ecommerceLike(category: WechatWorkCategory): boolean {
  return category === 'store' || category === 'account' || category === 'video_publish';
}

export function parseWorkTakeoverIndustryParameters(
  sourceMessage: string,
  category: WechatWorkCategory,
): WorkTakeoverIndustryParameters {
  const text = compact(sourceMessage);
  const deadlines = extractDeadlines(text);
  const budgetLabel = parseBudgetLabel(text);
  const flags: WorkTakeoverDeliverableFlags = {
    needsCad: /cad|dxf|dwg|施工图|平面图/i.test(text),
    needsRevit: /revit|bim|dynamo/i.test(text),
    needsQuote: /报价|预算|费用|清单|材料/i.test(text),
    needsWechatReply: /微信|回复|客服|客户|私信|消息/i.test(text),
    needsVideo: /视频|短视频|剪映|脚本|分镜|口播/i.test(text),
    needsImageText: /图文|图片|封面|海报|种草|笔记|提示词/i.test(text),
    needsPublishDraft: /发布|上架|投放|创作者|视频号|抖音|小红书|抖店/i.test(text),
    needsExternalTools: /浏览器|网页|后台|剪映|即梦|可灵|canva|cad|revit|wps|微信|抖店|小红书|视频号/i.test(text),
  };

  const productName = ecommerceLike(category) ? parseProductName(text) : undefined;
  const brandName = ecommerceLike(category) ? parseBrandName(text) : undefined;
  const platform = ecommerceLike(category) ? parsePlatform(text) : undefined;
  const audience = ecommerceLike(category) ? parseAudience(text, productName) : undefined;
  const target = ecommerceLike(category)
    ? parseTarget(text, flags.needsVideo ? '产出可发布的内容包并停在发布确认前' : '完成店铺/账号运营准备')
    : category === 'design_delivery'
    ? parseTarget(text, '生成客户可看的设计交付包')
    : parseTarget(text, '完成安全边界内的任务准备');

  const areaSqm = category === 'design_delivery' ? parseAreaSqm(text) : undefined;
  const layout = category === 'design_delivery' ? parseLayout(text) : undefined;
  const style = category === 'design_delivery' ? parseStyle(text) : undefined;
  const clientFocus = parseFocus(text);
  const evidence = parseEvidence(text);
  const caseType = category === 'legal_case' ? parseCaseType(text) : undefined;
  const parties = category === 'legal_case' ? parseLegalParties(text) : undefined;

  const requiredArtifactLabels = unique([
    ecommerceLike(category) ? '店铺/账号任务参数' : undefined,
    ecommerceLike(category) ? '内容矩阵' : undefined,
    flags.needsVideo ? '短视频脚本' : undefined,
    flags.needsImageText ? '图文/图片生成提示词' : undefined,
    flags.needsPublishDraft ? '发布草稿/发布确认项' : undefined,
    flags.needsWechatReply ? '微信/客服回复草稿' : undefined,
    category === 'design_delivery' ? '装修需求参数' : undefined,
    category === 'design_delivery' ? '客户方案PPT/PDF' : undefined,
    flags.needsQuote && category === 'design_delivery' ? '预算与材料清单' : undefined,
    flags.needsCad ? 'CAD DXF初稿' : undefined,
    flags.needsRevit ? 'Revit/Dynamo交接数据' : undefined,
    category === 'legal_case' ? '事实时间线' : undefined,
    category === 'legal_case' ? '证据目录' : undefined,
    category === 'legal_case' ? '立案材料清单' : undefined,
  ]);

  const expectedContentTerms = unique([
    productName,
    brandName,
    platform,
    audience,
    target,
    budgetLabel,
    areaSqm ? `${areaSqm}` : undefined,
    layout,
    style,
    caseType,
    parties,
    ...clientFocus,
    ...evidence,
    category === 'store' ? '店铺' : undefined,
    category === 'account' ? '账号' : undefined,
    category === 'video_publish' ? '视频' : undefined,
    category === 'design_delivery' ? '装修' : undefined,
    category === 'legal_case' ? '立案' : undefined,
  ]).slice(0, 18);

  const expectedSurfaces = unique([
    ecommerceLike(category) ? 'browser' : undefined,
    ecommerceLike(category) && flags.needsVideo ? 'video_editor' : undefined,
    ecommerceLike(category) && flags.needsPublishDraft ? 'creator_platform' : undefined,
    category === 'store' || category === 'account' ? 'store_platform' : undefined,
    category === 'design_delivery' ? 'office' : undefined,
    category === 'design_delivery' && flags.needsCad ? 'cad' : undefined,
    category === 'design_delivery' && flags.needsRevit ? 'bim' : undefined,
    flags.needsWechatReply ? 'wechat' : undefined,
  ]);

  const confirmationBoundaries = unique([
    flags.needsPublishDraft ? '正式发布前确认' : undefined,
    /投放|广告费|预算/.test(text) ? '投放扣费/预算消耗前确认' : undefined,
    flags.needsWechatReply ? '发送微信/客服消息前确认' : undefined,
    /登录|扫码|验证码|切号|授权/.test(text) ? '登录、验证码、切号或授权需要用户接管' : undefined,
    category === 'design_delivery' ? '现场尺寸、结构、水电、最终报价和合同需要确认' : undefined,
    category === 'legal_case' ? '提交立案、签名、缴费和正式法律意见需要确认' : undefined,
  ]);

  const summaryLines = unique([
    productName ? `商品/产品：${productName}` : undefined,
    brandName ? `店铺/账号：${brandName}` : undefined,
    platform ? `平台：${platform}` : undefined,
    audience ? `人群：${audience}` : undefined,
    target ? `目标：${target}` : undefined,
    budgetLabel ? `预算：${budgetLabel}` : undefined,
    areaSqm ? `面积：${areaSqm}㎡` : undefined,
    layout ? `户型：${layout}` : undefined,
    style ? `风格：${style}` : undefined,
    clientFocus.length ? `重点：${clientFocus.join('、')}` : undefined,
    caseType ? `案由：${caseType}` : undefined,
    parties ? `主体：${parties}` : undefined,
    evidence.length ? `证据：${evidence.join('、')}` : undefined,
    deadlines.length ? `时间：${deadlines.join('、')}` : undefined,
  ]).slice(0, 12);

  return {
    category,
    extractedAt: new Date().toISOString(),
    sourceMessage: text,
    brandName,
    productName,
    platform,
    audience,
    target,
    budgetLabel,
    areaSqm,
    layout,
    style,
    clientFocus,
    caseType,
    parties,
    evidence,
    deadlines,
    deliverableFlags: flags,
    requiredArtifactLabels,
    expectedContentTerms,
    expectedSurfaces,
    confirmationBoundaries,
    summaryLines,
  };
}
