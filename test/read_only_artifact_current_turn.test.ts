import './helpers';
import { describe, expect, it } from 'vitest';
import { buildActionEvidenceContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import type { ToolExecutionRecord } from '../server/tools/types';
const taskText = 'Read D:/case-source/A.md and show its complete contents.';
const scope = { taskId: 'current-read-task', requestId: 'current-read-request' };
const read = (overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({ ...scope, name: 'read_file', arguments: { path: 'D:/case-source/A.md' }, result: 'Complete existing source body.\nSOURCE_END', adapterStarted: true, terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Offline existing read-evidence scope test.' }, ...overrides });
const core = (rows: ToolExecutionRecord[], current?: { taskId?: string; requestId?: string }) => hasCoreActionEvidence(buildActionEvidenceContract(taskText), rows, taskText, undefined, current);
describe('existing artifact read evidence keeps the current turn scope', () => {
 it('accepts the complete verified current source', () => { expect(core([read()], scope)).toBe(true); });
 it.each([{ taskId: 'foreign-task', requestId: scope.requestId }, { taskId: scope.taskId, requestId: 'foreign-request' }])('rejects a restored receipt from a different turn %j', foreign => {
  expect(core([read()], scope)).toBe(true);
  expect(core([read(foreign)], scope)).toBe(false);
 });
 it('accepts the current receipt among restored foreign receipts', () => {
  expect(core([read({ requestId: 'foreign-request' }), read()], scope)).toBe(true);
 });
 it('keeps the established compatibility when no current scope is supplied', () => { expect(core([read()])).toBe(true); });
 it('does not let scope filtering weaken exact-path, failure or verified evidence boundaries', () => {
  expect(core([read({ arguments: { path: 'D:/other-source/A.md' } })], scope)).toBe(false);
  expect(core([read({ error: 'read failed' })], scope)).toBe(false);
  expect(core([read({ terminalVerification: undefined })], scope)).toBe(false);
  expect(core([read({ result: '{"ok":false,"content":"invented source"}' })], scope)).toBe(false);
 });
});
