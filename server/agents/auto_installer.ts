/**
 * Skill Auto-Installer — detects uninstalled OR outdated skills matching the user's task
 * and silently installs/upgrades them so Lumi can use them immediately.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { mcpManager } from '../mcp';
import { getMarketplaceSkills, recordInstall } from '../marketplace/registry';
import { createAgentForSkill } from './skill_agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_DIR = path.join(__dirname, '..', 'skills', 'bundled');
const SKILLS_DIR = path.join(os.homedir(), 'lumi_skills');

export interface InstallResult {
  skillId: string;
  skillName: string;
  action: 'installed' | 'upgraded' | 'skipped';
  reason: string;
}

const SKILL_KEYWORD_MAP: Array<{ keywords: RegExp[]; skillId: string; category: string }> = [
  { keywords: [/股票|行情|股价|A股|涨停|跌停|K线|大盘|板块|同花顺|炒股|上证|深证|创业板|沪深|PE|市值|换手率|涨了|跌了|什么价|买入|卖出|仓位|止损|止盈|交易计划|模拟盘|纸上交易|持仓|股票池|投资组合|证券/i], skillId: 'skill-stockbot', category: 'Finance' },
  { keywords: [/视频.*剪|剪.*视频|字幕|配音|剪辑|moviepy|ffmpeg/i], skillId: 'skill-video-editor', category: 'Creative' },
  { keywords: [/AI.*画|画.*AI|文生图|生成.*图|图片.*生成|comfyui|stable.diffusion/i], skillId: 'skill-pixelle', category: 'Creative' },
  { keywords: [/nanobanana|nano.banana|香蕉|硅基流动|siliconflow|纳米香蕉|轻量.*生图|快速.*生图/i], skillId: 'skill-nanobanana', category: 'Creative' },
  { keywords: [/二维码|QR|qrcode/i], skillId: 'skill-qrcode', category: 'Productivity' },
  { keywords: [/翻译|translate|英文.*转|中文.*转|多语言/i], skillId: 'skill-translator', category: 'Language' },
  { keywords: [/邮件.*解析|email.*pars|邮件.*附件|mailparser/i], skillId: 'skill-email-assistant', category: 'Productivity' },
  { keywords: [/短链接|短网址|url.*short|缩短/i], skillId: 'skill-shorturl', category: 'Web' },
  { keywords: [/PPT|演示文稿|幻灯片|presentation|ppt/i], skillId: 'skill-pdftools', category: 'Productivity' },
  { keywords: [/密码|password|生成.*密码|随机/i], skillId: 'skill-password', category: 'Security' },
  { keywords: [/天气|weather|气温|下雨|晴天/i], skillId: 'skill-weather', category: 'Productivity' },
  { keywords: [/计时|倒计时|timer|提醒.*时间|定时/i], skillId: 'skill-timer', category: 'Productivity' },
  { keywords: [/爬虫|crawl|爬取|抓取.*网页|网页.*数据|deep.crawl/i], skillId: 'skill-deep-crawler', category: 'Web' },
  { keywords: [/沙箱|sandbox|在线.*运行|在线.*执行|远程.*代码/i], skillId: 'skill-code-sandbox', category: 'Dev Tools' },
  { keywords: [/桌面.*自动化|自动.*点击|自动.*操作|maa/i], skillId: 'skill-desktop-automation', category: 'System' },
  { keywords: [/音乐|作曲|写歌|唱歌|旋律|和弦|和声|歌词|乐理|编曲|midi|谱曲|音阶|五声音阶|作词/i], skillId: 'skill-melody', category: 'Creative' },
  { keywords: [/网易云|网易音乐|netease|播放.*歌|搜.*歌|每日推荐|歌单|推荐.*歌曲|听.*歌|什么歌|放.*歌/i], skillId: 'skill-neteasemusic', category: 'Music' },
  { keywords: [/法律|律师|律所|案件|案号|类案|法条|合同.*审|起诉状|答辩状|委托书|庭审|判决|上诉|执行|legal|casework|court|lawsuit|contract.*review/i], skillId: 'skill-legal-casework', category: 'Legal' },
  { keywords: [/设计|品牌|logo|海报|视觉|UI|UX|设计系统|design|brand|poster|layout|creative brief|视觉方向/i], skillId: 'skill-design-studio-pack', category: 'Design' },
  { keywords: [/CAD|cad|DXF|dxf|图纸|平面图|施工图|草图|户型|装修|空间规划|drawing|drafting|floor plan/i], skillId: 'skill-cad-drafting', category: 'Architecture' },
  { keywords: [/飞书|微信|企业微信|远程访问|远程消息|绑定码|回消息|消息回复|feishu|wechat|wecom|lark/i], skillId: 'skill-messaging-ops', category: 'Messaging' },
  { keywords: [/老师|教师|教培|教学|教案|备课|课堂|作业|批改|评分|试卷|题库|测验|学生画像|家长沟通|lesson|teacher|education|tutor|rubric|quiz|student|parent.message/i], skillId: 'skill-education-teacher', category: 'Education' },
  { keywords: [/企业负责人|老板|创始人|CEO|总经理|管理层|经营会|经营简报|周报|月报|KPI|OKR|会议纪要|行动项|决策备忘录|团队风险|现金跑道|runway|executive|founder|manager|leadership|decision.memo|meeting.action/i], skillId: 'skill-executive-ops', category: 'Management' },
  { keywords: [/医生|医疗|临床|病历|SOAP|问诊|就诊|随访|出院|医嘱|患者|护理|检查报告|medical|clinical|patient|follow.?up|discharge|visit.prep/i], skillId: 'skill-medical-admin', category: 'Healthcare' },
  { keywords: [/HR|人事|招聘|简历|面试|候选人|入职|岗位JD|胜任力|人才|recruit|resume|candidate|interview|onboarding|job.description/i], skillId: 'skill-hr-recruiting', category: 'HR' },
  { keywords: [/销售|客服|客户成功|私域|线索|跟进|异议|工单|客诉|续费|流失|客户健康|lead|sales|customer.success|support.ticket|objection|follow.?up/i], skillId: 'skill-sales-customer-ops', category: 'Sales' },
  { keywords: [/餐饮|门店|咖啡店|奶茶店|饭店|菜单|菜品|毛利|报损|损耗|排班|点评|团购|促销|restaurant|cafe|store|menu|waste|shift|promotion/i], skillId: 'skill-restaurant-store-ops', category: 'Retail' },
  { keywords: [/电商|店铺|网店|淘宝|天猫|京东|拼多多|抖店|小红书|亚马逊|shopify|sku|spu|商品标题|商品文案|详情页|库存|补货|日销|动销|平台结算|结算单|退款率|售后|差评|投诉|广告费|投流|ROI|ROAS|ecommerce|commerce|marketplace|listing|inventory|settlement|campaign|refund|return/i], skillId: 'skill-ecommerce-ops', category: 'Ecommerce' },
  { keywords: [/\u5916\u8d38|\u8de8\u5883|\u8be2\u76d8|\u62a5\u4ef7\u5355|\u62a5\u5173|\u6e05\u5173|\u6d77\u5173|\u5173\u7a0e|\u8d27\u4ee3|\u63d0\u5355|\u4fe1\u7528\u8bc1|FOB|CIF|DDP|incoterm|customs|tariff|freight|forwarder|export|import|cross.?border|foreign.trade/i], skillId: 'skill-cross-border-trade', category: 'International Trade' },
  { keywords: [/\u5236\u9020|\u5de5\u5382|\u751f\u4ea7|\u4ea7\u7ebf|\u8d28\u68c0|\u54c1\u63a7|BOM|\u7269\u6599|\u4f9b\u5e94\u5546|\u4ea4\u671f|8D|\u4e0d\u826f|\u8fd4\u5de5|\u62a5\u5e9f|work.order|production|factory|quality|supplier|defect|inspection/i], skillId: 'skill-manufacturing-qa', category: 'Manufacturing' },
  { keywords: [/\u623f\u4ea7|\u623f\u6e90|\u4e2d\u4ecb|\u7269\u4e1a|\u79df\u8d41|\u770b\u623f|\u4e1a\u4e3b|\u79df\u5ba2|\u5de5\u5355|\u88c5\u4fee|\u65bd\u5de5\u8fdb\u5ea6|\u88c5\u4fee\u9884\u7b97|\u6750\u6599\u6e05\u5355|real.estate|property|leasing|tenant|landlord|renovation/i], skillId: 'skill-property-ops', category: 'Property' },
  { keywords: [/\u4fdd\u9669|\u4fdd\u5355|\u6295\u4fdd|\u7eed\u4fdd|\u7406\u8d54|\u4fdd\u969c|\u91cd\u75be|\u5bff\u9669|\u8f66\u9669|\u5e74\u91d1|\u5ba2\u6237\u753b\u50cf|insurance|policy|claim|renewal|premium|coverage/i], skillId: 'skill-insurance-advisor', category: 'Insurance' },
  { keywords: [/\u65b0\u5a92\u4f53|\u5185\u5bb9\u8fd0\u8425|\u77ed\u89c6\u9891|\u9009\u9898|\u811a\u672c|\u8d26\u53f7\u590d\u76d8|\u8bc4\u8bba\u5206\u6790|\u5c0f\u7ea2\u4e66|\u6296\u97f3|\u89c6\u9891\u53f7|\u516c\u4f17\u53f7|\u76f4\u64ad\u811a\u672c|content|creator|tiktok|youtube|script|calendar/i], skillId: 'skill-content-ops', category: 'Content' },
  { keywords: [/\u4ea7\u54c1\u7ecf\u7406|\u9879\u76ee\u7ecf\u7406|PRD|\u9700\u6c42\u6c60|\u9700\u6c42\u6587\u6863|\u7528\u6237\u6545\u4e8b|\u9a8c\u6536\u6807\u51c6|\u8def\u7ebf\u56fe|\u6392\u671f|\u91cc\u7a0b\u7891|\u8fed\u4ee3|sprint|roadmap|backlog|user.story|acceptance.criteria|project.manager|product.manager/i], skillId: 'skill-product-project-ops', category: 'Product' },
  { keywords: [/\u884c\u653f|\u52a9\u7406|\u8001\u677f\u52a9\u7406|\u603b\u52a9|\u65e5\u7a0b|\u4f1a\u8bae\u5b89\u6392|\u62a5\u9500|\u91c7\u8d2d\u7533\u8bf7|\u901a\u77e5|\u8d44\u6599\u5f52\u6863|\u6863\u6848|admin|assistant|schedule|reimbursement|filing/i], skillId: 'skill-admin-assistant', category: 'Administration' },
  { keywords: [/\u91c7\u8d2d|\u4f9b\u5e94\u94fe|\u4f9b\u5e94\u5546|\u8be2\u4ef7|\u6bd4\u4ef7|\u91c7\u8d2d\u8ba1\u5212|\u4ea4\u671f\u98ce\u9669|\u5e93\u5b58\u9884\u8b66|\u5bf9\u8d26|\u91c7\u8d2d\u5408\u540c|procurement|supply.chain|vendor|supplier|purchase.order|PO/i], skillId: 'skill-procurement-supply-chain', category: 'Procurement' },
  { keywords: [/\u6570\u636e\u5206\u6790|BI|\u62a5\u8868|\u770b\u677f|\u6307\u6807\u53e3\u5f84|\u6570\u636e\u6e05\u6d17|CSV|Excel|\u5f02\u5e38\u89e3\u91ca|\u5468\u62a5|\u6708\u62a5|dashboard|metric|analytics|anomaly|reporting/i], skillId: 'skill-data-bi', category: 'Data' },
  { keywords: [/\u7269\u6d41|\u4ed3\u50a8|\u4ed3\u5e93|\u5165\u5e93|\u51fa\u5e93|\u62e3\u8d27|\u76d8\u70b9|\u914d\u9001|\u8fd0\u8d39|\u5e93\u5b58\u5dee\u5f02|\u5feb\u9012|carrier|warehouse|logistics|inbound|outbound|picking|freight/i], skillId: 'skill-logistics-warehouse', category: 'Logistics' },
  { keywords: [/\u76f4\u64ad|\u4e3b\u64ad|\u5e26\u8d27|\u76f4\u64ad\u95f4|\u8d27\u76d8|\u573a\u63a7|\u76f4\u64ad\u811a\u672c|\u8f6c\u5316\u590d\u76d8|GMV|\u76f4\u64ad\u552e\u540e|live.commerce|livestream|host.script|rundown/i], skillId: 'skill-live-commerce', category: 'Live Commerce' },
  { keywords: [/\u5efa\u7b51|\u5de5\u7a0b|\u9020\u4ef7|\u62db\u6295\u6807|\u6295\u6807|\u6e05\u5355|\u5de5\u7a0b\u91cf|\u6807\u4e66|\u65bd\u5de5\u8282\u70b9|\u98ce\u9669\u6761\u6b3e|BOQ|tender|bid|quantity.survey|construction|cost.estimate/i], skillId: 'skill-construction-tender-cost', category: 'Construction' },
  { keywords: [/财务|财税|税务|税期|报税|纳税|增值税|进项|销项|税负|所得税|报销|发票|现金流|收支|预算|应收|应付|账龄|账款|费用|利润|营收|finance|tax|vat|expense|invoice|cashflow|reimbursement|aging|receivable|payable/i], skillId: 'skill-finance-office', category: 'Finance' },
];

function getInstalledNames(): Set<string> {
  const names = new Set<string>();
  try {
    if (fs.existsSync(SKILLS_DIR)) {
      for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    }
  } catch {}
  return names;
}

/**
 * Read the installed version from a skill's package.json
 */
