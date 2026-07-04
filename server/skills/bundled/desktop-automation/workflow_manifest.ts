import type { SkillWorkflowDescriptor } from '../../workflow_registry';
import { isSelfIntroDemoRequest, runSelfIntroDemo } from './workflows/self_intro_workflow';

export const desktopAutomationWorkflow: SkillWorkflowDescriptor = {
  id: 'self_intro_demo',
  skillId: 'desktop-automation',
  phase: 'self_intro_demo',
  source: 'self_intro_demo',
  logLabel: 'Self-intro demo',
  statusDetail: 'Running self-introduction desktop demo',
  chatSpeech: { minMs: 2200, maxMs: 6400, msPerChar: 115 },
  fallbackText: '我已经学会自我介绍演示这条流程了，不过刚才桌面演示没有完整跑完。你再说“Lumi，介绍一下你自己”，我会重新进入演示。',
  match: (text, context) => context?.targetIsLumi !== false && isSelfIntroDemoRequest(text),
  run: runSelfIntroDemo,
};
