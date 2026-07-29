import type { Socket } from 'socket.io';
import type { ToolExecutionRecord } from '../tools/types';
import type { ToolContext } from '../tools/types';
import type { ToolRegistry } from '../tools/registry';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import { authorizeCapabilityPlanTool } from '../cognition/capability_execution_plan';
import { executeToolCall } from '../tools/execution_engine';
import { desktopAutomationWorkflow } from './bundled/desktop-automation/workflow_manifest';

export type SkillWorkflowDesktopRelay = (name: string, args?: Record<string, any>) => Promise<any>;
export type SkillWorkflowSpeak = (line: string) => number | Promise<number>;

export interface SkillWorkflowVoiceScope {
  domain: 'personal' | 'work';
  orgId: string;
}

export interface SkillWorkflowRunOptions {
  socket: Socket;
  userText: string;
  userId: string;
  desktopRelay: SkillWorkflowDesktopRelay;
  speak: SkillWorkflowSpeak;
  voiceScope: SkillWorkflowVoiceScope;
  isCancelled?: () => boolean;
}

export interface SkillWorkflowResult {
  responseText: string;
  toolCalls: ToolExecutionRecord[];
}

export interface SkillWorkflowMatchContext {
  targetIsLumi?: boolean;
}

export interface SkillWorkflowDescriptor {
  id: string;
  skillId: string;
  phase: string;
  source: string;
  logLabel: string;
  statusDetail: string;
  chatSpeech: { minMs: number; maxMs: number; msPerChar: number };
  fallbackText: string;
  /** Complete deterministic adapter surface. Semantic selection stays in the plan. */
  requiredTools: string[];
  match: (text: string, context?: SkillWorkflowMatchContext) => boolean;
  run: (options: SkillWorkflowRunOptions) => Promise<SkillWorkflowResult>;
}

export async function executeSkillWorkflowAdapter(input: {
  workflow: SkillWorkflowDescriptor;
  plan: CapabilityExecutionPlan;
  registry: ToolRegistry;
  context: ToolContext;
  options: SkillWorkflowRunOptions;
}): Promise<SkillWorkflowResult> {
  const workflowNode = input.plan.nodes.find(node => (
    node.type === 'skill'
    && node.executionRole === 'adapter'
    && node.capabilityId === `${input.workflow.skillId}/${input.workflow.id}`
  ));
  if (!workflowNode) {
    throw new Error(`Capability plan did not select workflow adapter ${input.workflow.skillId}/${input.workflow.id}.`);
  }
  const captured: ToolExecutionRecord[] = [];
  const desktopRelay: SkillWorkflowDesktopRelay = async (name, args = {}) => {
    if (!input.workflow.requiredTools.includes(name)) {
      throw new Error(`Workflow adapter attempted undeclared tool '${name}'.`);
    }
    const authorization = authorizeCapabilityPlanTool(input.plan, name);
    if (!authorization.allowed) throw new Error(authorization.reason);
    const record = await executeToolCall({
      registry: input.registry,
      name,
      arguments: args,
      context: input.context,
    });
    captured.push(record);
    if (record.error) throw new Error(record.error);
    return record.result;
  };
  const result = await input.workflow.run({ ...input.options, desktopRelay });
  return {
    ...result,
    // Canonical records contain registry policy, evidence and verification.
    toolCalls: captured,
  };
}

const SKILL_WORKFLOWS: SkillWorkflowDescriptor[] = [
  desktopAutomationWorkflow,
];

export function listSkillWorkflows(): SkillWorkflowDescriptor[] {
  return [...SKILL_WORKFLOWS];
}

export function matchSkillWorkflow(
  text: string,
  context: SkillWorkflowMatchContext = {},
): SkillWorkflowDescriptor | null {
  const normalized = String(text || '');
  if (!normalized.trim()) return null;
  return SKILL_WORKFLOWS.find(workflow => workflow.match(normalized, context)) || null;
}

export function estimateSkillWorkflowChatSpeechMs(workflow: SkillWorkflowDescriptor, line: string): number {
  return Math.min(
    workflow.chatSpeech.maxMs,
    Math.max(workflow.chatSpeech.minMs, line.length * workflow.chatSpeech.msPerChar),
  );
}
