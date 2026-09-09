import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolContext } from '../tools/types';

// Propagate the registry-owned attempt through nested legal helpers. This does
// not mint another execution owner, task state, or cancellation policy.
const execution = new AsyncLocalStorage<ToolContext | undefined>();
export function withLegalExecution<T>(context: ToolContext | undefined, work: () => T): T {
  return execution.run(context, work);
}
export function legalExecutionSignal(): AbortSignal | undefined {
  return execution.getStore()?.executionSignal;
}
export function legalExecutionContext(): ToolContext | undefined { return execution.getStore(); }
export function assertLegalExecutionActive(context = execution.getStore()): void {
  context?.executionSignal?.throwIfAborted();
  if (context?.isCancelled?.()) throw new DOMException('Legal operation cancelled.', 'AbortError');
}
export function legalWrite<T>(write: () => T): T {
  assertLegalExecutionActive();
  return write();
}
