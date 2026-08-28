import type { ToolPolicy } from '../personality/types';
import type { WorkTakeoverTurnSurface } from '../work_takeover/continuity';
import type { LumiExecutionDecision } from './execution_decision';
import {
  traceToolIntentDecision,
  type ToolIntentDecisionTrace,
} from './tool_intent';
import type { ToolRoute } from './tool_router';
import type { LumiTurnBoundary, LumiTurnDispatch } from './turn_dispatch';
import type {
  LumiExecutionGovernance,
  LumiTurnChannel,
} from './turn_flow';
import { normalizeActionIntent, type NormalizedActionIntent } from './normalized_action_intent';

export interface LumiIntentTraceRule {
  layer: string;
  name: string;
}

export interface LumiIntentTraceToolPolicy {
  allowedTools: string[];
  forbiddenTools: string[];
  requireConfirmation: string[];
  maxIterations: number;
}

export interface LumiIntentTraceToolRoute {
  categories: string[];
  reasons: string[];
  toolNames: string[];
  totalAvailable: number;
  maxTools: number;
  truncated: boolean;
  unavailableMcpServers: string[];
}

export interface LumiIntentTrace {
  version: 1;
  source: string;
  channel: LumiTurnChannel;
  surface: WorkTakeoverTurnSurface;
  boundary: LumiTurnBoundary;
  operationMode: string;
  effectiveOperationMode: string;
  toolGate: 'available' | 'chat_only';
  allowed: boolean;
  summary: string;
  input: {
    text: string;
    routeText: string;
  };
  normalizedActionIntent: NormalizedActionIntent;
  matched: {
    informationOnlyQuestion: boolean;
    diagnosticOrRepair: boolean;
    explicitToolIntent: boolean;
    clientActionIntent: boolean;
    clientActionOnlyIntent: boolean;
    visionIntent: boolean;
    autonomousTask: boolean;
    clientActionOnlyTurn: boolean;
    selfRepairTurn: boolean;
    autoPromoteToAssistant: boolean;
    workTakeover: boolean;
    specialWorkflow: string | null;
    completionEvidenceNeeded: boolean;
  };
  matchedRules: LumiIntentTraceRule[];
  blockedBy: string[];
  reasons: string[];
  toolIntent: ToolIntentDecisionTrace;
  toolPolicy: LumiIntentTraceToolPolicy;
  toolRoute: LumiIntentTraceToolRoute | null;
  governance: LumiExecutionGovernance;
}

export interface BuildLumiIntentTraceInput {
  dispatch: LumiTurnDispatch;
  execution: LumiExecutionDecision;
  text: string;
  source?: string;
}

function compactPolicy(policy: ToolPolicy): LumiIntentTraceToolPolicy {
  return {
    allowedTools: [...(policy.allowedTools || [])],
    forbiddenTools: [...(policy.forbiddenTools || [])],
    requireConfirmation: [...(policy.requireConfirmation || [])],
    maxIterations: policy.maxIterations || 0,
  };
}

function compactRoute(route: ToolRoute | null): LumiIntentTraceToolRoute | null {
  if (!route) return null;
  return {
    categories: [...route.categories],
    reasons: [...route.reasons],
    toolNames: [...route.toolNames],
    totalAvailable: route.totalAvailable,
    maxTools: route.maxTools,
    truncated: route.truncated,
    unavailableMcpServers: [...(route.unavailableMcpServers || [])],
  };
}

