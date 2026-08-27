import {
  cancelRuntimeWork,
  getRuntimeWorkSnapshot,
  pauseRuntimeWork,
  resumeRuntimeWork,
  type RuntimeWorkKind,
  type RuntimeWorkScope,
} from '../../runtime/work_control';
import { ToolRegistry } from '../registry';

function kindsFromArgs(value: unknown): RuntimeWorkKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((kind): kind is RuntimeWorkKind => (
    kind === 'delegation' || kind === 'autonomy' || kind === 'takeover'
  ));
}

function taskIdsFromArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(new Set(value
    .map(item => String(item || '').trim().slice(0, 180))
    .filter(Boolean)))
    .slice(0, 64);
}

function scopeFromContext(context: { domain?: string; orgId?: string } | undefined): RuntimeWorkScope {
  if (context?.domain === 'work') {
    const orgId = String(context.orgId || '').trim();
    return orgId ? { domain: 'work', orgId } : { domain: 'work' };
  }
  return { domain: 'personal' };
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
      getRuntimeWorkSnapshot(
        context?.userId || 'anonymous',
        kindsFromArgs(args.kinds),
        scopeFromContext(context),
      ),
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
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional immutable batch of exact runtime task ids. An empty array cancels nothing; it never means all work.',
        },
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
      taskIds: taskIdsFromArgs(args.taskIds),
      kinds: kindsFromArgs(args.kinds),
      scope: scopeFromContext(context),
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

  registry.register({
    name: 'runtime_work_pause',
    description: 'Pause checkpoint-capable delegated or autonomous Lumi work without discarding its task identity, execution checkpoint, or receipts. Use only when the user explicitly asks to pause or temporarily suspend work.',
    // i18n-allow: Chinese input-recognition vocabulary; not user-visible copy.
    routingHints: ['\u6682\u505c\u540e\u53f0\u4efb\u52a1', '\u5148\u505c\u4e00\u4e0b', 'pause background work', 'suspend current task'],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional exact runtime task id. Omit to pause all matching checkpoint-capable work.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['delegation', 'autonomy'] } },
      },
      required: [],
    },
    handler: async (args, context) => JSON.stringify(pauseRuntimeWork({
      userId: context?.userId || 'anonymous',
      taskId: args.taskId ? String(args.taskId) : undefined,
      kinds: kindsFromArgs(args.kinds),
      scope: scopeFromContext(context),
    }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'runtime.work.pause',
      family: 'runtime_work',
      lane: 'agents',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'active Lumi task state', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'matchedCount', 'pausedCount', 'pausingCount'],
        requiredValues: { ok: true },
        successStatuses: ['idle', 'paused'],
        successSignals: ['matched work is paused or no matching active work exists'],
        limitations: ['A pausing receipt is provisional until the active executor reaches a checkpoint and acknowledges pause.'],
      },
    },
    evidence: {
      capability: 'runtime.work.pause',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'taskId',
    },
  });

  registry.register({
    name: 'runtime_work_resume',
    description: 'Resume paused delegated or autonomous Lumi work from its durable checkpoint and existing receipt ledger. Use only when the user explicitly asks to continue paused work.',
    // i18n-allow: Chinese input-recognition vocabulary; not user-visible copy.
    routingHints: ['\u7ee7\u7eed\u540e\u53f0\u4efb\u52a1', '\u6062\u590d\u4efb\u52a1', 'resume background work', 'continue paused task'],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional exact runtime task id. Omit to resume all matching paused work.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['delegation', 'autonomy'] } },
      },
      required: [],
    },
    handler: async (args, context) => JSON.stringify(resumeRuntimeWork({
      userId: context?.userId || 'anonymous',
      taskId: args.taskId ? String(args.taskId) : undefined,
      kinds: kindsFromArgs(args.kinds),
      scope: scopeFromContext(context),
    }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'runtime.work.resume',
      family: 'runtime_work',
      lane: 'agents',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'paused Lumi task state', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'matchedCount', 'resumedCount'],
        requiredValues: { ok: true },
        successStatuses: ['idle', 'resumed'],
        successSignals: ['matched paused work is queued for durable execution'],
        limitations: ['Resumed means queued from the retained checkpoint; completion still requires a later verified task receipt.'],
      },
    },
    evidence: {
      capability: 'runtime.work.resume',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'taskId',
    },
  });
}
