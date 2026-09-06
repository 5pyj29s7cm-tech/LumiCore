// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import ts from 'typescript';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: { uid: 'owner-a' }, api: vi.fn(), login: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: mocks.user, login: mocks.login }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: mocks.api }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../src/components/MemoryAvatarCreate', () => ({ MemoryAvatarCreate: ({ onImport }: { onImport: () => void }) => <button onClick={onImport}>Import records</button> }));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: any) => children, motion: { div: ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: any) => <div {...props}>{children}</div> } }));
import { MemoryAvatarLab } from '../src/components/MemoryAvatarLab';

class Reader {
  static LOADING = 1;
  static instances: Reader[] = [];
  readyState = 1;
  result = '';
  onload: null | ((event: any) => unknown) = null;
  onloadend: null | (() => unknown) = null;
  constructor() { Reader.instances.push(this); }
  readAsText() { /* Explicit completion models a delayed OS read. */ }
  readAsDataURL() { /* Only synthetic input; no real audio is read. */ }
  abort() { this.readyState = 2; this.onloadend?.(); }
  complete(result: string) { this.result = result; this.readyState = 2; const pending = this.onload?.({ target: { result } }); this.onloadend?.(); return pending; }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
const response = (data: unknown) => ({ ok: true, json: async () => data });
const distilled = { inferredName: 'Synthetic person A', relationshipType: 'close_friend', personalityConfig: { expressionStyle: { tone: 'warm' } }, seedMemories: [], evidenceMap: [], narrative: 'Synthetic biography', summary: { messageCount: 1, memoryCount: 0 } };
beforeEach(() => {
  mocks.user = { uid: 'owner-a' }; Object.values(mocks).forEach(mock => { if (typeof mock === 'function') mock.mockReset(); });
  Reader.instances = []; vi.stubGlobal('FileReader', Reader);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function lab() {
  const entered = vi.fn();
  const props = { t: { langCode: 'en' }, lang: 'en' as const, onEnterSanctuary: entered };
  const view = render(<MemoryAvatarLab {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import records' }));
  return { ...view, entered, props };
}
async function loadRecords(view: ReturnType<typeof lab>) {
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'fixture.txt')] } });
  await act(async () => { await Reader.instances.at(-1)!.complete('Target: a synthetic remembered sentence.'); });
}
async function prepareCreate(view: ReturnType<typeof lab>) {
  await loadRecords(view);
  mocks.api.mockResolvedValueOnce(response(distilled));
  fireEvent.click(screen.getByRole('button', { name: /Start Personality Distill/i }));
  await screen.findByRole('button', { name: /^Create Sanctuary/i });
}

it('preserves normal record creation and enters only after the confirmed response', async () => {
  const view = lab(); await prepareCreate(view);
  const gate = deferred<ReturnType<typeof response>>(); mocks.api.mockReturnValueOnce(gate.promise);
  fireEvent.click(screen.getByRole('button', { name: /^Create Sanctuary/i }));
  expect(view.entered).not.toHaveBeenCalled();
  await act(async () => { gate.resolve(response({ id: 'avatar-a', name: distilled.inferredName })); });
  expect(view.entered).toHaveBeenCalledWith({ id: 'avatar-a', name: distilled.inferredName });
});

