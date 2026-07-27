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
  fallbackText: '刚才的可视化自我介绍没有完整跑完。你可以再明确说“Lumi，演示一下你自己”，我会根据当前实时能力重新规划演示。',
  match: (text, context) => context?.targetIsLumi !== false && isSelfIntroDemoRequest(text),
  run: runSelfIntroDemo,
};
