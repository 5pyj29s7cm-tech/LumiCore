import { logger } from '../../logger';
import { isCanonicalToolExecutionRecord } from './execution_engine';
import type { ToolExecutionRecord } from './types';

/** Passive archival plus an awaitable barrier for the same canonical receipt. */
export function createToolReceiptObserver(write: (record: ToolExecutionRecord) => Promise<void>) {
  const writes = new WeakMap<ToolExecutionRecord, Promise<void>>();
  const persist = (record: ToolExecutionRecord): Promise<void> => {
    if (!isCanonicalToolExecutionRecord(record)) return Promise.resolve();
    let pending = writes.get(record);
    if (!pending) {
      pending = write(record);
      writes.set(record, pending);
      // A failed save may be retried, but concurrent callbacks share one write.
      void pending.catch(() => writes.delete(record));
    }
    return pending;
  };
  return {
    persist,
    onToolRecord(record: ToolExecutionRecord) {
      void persist(record).catch(error => logger.error('[ExecutionReceipt] Tool receipt persistence failed:', error));
    },
  };
}