it.each([false, true])('reuses the create identity after 503 unless the submitted fields change (edited=%s)', async edited => {
  const view = lab(); await prepareCreate(view);
  mocks.api.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Save not confirmed' }) });
  fireEvent.click(screen.getByRole('button', { name: /^Create Sanctuary/i }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Save not confirmed'));
  expect(view.entered).not.toHaveBeenCalled();
  const original = JSON.parse(mocks.api.mock.calls.at(-1)![1].body);
  expect(original.clientRequestId).toBeTruthy();
  if (edited) fireEvent.change(screen.getByDisplayValue(distilled.inferredName), { target: { value: 'Edited synthetic person' } });
  mocks.api.mockResolvedValueOnce(response({ id: 'avatar-a', name: distilled.inferredName }));
  fireEvent.click(screen.getByRole('button', { name: /^Create Sanctuary/i }));
  await waitFor(() => expect(view.entered).toHaveBeenCalledTimes(1));
  const retried = JSON.parse(mocks.api.mock.calls.at(-1)![1].body);
  expect(retried.clientRequestId === original.clientRequestId).toBe(!edited);
});

it.each(['unmount', 'owner-change'] as const)('ignores late record creation after %s and aborts the old request', async change => {
  const view = lab(); await prepareCreate(view);
  const gate = deferred<ReturnType<typeof response>>(); mocks.api.mockReturnValueOnce(gate.promise);
  fireEvent.click(screen.getByRole('button', { name: /^Create Sanctuary/i }));
  const signal = mocks.api.mock.calls.at(-1)![1].signal as AbortSignal;
  mocks.success.mockClear();
  if (change === 'unmount') view.unmount();
  else { mocks.user = { uid: 'owner-b' }; view.rerender(<MemoryAvatarLab {...view.props} />); }
  expect(signal.aborted).toBe(true);
  await act(async () => { gate.resolve(response({ id: 'avatar-a', name: 'Private previous person' })); });
  expect(view.entered).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
  if (change === 'owner-change') {
    fireEvent.click(screen.getByRole('button', { name: 'Import records' }));
    expect((screen.getByRole('button', { name: /Start Personality Distill/i }) as HTMLButtonElement).disabled).toBe(true);
  }
});

it('does not upload an old recording if its FileReader completes after an account switch', async () => {
  const view = lab();
  fireEvent.change(view.container.querySelectorAll('input[type=file]')[1], { target: { files: [new File(['synthetic'], 'recording.wav')] } });
  const reader = Reader.instances.at(-1)!;
  mocks.user = { uid: 'owner-b' }; view.rerender(<MemoryAvatarLab {...view.props} />);
  await act(async () => { await reader.complete('data:audio/wav;base64,c3ludGhldGlj'); });
  expect(mocks.api).not.toHaveBeenCalled();
});

it('discards old distillation after an owner change and lets the new owner start with empty records', async () => {
  const view = lab(); await loadRecords(view);
  const gate = deferred<ReturnType<typeof response>>(); mocks.api.mockReturnValueOnce(gate.promise);
  fireEvent.click(screen.getByRole('button', { name: /Start Personality Distill/i }));
  mocks.user = { uid: 'owner-b' }; view.rerender(<MemoryAvatarLab {...view.props} />);
  await act(async () => { gate.resolve(response(distilled)); });
  expect(screen.queryByText('Synthetic biography')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Import records' }));
  expect((screen.getByRole('button', { name: /Start Personality Distill/i }) as HTMLButtonElement).disabled).toBe(true);
});

// Execute the production shell callbacks; avoid mounting unrelated desktop OS,
// model, microphone and WebGL modules just to exercise entry authorization.
const desktop = fs.readFileSync('src/components/DesktopUI.tsx', 'utf8');
const ast = ts.createSourceFile('DesktopUI.tsx', desktop, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function shellCallback(name: string, context: Record<string, any>): any {
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback || !ts.isArrowFunction(callback)) throw new Error(`Missing actual shell callback ${name}`);
  const code = ts.transpileModule(`return (${callback.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(context), code)(...Object.values(context));
}
function shell() {
  const scope = { userId: 'owner-a' };
  return {
    memoryAvatarOwnerScope: scope, memoryAvatarOwnerRef: { current: scope }, memoryAvatarOpenGenerationRef: { current: 4 }, memoryAvatarSurfaceGeneration: 4,
    memoryAvatarListOwnerRef: { current: 'owner-a' }, memoryAvatars: [{ id: 'avatar-current' }],
    setMemoryAvatars: vi.fn(), setMemoryLabOpen: vi.fn(), setSanctuaryAgent: vi.fn(), setSanctuaryLoaded: vi.fn(), setSanctuaryOpen: vi.fn(),
    memoryAvatarService: { list: vi.fn() },
  };
}
it.each(['closed', 'other-owner', 'same-owner-new-login'] as const)('the actual shell ignores a retained creation callback after %s', change => {
  const context = shell(); const enter = shellCallback('enterCreatedMemoryAvatar', context);
  if (change === 'closed') context.memoryAvatarOpenGenerationRef.current++;
  else context.memoryAvatarOwnerRef.current = { userId: change === 'other-owner' ? 'owner-b' : 'owner-a' };
  enter({ id: 'late-avatar' });
  expect(context.setSanctuaryAgent).not.toHaveBeenCalled(); expect(context.setSanctuaryOpen).not.toHaveBeenCalled(); expect(context.setMemoryAvatars).not.toHaveBeenCalled();
});
it('the actual shell accepts current creation and rejects a list response from a previous login of the same owner', async () => {
  const context = shell();
  shellCallback('enterCreatedMemoryAvatar', context)({ id: 'fresh-avatar' });
  expect(context.setSanctuaryAgent).toHaveBeenCalledWith({ id: 'fresh-avatar' });
  const gate = deferred<{ avatars: any[] }>(); context.memoryAvatarService.list.mockReturnValueOnce(gate.promise);
  const loading = shellCallback('loadMemoryAvatars', context)();
  context.memoryAvatarOwnerRef.current = { userId: 'owner-a' };
  context.setMemoryAvatars.mockClear(); gate.resolve({ avatars: [{ id: 'old-avatar' }] });
  expect(await loading).toEqual([]); expect(context.setMemoryAvatars).not.toHaveBeenCalled();
});
