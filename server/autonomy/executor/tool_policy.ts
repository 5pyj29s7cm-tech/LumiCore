import { toolRegistry, type ToolRegistry } from "../../tools/registry";
import type { AutonomousTask } from "../task_queue";
import { buildLumiExecutionPipeline, type LumiExecutionPipeline, type BuildLumiExecutionPipelineInput } from "../../cognition/execution_pipeline";

/** Tight tool policy for autonomous background work — more conservative than user-initiated mode */
const AUTONOMOUS_POLICY = {
  allowedTools: ['*'],
  requireConfirmation: [],
  forbiddenTools: [
    'delete_file',
    'run_command',   // shell remains available but gated below
    'system_command',
  ],
  maxIterations: 50,
};

const LOCAL_BODY_LEARNING_TOOLS = [
  'desktop_system_info',
  'desktop_list_apps',
  'desktop_list_files',
  'desktop_path_info',
  'desktop_running_processes',
  'desktop_active_window',
  'get_active_window_info',
  'get_running_processes',
  'desktop_idle_time',
  'desktop_poll_activity',
  'adapter_registry_list',
  'work_product_plan',
  'work_product_verify',
];

const SELF_IMPROVEMENT_TASK_TOOLS = [
  'self_improvement_read_scope',
  'self_improvement_stage_patch',
  'self_improvement_replay_verified_stage',
];

function isSelfImprovementTask(task: Partial<Pick<AutonomousTask, 'idempotencyKey'>>): boolean {
  return /^self-improvement:improvement_[a-z0-9_-]+:\d+$/i.test(String(task.idempotencyKey || ''));
}

export function isLocalBodyLearningTask(task: Pick<AutonomousTask, 'title' | 'description'>): boolean {
  // i18n-allow: Existing bilingual local-body task input recognition.
  return /本机身体|local machine body|desktop body|local body|desktop_body_map|local_machine_awareness/i
    .test(`${task.title || ''}\n${task.description || ''}`);
}

export function buildAutonomousToolPolicy(
  task: Pick<AutonomousTask, 'title' | 'description'> & Partial<Pick<AutonomousTask, 'idempotencyKey' | 'executionPlan' | 'recovery' | 'domain' | 'orgId'>>,
  maxIterations: number,
) {
  const recoveryToolBoundary = task.recovery?.planRevisions?.length && task.executionPlan
    ? Array.from(new Set(task.executionPlan.nodes
        .map(node => node.toolName)
        .filter((name): name is string => Boolean(name))))
    : [];
  const narrowForRecovery = (policy: typeof AUTONOMOUS_POLICY) => {
    if (recoveryToolBoundary.length === 0) return policy;
    const permitted = policy.allowedTools.includes('*')
      ? recoveryToolBoundary
      : recoveryToolBoundary.filter(tool => policy.allowedTools.includes(tool));
    return { ...policy, allowedTools: permitted };
  };
  if (isSelfImprovementTask(task)) {
    // A prior diagnostic/read-only plan is not a complete self-improvement
    // capability boundary. Recovery must retain the dedicated stage tool or a
    // persisted read-only plan can deadlock the exact task forever.
    return {
      allowedTools: SELF_IMPROVEMENT_TASK_TOOLS,
      requireConfirmation: ['self_improvement_stage_patch'],
      forbiddenTools: AUTONOMOUS_POLICY.forbiddenTools,
      maxIterations: Math.min(maxIterations, 8),
    };
  }
  if (isLocalBodyLearningTask(task)) {
    return narrowForRecovery({
      allowedTools: LOCAL_BODY_LEARNING_TOOLS,
      requireConfirmation: [],
      forbiddenTools: AUTONOMOUS_POLICY.forbiddenTools,
      maxIterations: Math.min(maxIterations, 16),
    });
  }
  return narrowForRecovery({ ...AUTONOMOUS_POLICY, maxIterations });
}

export function autonomousTurnPlanningData(
  task: Pick<AutonomousTask, 'id' | 'userId' | 'description' | 'source' | 'title'>
    & Partial<Pick<AutonomousTask, 'idempotencyKey' | 'executionPlan' | 'recovery' | 'domain' | 'orgId'>>,
  maxIterations: number,
  registry: ToolRegistry = toolRegistry,
): BuildLumiExecutionPipelineInput {
  const policy = buildAutonomousToolPolicy(task, maxIterations);
  return {
    dispatch: {
      userId: task.userId, domain: task.domain, orgId: task.orgId,
      text: task.description || task.title,
      channel: task.source === 'scheduler' ? 'scheduler' : 'autonomy',
      source: `autonomous:${task.source}`,
      operationMode: 'autonomous',
      targetIsLumi: true,
      surface: 'work',
    },
    registry,
    personalityToolPolicy: policy,
    decisionText: task.description || task.title,
    traceText: task.description || task.title,
    source: `autonomous:${task.source}`,
    taskId: task.id,
  };
}

export function buildAutonomousCapabilityPipeline(
  task: Pick<AutonomousTask, 'id' | 'userId' | 'description' | 'source' | 'title'>
    & Partial<Pick<AutonomousTask, 'idempotencyKey' | 'executionPlan' | 'recovery' | 'domain' | 'orgId'>>,
  maxIterations: number,
  registry: ToolRegistry = toolRegistry,
  requestId?: string,
): LumiExecutionPipeline {
  return buildLumiExecutionPipeline({ ...autonomousTurnPlanningData(task, maxIterations, registry), requestId });
}
