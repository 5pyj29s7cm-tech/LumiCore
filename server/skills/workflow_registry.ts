import { desktopAutomationWorkflow } from './bundled/desktop-automation/workflow_manifest';

export interface SkillWorkflowMatchContext {
  targetIsLumi?: boolean;
}

export interface SkillWorkflowDescriptor {
  id: string;
  skillId: string;
  /** Tool candidates only; execution stays in the shared model loop. */
  requiredTools: string[];
  match: (text: string, context?: SkillWorkflowMatchContext) => boolean;
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
