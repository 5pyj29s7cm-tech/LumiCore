import type { SkillWorkflowDescriptor } from '../../workflow_registry';
import { isDesignDeliveryRequest, runDesignDeliveryWorkflow } from './workflows/design_delivery_workflow';

export const cadDraftingWorkflow: SkillWorkflowDescriptor = {
  id: 'design_delivery_workflow',
  skillId: 'cad-drafting',
  phase: 'design_delivery_workflow',
  source: 'design_delivery_workflow',
  logLabel: 'Design delivery workflow',
  statusDetail: 'Running design delivery workflow',
  chatSpeech: { minMs: 2600, maxMs: 7600, msPerChar: 118 },
  fallbackText: '我已经准备好装修设计交付工作流了，不过刚才桌面流程没有完整跑完。你再说“Lumi，开始装修设计交付”，我会重新生成方案、CAD 和 Revit 交接包。',
  match: text => isDesignDeliveryRequest(text),
  run: runDesignDeliveryWorkflow,
};
