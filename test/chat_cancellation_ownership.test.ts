import { afterEach, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import ts from 'typescript';
import { pageHarness, pagePath } from './chat_page_fixture';
import { extractSourceExpression as extract, readSourceAst } from './source_expression';
import { ChatTurnTimerGuard } from '../src/lib/chatEventReceipts';

const cancellationSource = pagePath;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function cancellationHarness() {
  vi.useFakeTimers();
  const h = pageHarness(), guard = new ChatTurnTimerGuard(), acknowledgements: Array<(ack: any) => void> = [];
  const emit = vi.fn((_event: string, _payload: any, ack: any) => acknowledgements.push(ack));
  h.deps.chatRequestLedgerRef.current.begin('foreground'); guard.begin('foreground');
  Object.assign(h.deps, { chatTurnTimerGuardRef: { current: guard }, setWorkflowStatus: vi.fn(),
    pushChatProgress: vi.fn(), chatProgressClearTimerRef: { current: null }, clearTimeout,
    window: { setTimeout, clearTimeout }, socket: { connected: true, emit } });
  const cancel = extract(cancellationSource, 'cancelActiveChat', h.deps);
  const cleanups: Array<() => void> = [], ast = readSourceAst(pagePath);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && /chatUploadsRef.current.reset\(\)|chatTurnTimerGuardRef.current.dispose\(\)/.test(node.arguments[0]?.getText(ast) || '')) {
      cleanups.push(vm.runInNewContext(ts.transpileModule('(' + node.arguments[0].getText(ast) + ')',
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h.deps)());
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { ...h, cancel, guard, acknowledgements, emit, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}
it('unmount prevents a late rejected cancellation acknowledgement from updating the view', () => {
  const h = cancellationHarness(); h.cancel(); h.unmount();
  const count = h.deps.setWorkflowStatus.mock.calls.length;
  h.acknowledgements[0]({ ok: false, error: 'Late after unmount' });
  expect(h.deps.setWorkflowStatus).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
it('unmount disposes the cancellation timeout even without an acknowledgement', () => {
  const h = cancellationHarness(); h.cancel(); h.unmount();
  const count = h.deps.setWorkflowStatus.mock.calls.length;
  vi.advanceTimersByTime(8000);
  expect(h.deps.setWorkflowStatus).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
it('scope changes invalidate a late cancellation rejection before request promotion', () => {
  const h = cancellationHarness(); h.cancel(); h.registry.invalidate();
  const count = h.deps.setWorkflowStatus.mock.calls.length;
  h.acknowledgements[0]({ ok: false, error: 'Wrong scope' }); vi.advanceTimersByTime(8000);
  expect(h.deps.setWorkflowStatus).toHaveBeenCalledTimes(count);
});
it('cancellation targets the current ledger foreground and ignores the previous request acknowledgement', () => {
  const h = cancellationHarness(); h.cancel();
  h.deps.chatRequestLedgerRef.current.begin('promoted');
  h.deps.settleTrackedChatRequest('foreground'); h.cancel();
  expect(h.emit.mock.calls.map(call => call[1].requestId)).toEqual(['foreground', 'promoted']);
  const count = h.deps.setWorkflowStatus.mock.calls.length;
  h.acknowledgements[0]({ ok: false, error: 'Old owner' });
  expect(h.deps.setWorkflowStatus).toHaveBeenCalledTimes(count);
  h.acknowledgements[1]({ ok: true }); vi.advanceTimersByTime(8000);
  expect(h.deps.setWorkflowStatus).toHaveBeenCalledTimes(count); h.unmount();
});
it('an owned cancellation still reports missing and rejected acknowledgements', () => {
  const h = cancellationHarness(); h.cancel(); vi.advanceTimersByTime(8000);
  expect(h.deps.setWorkflowStatus).toHaveBeenLastCalledWith('error');
  h.cancel(); h.acknowledgements[1]({ ok: false, error: 'Synthetic rejection' });
  expect(h.deps.pushChatProgress).toHaveBeenLastCalledWith('Synthetic rejection', 'error'); h.unmount();
});
