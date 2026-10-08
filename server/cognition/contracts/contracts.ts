import type { CapabilityLane, CapabilityOperation } from "../../tools/types";
import { unique } from "../action_contract_support";

export type LumiActionContractKind =
  | 'media_generation'
  | 'avatar_authoring'
  | 'skill_authoring'
  | 'none'
  | 'messaging_read'
  | 'messaging_send'
  | 'browser_account'
  | 'public_post'
  | 'cad_document'
  | 'cad_drafting'
  | 'customer_operations'
  | 'ecommerce_operations'
  | 'design_delivery'
  | 'stock_monitor'
  | 'task_control'
  | 'work_task'
  | 'external_ai_history'
  | 'external_ai_request'
  | 'external_cli_status'
  | 'extension_registry'
  | 'legal_document'
  | 'desktop_operation'
  | 'artifact_work';

export interface LumiActionContract {
  mediaPlayback?: 'play' | 'pause';
  mediaGeneration?: { toolName: 'generate_image' | 'ai_edit_image' | 'generate_video'; standalone: boolean; duration?: number; size?: string; count: number; audioRequired: boolean };
  components?: Array<{ text: string; contract: LumiActionContract }>;
  applies: boolean;
  kind: LumiActionContractKind;
  label: string;
  coreAction: string;
  preparationIsNotCompletion: string[];
  requiredEvidence: string[];
  preferredTools: string[];
  verificationTools: string[];
  preferredCapabilities: ActionCapabilityRequirement[];
  verificationCapabilities: ActionCapabilityRequirement[];
  nextStep: string;
  caution: string;
}

export interface ActionCapabilityRequirement {
  lanes: CapabilityLane[];
  operations?: CapabilityOperation[];
  terms: string[];
}

const ACTION_CAPABILITY_REQUIREMENTS: Partial<Record<LumiActionContractKind, ActionCapabilityRequirement[]>> = {
  media_generation: [{ lanes: ['media'], operations: ['create', 'test'], terms: ['generate', 'image', 'video', 'artifact'] }],
  messaging_read: [{ lanes: ['messaging', 'desktop'], operations: ['observe'], terms: ['message', 'wechat', 'chat', 'window', 'screen', 'ocr'] }],
  messaging_send: [{ lanes: ['messaging', 'desktop'], operations: ['communicate', 'mutate'], terms: ['message', 'wechat', 'send', 'file', 'desktop'] }],
  browser_account: [{ lanes: ['web', 'desktop'], operations: ['observe', 'mutate'], terms: ['login', 'session', 'account', 'browser', 'page'] }],
  public_post: [{ lanes: ['web', 'desktop'], operations: ['communicate', 'mutate'], terms: ['post', 'publish', 'comment', 'browser', 'page'] }],
  cad_document: [{ lanes: ['cad'], operations: ['create', 'mutate'], terms: ['autocad', 'document', 'drawing'] }],
  cad_drafting: [{ lanes: ['cad', 'media', 'files', 'desktop'], operations: ['observe', 'create', 'mutate', 'test'], terms: ['cad', 'autocad', 'floorplan', 'geometry', 'drawing'] }],
  customer_operations: [{ lanes: ['agents', 'messaging', 'office', 'industry'], terms: ['customer', 'sales', 'lead', 'takeover', 'message'] }],
  ecommerce_operations: [{ lanes: ['industry', 'web', 'office', 'media'], terms: ['ecommerce', 'store', 'listing', 'inventory', 'campaign', 'content'] }],
  design_delivery: [{ lanes: ['cad', 'media', 'office', 'files'], terms: ['design', 'cad', 'image', 'presentation', 'document'] }],
  stock_monitor: [{ lanes: ['industry', 'web', 'agents'], operations: ['observe', 'create'], terms: ['stock', 'market', 'quote', 'watch', 'workflow'] }],
  task_control: [{ lanes: ['system', 'agents'], operations: ['observe', 'mutate'], terms: ['runtime', 'task', 'work', 'status', 'cancel'] }],
  work_task: [{ lanes: ['agents'], operations: ['create', 'observe', 'mutate'], terms: ['persistent', 'task', 'takeover', 'ledger', 'workflow'] }],
  external_ai_history: [{ lanes: ['agents'], operations: ['observe', 'create', 'mutate'], terms: ['external', 'ai', 'history', 'conversation', 'sync', 'authorization'] }],
  external_ai_request: [{ lanes: ['web', 'desktop'], operations: ['communicate', 'observe'], terms: ['external', 'ai', 'tool', 'answer', 'target'] }],
  external_cli_status: [{ lanes: ['agents'], operations: ['observe'], terms: ['external', 'cli', 'status'] }],
  extension_registry: [{ lanes: ['system'], operations: ['observe', 'test', 'mutate'], terms: ['extension', 'registry', 'provider', 'plugin', 'compatibility', 'rollback'] }],
  legal_document: [{ lanes: ['industry', 'web', 'office'], terms: ['legal', 'law', 'case', 'citation', 'court', 'document'] }],
  desktop_operation: [{ lanes: ['desktop'], operations: ['observe', 'mutate', 'test'], terms: ['desktop', 'window', 'application', 'native', 'screen', 'open'] }],
  artifact_work: [{ lanes: ['files', 'office', 'media'], operations: ['observe', 'create', 'mutate', 'test'], terms: ['file', 'document', 'artifact', 'create', 'verify'] }],
};

function actionCapabilityRequirements(kind: LumiActionContractKind): ActionCapabilityRequirement[] {
  return (ACTION_CAPABILITY_REQUIREMENTS[kind] || []).map(requirement => ({
    lanes: [...requirement.lanes],
    operations: requirement.operations ? [...requirement.operations] : undefined,
    terms: [...requirement.terms],
  }));
}

export const NONE_CONTRACT: LumiActionContract = {
  applies: false,
  kind: 'none',
  label: 'No external action contract',
  coreAction: '',
  preparationIsNotCompletion: [],
  requiredEvidence: [],
  preferredTools: [],
  verificationTools: [],
  preferredCapabilities: [],
  verificationCapabilities: [],
  nextStep: '',
  caution: '',
};

export function withDefaults(
  contract: Omit<LumiActionContract, 'applies' | 'preferredCapabilities' | 'verificationCapabilities'>,
): LumiActionContract {
  const preferredCapabilities = actionCapabilityRequirements(contract.kind);
  return {
    ...contract,
    applies: true,
    preparationIsNotCompletion: unique(contract.preparationIsNotCompletion),
    requiredEvidence: unique(contract.requiredEvidence),
    preferredTools: unique(contract.preferredTools),
    verificationTools: unique(contract.verificationTools),
    preferredCapabilities,
    verificationCapabilities: preferredCapabilities.map(requirement => ({
      ...requirement,
      lanes: [...requirement.lanes],
      operations: requirement.operations ? [...requirement.operations] : undefined,
      terms: [...requirement.terms],
    })),
  };
}
