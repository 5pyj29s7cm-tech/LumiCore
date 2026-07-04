import type { SkillWorkflowDescriptor } from '../../workflow_registry';
import { isCustomerTakeoverRequest, runCustomerTakeoverWorkflow } from './workflows/customer_takeover_workflow';

export const salesCustomerOpsWorkflow: SkillWorkflowDescriptor = {
  id: 'customer_takeover_workflow',
  skillId: 'sales-customer-ops',
  phase: 'customer_takeover_workflow',
  source: 'customer_takeover_workflow',
  logLabel: 'Customer takeover workflow',
  statusDetail: 'Running customer takeover workflow',
  chatSpeech: { minMs: 2300, maxMs: 7000, msPerChar: 112 },
  fallbackText: '我已经准备好客户接管工作流了，不过刚才桌面流程没有完整跑完。你再说“Lumi，按我的规则推进这个客户”，我会重新进入客户接管。',
  match: text => isCustomerTakeoverRequest(text),
  run: runCustomerTakeoverWorkflow,
};
