import {
  createLumiSceneSnapshot,
  diffLumiSceneSnapshots,
  type LumiSceneNode,
  type LumiScenePatch,
  type LumiSceneSnapshot,
} from '../../shared/lumi_scene';
import { buildStructuredRuntimeStatus, type StructuredRuntimeStatus } from '../monitor/runtime_status';

export type RuntimeSceneSyncPayload =
  | { kind: 'snapshot'; snapshot: LumiSceneSnapshot }
  | { kind: 'patch'; patch: LumiScenePatch }
  | { kind: 'noop'; sceneId: string; revision: number; digest: string };

const SCENE_ID = 'runtime-status';
const sceneStore = new Map<string, LumiSceneSnapshot>();

function scopeKey(userId: string, domain: 'personal' | 'work', orgId: string): string {
  return domain === 'work' ? `${userId}:org:${orgId}:${SCENE_ID}` : `${userId}:personal:${SCENE_ID}`;
}

function statusTone(level: StructuredRuntimeStatus['level']): LumiSceneNode['tone'] {
  return level === 'attention' ? 'warning' : level === 'working' ? 'info' : 'success';
}

function sceneNodeId(prefix: string, value: unknown): string {
  const safe = String(value || '')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .replace(/^[_:.-]+/, '')
    .slice(0, 80);
  return `${prefix}.${safe || 'unknown'}`;
}

export function buildRuntimeSceneNodes(status: StructuredRuntimeStatus): LumiSceneNode[] {
  return [
    {
      id: 'runtime.overall',
      kind: 'status',
      title: 'runtime.overall',
      value: status.level,
      detail: status.attentionReasons.join(', '),
      tone: statusTone(status.level),
    },
    {
      id: 'runtime.metrics',
      kind: 'group',
      title: 'runtime.metrics',
      children: [
        { id: 'runtime.metric.active', kind: 'metric', title: 'runtime.active', value: status.counts.activeTasks, tone: 'info' },
        { id: 'runtime.metric.waiting', kind: 'metric', title: 'runtime.waiting', value: status.counts.waitingConfirmation, tone: status.counts.waitingConfirmation ? 'warning' : 'neutral' },
        { id: 'runtime.metric.blocked', kind: 'metric', title: 'runtime.blocked', value: status.counts.blockedTasks + status.counts.durableBlocked, tone: status.counts.blockedTasks + status.counts.durableBlocked ? 'danger' : 'neutral' },
        { id: 'runtime.metric.verified', kind: 'metric', title: 'runtime.verified', value: status.counts.verifiedReceipts, tone: 'success' },
        { id: 'runtime.metric.autonomous', kind: 'metric', title: 'runtime.autonomous', value: status.counts.autonomousActive, tone: 'info' },
      ],
    },
    {
      id: 'runtime.tasks',
      kind: 'group',
      title: 'runtime.tasks',
      children: status.tasks.slice(0, 6).map(task => ({
        id: sceneNodeId('task', task.taskId),
        kind: 'task',
        title: task.goal,
        value: task.status,
        detail: task.blocker || task.focus.waitingFor || task.focus.nextAction || task.target,
        tone: task.status === 'blocked'
          ? 'danger'
          : task.status === 'waiting_confirmation'
            ? 'warning'
            : task.status === 'completed'
              ? 'success'
              : 'info',
        children: task.evidence.latest.slice(0, 3).map(receipt => ({
          id: sceneNodeId('receipt', receipt.receiptId),
          kind: 'evidence',
          title: receipt.toolName,
          value: receipt.outcome,
          detail: receipt.targetIdentity,
          tone: receipt.outcome === 'verified_success'
            ? 'success'
            : receipt.outcome === 'waiting_confirmation'
              ? 'warning'
              : 'danger',
        })),
      })),
    },
    {
      id: 'runtime.safety',
      kind: 'group',
      title: 'runtime.safety',
      tone: 'success',
      children: [
        { id: 'runtime.safety.confirmation', kind: 'text', title: 'runtime.safety.external_confirmation', value: status.safety.externalCommitConfirmationRequired, tone: 'success' },
        { id: 'runtime.safety.unknown', kind: 'text', title: 'runtime.safety.unknown_replay', value: status.safety.unknownExternalOutcomeReplayBlocked, tone: 'success' },
        { id: 'runtime.safety.payloads', kind: 'text', title: 'runtime.safety.payloads_excluded', value: status.safety.payloadsExcluded, tone: 'success' },
      ],
    },
  ];
}

function currentSnapshot(
  db: any,
  input: { userId: string; domain: 'personal' | 'work'; orgId?: string; now?: string },
): { key: string; previous?: LumiSceneSnapshot; snapshot: LumiSceneSnapshot; changed: boolean } {
  const orgId = input.domain === 'work' ? String(input.orgId || '') : '';
  const key = scopeKey(input.userId, input.domain, orgId);
  const previous = sceneStore.get(key);
  const runtime = buildStructuredRuntimeStatus(db, {
    userId: input.userId,
    domain: input.domain,
    orgId,
    now: input.now,
  });
  const nodes = buildRuntimeSceneNodes(runtime);
  const candidate = createLumiSceneSnapshot({
    sceneId: SCENE_ID,
    revision: previous ? previous.revision + 1 : 1,
    nodes,
    generatedAt: input.now,
  });
  if (previous?.digest === candidate.digest) return { key, previous, snapshot: previous, changed: false };
  const snapshot = candidate;
  sceneStore.set(key, snapshot);
  return { key, previous, snapshot, changed: true };
}

export function syncRuntimeScene(
  db: any,
  input: {
    userId: string;
    domain: 'personal' | 'work';
    orgId?: string;
    currentRevision?: number;
    currentDigest?: string;
    forceSnapshot?: boolean;
    now?: string;
  },
): RuntimeSceneSyncPayload {
  const state = currentSnapshot(db, input);
  if (input.forceSnapshot || !state.previous) return { kind: 'snapshot', snapshot: state.snapshot };
  if (!state.changed && Number(input.currentRevision) === state.snapshot.revision && input.currentDigest === state.snapshot.digest) {
    return { kind: 'noop', sceneId: state.snapshot.sceneId, revision: state.snapshot.revision, digest: state.snapshot.digest };
  }
  if (
    state.changed
    && Number(input.currentRevision) === state.previous.revision
    && (!input.currentDigest || input.currentDigest === state.previous.digest)
  ) {
    return { kind: 'patch', patch: diffLumiSceneSnapshots(state.previous, state.snapshot) };
  }
  return { kind: 'snapshot', snapshot: state.snapshot };
}

export function resetRuntimeSceneStoreForTests(): void {
  sceneStore.clear();
}
