/**
 * Skill translation cache — auto-translates skill metadata via LLM,
 * persists to DB so each skill is translated only once.
 */
import { readDB, writeDB } from '../../db_layer';
import { logger } from '../../logger';

const SUPPORTED_LANGS = ['zh', 'en'];
const FIELDS_TO_TRANSLATE = ['displayName', 'description', 'setupNote'] as const;

const BUILTIN_ZH_TRANSLATIONS: Record<string, TranslationEntry> = {
  'skill-cad-drafting': {
    displayName: 'CAD 制图包',
    description: '面向空间规划和装修方案的 CAD 工作流。可生成可编辑 DXF 草图、绘图检查清单和交付说明。',
  },
  'skill-calculator': {
    displayName: '高级计算器',
    description: '表达式计算、单位换算、统计分析等本地计算工具。',
  },
  'skill-code-sandbox': {
    displayName: '代码沙盒',
    description: '安全执行 Python 和 JavaScript 代码，用于计算、验证脚本和小型自动化。',
  },
  'skill-deep-crawler': {
    displayName: '深度网页采集',
    description: '支持认证场景、站内深度抓取和结构化内容提取的网页采集工具。',
  },
  'skill-design-studio-pack': {
    displayName: '设计工作室包',
    description: '面向品牌、UI、空间与视觉生产的设计工作流，支持创意简报、方向整理、审查清单和交付计划。',
  },
  'skill-desktop-automation': {
    displayName: '桌面指挥官',
    description: '控制鼠标、键盘、窗口和 OCR 的桌面自动化能力，用于在本机应用里执行可确认的操作。',
  },
  'skill-email-assistant': {
    displayName: '邮件助手',
    description: '解析邮件内容、附件和元数据，并辅助起草、摘要和归档。',
  },
  'skill-fetcher': {
    displayName: '网页读取专家',
    description: '把网页 URL 转换成干净可读的内容，方便 Lumi 阅读、摘要和引用。',
  },
  'skill-finance-office': {
    displayName: '财税办公包',
    description: '费用汇总、现金流预测、发票 VAT 复核、应收应付账龄、电商税务底稿和经营报告提纲等财税办公能力。',
  },
  'skill-ecommerce-ops': {
    displayName: '电商运营包',
    description: '商品标题与卖点优化、订单利润分析、库存补货、平台结算复核、广告 ROI 和售后风险分析等电商运营能力。',
  },
  'skill-cross-border-trade': {
    displayName: '\u5916\u8d38\u8de8\u5883\u8fd0\u8425\u5305',
    description: '\u8be2\u76d8\u56de\u590d\u3001\u62a5\u4ef7\u5355\u3001\u62a5\u5173/\u6e05\u5173\u8d44\u6599\u6e05\u5355\u3001\u7269\u6d41\u66f4\u65b0\u548c\u591a\u8bed\u5ba2\u670d\u7b49\u5916\u8d38\u4e0e\u8de8\u5883\u5de5\u4f5c\u6d41\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u5916\u8d38\u548c\u8de8\u5883\u7535\u5546\u5de5\u4f5c\u6d41\u3002\u5408\u540c\u3001\u6d77\u5173\u3001\u5173\u7a0e\u548c\u5408\u89c4\u7ed3\u8bba\u9700\u6838\u5bf9\u5b98\u65b9\u8bb0\u5f55\u5e76\u7531\u4e13\u4e1a\u4eba\u5458\u590d\u6838\u3002',
  },
  'skill-manufacturing-qa': {
    displayName: '\u5236\u9020\u8d28\u68c0\u5305',
    description: '\u751f\u4ea7\u65e5\u62a5\u3001BOM \u68c0\u67e5\u30018D \u8d28\u91cf\u95ee\u9898\u6846\u67b6\u3001\u4f9b\u5e94\u5546\u4ea4\u671f\u98ce\u9669\u548c\u5de5\u5355\u8ba1\u5212\u7b49\u5236\u9020\u4e0e\u54c1\u63a7\u5de5\u4f5c\u6d41\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u751f\u4ea7\u3001\u5de5\u5382\u3001\u8d28\u91cf\u548c\u4f9b\u5e94\u5546\u534f\u540c\u3002\u5de5\u7a0b\u3001\u5b89\u5168\u548c\u751f\u4ea7\u51b3\u7b56\u9700\u7531\u8d1f\u8d23\u4eba\u590d\u6838\u3002',
  },
  'skill-property-ops': {
    displayName: '\u623f\u4ea7\u7269\u4e1a\u8fd0\u8425\u5305',
    description: '\u623f\u6e90\u9700\u6c42\u5339\u914d\u3001\u7269\u4e1a\u5de5\u5355\u5206\u8bca\u3001\u88c5\u4fee\u9884\u7b97\u3001\u65bd\u5de5\u8fdb\u5ea6\u548c\u79df\u8d41\u6c9f\u901a\u8349\u7a3f\u7b49\u623f\u4ea7/\u7269\u4e1a/\u88c5\u4fee\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u623f\u4ea7\u3001\u7269\u4e1a\u548c\u88c5\u4fee\u8fd0\u8425\u3002\u5408\u540c\u3001\u6cd5\u5f8b\u3001\u5b89\u5168\u548c\u65bd\u5de5\u51b3\u7b56\u9700\u7531\u5408\u683c\u4eba\u5458\u590d\u6838\u3002',
  },
  'skill-insurance-advisor': {
    displayName: '\u4fdd\u9669\u987e\u95ee\u8f85\u52a9\u5305',
    description: '\u5ba2\u6237\u9700\u6c42\u753b\u50cf\u3001\u4fdd\u5355\u5bf9\u6bd4\u6846\u67b6\u3001\u7406\u8d54\u8d44\u6599\u6e05\u5355\u3001\u7eed\u4fdd\u590d\u76d8\u548c\u5408\u89c4\u62ab\u9732\u68c0\u67e5\u7b49\u4fdd\u9669\u987e\u95ee\u5de5\u4f5c\u6d41\u3002',
    setupNote: '\u7528\u4e8e\u4fdd\u9669\u5de5\u4f5c\u6d41\u8f85\u52a9\u3002\u53ea\u6574\u7406\u4fe1\u606f\u548c\u590d\u6838\u95ee\u9898\uff0c\u4e0d\u76f4\u63a5\u4f5c\u51fa\u9002\u5f53\u6027\u3001\u6295\u8d44\u6216\u6cd5\u5f8b\u7ed3\u8bba\u3002',
  },
  'skill-content-ops': {
    displayName: '\u65b0\u5a92\u4f53\u5185\u5bb9\u8fd0\u8425\u5305',
    description: '\u9009\u9898\u7ba1\u7ebf\u3001\u77ed\u89c6\u9891\u811a\u672c\u3001\u8d26\u53f7\u590d\u76d8\u3001\u8bc4\u8bba\u6d1e\u5bdf\u548c\u5185\u5bb9\u65e5\u5386\u7b49\u65b0\u5a92\u4f53/\u521b\u4f5c\u8005\u8fd0\u8425\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u65b0\u5a92\u4f53\u3001\u521b\u4f5c\u8005\u548c\u54c1\u724c\u5185\u5bb9\u5de5\u4f5c\u6d41\u3002\u5e73\u53f0\u89c4\u5219\u3001\u5ba3\u79f0\u3001\u7248\u6743\u548c\u53d1\u5e03\u51b3\u7b56\u9700\u5728\u53d1\u5e03\u524d\u590d\u6838\u3002',
  },
  'skill-product-project-ops': {
    displayName: '\u4ea7\u54c1\u9879\u76ee\u7ba1\u7406\u5305',
    description: 'PRD\u3001\u7528\u6237\u6545\u4e8b\u3001\u8def\u7ebf\u56fe\u4f18\u5148\u7ea7\u3001\u9879\u76ee\u98ce\u9669\u767b\u8bb0\u548c\u4f1a\u8bae\u5230\u8fed\u4ee3\u8ba1\u5212\u7b49\u4ea7\u54c1/\u9879\u76ee\u5de5\u4f5c\u6d41\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u4ea7\u54c1\u7ecf\u7406\u3001\u9879\u76ee\u7ecf\u7406\u548c\u4ea4\u4ed8\u8d1f\u8d23\u4eba\u3002\u6700\u7ec8\u8303\u56f4\u3001\u4f18\u5148\u7ea7\u548c\u4ea4\u4ed8\u627f\u8bfa\u7531\u8d1f\u8d23\u56e2\u961f\u786e\u8ba4\u3002',
  },
  'skill-admin-assistant': {
    displayName: '\u884c\u653f\u52a9\u7406\u5305',
    description: '\u65e5\u7a0b\u51b2\u7a81\u68b3\u7406\u3001\u4f1a\u8bae\u7eaa\u8981\u3001\u62a5\u9500\u6750\u6599\u68c0\u67e5\u3001\u529e\u516c\u91c7\u8d2d\u7533\u8bf7\u548c\u901a\u77e5/\u5f52\u6863\u7b49\u884c\u653f\u52a9\u7406\u5de5\u4f5c\u6d41\u3002',
    setupNote: '\u7528\u4e8e\u884c\u653f\u3001\u8001\u677f\u52a9\u7406\u548c\u529e\u516c\u534f\u540c\u3002\u6d89\u53ca\u8d22\u52a1\u3001\u6cd5\u52a1\u548c\u4eba\u4e8b\u654f\u611f\u4e8b\u9879\u9700\u7531\u8d1f\u8d23\u4eba\u590d\u6838\u3002',
  },
  'skill-procurement-supply-chain': {
    displayName: '\u91c7\u8d2d\u4f9b\u5e94\u94fe\u5305',
    description: '\u4f9b\u5e94\u5546\u62a5\u4ef7\u5bf9\u6bd4\u3001\u91c7\u8d2d\u8ba1\u5212\u3001\u4ea4\u671f\u98ce\u9669\u3001\u5e93\u5b58\u9884\u8b66\u548c\u91c7\u8d2d\u5408\u540c\u68c0\u67e5\u7b49\u91c7\u8d2d/\u4f9b\u5e94\u94fe\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u91c7\u8d2d\u3001\u4f9b\u5e94\u94fe\u548c\u4f9b\u5e94\u5546\u534f\u540c\u3002\u6700\u7ec8\u4f9b\u5e94\u5546\u9009\u62e9\u3001\u5408\u540c\u627f\u8bfa\u548c\u5408\u89c4\u51b3\u7b56\u9700\u4eba\u5de5\u6279\u51c6\u3002',
  },
  'skill-data-bi': {
    displayName: '\u6570\u636e BI \u5206\u6790\u5305',
    description: 'CSV/Excel \u6e05\u6d17\u8ba1\u5212\u3001\u6307\u6807\u53e3\u5f84\u3001\u770b\u677f\u7b80\u62a5\u3001\u5f02\u5e38\u89e3\u91ca\u548c\u5468/\u6708\u62a5\u5927\u7eb2\u7b49\u6570\u636e\u5206\u6790\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u6570\u636e\u5206\u6790\u548c BI \u89c4\u5212\u3002\u6e90\u6570\u636e\u3001\u4e1a\u52a1\u53e3\u5f84\u548c\u6700\u7ec8\u7ed3\u8bba\u9700\u590d\u6838\u3002',
  },
  'skill-logistics-warehouse': {
    displayName: '\u7269\u6d41\u4ed3\u50a8\u5305',
    description: '\u5165\u5e93/\u51fa\u5e93\u8bb0\u5f55\u3001\u62e3\u8d27\u5f02\u5e38\u3001\u5e93\u5b58\u76d8\u70b9\u3001\u914d\u9001\u5ef6\u8bef\u3001\u8fd0\u8d39\u6838\u5bf9\u548c\u5ba2\u6237\u901a\u77e5\u7b49\u7269\u6d41\u4ed3\u50a8\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u7269\u6d41\u3001\u4ed3\u5e93\u548c\u914d\u9001\u534f\u540c\u3002\u627f\u8fd0\u5546\u7d22\u8d54\u3001\u6d77\u5173\u3001\u5b89\u5168\u548c\u5408\u540c\u8d23\u4efb\u9700\u6838\u5bf9\u539f\u59cb\u8bb0\u5f55\u3002',
  },
  'skill-live-commerce': {
    displayName: '\u76f4\u64ad\u8fd0\u8425\u5e26\u8d27\u5305',
    description: '\u76f4\u64ad\u6d41\u7a0b\u811a\u672c\u3001\u8d27\u76d8\u89c4\u5212\u3001\u4e3b\u64ad\u63d0\u793a\u5361\u3001\u8f6c\u5316\u590d\u76d8\u548c\u552e\u540e FAQ \u7b49\u76f4\u64ad\u7535\u5546\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u76f4\u64ad\u9500\u552e\u548c\u521b\u4f5c\u8005\u8fd0\u8425\u3002\u5ba3\u79f0\u3001\u4ef7\u683c\u3001\u5e73\u53f0\u89c4\u5219\u548c\u5546\u54c1\u627f\u8bfa\u9700\u5728\u5f00\u64ad\u524d\u590d\u6838\u3002',
  },
  'skill-construction-tender-cost': {
    displayName: '\u5efa\u7b51\u62db\u6295\u6807\u9020\u4ef7\u5305',
    description: '\u5de5\u7a0b\u91cf\u6e05\u5355\u68c0\u67e5\u3001\u62db\u6807\u6587\u4ef6\u6458\u8981\u3001\u62a5\u4ef7\u5bf9\u6bd4\u3001\u65bd\u5de5\u8282\u70b9\u548c\u98ce\u9669\u6761\u6b3e\u68c0\u67e5\u7b49\u5efa\u7b51/\u9020\u4ef7/\u62db\u6295\u6807\u80fd\u529b\u3002',
    setupNote: '\u7528\u4e8e\u5efa\u7b51\u3001\u62db\u6295\u6807\u3001\u9020\u4ef7\u548c\u9879\u76ee\u63a7\u5236\u3002\u6b63\u5f0f\u6295\u6807\u3001\u5408\u540c\u3001\u5de5\u7a0b\u91cf\u548c\u5b89\u5168\u51b3\u7b56\u9700\u4e13\u4e1a\u590d\u6838\u3002',
  },
  'skill-education-teacher': {
    displayName: '教师教培包',
    description: '备课教案、评分量规、测验提纲、学生学习支持画像和家长沟通草稿等教师工作流能力。',
  },
  'skill-executive-ops': {
    displayName: '企业负责人经营包',
    description: '经营 KPI 简报、会议行动项、OKR 规划、决策备忘录、团队风险和现金跑道场景等管理能力。',
  },
  'skill-medical-admin': {
    displayName: '医疗文书与随访包',
    description: '病历结构化、就诊准备、患者说明草稿、随访计划和医学资料检索清单等医疗文书辅助能力，不替代医生诊疗。',
  },
  'skill-hr-recruiting': {
    displayName: 'HR 招聘包',
    description: '岗位 JD、简历匹配摘要、结构化面试、候选人对比和入职清单等招聘与人事工作流能力。',
  },
  'skill-sales-customer-ops': {
    displayName: '销售客服包',
    description: '线索评分、销售跟进、异议处理、客户健康度和客服工单分诊等销售与客户运营能力。',
  },
  'skill-restaurant-store-ops': {
    displayName: '餐饮门店包',
    description: '菜单毛利、报损损耗、门店排班、点评主题和促销 ROI 复盘等餐饮与本地门店运营能力。',
  },
  'skill-hermes': {
    displayName: 'Hermes 助手',
    description: '研究、写作和编码等通用智能体能力，可作为 Lumi 的团队成员接入。',
  },
  'skill-image': {
    displayName: '图片处理',
    description: '图片尺寸调整、格式转换和元数据读取等本地图片工具。',
  },
  'skill-legal-casework': {
    displayName: '法律案件工作包',
    description: '面向律师办案流程的案件辅助能力，支持会谈纪要、期限规划、文书提纲和案件分析，最终结论由律师确认。',
  },
  'skill-melody': {
    displayName: 'Lumi 旋律',
    description: '歌词创作、旋律构思和音乐主题设计工具。',
  },
  'skill-messaging-ops': {
    displayName: '飞书/微信协作包',
    description: '处理飞书、微信和企业微信里的远程请求、文件接收、消息分诊和回复草稿。',
  },
  'skill-minimax': {
    displayName: 'MiniMax 创作室',
    description: '接入 MiniMax 多模态能力，支持音乐、视频、图片和语音创作。',
  },
  'skill-nanobanana': {
    displayName: 'Nano Banana 图像',
    description: '基于 SiliconFlow 的轻量图像生成能力，适合快速出图和灵感草稿。',
  },
  'skill-notes': {
    displayName: '本地便签',
    description: '创建、搜索、列出和删除本地便签。',
  },
  'skill-openclaw': {
    displayName: 'OpenClaw 桌面自动化',
    description: '开源桌面自动化智能体，可控制鼠标、键盘和应用窗口。',
  },
  'skill-password': {
    displayName: '密码生成器',
    description: '生成高强度随机密码。',
  },
  'skill-pdftools': {
    displayName: 'PDF 工具',
    description: '合并 PDF、提取文档元数据等常用 PDF 处理能力。',
  },
  'skill-pixelle': {
    displayName: 'Pixelle 创作室',
    description: '基于 ComfyUI 的 AIGC 工作流，支持图像、视频、声音和创作流水线。',
  },
  'skill-qrcode': {
    displayName: '二维码生成器',
    description: '把文本或 URL 生成二维码图片。',
  },
  'skill-shorturl': {
    displayName: '短链接',
    description: '通过 is.gd 将长 URL 转成短链接。',
  },
  'skill-stockbot': {
    displayName: '股票助手',
    description: 'A 股行情、K 线、板块、新闻、交易计划和模拟盘记录工具。用于学习和演练，不提供投资建议、不连接券商下单。',
  },
  'skill-timer': {
    displayName: '计时提醒',
    description: '设置倒计时、计时器和桌面提醒。',
  },
  'skill-translator': {
    displayName: '翻译助手',
    description: '支持多语言互译，并可自动检测源语言。',
  },
  'skill-video-editor': {
    displayName: '视频工坊',
    description: '视频和音频剪辑、合并、裁切、旋转、效果处理与交付辅助。',
  },
  'skill-weather': {
    displayName: '天气查询',
    description: '查询任意城市的实时天气。',
  },
  'skill-web-scraper': {
    displayName: '网页结构化抓取',
    description: '使用 CSS 选择器抽取网页结构化数据。',
  },
};

