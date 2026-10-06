import { readSettingRecord, writeSetting } from "../../persistence/settings_repository";
import { randomUUID } from "crypto";
import type { WorkflowRuntimeStore, WorkflowRun } from './contracts';
import { migrateStoredRun } from './migration';
import { WorkflowStateError, WorkflowRevisionConflictError } from './contracts';
import { nowIso, redactWorkflowValue, clone } from './values';

const WORKFLOW_RUNTIME_SETTING = 'lumi.workflow_runtime.v1';

export const WORKFLOW_RUNTIME_SCHEMA_VERSION = 1 as const;

export function loadStore(): WorkflowRuntimeStore {
  const row = readSettingRecord(WORKFLOW_RUNTIME_SETTING);
  if (!row?.value) return { schemaVersion: WORKFLOW_RUNTIME_SCHEMA_VERSION, definitions: [], runs: [] };
  try {
    const parsed = JSON.parse(row.value) as Partial<WorkflowRuntimeStore>;
    return {
      schemaVersion: WORKFLOW_RUNTIME_SCHEMA_VERSION,
      definitions: Array.isArray(parsed.definitions) ? parsed.definitions : [],
      runs: Array.isArray(parsed.runs)
        ? parsed.runs.map(run => migrateStoredRun(run as WorkflowRun))
        : [],
    };
  } catch (error) {
    throw new WorkflowStateError(`Workflow runtime store is unreadable and was left untouched: ${String((error as Error)?.message || error)}`);
  }
}

export function saveStore(store: WorkflowRuntimeStore): void {
  writeSetting(WORKFLOW_RUNTIME_SETTING, JSON.stringify(store));
}

function getMutableRun(store: WorkflowRuntimeStore, runId: string): WorkflowRun {
  const run = store.runs.find(item => item.runId === runId);
  if (!run) throw new WorkflowStateError(`Workflow run '${runId}' was not found.`);
  return run;
}

function assertRevision(run: WorkflowRun, expectedRevision: number): void {
  if (run.revision !== expectedRevision) throw new WorkflowRevisionConflictError(run.runId, expectedRevision, run.revision);
}

export function appendEvent(
  run: WorkflowRun,
  type: string,
  actor: string,
  detail?: Record<string, unknown>,
): void {
  run.events.push({
    sequence: run.events.length + 1,
    eventId: randomUUID(),
    type,
    at: nowIso(),
    actor,
    revision: run.revision,
    detail: detail ? redactWorkflowValue(detail, `events.${run.events.length + 1}`) as Record<string, unknown> : undefined,
  });
}

export function mutateRun(
  runId: string,
  expectedRevision: number,
  userId: string,
  actor: string,
  eventType: string,
  mutation: (run: WorkflowRun) => Record<string, unknown> | void,
): WorkflowRun {
  const store = loadStore();
  const run = getMutableRun(store, runId);
  if (run.userId !== userId) throw new WorkflowStateError(`Workflow run '${runId}' was not found for this user.`);
  assertRevision(run, expectedRevision);
  const detail = mutation(run);
  run.revision += 1;
  run.updatedAt = nowIso();
  appendEvent(run, eventType, actor, detail || undefined);
  saveStore(store);
  return clone(run);
}

export function resetWorkflowRuntimeForTest(): void {
  writeSetting(WORKFLOW_RUNTIME_SETTING, undefined);
}
