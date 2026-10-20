import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolContext } from '../tools/types';

// Keep successful writes with the registry-owned attempt, never a workspace-wide
// before/after comparison. Workflow display history is not a source archive.
interface LegalExecutionWrites { cases: Map<string, Set<string>>; articles: Set<string>; }
const execution = new AsyncLocalStorage<{ context: ToolContext | undefined; writes: Map<string, LegalExecutionWrites> }>();
export function withLegalExecution<T>(context: ToolContext | undefined, work: () => T): T {
  return execution.run({ context, writes: new Map() }, work);
}
export function legalExecutionWrites(orgId: string, userId: string): LegalExecutionWrites {
  const writes = execution.getStore()?.writes;
  const key = JSON.stringify([orgId, userId]);
  let scope = writes?.get(key);
  if (!scope) { scope = { cases: new Map(), articles: new Set() }; writes?.set(key, scope); }
  return scope;
}
export function recordLegalCaseWrite(orgId: string, userId: string, caseId: string, materialIds: string[] = []): void {
  const cases = legalExecutionWrites(orgId, userId).cases;
  const materials = cases.get(caseId) || new Set<string>();
  for (const id of materialIds) materials.add(id);
  cases.set(caseId, materials);
}
export function recordLegalArticleWrite(orgId: string, userId: string, articleId: string): void {
  legalExecutionWrites(orgId, userId).articles.add(articleId);
}
export function legalExecutionSignal(): AbortSignal | undefined {
  return execution.getStore()?.context?.executionSignal;
}
export function legalExecutionContext(): ToolContext | undefined { return execution.getStore()?.context; }
export function assertLegalExecutionActive(context = legalExecutionContext()): void {
  context?.executionSignal?.throwIfAborted();
  if (context?.isCancelled?.()) throw new DOMException('Legal operation cancelled.', 'AbortError');
}
export function legalWrite<T>(write: () => T): T {
  assertLegalExecutionActive();
  return write();
}
