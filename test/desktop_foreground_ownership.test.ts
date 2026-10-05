import { extractSourceExpression, readSourceAst } from './source_expression';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('desktop foreground event ownership', () => {
  it('keeps the foreground task while unrelated background events pause, cancel or finish', () => {
    // Execute the production effect and its actual socket registrations, not
    // source-string assertions about whether a guard exists.
    const ast = readSourceAst('src/components/DesktopUI.tsx');
    let effect: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('let terminalResponseSeen = false;')) effect = node.arguments[0];
      ts.forEachChild(node, visit);
    }
    visit(ast); expect(effect).toBeTruthy();
    const listeners = new Map<string, (...args: any[]) => void>(); let status = 'idle';
    const timers: Array<() => void> = []; const reactions: string[] = [];
    const sandbox = {
      socket: { on: (event: string, callback: any) => listeners.set(event, callback), off: (event: string) => listeners.delete(event) },
      setAgentStatus: (value: string) => { status = value; },
      seenWorkflowToolEvents: { current: new Set() }, triggerPetReaction: (value: string) => reactions.push(value),
      setTimeout: (fn: () => void) => timers.push(fn), clearTimeout: () => {}, cleanup: undefined,
    };
    const code = ts.transpileModule(`globalThis.cleanup = (${effect!.getText(ast)})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, sandbox, { timeout: 1000 });
    listeners.get('agent:status')!({ status: 'thinking', requestId: 'A', source: 'chat' });
    expect(status).toBe('thinking');
    for (const event of ['started', 'paused', 'completed', 'cancelled', 'failed']) listeners.get(`autonomous:task_${event}`)?.({ task: { id: 'B', status: event } });
    listeners.get('agent:status')!({ status: 'thinking', requestId: 'B', source: 'background' });
    expect(status).toBe('thinking');
    const tool = { correlationId: 'tool-a', name: 'read_file', requestId: 'A', source: 'chat' };
    listeners.get('agent:tool_call')!({ ...tool });
    expect(status).toBe('executing'); expect(reactions).toEqual([]);
    listeners.get('agent:tool')!({ ...tool, result: '{"success":false}' });
    listeners.get('agent:tool_call')!({ ...tool, result: '{"success":false}' });
    expect(reactions).toEqual(['failed']); // Aliased delivery reacts once.
    listeners.get('agent:response')!({ requestId: 'B', source: 'background', finalized: true, text: 'Done' });
    expect(status).toBe('executing');
    listeners.get('agent:response')!({ requestId: 'A', source: 'chat', finalized: true, text: 'Result' });
    listeners.get('agent:status')!({ status: 'idle', requestId: 'A', source: 'chat' });
    expect(status).toBe('done');
    const oldReset = timers.at(-1)!;
    listeners.get('agent:status')!({ status: 'thinking', requestId: 'C', source: 'chat' });
    oldReset(); expect(status).toBe('thinking'); // Prior terminal timer cannot clear a new request.
    listeners.get('agent:response')!({ requestId: 'C', source: 'chat', text: 'Unfinalized' });
    expect(status).toBe('error');
    timers.at(-1)!(); expect(status).toBe('idle');
    (sandbox.cleanup as unknown as () => void)(); expect(listeners.size).toBe(0);
  });
});

it('keeps one window order across reopen, minimize, close, and returning home', () => {
  const state = { openWindows: [] as string[], minimizedWindows: [] as string[], focusedWindow: null as string | null, activeTab: 'home' };
  const set = (key: keyof typeof state) => (value: any) => { (state as any)[key] = typeof value === 'function' ? value(state[key]) : value; };
  const noop = () => {};
  const invoke = (name: string, tab: string) => extractSourceExpression('src/components/DesktopUI.tsx', name, {
    ...state, setOpenWindows: set('openWindows'), setMinimizedWindows: set('minimizedWindows'), setFocusedWindow: set('focusedWindow'),
    setActiveTab: set('activeTab'), sounds: { playClick: noop }, surfaceReturnTargetRef: { current: 'home' },
    setKnowledgeOpen: noop, setMemoryLabOpen: noop, setSanctuaryOpen: noop, setSanctuaryAgent: noop,
    setChatOpen: noop, setChatPrefill: noop, setViewMode: noop, setIsSearchOpen: noop, setIsNotificationPanelOpen: noop,
    memoryAvatarOpenGenerationRef: { current: 0 }, inferSurfaceReturnTarget: () => 'home', normalizeTarget: (value: string) => value,
    dismissUtilitySurfaces: (keep?: string) => invoke('dismissUtilitySurfaces', keep as string),
    openSurface: (value: string) => invoke('openSurface', value),
  })(tab);
  const open = (tab: string) => invoke('toggleWindow', tab);
  open('settings'); open('terminal'); open('settings'); open('settings');
  expect(state.openWindows).toEqual(['terminal', 'settings']);
  invoke('minimizeOsWindow', 'settings');
  expect(state.focusedWindow).toBe('terminal');
  open('kernel'); invoke('closeWindow', 'kernel');
  expect(state.focusedWindow).toBe('terminal'); // A minimized window cannot receive focus.
  invoke('closeWindow', 'terminal');
  expect(state.focusedWindow).toBeNull(); expect(state.activeTab).toBe('home');
  open('settings'); expect(state.minimizedWindows).toEqual([]);
  invoke('minimizeOsWindow', 'settings'); open('home');
  expect(state).toEqual({ openWindows: [], minimizedWindows: [], focusedWindow: null, activeTab: 'home' });
  open('settings'); expect(state.openWindows).toEqual(['settings']); expect(state.focusedWindow).toBe('settings');
});
