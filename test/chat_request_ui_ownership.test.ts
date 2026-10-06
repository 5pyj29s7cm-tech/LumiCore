import { expect, it, vi } from 'vitest';
import vm from 'node:vm';
import ts from 'typescript';
import { pageHarness, pagePath } from './chat_page_fixture';
import { extractSourceExpression as extract, readSourceAst } from './source_expression';
import * as delivery from '../src/lib/agentResponseDelivery';
import * as progress from '../src/lib/chatProgress';
import * as receipts from '../src/lib/chatEventReceipts';
import { resolveChatExecutionEvent } from '../src/lib/conversationSync';
import { projectAgentActivity } from '../src/lib/agentStatusTruth';
import { extractMediaGenerationArtifacts } from '../src/lib/mediaGenerationArtifacts';

function listenerHarness(source = pagePath) {
  const h = pageHarness();
  const listeners = new Map<string, (...args: any[]) => void>();
  const acknowledgements: Array<(ack: any) => void> = [];
  let status = 'idle';
  Object.assign(h.deps, {
    ...delivery, ...progress, ...receipts, resolveChatExecutionEvent, projectAgentActivity, extractMediaGenerationArtifacts,
    isFounder: false, seenWorkflowToolEvents: { current: new Set() },
    terminalReceiptsRef: { current: new receipts.ChatTerminalReceiptLedger() },
    setWorkflowStatus: vi.fn((next: string) => { status = next; }), pushChatProgress: vi.fn(),
    taskRelationLedgerRef: { current: { controlTarget: () => ({}), record: vi.fn() } },
    MEDIA_GENERATION_TOOL_NAMES: new Set(), normalizeTaskCompletionFeedback: () => undefined,
    finishChatProgress: vi.fn(), scheduleWorkflowReset: vi.fn(), agentNameRef: { current: 'Lumi' },
    bindAttachmentContextToConversation: vi.fn(),
  });
  h.deps.socket.on = (event: string, callback: any) => listeners.set(event, callback);
  h.deps.socket.off = (event: string) => listeners.delete(event);
  h.deps.socket.emit = (_event: string, _payload: any, callback: any) => acknowledgements.push(callback);
  h.deps.acceptChatExecutionEvent = extract(pagePath, 'acceptChatExecutionEvent', h.deps);
  const ast = readSourceAst(source); let effect: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('socket.on("agent:chunk", onChunk)')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast); if (!effect) throw Error('Production chat listener missing');
  const cleanup = vm.runInNewContext(ts.transpileModule('(' + effect.getText(ast) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, h.deps)();
  const send = () => { h.send(); return h.deps.chatRequestLedgerRef.current.foreground; };
  return { ...h, listeners, acknowledgements, cleanup, send, status: () => status };
}
it('a queued rejection cannot replace the foreground workflow or metadata', () => {
  const h = listenerHarness(); const first = h.send(); const meta = h.deps.currentTurnUiMetaRef.current;
  h.deps.setDraftText('queued request'); h.send();
  h.acknowledgements[1]({ ok: false, error: 'Synthetic queue rejection' });
  expect(h.deps.chatRequestLedgerRef.current.foreground).toBe(first);
  expect(h.status()).toBe('thinking'); expect(h.deps.currentTurnUiMetaRef.current).toBe(meta);
  expect(h.deps.chatTurnUiMetaRef.current.size).toBe(1);
  h.cleanup();
});
it.each(['executing', 'waiting_confirmation', 'cancelling'])('queued %s status does not own foreground progress', status => {
  const h = listenerHarness(); h.send(); h.deps.setDraftText('queued request'); h.send();
  const queued = [...h.deps.chatTurnUiMetaRef.current.keys()][1];
  h.listeners.get('agent:status')!({ requestId: queued, status, executionAccepted: true });
  expect(h.status()).toBe('thinking'); h.cleanup();
});
it.each(['agent:tool', 'agent:progress'])('%s for a queued request preserves its evidence without changing foreground progress', event => {
  const h = listenerHarness(); h.send(); h.deps.setDraftText('queued request'); h.send();
  const queued = [...h.deps.chatTurnUiMetaRef.current.keys()][1];
  const count = h.deps.pushChatProgress.mock.calls.length;
  h.listeners.get(event)!({ requestId: queued, name: 'read_file', text: 'Queued progress' });
  expect(h.status()).toBe('thinking'); expect(h.deps.pushChatProgress).toHaveBeenCalledTimes(count);
  if (event === 'agent:tool') expect(h.deps.chatTurnUiMetaRef.current.get(queued).hadTool).toBe(true);
  expect(h.deps.currentTurnUiMetaRef.current.hadTool).toBe(false); h.cleanup();
});
it('terminal delivery releases the exact watcher once and blocks a late rejected acknowledgement', () => {
  const h = listenerHarness(); const id = h.send();
  const release = h.deps.activeChatViewDetachersRef.current.get(id); const spy = vi.fn(release);
  h.deps.activeChatViewDetachersRef.current.set(id, spy);
  const response = { requestId: id, source: 'command-center-chat', text: 'Synthetic finalized reply', agentName: 'Lumi', finalized: true };
  h.listeners.get('agent:response')!(response);
  h.acknowledgements[0]({ ok: false, error: 'Late rejection' });
  h.listeners.get('agent:response')!(response);
  expect(spy).toHaveBeenCalledOnce(); expect(h.status()).toBe('done');
  expect(h.deps.chatRequestLedgerRef.current.size).toBe(0);
  expect(h.deps.messages.filter((m: any) => m.text === response.text)).toHaveLength(1);
  expect(h.deps.activeChatViewDetachersRef.current.size).toBe(0); h.cleanup();
});
it('foreground rejection promotes the next metadata owner while preserving the queued watcher', () => {
  const h = listenerHarness(); const first = h.send();
  h.deps.setDraftText('queued request'); h.send();
  const next = [...h.deps.chatTurnUiMetaRef.current.keys()][1]; const meta = h.deps.chatTurnUiMetaRef.current.get(next);
  h.acknowledgements[0]({ ok: false, error: 'Foreground rejected' });
  expect(h.deps.chatRequestLedgerRef.current.foreground).toBe(next);
  expect(h.deps.currentTurnUiMetaRef.current).toBe(meta); expect(h.status()).toBe('thinking');
  expect(h.deps.activeChatViewDetachersRef.current.has(first)).toBe(false);
  expect(h.deps.activeChatViewDetachersRef.current.has(next)).toBe(true); h.cleanup();
});
it('sending twice does not create extra terminal socket listeners', () => {
  const h = listenerHarness(); const count = h.listeners.size;
  h.deps.socket.on = vi.fn(); h.send(); h.deps.setDraftText('second'); h.send();
  expect(h.deps.socket.on).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(count); h.cleanup();
});

it('unmount disposes transport watches before any late acknowledgement can update the view', () => {
  const h = listenerHarness(); h.send(); const ast = readSourceAst(pagePath);
  let effect: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('chatUploadsRef.current.reset()')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast); expect(effect).toBeTruthy();
  const unmount = vm.runInNewContext(ts.transpileModule('(' + effect!.getText(ast) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, h.deps)();
  unmount();
  const count = h.deps.setWorkflowStatus.mock.calls.length;
  h.acknowledgements[0]({ ok: false, error: 'Late after unmount' });
  expect(h.deps.setWorkflowStatus).toHaveBeenCalledTimes(count);
  expect(h.deps.activeChatViewDetachersRef.current.size).toBe(0);
  expect(h.registry.capture()()).toBe(true); // The registry can capture fresh work after invalidation.
  h.cleanup();
});
