import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('desktop foreground event ownership', () => {
  it('keeps the foreground task while unrelated background events pause, cancel or finish', () => {
    // Execute the production effect and its actual socket registrations, not
    // source-string assertions about whether a guard exists.
    const source = fs.readFileSync('src/components/DesktopUI.tsx', 'utf8');
    const ast = ts.createSourceFile('DesktopUI.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('let terminalResponseSeen = false;')) effect = node.arguments[0];
      ts.forEachChild(node, visit);
    }
    visit(ast); expect(effect).toBeTruthy();
    const listeners = new Map<string, (...args: any[]) => void>(); let status = 'idle'; let steps: any[] = [];
    const sandbox = {
      socket: { on: (event: string, callback: any) => listeners.set(event, callback), off: (event: string) => listeners.delete(event) },
      setAgentStatus: (value: string) => { status = value; },
      setWorkflowSteps: (next: any) => { steps = typeof next === 'function' ? next(steps) : next; },
      seenWorkflowToolEvents: { current: new Set() }, t: {}, setTimeout: () => 1, clearTimeout: () => {}, cleanup: undefined,
    };
    const code = ts.transpileModule(`globalThis.cleanup = (${effect!.getText(ast)})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, sandbox, { timeout: 1000 });
    listeners.get('agent:status')!({ status: 'thinking', requestId: 'A', source: 'chat' });
    expect(status).toBe('thinking');
    for (const event of ['started', 'paused', 'completed', 'cancelled', 'failed']) listeners.get(`autonomous:task_${event}`)?.({ task: { id: 'B', status: event } });
    listeners.get('agent:status')!({ status: 'thinking', requestId: 'B', source: 'background' });
    expect(status).toBe('thinking'); expect(steps).toHaveLength(1);
    (sandbox.cleanup as unknown as () => void)(); expect(listeners.size).toBe(0);
  });
});