function uniqueRules(rules: LumiIntentTraceRule[]): LumiIntentTraceRule[] {
  const seen = new Set<string>();
  const out: LumiIntentTraceRule[] = [];
  for (const rule of rules) {
    const key = `${rule.layer}:${rule.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildReasons(input: {
  dispatch: LumiTurnDispatch;
  execution: LumiExecutionDecision;
  toolIntent: ToolIntentDecisionTrace;
}): string[] {
  const { dispatch, execution, toolIntent } = input;
  const flow = dispatch.flow;
  const reasons = [
    `boundary:${dispatch.boundary}`,
    execution.allowToolUse ? 'tool gate:available' : 'tool gate:chat-only',
    toolIntent.decisionReason,
  ];

  if (!flow.allowToolUseForTurn) reasons.push('turn flow did not detect an action signal');
  if (flow.clientActionOnlyTurn) reasons.push('client action turn is restricted to client_get_state/client_action');
  if (flow.selfRepairTurn) reasons.push('self-repair turn should inspect, repair once when safe, then verify');
  if (flow.autoPromoteToAssistant) reasons.push('work wording requested assistant execution');
  if (flow.workTakeover.shouldResumeTask) reasons.push('active work takeover context is being resumed');
  if (flow.specialWorkflow) reasons.push(`skill workflow matched:${flow.specialWorkflow.id}`);
  if (flow.completionEvidenceNeeded) reasons.push('completion evidence is needed before claiming done');
  if (flow.executionGovernance.verificationIntent !== 'none') {
    reasons.push(`verification:${flow.executionGovernance.verificationIntent}`);
  }
  if (flow.executionGovernance.capabilityLearningIntent !== 'none') {
    reasons.push(`capability:${flow.executionGovernance.capabilityLearningIntent}`);
  }
  for (const blocked of toolIntent.blockedBy) reasons.push(`blocked:${blocked}`);
  for (const reason of execution.toolRoute?.reasons || []) reasons.push(reason);

  return unique(reasons);
}

export function buildLumiIntentTrace(input: BuildLumiIntentTraceInput): LumiIntentTrace {
  const { dispatch, execution } = input;
  const flow = dispatch.flow;
  const source = input.source || dispatch.source || dispatch.channel;
  const text = input.text || '';
  const normalizedActionIntent = normalizeActionIntent(text);
  const toolIntent = traceToolIntentDecision(text, source, flow.effectiveOperationMode);
  const toolRoute = compactRoute(execution.toolRoute);
  const routeSummary = toolRoute
    ? `${toolRoute.toolNames.length}/${toolRoute.totalAvailable}:${toolRoute.categories.join(',') || 'fallback'}`
    : 'none';
  const summary = [
    `boundary=${dispatch.boundary}`,
    `tools=${execution.allowToolUse ? 'available' : 'chat-only'}`,
    `route=${routeSummary}`,
  ].join(' ');

  const matchedRules = uniqueRules([
    ...toolIntent.matchedRules,
    { layer: 'boundary', name: `boundary:${dispatch.boundary}` },
    { layer: 'tool_gate', name: execution.allowToolUse ? 'tool-gate:available' : 'tool-gate:chat-only' },
    flow.clientActionOnlyTurn ? { layer: 'turn_flow', name: 'client-action-only-turn' } : null,
    flow.selfRepairTurn ? { layer: 'turn_flow', name: 'self-repair-turn' } : null,
    flow.workTakeover.shouldResumeTask ? { layer: 'turn_flow', name: 'work-takeover-resume' } : null,
    flow.specialWorkflow ? { layer: 'turn_flow', name: `skill-workflow:${flow.specialWorkflow.id}` } : null,
    toolRoute ? { layer: 'tool_route', name: `categories:${toolRoute.categories.join(',') || 'fallback'}` } : null,
  ].filter(Boolean) as LumiIntentTraceRule[]);

  return {
    version: 1,
    source,
    channel: dispatch.channel,
    surface: dispatch.surface,
    boundary: dispatch.boundary,
    operationMode: flow.operationMode,
    effectiveOperationMode: flow.effectiveOperationMode,
    toolGate: execution.allowToolUse ? 'available' : 'chat_only',
    allowed: execution.allowToolUse,
    summary,
    input: {
      text,
      routeText: flow.routeText || text,
    },
    normalizedActionIntent,
    matched: {
      informationOnlyQuestion: toolIntent.signals.informationOnlyQuestion,
      diagnosticOrRepair: toolIntent.signals.diagnosticOrRepair,
      explicitToolIntent: toolIntent.signals.explicitToolIntent,
      clientActionIntent: toolIntent.signals.clientActionIntent,
      clientActionOnlyIntent: toolIntent.signals.clientActionOnlyIntent,
      visionIntent: toolIntent.signals.visionIntent,
      autonomousTask: toolIntent.signals.autonomousTask,
      clientActionOnlyTurn: flow.clientActionOnlyTurn,
      selfRepairTurn: flow.selfRepairTurn,
      autoPromoteToAssistant: flow.autoPromoteToAssistant,
      workTakeover: flow.workTakeover.shouldResumeTask,
      specialWorkflow: flow.specialWorkflow?.id || null,
      completionEvidenceNeeded: flow.completionEvidenceNeeded,
    },
    matchedRules,
    // Legacy intent classifiers may still report advisory blockers. Once the
    // hard execution decision exposes a manifest, do not mislabel those
    // semantic hints as authorization denials in telemetry.
    blockedBy: execution.allowToolUse ? [] : [...toolIntent.blockedBy],
    reasons: buildReasons({ dispatch, execution, toolIntent }),
    toolIntent,
    toolPolicy: compactPolicy(execution.toolPolicy),
    toolRoute,
    governance: flow.executionGovernance,
  };
}
