import type { SkillWorkflowDescriptor } from '../../workflow_registry';
import { CN_SELF_INTRODUCTION_COPY } from '../../../regions/packs/cn/self_introduction';
import { isSelfIntroDemoRequest, runSelfIntroDemo } from './workflows/self_intro_workflow';

export const desktopAutomationWorkflow: SkillWorkflowDescriptor = {
  id: 'self_intro_demo',
  skillId: 'desktop-automation',
  phase: 'self_intro_demo',
  source: 'self_intro_demo',
  logLabel: 'Self-intro demo',
  statusDetail: 'Running self-introduction desktop demo',
  chatSpeech: { minMs: 2200, maxMs: 6400, msPerChar: 115 },
  fallbackText: CN_SELF_INTRODUCTION_COPY.demoFallback,
  requiredTools: ['client_action', 'desktop_list_apps', 'desktop_open', 'desktop_active_window'],
  match: (text, context) => context?.targetIsLumi !== false && isSelfIntroDemoRequest(text),
  run: runSelfIntroDemo,
};
