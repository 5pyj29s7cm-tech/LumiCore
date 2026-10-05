import type { SkillWorkflowDescriptor } from '../../workflow_registry';

const SELF_INTRO_PATTERNS = [
  /\u81ea\u6211\u4ecb\u7ecd/,
  /\u4ecb\u7ecd(?:\u4e00\u4e0b|\u4e0b)?(?:\u4f60\u81ea\u5df1|\u81ea\u5df1|lumi|Lumi)/,
  /\u4ecb\u7ecd(?:\u4e00\u4e0b|\u4e0b)?\u4f60(?:\u7684\u80fd\u529b|\u80fd\u505a\u4ec0\u4e48|\u4f1a\u505a\u4ec0\u4e48)/,
  /(?:\u4f60|lumi|Lumi).{0,8}\u4ecb\u7ecd.{0,8}(?:\u81ea\u5df1|\u4e00\u4e0b)/,
  /(?:\u4f60|lumi|Lumi).{0,12}(?:\u80fd\u505a\u4ec0\u4e48|\u4f1a\u505a\u4ec0\u4e48|\u6709\u54ea\u4e9b\u80fd\u529b|\u80fd\u529b\u6f14\u793a)/,
  /(?:\u5c55\u793a|\u6f14\u793a)(?:\u4e00\u4e0b)?(?:\u4f60\u81ea\u5df1|\u81ea\u5df1|lumi|Lumi)/,
  /(?:\u5c55\u793a|\u6f14\u793a)(?:\u4e00\u4e0b|\u4e0b)?(?:\u4f60|lumi|Lumi).{0,12}(?:\u80fd\u529b|\u684c\u9762|\u64cd\u4f5c|\u81ea\u5df1)/,
  /(?:\u8ba9|\u53eb|\u8bf7)(?:\u4f60|lumi|Lumi).{0,8}(?:\u81ea\u6211\u4ecb\u7ecd|\u4ecb\u7ecd\u81ea\u5df1|\u6f14\u793a\u81ea\u5df1)/,
  /(?:\u7ed9|\u5411)(?:\u65b0\u7528\u6237|\u7528\u6237|\u5927\u5bb6).{0,12}(?:\u4ecb\u7ecd|\u6f14\u793a)(?:\u4e00\u4e0b|\u4e0b)?(?:\u4f60|lumi|Lumi|\u81ea\u5df1)/,
  /(?:\u5f00\u59cb|\u64ad\u653e|\u542f\u52a8).{0,8}(?:\u81ea\u6211\u4ecb\u7ecd|\u80fd\u529b\u6f14\u793a|\u4ecb\u7ecd\u89c6\u9891)/,
  /(?:\u4f60|lumi|Lumi).{0,8}\u662f\u8c01/,
  /introduce\s*(yourself|lumi)/i,
  /show\s*(yourself|lumi)/i,
  /demo\s*(yourself|lumi)/i,
];

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, '');
}

function isSelfIntroDemoRequest(text: string): boolean {
  const normalized = normalizeIntentText(text || '');
  if (!normalized) return false;
  const selfIntroduction = SELF_INTRO_PATTERNS.some(pattern => pattern.test(normalized))
    || /(?:自我介绍|介绍(?:一下)?你自己|你是谁|(?:introduce|demo|show).{0,40}(?:yourself|lumi))/iu.test(normalized); // i18n-allow: Chinese self-introduction input recognition.
  const visibleDemo = /(?:演示|展示|桌面操作|实际操作|边介绍边操作|(?:demo|show).{0,40}(?:yourself|lumi))/iu.test(normalized); // i18n-allow: Chinese visible-demo input recognition.
  return selfIntroduction && visibleDemo;
}

export const desktopAutomationWorkflow: SkillWorkflowDescriptor = {
  id: 'self_intro_demo',
  skillId: 'desktop-automation',
  requiredTools: ['client_action', 'desktop_list_apps', 'desktop_open', 'desktop_active_window'],
  match: (text, context) => context?.targetIsLumi !== false && isSelfIntroDemoRequest(text),
};
