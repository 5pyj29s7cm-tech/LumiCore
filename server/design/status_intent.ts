// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
const DESIGN_SUBJECT_ZH_RE = /(?:设计项目|室内项目|装修项目|空间项目|CAD\s*方案|效果图(?:阶段)?|提案\s*PPT|交付中心|样板间|验收户型)/iu;
// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
const DESIGN_STATUS_ZH_RE = /(?:事实|状态|进度|阶段|完成了吗|做完了吗|创建好了吗|建好了吗|做到哪|进行到哪|哪一步|到哪了|怎么样|如何|当前|现在|目前|查询|查看)/u;
// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
const DESIGN_STAGE_ACTION_ZH_RE = /(?:进入|开始|继续|推进|执行|着手|启动).{0,32}(?:CAD|效果图|渲染|提案|PPT|交付|设计项目|项目方案|方案阶段|设计阶段|效果图阶段|交付阶段)|(?:请|帮我|给我).{0,24}(?:生成|制作|做一张|做一份|产出).{0,20}(?:CAD|效果图|渲染图|提案|PPT|交付包)/iu;

const DESIGN_SUBJECT_EN_RE = /\b(?:(?:interior|renovation|design)\s+project|(?:cad|visualization|presentation|handoff)\s+(?:stage|workspace))\b/i;
const DESIGN_STATUS_EN_RE = /\b(?:status|progress|facts?|current\s+stage|what\s+stage|where\s+(?:are|is)|how\s+far|next\s+stage)\b/i;
const DESIGN_STAGE_ACTION_EN_RE = /\b(?:start|enter|continue|advance|execute|generate|create|make|render|build)\b.{0,40}\b(?:visualization|render|cad|presentation|proposal|handoff|delivery|stage)\b/i;
const NEGATED_DESIGN_ACTION_ZH_RE = /(?:\u4e0d\u8981|\u4e0d\u5f97|\u65e0\u9700|\u4e0d\u9700\u8981|\u8bf7\u52ff|\u7981\u6b62).{0,36}(?:\u751f\u6210|\u6267\u884c|\u521b\u5efa|\u5236\u4f5c|\u6253\u5f00|\u5916\u53d1|\u8bbe\u8ba1).{0,20}(?:CAD|\u6548\u679c\u56fe|\u6e32\u67d3|\u63d0\u6848|PPT|\u4ea4\u4ed8|\u5916\u90e8\u8f6f\u4ef6|\u65b0\u8bbe\u8ba1)/giu;
// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
const DESIGN_WORKSPACE_LABELS = ['设计项目', 'CAD 方案', '效果图', '提案 PPT', '交付中心'];

function isMultiWorkspaceLedgerStatusRequest(value: string): boolean {
// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
  if (!/(?:分别|逐项|各自|行业任务账本|最终回执|最近任务)/u.test(value)) return false;
  return DESIGN_WORKSPACE_LABELS.filter(label => value.includes(label)).length >= 2;
}

export function isDesignProjectStatusRequest(text: unknown): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  // Positive design execution must win over generic status words such as
  // "current", "stage", and "verification" that legitimately occur in
  // project, CAD, visualization, presentation, and handoff requests.
  if (isDesignProjectCreationRequest(value) || isCurrentIndustryWorkflowExecutionRequest(value)) return false;
  // A cross-workspace receipt summary belongs to the generic industry action
  // ledger. The active-project stage reader is intentionally single-project
  // and must not collapse five requested workspaces into one CAD/status row.
  if (isMultiWorkspaceLedgerStatusRequest(value)) return false;
  const actionProbe = value.replace(NEGATED_DESIGN_ACTION_ZH_RE, ' ');
  if (DESIGN_STAGE_ACTION_ZH_RE.test(actionProbe) || DESIGN_STAGE_ACTION_EN_RE.test(actionProbe)) return false;
  return (
    DESIGN_SUBJECT_ZH_RE.test(value) && DESIGN_STATUS_ZH_RE.test(value)
  ) || (
    DESIGN_SUBJECT_EN_RE.test(value) && DESIGN_STATUS_EN_RE.test(value)
  );
}
import {
  isCurrentIndustryWorkflowExecutionRequest,
  isDesignProjectCreationRequest,
} from '../regions/packs/cn/industry_capability_profile';