function getInstalledVersion(name: string): string {
  try {
    const pkgPath = path.join(SKILLS_DIR, name, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.lumi?.installedVersion || pkg.version || '0.0.0';
    }
  } catch {}
  return '0.0.0';
}

/**
 * Read the bundled source version
 */
function getBundledVersion(name: string): string {
  try {
    const pkgPath = path.join(BUNDLED_DIR, name, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || '0.0.0';
    }
  } catch {}
  return '0.0.0';
}

/**
 * Auto-install or upgrade matching skills for the user's task.
 * Returns which skills were newly installed or upgraded.
 */
export async function autoInstallForTask(userText: string, io?: { emit: (event: string, data: any) => void }): Promise<InstallResult[]> {
  const installed = getInstalledNames();
  const results: InstallResult[] = [];

  for (const entry of SKILL_KEYWORD_MAP) {
    const matched = entry.keywords.some(k => k.test(userText));
    if (!matched) continue;

    const dirName = entry.skillId.replace('skill-', '');
    const bundledPath = path.join(BUNDLED_DIR, dirName);
    if (!fs.existsSync(bundledPath)) continue;

    const isAlreadyInstalled = installed.has(dirName);
    const skill = getMarketplaceSkills().find(s => s.id === entry.skillId);
    const displayName = skill?.name || dirName;

    // Check if upgrade is available
    let action: 'installed' | 'upgraded' | 'skipped' = 'skipped';
    if (isAlreadyInstalled) {
      const installedVer = getInstalledVersion(dirName);
      const bundledVer = getBundledVersion(dirName);
      if (installedVer === bundledVer) {
        continue; // Already latest, skip
      }
      action = 'upgraded';
    } else {
      action = 'installed';
    }

    try {
      const actionVerb = action === 'upgraded' ? '升级' : '安装';
      console.log(`[AutoInstall] ${actionVerb} "${displayName}" for task: "${userText.slice(0, 80)}"`);


      // Install or upgrade — allowUpgrade=true handles both cases
      const installDir = mcpManager.installSkill(dirName, bundledPath, true);
      console.log(`[AutoInstall] ${actionVerb}完成: ${installDir}`);

      // Restart MCP server to pick up changed tools
      const tools = await mcpManager.restartServer(dirName);
      console.log(`[AutoInstall] Server ready with ${tools.length} tools`);

      // Record install (even for upgrades, to update stats)
      recordInstall(entry.skillId);

      // Create or refresh team agent
      createAgentForSkill(displayName, {
        description: skill?.description,
        category: entry.category,
        toolCount: skill?.toolCount || tools.length,
        installSource: 'bundled',
      }, io);

      results.push({
        skillId: entry.skillId,
        skillName: displayName,
        action,
        reason: action === 'upgraded' ? `已自动升级 ${displayName}` : `已自动安装 ${displayName}`,
      });

      console.log(`[AutoInstall] Done: ${displayName} (${action})`);
    } catch (err: any) {
      console.warn(`[AutoInstall] Failed: "${displayName}": ${err.message}`);
      results.push({
        skillId: entry.skillId,
        skillName: displayName,
        action: 'skipped',
        reason: `失败: ${err.message}`,
      });
    }
  }

  return results;
}