const CATEGORY_ZH: Record<string, string> = {
  Architecture: '建筑/CAD',
  Productivity: '效率办公',
  'Dev Tools': '开发工具',
  Web: '网页/数据',
  Design: '设计',
  System: '系统',
  Finance: '财务',
  Ecommerce: '电商',
  'International Trade': '\u5916\u8d38\u8de8\u5883',
  Manufacturing: '\u5236\u9020\u8d28\u68c0',
  Property: '\u623f\u4ea7\u7269\u4e1a',
  Insurance: '\u4fdd\u9669',
  Content: '\u65b0\u5a92\u4f53',
  Product: '\u4ea7\u54c1\u9879\u76ee',
  Administration: '\u884c\u653f\u52a9\u7406',
  Procurement: '\u91c7\u8d2d\u4f9b\u5e94\u94fe',
  Data: '\u6570\u636e BI',
  Logistics: '\u7269\u6d41\u4ed3\u50a8',
  'Live Commerce': '\u76f4\u64ad\u7535\u5546',
  Construction: '\u5efa\u7b51\u9020\u4ef7',
  Education: '教育',
  Management: '管理',
  Healthcare: '医疗',
  HR: '人事招聘',
  Sales: '销售客服',
  Retail: '零售门店',
  Assistant: '助手',
  Media: '媒体',
  Legal: '法律',
  Creative: '创作',
  Messaging: '飞书/微信',
  Music: '音乐',
  Automation: '自动化',
  Security: '安全',
  Language: '语言',
  Featured: '精选',
  Generated: '生成技能',
  Other: '其他',
};

