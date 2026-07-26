import { ToolRegistry } from '../registry';
import { executeToolCallOrThrow } from '../execution_engine';
import { saveWorkflow, listWorkflows, getWorkflow, deleteWorkflow, captureRecentAsWorkflow } from '../../agents/workflows';
import { getRecentWorkflows } from '../../skills/worklog';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

function workflowScope(context?: any): { domain: 'personal' | 'work'; orgId: string } {
  if (context?.domain === 'work' && context?.orgId) {
    return { domain: 'work', orgId: String(context.orgId) };
  }
  return { domain: 'personal', orgId: '' };
}

async function handleSaveWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const description: string = args.description || '';
  const steps = args.steps || [];

  if (!name) throw new Error('Workflow name is required');
  if (!steps.length) throw new Error('At least one step is required');

  const wf = saveWorkflow(userId, name, description, steps, undefined, args.category, workflowScope(context));
  return JSON.stringify({ ok: true, status: 'saved', workflowId: wf.id, name: wf.name, stepCount: wf.steps.length }, null, 2);
}

async function handleListWorkflows(_args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const workflows = listWorkflows(userId, undefined, workflowScope(context));
  if (!workflows.length) return 'No saved workflows.';
  return workflows.map(w =>
    `- **${w.name}**: ${w.description || 'No description'} (${w.steps.length} steps, run ${w.runCount} times)`
  ).join('\n');
}

async function handleGetWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const wf = getWorkflow(userId, name, workflowScope(context));
  if (!wf) throw new Error(`Workflow "${name}" not found`);
  const steps = wf.steps.map((s, i) => `  ${i + 1}. ${s.description}`).join('\n');
  return `**${wf.name}** — ${wf.description}\n\nSteps:\n${steps}\n\nRun count: ${wf.runCount}`;
}

async function handleDeleteWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const ok = deleteWorkflow(userId, name, workflowScope(context));
  return JSON.stringify({ ok, status: ok ? 'deleted' : 'not_found', name }, null, 2);
}

async function handleCaptureRecentWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  if (!name) throw new Error('Workflow name is required. Ask the user what to call this workflow.');

  const scope = workflowScope(context);
  const recent = getRecentWorkflows(userId, scope.domain, scope.orgId);
  if (recent.length === 0) return 'No recent activity to capture. Try doing something first.';

  const last = recent[recent.length - 1];
  const toolTrace = last.toolSequence.map(s => ({
    name: s.name,
    args: s.args,
    resultSummary: s.resultSummary,
  }));

  const wf = captureRecentAsWorkflow(userId, name, toolTrace, scope);
  if (!wf) return 'No tool calls found in recent activity.';

  return `Workflow "${name}" captured with ${wf.steps.length} steps. You can now say "run ${name}" to execute it.`;
}

async function handleRunWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  if (!name) throw new Error('Workflow name is required');

  const wf = getWorkflow(userId, name, workflowScope(context));
  if (!wf) throw new Error(`Workflow "${name}" not found. Use list_workflows to see available workflows.`);

  const stepReceipts: Array<Record<string, unknown>> = [];

  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    if (!step.tool || !context?.toolRegistry) {
      return JSON.stringify({
        ok: false,
        status: 'blocked',
        workflowId: wf.id,
        name: wf.name,
        completedSteps: stepReceipts.length,
        totalSteps: wf.steps.length,
        failedStep: i + 1,
        blocker: !step.tool ? 'The workflow step has no executable capability.' : 'The tool registry is unavailable.',
        steps: stepReceipts,
      }, null, 2);
    }
    try {
      const result = await executeToolCallOrThrow({
        registry: context.toolRegistry,
        name: step.tool,
        arguments: step.args || {},
        context,
      });
      stepReceipts.push({ index: i + 1, capability: step.tool, status: 'completed', result });
    } catch (e: any) {
      return JSON.stringify({
        ok: false,
        status: 'failed',
        workflowId: wf.id,
        name: wf.name,
        completedSteps: stepReceipts.length,
        totalSteps: wf.steps.length,
        failedStep: i + 1,
        blocker: e.message,
        steps: [...stepReceipts, { index: i + 1, capability: step.tool, status: 'failed', error: e.message }],
      }, null, 2);
    }
  }

  return JSON.stringify({
    ok: true,
    status: 'completed',
    workflowId: wf.id,
    name: wf.name,
    completedSteps: stepReceipts.length,
    totalSteps: wf.steps.length,
    steps: stepReceipts,
  }, null, 2);
}

export function registerWorkflowTools(registry: ToolRegistry): void {
  registry.register({
    name: 'save_workflow',
    description: 'Save a named multi-step workflow that can be recalled and run later. Use this when the user says "remember this workflow" or wants to save a useful process pattern.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for this workflow (e.g., "morning routine")' },
        description: { type: 'string', description: 'Short description of what this workflow does' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              tool: { type: 'string' },
              args: { type: 'object' },
            },
          },
          description: 'Ordered list of workflow steps',
        },
        category: { type: 'string', description: 'Optional category for grouping' },
      },
      required: ['name', 'steps'],
    },
    handler: handleSaveWorkflow,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.definition.save', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'named workflow definition', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'workflowId', 'name', 'stepCount'],
        requiredValues: { ok: true, status: 'saved' }, successStatuses: ['saved'],
        successSignals: ['the workflow store returned a stable id and exact step count'],
        limitations: ['Saving does not execute or validate workflow steps.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.save', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'list_workflows',
    description: 'List all saved named workflows for the current user.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleListWorkflows,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'get_workflow',
    description: 'Get the full details of a saved workflow by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
      },
      required: ['name'],
    },
    handler: handleGetWorkflow,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'delete_workflow',
    description: 'Delete a saved workflow by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name to delete' },
      },
      required: ['name'],
    },
    handler: handleDeleteWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.definition.delete', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'named workflow definition', reversible: false }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'name'], requiredValues: { ok: true, status: 'deleted' },
        successStatuses: ['deleted'], successSignals: ['the workflow store acknowledged deletion'],
        limitations: ['Deleted workflow definitions are not automatically recoverable.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.delete', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'capture_recent_workflow',
    description: 'Capture the most recent tool execution as a named workflow. Use this when the user says "remember this", "记下这个流程", "保存这个流程", or wants to save what they just did as a reusable workflow.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A descriptive name for this workflow (e.g., "morning briefing", "daily report")' },
      },
      required: ['name'],
    },
    handler: handleCaptureRecentWorkflow,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'run_workflow',
    description: 'Execute a saved named workflow by name. Use this when the user says "run my X routine", "执行XX流程", "跑XX流程", or asks to execute a previously saved workflow.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the workflow to run' },
      },
      required: ['name'],
    },
    handler: handleRunWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.run', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'workflow run ledger', reversible: true },
        { type: 'external_state_change', scope: 'declared saved workflow step capabilities', reversible: false },
      ],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'workflowId', 'completedSteps', 'totalSteps', 'steps'],
        requiredValues: { ok: true, status: 'completed' }, successStatuses: ['completed'],
        successSignals: ['every declared step completed through the unified execution engine'],
        limitations: ['Each nested step still requires its own capability receipt and permission policy.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'workflow.execution.run', operation: 'mutate', subjectArgument: 'name',
      limitations: ['A failed nested step returns failed or blocked and never appends a false completion marker.'],
    }),
  });
}
