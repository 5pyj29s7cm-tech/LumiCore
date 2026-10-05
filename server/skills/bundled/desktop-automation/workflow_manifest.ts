import type { SkillWorkflowDescriptor } from '../../workflow_registry';

const SELF_INTRO_PATTERNS = [
  /自我介绍/,
  /介绍(?:一下|下)?(?:你自己|自己|lumi|Lumi)/,
  /介绍(?:一下|下)?你(?:的能力|能做什么|会做什么)/,
  /(?:你|lumi|Lumi).{0,8}介绍.{0,8}(?:自己|一下)/,
  /(?:你|lumi|Lumi).{0,12}(?:能做什么|会做什么|有哪些能力|能力演示)/,
  /(?:展示|演示)(?:一下)?(?:你自己|自己|lumi|Lumi)/,
  /(?:展示|演示)(?:一下|下)?(?:你|lumi|Lumi).{0,12}(?:能力|桌面|操作|自己)/,
  /(?:让|叫|请)(?:你|lumi|Lumi).{0,8}(?:自我介绍|介绍自己|演示自己)/,
  /(?:给|向)(?:新用户|用户|大家).{0,12}(?:介绍|演示)(?:一下|下)?(?:你|lumi|Lumi|自己)/,
  /(?:开始|播放|启动).{0,8}(?:自我介绍|能力演示|介绍视频)/,
  /(?:你|lumi|Lumi).{0,8}是谁/,
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
