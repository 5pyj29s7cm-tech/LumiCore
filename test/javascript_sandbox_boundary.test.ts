import './helpers';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerCodeOpsTools } from '../server/tools/definitions/code_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { executeSandboxedJavaScript } from '../server/tools/javascript_sandbox';
import type { ToolContext } from '../server/tools/types';
import { guardCurrentAppToolCall } from '../server/cognition/current_app_execution';

const context: ToolContext = {
  userId: 'synthetic-local-code-owner', authenticated: true, source: 'chat',
  domain: 'personal', localExecution: true, executionBoundary: 'trusted_local', userConfirmed: true,
};
function registry() { const value = new ToolRegistry(); registerCodeOpsTools(value); return value; }
function execute(code: string, overrides: Partial<ToolContext> = {}) {
  return executeToolCall({ registry: registry(), name: 'code_execution', arguments: { code, timeout: 1500 }, context: { ...context, ...overrides } });
}

describe('JavaScript calculation guest and host boundary', () => {
  it('allows I/O-free calculation through both chat preflight and mandatory file-target guards', async () => {
    const taskText = '读取 C:/Users/test/Documents/input.csv，计算数量乘单价并生成 output.csv。';
    const args = { code: 'input.quantity * input.price', input: { quantity: 4, price: 18 } };
    expect(guardCurrentAppToolCall({ taskText, toolName: 'code_execution', arguments: args }).allowed).toBe(false);
    const preflight = guardCurrentAppToolCall({ taskText, toolName: 'code_execution', arguments: args, isolatedCalculation: true });
    expect(preflight.allowed).toBe(true);
    const record = await executeToolCall({ registry: registry(), name: 'code_execution', arguments: args,
      context: { ...context, actionIntent: taskText, routedTaskText: taskText, currentTurnExecutionRequested: true },
      preflight: () => ({ allowed: preflight.allowed, reason: preflight.reason, arguments: args }) });
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result).output).toBe(72);
    expect(guardCurrentAppToolCall({ taskText, toolName: 'python_exec', isolatedCalculation: true }).allowed).toBe(false);
  });
  it('reuses the same calculation with fresh JSON input and treats code-like data literally', async () => {
    const code = '({total: input.quantity * input.price, label: input.label})';
    const label = '\"); throw new Error("data executed"); //';
    expect(JSON.parse(await executeSandboxedJavaScript(code, 1500, context, { quantity: 4, price: 18, label })).output).toEqual({ total: 72, label });
    expect(JSON.parse(await executeSandboxedJavaScript(code, 1500, context, { quantity: 5, price: 18, label })).output.total).toBe(90);
    expect(JSON.parse(await executeSandboxedJavaScript('typeof input', 1500, context)).output).toBe('undefined');
    expect(JSON.parse(await executeSandboxedJavaScript('input', 1500, context, 'x'.repeat(140000))).ok).toBe(false);
  });
  it('keeps normal arithmetic and JSON while exposing no Node, filesystem or network APIs', async () => {
    const record = await execute('JSON.stringify({ result: 6 * 7, process: typeof process, require: typeof require, fetch: typeof fetch, timer: typeof setTimeout, global: typeof global })');
    expect(record.error).toBeUndefined();
    expect(JSON.parse(JSON.parse(record.result).output)).toEqual({ result: 42, process: 'undefined', require: 'undefined', fetch: 'undefined', timer: 'undefined', global: 'undefined' });
    expect(record.terminalVerification?.status).toBe('verified');
  });

  it.each([
    "console.log.constructor('return process')().version",
    "JSON.stringify.constructor('return process')().version",
    "Object.constructor('return process')().version",
    "(async function(){}).constructor('return process')()",
    "(function*(){}).constructor('return process')().next().value.version",
  ])('cannot reach the host process through constructors: %s', async code => {
    const record = await execute(code);
    expect(JSON.parse(record.result).ok).toBe(false);
    expect(record.terminalVerification?.status).not.toBe('verified');
    expect(record.result).not.toContain(process.version);
  });

  it('captures console output and resolves guest promises', async () => {
    expect(JSON.parse(await executeSandboxedJavaScript('console.log("sum", [1,2,3].reduce((a,b)=>a+b,0)); console.warn("bounded");', 1500))).toMatchObject({ ok: true, output: 'sum 6\n[warn] bounded' });
    expect(JSON.parse(await executeSandboxedJavaScript('(async () => (await Promise.resolve(20)) + 22)()', 1500))).toMatchObject({ ok: true, output: 42 });
  });

  it('does not share mutable globals between invocations', async () => {
    expect(JSON.parse(await executeSandboxedJavaScript('globalThis.privateMarker = 42; Object.prototype.polluted = true; 42', 1500)).ok).toBe(true);
    expect(JSON.parse(await executeSandboxedJavaScript('[typeof privateMarker, ({}).polluted === undefined]', 1500))).toMatchObject({ ok: true, output: ['undefined', true] });
    expect(({} as any).polluted).toBeUndefined();
  });

  it.each(['while(true){}', 'Promise.resolve().then(()=>{while(true){}})', '({get value(){while(true){} }})'])('bounds synchronous, asynchronous and result-serialization loops: %s', async code => {
    const start = Date.now();
    const result = JSON.parse(await executeSandboxedJavaScript(code, 250));
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(JSON.parse(await executeSandboxedJavaScript('21 * 2', 1500))).toMatchObject({ ok: true, output: 42 });
  });

  it.each(['"x".repeat(300000)', 'console.log("x".repeat(300000))', 'new Array(100000000).fill("large")'])('bounds output and guest memory without affecting the host: %s', async code => {
    const result = JSON.parse(await executeSandboxedJavaScript(code, 1500));
    expect(result.ok).toBe(false);
    expect(JSON.parse(await executeSandboxedJavaScript('2 + 2', 1500)).output).toBe(4);
  });

  it('cancels a running loop without blocking the main event loop and waits for worker exit', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const pending = executeSandboxedJavaScript('while(true){}', 5000, { ...context, executionSignal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      expect(JSON.parse(await pending)).toMatchObject({ ok: false, status: 'cancelled' });
      expect(Date.now() - start).toBeLessThan(2000);
      expect(JSON.parse(await executeSandboxedJavaScript('42', 1500)).output).toBe(42);
    } finally { clearTimeout(timer); }
  });

  it('allows bounded local arithmetic without a separate approval while rejecting remote and anonymous callers', async () => {
    expect((await execute('42', { userConfirmed: false })).terminalVerification?.status).toBe('verified');
    expect((await execute('42', { executionBoundary: 'remote_restricted', localExecution: false })).error).toMatch(/remote execution surfaces/i);
    expect((await execute('42', { userId: 'anonymous', authenticated: false })).error).toMatch(/authenticated user/i);
  });

  it('cancels queued calculations while busy workers remain bounded and later calls recover', async () => {
    const running = new AbortController();
    const queued = new AbortController();
    const first = executeSandboxedJavaScript('while(true){}', 5000, { ...context, executionSignal: running.signal });
    const second = executeSandboxedJavaScript('while(true){}', 5000, { ...context, executionSignal: running.signal });
    const waiting = executeSandboxedJavaScript('42', 5000, { ...context, executionSignal: queued.signal });
    queued.abort();
    try { expect(JSON.parse(await waiting)).toMatchObject({ ok: false, status: 'cancelled' }); }
    finally { running.abort(); await Promise.all([first, second]); }
    expect(JSON.parse(await executeSandboxedJavaScript('42', 1500))).toMatchObject({ ok: true, output: 42 });
  });

  it('limits admission to two workers and eight queued requests', async () => {
    const controller = new AbortController();
    const options = { ...context, executionSignal: controller.signal };
    const pending = Array.from({ length: 10 }, () => executeSandboxedJavaScript('while(true){}', 5000, options));
    try {
      expect(JSON.parse(await executeSandboxedJavaScript('42', 5000, options))).toMatchObject({ ok: false, error: expect.stringMatching(/queue is full/) });
    } finally { controller.abort(); await Promise.all(pending); }
    expect(JSON.parse(await executeSandboxedJavaScript('42', 1500)).output).toBe(42);
  });
});
