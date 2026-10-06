import {
  buildLumiTurnFlow,
  resolveTurnSurface,
  type LumiTurnChannel,
  type LumiTurnFlow,
  type LumiTurnFlowInput,
} from './turn_flow';
import type { WorkTakeoverTurnSurface } from '../work_takeover/continuity';

export type LumiTurnBoundary =
  | 'conversation'
  | 'client_action'
  | 'self_repair'
  | 'work_takeover'
  | 'task_center'
  | 'tool_action';

export interface LumiTurnDispatchInput extends LumiTurnFlowInput {
  channel: LumiTurnChannel;
}

export interface LumiTurnDispatch {
  channel: LumiTurnChannel;
  source: string;
  surface: WorkTakeoverTurnSurface;
  boundary: LumiTurnBoundary;
  flow: LumiTurnFlow;
  promptOverlay: string;
}

function classifyBoundary(flow: LumiTurnFlow): LumiTurnBoundary {
  if (flow.channel === 'task' || flow.channel === 'scheduler' || flow.channel === 'autonomy') return 'task_center';
  if (flow.conceptualCapabilityQuestion) return 'conversation';
  if (flow.clientActionOnlyTurn) return 'client_action';
  if (flow.selfRepairTurn) return 'self_repair';
  if (flow.workTakeover.shouldResumeTask) return 'work_takeover';
  if (flow.allowToolUseForTurn) return 'tool_action';
  return 'conversation';
}

function boundaryRule(boundary: LumiTurnBoundary): string {
  switch (boundary) {
    case 'client_action':
      return 'This turn only changes or inspects Lumi client state. Keep it on the client surface and do not drift into external tools.';
    case 'self_repair':
      return 'This turn is about Lumi fixing or inspecting itself. Inspect state first, make one safe recovery when possible, then verify.';
    case 'work_takeover':
      return 'This turn continues an existing task. Bind follow-ups to the task center, preserve blockers/artifacts, and verify before claiming completion.';
    case 'task_center':
      return 'This turn entered through the task center. Treat it as persistent work with state, artifacts, blockers, and a concise user-facing result.';
    case 'tool_action':
      return 'This turn asks for action. Choose the lightest fitting tool/skill/desktop path and keep Lumi as the single owner of the result.';
    case 'conversation':
    default:
      return 'This turn is conversation-first. Answer naturally and do not force tools or task continuation without a clear action signal.';
  }
}

function buildDispatchOverlay(dispatch: Omit<LumiTurnDispatch, 'promptOverlay'>): string {
  return [
    '## Lumi Unified Turn Dispatch',
    `Entry channel: ${dispatch.channel}. Source: ${dispatch.source || dispatch.channel}. Surface: ${dispatch.surface}. Boundary: ${dispatch.boundary}.`,
    'Chat, voice, task center, scheduler, and autonomy are entrances into the same Lumi. Do not fork personality, memory, or task ownership by channel.',
    dispatch.source === 'command-center-chat'
      ? 'The user is already using Lumi\'s integrated command-center text panel. It is the only text entry; do not redirect them to another chat screen or back to the command center.'
      : '',
    boundaryRule(dispatch.boundary),
    'If the user switches from work to casual talk, follow the newest wording. If they resume work, bind it through the same task/capability graph.',
  ].filter(Boolean).join('\n');
}

export function buildLumiTurnDispatch(input: LumiTurnDispatchInput): LumiTurnDispatch {
  const surface = resolveTurnSurface({
    channel: input.channel,
    source: input.source,
    category: input.category,
    domain: input.domain,
    explicitSurface: input.surface,
  });
  const flow = buildLumiTurnFlow({ ...input, surface });
  const dispatchWithoutPrompt: Omit<LumiTurnDispatch, 'promptOverlay'> = {
    channel: input.channel,
    source: input.source || input.channel,
    surface,
    boundary: classifyBoundary(flow),
    flow,
  };

  return {
    ...dispatchWithoutPrompt,
    promptOverlay: buildDispatchOverlay(dispatchWithoutPrompt),
  };
}

export function restrictLumiDispatchToUnboundConversation(dispatch: LumiTurnDispatch): LumiTurnDispatch {
  const flow = {
    ...dispatch.flow,
    operationMode: 'chat' as const,
    effectiveOperationMode: 'chat' as const,
    requestedMode: null,
    autoPromoteToAssistant: false,
    allowToolUseForTurn: false,
    selfRepairTurn: false,
    clientActionOnlyTurn: false,
    promptOverlay: [
      '## Lumi Turn Flow',
      'Channel: chat. Surface: chat. Mode: chat -> chat. Tool access: chat-only.',
      'This remote sender is not identity-bound. Keep the turn conversational and do not expose private, local, organization, client, or desktop tools.',
    ].join('\n'),
  };
  return {
    ...dispatch,
    boundary: 'conversation',
    flow,
    promptOverlay: [
      '## Lumi Unified Turn Dispatch',
      `Entry channel: chat. Source: ${dispatch.source}. Surface: chat. Boundary: conversation.`,
      'Identity boundary: this sender is not bound to a Lumi user, so this turn cannot control or inspect a private Lumi client.',
    ].join('\n'),
  };
}
