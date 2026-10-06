import { expect, it } from 'vitest';
import { extendTurnBindings } from '../server/cognition/turn_bindings';

it('keeps one live cancellation and receipt owner across turn phases without reading accessors early', () => {
  let cancelled = false;
  let receipts: string[] = [];
  let reads = 0;
  const admission = { get cancelled() { reads++; return cancelled; } };
  const execution = extendTurnBindings(admission, {
    get receipts() { reads++; return receipts; },
    set receipts(value: string[]) { receipts = value; },
  });
  expect(execution).toBe(admission);
  expect(reads).toBe(0);
  cancelled = true;
  execution.receipts = ['late verified receipt'];
  expect(admission.cancelled).toBe(true);
  expect(execution.receipts).toEqual(['late verified receipt']);
  expect(receipts).toEqual(['late verified receipt']);
});
