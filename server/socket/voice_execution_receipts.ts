import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import { isCanonicalToolExecutionRecord } from '../tools/execution_engine';

type StartedCall = Parameters<NonNullable<ToolContext['onToolStart']>>[0];

/** One immutable request's evidence, independent of the mutable voice session. */
export function createVoiceExecutionReceiptCollector(requestId: string) {
  let taskId: string | undefined;
  const records = new Map<string, ToolExecutionRecord>();
  const pending = new Map<string, { call: StartedCall; promise: Promise<void>; resolve: () => void }>();
  const unresolved = new Map<string, StartedCall>();
  let cancellation: Promise<boolean> | undefined;
  let lateRecord: ((record: ToolExecutionRecord) => void) | undefined;
  const key = (call: { id?: string; name: string }) => call.id || call.name;
  const snapshot = () => {
    const unknown = new Map([...unresolved, ...[...pending].map(([id, entry]) => [id, entry.call] as const)]);
    return {
      settled: unknown.size === 0,
      records: [...records.values(), ...[...unknown.values()].map(call => ({
        id: call.id, name: call.name, arguments: call.arguments,
        taskId, requestId, turnId: requestId, result: '',
        error: 'The started tool has no settled canonical receipt; its outcome requires reconciliation.',
        terminalVerification: { status: 'unverified' as const, strategy: 'terminal_receipt' as const, reason: 'tool_settlement_unknown' },
      }))],
      pendingCount: unknown.size,
    };
  };
  return {
    requestId,
    bindTask(value: string | undefined) {
      if (taskId && value !== taskId) throw new Error('Voice receipt collector cannot change task ownership');
      taskId = value;
    },
    onToolStart(call: StartedCall) {
      if (pending.has(key(call))) return;
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      pending.set(key(call), { call, promise, resolve });
    },
    onToolRecord(record: ToolExecutionRecord) {
      if (!isCanonicalToolExecutionRecord(record) || record.requestId !== requestId
        || (taskId && record.taskId !== taskId)) return;
      records.set(key(record), record);
      unresolved.delete(key(record));
      lateRecord?.(record);
    },
    onToolFinished(call: { id?: string; name: string; recorded: boolean }) {
      const entry = pending.get(key(call));
      if (!entry) return;
      if (!call.recorded || !records.has(key(call))) unresolved.set(key(call), entry.call);
      pending.delete(key(call));
      entry.resolve();
    },
    snapshot,
    retainLateRecords(handler: (record: ToolExecutionRecord) => void) { lateRecord = handler; },
    async settle(timeoutMs = 5_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...pending.values()].map(entry => entry.promise)),
          new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      return snapshot();
    },
    get cancellation() { return cancellation; },
    cancelOnce(commit: () => Promise<boolean>): Promise<boolean> {
      if (cancellation) return cancellation;
      let resolve!: (value: boolean) => void;
      let reject!: (error: unknown) => void;
      cancellation = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; });
      void commit().then(resolve, reject);
      return cancellation;
    },
  };
}

export type VoiceExecutionReceiptCollector = ReturnType<typeof createVoiceExecutionReceiptCollector>;
