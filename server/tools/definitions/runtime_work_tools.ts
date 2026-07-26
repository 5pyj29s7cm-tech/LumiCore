import { cancelRuntimeWork, getRuntimeWorkSnapshot, type RuntimeWorkKind } from '../../runtime/work_control';
import { ToolRegistry } from '../registry';

function kindsFromArgs(value: unknown): RuntimeWorkKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((kind): kind is RuntimeWorkKind => (
    kind === 'delegation' || kind === 'autonomy' || kind === 'takeover'
  ));
}

export function registerRuntimeWorkTools(registry: ToolRegistry): void {
  registry.register({
    name: 'runtime_work_status',
    description: 'Read the real active Lumi work ledger across delegated background work, autonomous tasks, and work-takeover tasks. Use this for task progress, what Lumi is doing, or whether background work is still active. Do not substitute process lists or client health checks.',
    // i18n-allow: Chinese input-recognition vocabulary; not user-visible copy.
    routingHints: ['后台任务', '任务进度', '正在做什么', '还在执行吗', 'active work', 'task progress', 'background task status'],
    parameters: {
      type: 'object',
      properties: {
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['delegation', 'autonomy', 'takeover'] },
          description: 'Optional work-ledger categories. Omit to inspect all Lumi work.',
        },
      },
      required: [],
    },
    handler: async (args, context) => JSON.stringify(
      getRuntimeWorkSnapshot(context?.userId || 'anonymous', kindsFromArgs(args.kinds)),
      null,
      2,
    ),
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'runtime.work.status',
      operation: 'observe',
      assurance: 'verified',
      subjectArgument: 'kinds',
    },
  });

  registry.register({
    name: 'runtime_work_cancel',
    description: 'Cancel real active Lumi work in the unified runtime ledger. Use only when the user explicitly asks to stop, cancel, end, or abandon current/background work. The result distinguishes immediate cancellation from cancellation still in progress.',
    // i18n-allow: Chinese input-recognition vocabulary; not user-visible copy.
    routingHints: ['停止后台任务', '取消当前任务', '结束工作', '别做了', 'stop current task', 'cancel background work'],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional exact runtime task id. Omit to cancel all matching active work.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['delegation', 'autonomy', 'takeover'] },
          description: 'Optional work-ledger categories. Omit to cancel all Lumi work categories.',
        },
      },
      required: [],
    },
    handler: async (args, context) => JSON.stringify(cancelRuntimeWork({
      userId: context?.userId || 'anonymous',
      taskId: args.taskId ? String(args.taskId) : undefined,
      kinds: kindsFromArgs(args.kinds),
    }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'runtime.work.cancel',
      family: 'runtime_work',
      lane: 'agents',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'active Lumi task state', reversible: false }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'matchedCount', 'cancelledCount', 'cancellingCount'],
        requiredValues: { ok: true },
        successStatuses: ['idle', 'cancelled'],
        successSignals: ['no matching work remains active or every matched task is cancelled'],
        limitations: ['A cancelling receipt is only an accepted request and remains unverified until the task stops.'],
      },
    },
    evidence: {
      capability: 'runtime.work.cancel',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'kinds',
    },
  });
}
