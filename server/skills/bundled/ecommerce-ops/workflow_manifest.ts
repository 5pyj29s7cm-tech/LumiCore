import type { SkillWorkflowDescriptor } from '../../workflow_registry';
import { isEcommerceGrowthRequest, runEcommerceGrowthWorkflow } from './workflows/ecommerce_growth_workflow';

export const ecommerceOpsWorkflow: SkillWorkflowDescriptor = {
  id: 'ecommerce_growth_workflow',
  skillId: 'ecommerce-ops',
  phase: 'ecommerce_growth_workflow',
  source: 'ecommerce_growth_workflow',
  logLabel: 'Ecommerce growth workflow',
  statusDetail: 'Running ecommerce growth workflow',
  chatSpeech: { minMs: 2600, maxMs: 8200, msPerChar: 118 },
  fallbackText: '我可以进入电商增长接管流程，不过刚才桌面流程没有完整跑完。你再说“Lumi，接管这个店铺账号，生成短视频内容和发布草稿”，我会重新生成店铺诊断、内容矩阵、外部工具提示词、发布草稿和微信客服话术。',
  match: text => isEcommerceGrowthRequest(text),
  run: runEcommerceGrowthWorkflow,
};
