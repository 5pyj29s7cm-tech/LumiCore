import type { IncomingMessage } from "../../../../messaging/types";
import { getBinding } from "../../../../messaging/bindings";
import { getMember } from "../../../../org/db";
import type { TurnResolution } from "../../../../cognition/turn_resolution";
import type { OperationMode } from "../../../../cognition/operation_modes";
import type { ToolPolicy } from "../../../../personality/types";
import type { PendingAssistantOfferContext } from "../../../../cognition/pending_assistant_offer";
import { buildLumiExecutionPipeline, type LumiExecutionPipeline, type BuildLumiExecutionPipelineInput } from "../../../../cognition/execution_pipeline";
import { toolRegistry } from "../../../../tools/registry";

export function resolveMentionedOrganizationMembers(message: IncomingMessage, orgId: string): string[] {
  if (message.chatType !== 'group' || !orgId) return [];
  if (!['feishu', 'wecom', 'wechat'].includes(message.platform)) return [];
  const platform = message.platform as 'feishu' | 'wecom' | 'wechat';
  const members = (message.mentionedUserIds || []).flatMap(platformUserId => {
    if (!platformUserId || platformUserId === message.userId) return [];
    const binding = getBinding(platform, platformUserId, message.chatId, 'group');
    if (!binding || binding.orgId !== orgId) return [];
    const membership = getMember(orgId, binding.lumiUserId);
    if (!membership || membership.status !== 'active' || membership.role === 'viewer') return [];
    return [binding.lumiUserId];
  });
  return Array.from(new Set(members));
}

const ORGANIZATION_VIEWER_WRITE_TOOLS = [
  'legal_case_workspace',
  'legal_message_intake_to_case',
  'legal_meeting_minutes_to_case',
  'legal_import_materials_to_kb',
  'legal_import_judgment',
  'wechat_send_file',
  'feishu_send_file',
];

export interface RemoteLumiExecutionPlanInput {
  requestId?: string;
  userText?: string;
  acceptedResolution?: TurnResolution;
  serverBoundCapability?: BuildLumiExecutionPipelineInput['serverBoundCapability'];
  userId: string;
  text: string;
  source: string;
  domain: 'personal' | 'work';
  orgId: string;
  operationMode: OperationMode;
  identityBound: boolean;
  canWriteOrganization: boolean;
  personalityToolPolicy?: ToolPolicy;
  actionTaskState?: import("../../../../cognition/action_continuation").ConversationActionContinuationState | null;
  taskId?: string;
  pendingAssistantOfferContext?: PendingAssistantOfferContext;
}

export function remoteTurnPlanningData(input: RemoteLumiExecutionPlanInput): BuildLumiExecutionPipelineInput {
  return {
    requestId:input.requestId, userText:input.userText, acceptedResolution:input.acceptedResolution,
    serverBoundCapability: input.serverBoundCapability,
    dispatch: {
      userId: input.userId,
      text: input.text,
      channel: 'chat',
      source: input.source,
      category: input.domain === 'work' ? 'organization' : undefined,
      domain: input.domain,
      orgId: input.orgId,
      operationMode: input.operationMode,
      targetIsLumi: true,
    },
    unboundRemoteSender: !input.identityBound,
    registry: toolRegistry,
    personalityToolPolicy: input.personalityToolPolicy,
    actionTaskState: input.actionTaskState,
    pendingAssistantOfferContext: input.pendingAssistantOfferContext,
    isSanctuary: !input.identityBound,
    additionalForbiddenTools: input.domain === 'work' && !input.canWriteOrganization
      ? ORGANIZATION_VIEWER_WRITE_TOOLS
      : undefined,
    decisionText: input.text,
    traceText: input.text,
    source: input.source,
    taskId: input.taskId,
  };
}

export function buildRemoteLumiExecutionPlan(input: RemoteLumiExecutionPlanInput): LumiExecutionPipeline {
  return buildLumiExecutionPipeline(remoteTurnPlanningData(input));
}
