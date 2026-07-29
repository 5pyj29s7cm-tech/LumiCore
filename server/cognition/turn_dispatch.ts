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
  | 'skill_workflow'
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
  if (flow.channel === 'task' || flow.channel === 'scheduler' || flow.channel === 'agent') return 'task_center';
  if (flow.clientActionOnlyTurn) return 'client_action';
  if (flow.selfRepairTurn) return 'self_repair';
  if (flow.specialWorkflow) return 'skill_workflow';
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
    case 'skill_workflow':
      return 'This turn may use a learned skill workflow. Parameterize it from the user wording; do not behave like a fixed demo script.';
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
    'Chat, voice, task center, scheduler, and agent execution are entrances into the same Lumi. Do not fork personality, memory, or task ownership by channel.',
    boundaryRule(dispatch.boundary),
    'If the user switches from work to casual talk, follow the newest wording. If they resume work, bind it through the same task/capability graph.',
  ].join('\n');
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