export interface TranslationEntry {
  displayName?: string;
  description?: string;
  setupNote?: string;
  translatedAt?: number;
}

interface TranslationCache {
  [skillId: string]: {
    [lang: string]: TranslationEntry;
  };
}

function loadCache(): TranslationCache {
  const db = readDB();
  return db.skillTranslations || {};
}

function saveCache(cache: TranslationCache) {
  const db = readDB();
  db.skillTranslations = cache;
  writeDB(db);
}

export function getTranslation(skillId: string, lang: string): TranslationEntry | null {
  if (lang === 'en') return null; // English is source
  const cache = loadCache();
  const entry = cache[skillId]?.[lang];
  if (!entry) return lang === 'zh' ? BUILTIN_ZH_TRANSLATIONS[skillId] || null : null;

  // Check staleness: re-translate after 7 days in case source changed
  if (Date.now() - entry.translatedAt > 7 * 24 * 3600 * 1000) {
    return lang === 'zh' ? BUILTIN_ZH_TRANSLATIONS[skillId] || null : null;
  }
  return entry;
}

export function translateCategory(category: string, lang?: string): string {
  if (lang !== 'zh') return category;
  return CATEGORY_ZH[category] || category;
}

export async function translateSkills(
  skills: Array<{
    id: string;
    displayName: string;
    description: string;
    setupNote?: string;
  }>,
  lang: string,
  llmCaller: (prompt: string) => Promise<string>,
): Promise<Map<string, TranslationEntry>> {
  if (lang === 'en' || !SUPPORTED_LANGS.includes(lang)) {
    return new Map();
  }

  const cache = loadCache();
  const results = new Map<string, TranslationEntry>();
  const untranslated: typeof skills = [];

  for (const s of skills) {
    const cached = getCached(cache, s.id, lang);
    if (cached) {
      results.set(s.id, cached);
    } else {
      untranslated.push(s);
    }
  }

  if (untranslated.length > 0) {
    logger.info(`[SkillI18n] Translating ${untranslated.length} skills to ${lang}...`);
    try {
      const prompt = buildTranslationPrompt(untranslated, lang);
      const raw = await llmCaller(prompt);
      const parsed = parseTranslationResponse(raw, untranslated, lang);

      for (const [skillId, trans] of parsed) {
        cache[skillId] = cache[skillId] || {};
        cache[skillId][lang] = { ...trans, translatedAt: Date.now() };
        results.set(skillId, trans);
      }
      saveCache(cache);
      logger.info(`[SkillI18n] Translated ${parsed.size} skills to ${lang}`);
    } catch (err: any) {
      logger.warn(`[SkillI18n] Translation failed: ${err.message}`);
    }
  }

  return results;
}

