import type { Socket } from 'socket.io';
import type { ToolExecutionRecord } from '../tools/types';
import { cadDraftingWorkflow } from './bundled/cad-drafting/workflow_manifest';
import { desktopAutomationWorkflow } from './bundled/desktop-automation/workflow_manifest';
import { ecommerceOpsWorkflow } from './bundled/ecommerce-ops/workflow_manifest';
import { salesCustomerOpsWorkflow } from './bundled/sales-customer-ops/workflow_manifest';

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
  match: (text: string, context?: SkillWorkflowMatchContext) => boolean;
  run: (options: SkillWorkflowRunOptions) => Promise<SkillWorkflowResult>;
}

const SKILL_WORKFLOWS: SkillWorkflowDescriptor[] = [
  cadDraftingWorkflow,
  ecommerceOpsWorkflow,
  salesCustomerOpsWorkflow,
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
