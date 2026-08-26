import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('socket sidecar idempotency integration', () => {
  for (const relativePath of ['server/socket/chat.ts', 'server/socket/task.ts']) {
    it(`${relativePath} durably fences cancel sidecars before queue cancellation`, () => {
      const code = source(relativePath);
      const durableBarrier = code.indexOf('await persistChatSidecarCancellationIntent(executionScope, requestId,');
      const cancelSideEffect = code.indexOf('.cancelRequest(', durableBarrier);

      expect(code).toContain('beginChatSidecarExecution(executionScope, requestId)');
      expect(durableBarrier).toBeGreaterThan(-1);
      expect(cancelSideEffect).toBeGreaterThan(durableBarrier);
      expect(code.slice(durableBarrier, cancelSideEffect)).toContain('catch');
      expect(code.slice(durableBarrier, cancelSideEffect)).toContain('getByRequestId(');
      expect(code.slice(durableBarrier, cancelSideEffect)).toContain('controlTargetRequestId');
    });

    it(`${relativePath} checks an exact request receipt before classifying a sidecar replay`, () => {
      const code = source(relativePath);
      const existingReceipt = code.indexOf('existingExecution = getChatExecution(executionScope, requestId)');
      const relation = Math.max(
        code.indexOf('classifyActiveTaskMessage', existingReceipt),
        code.indexOf('resolveActiveTaskMessageRelation', existingReceipt),
      );

      expect(existingReceipt).toBeGreaterThan(-1);
      expect(relation).toBeGreaterThan(existingReceipt);
      expect(code.slice(existingReceipt, relation)).toMatch(/if \(existingExecution\)[\s\S]*?return;/);
    });

    it(`${relativePath} registers queued requests before the executor waits`, () => {
      const code = source(relativePath);
      const queuedReceipt = code.indexOf('beginQueuedChatExecution(executionScope, requestId)');
      const queueReservation = code.indexOf('ExecutionQueue.reserve(', queuedReceipt);

      expect(queuedReceipt).toBeGreaterThan(-1);
      expect(queueReservation).toBeGreaterThan(queuedReceipt);
    });
  }
});