function getCached(cache: TranslationCache, skillId: string, lang: string): TranslationEntry | null {
  const entry = cache[skillId]?.[lang];
  if (!entry) return null;
  if (Date.now() - entry.translatedAt > 7 * 24 * 3600 * 1000) return null;
  return entry;
}

function buildTranslationPrompt(
  skills: Array<{ id: string; displayName: string; description: string; setupNote?: string }>,
  lang: string,
): string {
  const langName = lang === 'zh' ? 'Simplified Chinese (简体中文)' : lang;
  const items = skills.map(s => {
    let text = `[ID: ${s.id}]\nName: ${s.displayName}\nDescription: ${s.description}`;
    if (s.setupNote) text += `\nSetupNote: ${s.setupNote}`;
    return text;
  }).join('\n\n---\n\n');

  return `Translate the following software skill names, descriptions and setup notes to ${langName}.
Keep technical terms (OCR, API, CSS, LLM, Python, JavaScript, ComfyUI, etc.) untranslated.
Keep brand names (MiniMax, Pixelle, E2B, etc.) untranslated.
Output ONLY a JSON object like this:
{
  "skill-id-1": {
    "displayName": "中文名称",
    "description": "中文描述",
    "setupNote": "中文安装说明"
  }
}

${items}`;
}

function parseTranslationResponse(
  raw: string,
  skills: Array<{ id: string }>,
  lang: string,
): Map<string, TranslationEntry> {
  const map = new Map<string, TranslationEntry>();
  try {
    // Extract JSON from response (may have markdown fence)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return map;
    const parsed = JSON.parse(jsonMatch[0]);
    for (const skill of skills) {
      if (parsed[skill.id]) {
        map.set(skill.id, parsed[skill.id]);
      }
    }
  } catch {
    logger.warn('[SkillI18n] Failed to parse LLM translation response');
  }
  return map;
}
