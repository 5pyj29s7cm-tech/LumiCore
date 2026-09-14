import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDataPath } from '../server/config/data_path';
import { buildCliArgs, consumeCliEvent, executeExternalCli, getExternalCliRun, inspectExternalClis, type CliStreamState } from '../server/external_agents/cli_runtime';
import { runCliProcess, type CliProcessInput } from '../server/external_agents/cli_process';
import { collectChatArtifacts } from '../server/conversation/chat_artifacts';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { buildActionContract } from '../server/cognition/action_contract';
import { hasExplicitToolIntent } from '../server/cognition/tool_intent';
import { isExternalCliRequest } from '../server/cognition/external_cli_intent';
import { registerExternalCliTools } from '../server/tools/definitions/external_cli_tools';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { verifyCapabilityReceipt } from '../server/tools/capability_verification';
import type { ToolContext } from '../server/tools/types';

const context: ToolContext = { userId: 'external-cli-test', authenticated: true, executionBoundary: 'trusted_local', localExecution: true, conversationId: 'test-conversation', taskId: 'test-task', source: 'test', actionIntent: '调用 Codex CLI 和 Claude Code CLI 进行测试' };
function workspace() { const root = getDataPath('cli-tests'); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, 'project-')); }
const resolveLaunch = () => ({ executable: process.execPath, prefix: [] });
function emitCodex(input: CliProcessInput, text = 'done', session = 'session-test-123') {
  for (const event of [{ type: 'thread.started', thread_id: session }, { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' }]) input.onLine?.(JSON.stringify(event));
  return { exitCode: 0, stdout: '', stderr: '' };
}
const state = (): CliStreamState => ({ terminal: false, failed: false, response: '', progress: [] });
afterEach(() => { delete process.env.LUMI_PRIVACY; });

describe('external CLI protocol and authority', () => {
  it('builds shell-free CLI arguments with exact resume IDs and read-only defaults', () => {
    const codex = buildCliArgs('codex', 'workspace-write', 'D:/work', 'known-session-123', 'D:/outputs');
    expect(codex).toContain('resume'); expect(codex).toContain('known-session-123'); expect(codex).not.toContain('--last');
    expect(codex).toContain('--add-dir'); expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    const claude = buildCliArgs('claude', 'read-only', 'D:/work');
    expect(claude).toContain('Read,Glob,Grep'); expect(claude).toContain('dontAsk'); expect(claude).toContain('--strict-mcp-config');
    expect(claude).not.toContain('Bash'); expect(() => buildCliArgs('codex', 'read-only', 'D:/work', '--last')).toThrow();
  });
  it('requires provider terminal evidence, not plain text or process exit', () => {
    const codex = state(); consumeCliEvent('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"完成"}}', codex);
    expect(codex.terminal).toBe(false); consumeCliEvent('codex', '{"type":"turn.failed","error":{"message":"quota"}}', codex); expect(codex.failed).toBe(true);
    const claude = state(); consumeCliEvent('claude', '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"unfinished"}', claude);
    expect(claude).toMatchObject({ terminal: true, failed: true, response: 'unfinished' });
  });
  it('accepts a final successful Codex turn after a recoverable reconnect error', () => {
    const value = state(); consumeCliEvent('codex', '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}', value);
    consumeCliEvent('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"READY"}}', value);
    consumeCliEvent('codex', '{"type":"turn.completed"}', value);
    expect(value).toMatchObject({ terminal: true, failed: false, response: 'READY' });
  });
  it('blocks remote, missing-owner and strict-privacy invocation before launching', async () => {
    const args = { provider: 'codex', prompt: 'test', cwd: workspace() }; let calls = 0;
    const deps = { resolveLaunch, runProcess: async (input: CliProcessInput) => { calls++; return emitCodex(input); } };
    await expect(executeExternalCli(args, { ...context, executionBoundary: 'remote_restricted' }, deps)).rejects.toThrow('local Lumi host');
    await expect(executeExternalCli(args, { ...context, userId: undefined }, deps)).rejects.toThrow('local Lumi host');
    process.env.LUMI_PRIVACY = 'strict'; await expect(executeExternalCli(args, context, deps)).rejects.toThrow(); expect(calls).toBe(0);
  });
  it('reports configuration failure without pretending the CLI needs a new account', async () => {
    const result = JSON.parse(await inspectExternalClis(context, { resolveLaunch, runProcess: async input => input.args.includes('--version')
      ? { exitCode: 0, stdout: 'cli 1.0', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'Error loading configuration: unknown variant ultra' } }));
    expect(result.targets[0]).toMatchObject({ provider: 'codex', ready: false, status: 'config_error' });
  });
});

describe('same Lumi task owns CLI lifecycle', () => {
  it('resumes the exact owned CLI session and validates changed output bytes', async () => {
    const cwd = workspace(), calls: CliProcessInput[] = [];
    const deps = { resolveLaunch, runProcess: async (input: CliProcessInput) => {
      calls.push(input); const output = input.input!.match(/Lumi output directory: (.+)/)![1];
      fs.writeFileSync(path.join(output, 'answer.txt'), calls.length === 1 ? 'first' : 'second');
      return emitCodex(input, calls.length === 1 ? 'first response' : 'continued response');
    } };
    const first = JSON.parse(await executeExternalCli({ provider: 'codex', prompt: 'Write answer.txt', cwd, access: 'workspace-write' }, context, deps));
    expect(first).toMatchObject({ ok: true, status: 'completed', taskId: context.taskId, conversationId: context.conversationId });
    expect(first.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/); expect(first.sessionId).toBeUndefined();
    const second = JSON.parse(await executeExternalCli({ provider: 'codex', prompt: 'Change it', resumeRunId: first.runId }, context, deps));
    expect(second.parentRunId).toBe(first.runId); expect(second.outputDirectory).toBe(first.outputDirectory);
    expect(calls[1].args).toContain('session-test-123'); expect(second.artifacts[0].sha256).not.toBe(first.artifacts[0].sha256);
    expect(calls[0].env?.JWT_SECRET).toBeUndefined();
    const record: any = { name: 'external_cli_run', arguments: {}, result: JSON.stringify(second), terminalVerification: { status: 'verified' } };
    expect(collectChatArtifacts([record], context.conversationId)).toHaveLength(1);
    expect(collectChatArtifacts([{ ...record, terminalVerification: { status: 'unverified' } }])).toEqual([]);
    await expect(getExternalCliRun({ runId: first.runId }, { ...context, userId: 'other' })).rejects.toThrow('unavailable');
    await expect(executeExternalCli({ provider: 'claude', prompt: 'Continue', resumeRunId: first.runId }, context, deps)).rejects.toThrow('cannot be resumed');
    await expect(executeExternalCli({ provider: 'codex', prompt: 'Continue', cwd: workspace(), resumeRunId: first.runId }, context, deps)).rejects.toThrow('same working directory');
  });
  it('does not archive a previously existing unchanged file or a path merely mentioned by the agent', async () => {
    const cwd = workspace();
    const first = JSON.parse(await executeExternalCli({ provider: 'codex', cwd, prompt: 'Inspect' }, context, { resolveLaunch, runProcess: async input => {
      const output = input.input!.match(/Lumi output directory: (.+)/)![1]; fs.writeFileSync(path.join(output, 'unchanged.txt'), 'same'); return emitCodex(input);
    } }));
    const second = JSON.parse(await executeExternalCli({ provider: 'codex', prompt: 'Again', resumeRunId: first.runId }, context, { resolveLaunch, runProcess: async input => emitCodex(input, 'Created C:/fake/secret.txt') }));
    expect(second.artifacts).toEqual([]);
  });
  it('keeps cancellation receipt and partial artifacts, without exposing them as completed outputs', async () => {
    const result = JSON.parse(await executeExternalCli({ provider: 'claude', cwd: workspace(), prompt: 'test' }, context, { resolveLaunch, runProcess: async input => {
      const output = input.input!.match(/Lumi output directory: (.+)/)![1]; fs.writeFileSync(path.join(output, 'partial.txt'), 'partial');
      input.onLine?.('{"type":"system","subtype":"init","session_id":"claude-session-123"}');
      return { exitCode: null, stdout: '', stderr: '', failure: 'cancelled' as const };
    } }));
    expect(result).toMatchObject({ ok: false, status: 'cancelled' }); expect(result.artifacts).toHaveLength(1);
    const receipt = JSON.parse(await getExternalCliRun({ runId: result.runId }, context)); expect(receipt.status).toBe('cancelled');
    expect(collectChatArtifacts([{ name: 'external_cli_run', result: JSON.stringify(result), terminalVerification: { status: 'verified' } }])).toEqual([]);
  });
  it('does not treat zero exit without a provider terminal result as success', async () => {
    const result = JSON.parse(await executeExternalCli({ provider: 'codex', cwd: workspace(), prompt: 'test' }, context, { resolveLaunch, runProcess: async () => ({ exitCode: 0, stdout: 'all done', stderr: '' }) }));
    expect(result).toMatchObject({ ok: false, status: 'failed' });
  });
  it('does not overlap two agents in the same workspace', async () => {
    const cwd = workspace(); let finish!: (value: any) => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = executeExternalCli({ provider: 'codex', cwd, prompt: 'test' }, context, { resolveLaunch, runProcess: input => { started(); return new Promise(resolve => { finish = () => resolve(emitCodex(input)); }); } });
    await ready;
    const second = JSON.parse(await executeExternalCli({ provider: 'claude', cwd, prompt: 'test' }, context, { resolveLaunch }));
    expect(second.status).toBe('blocked'); finish(undefined); await first;
  });
  it('records an interrupted persisted run instead of declaring stale running work completed', async () => {
    const run = JSON.parse(await executeExternalCli({ provider: 'codex', cwd: workspace(), prompt: 'test' }, context, { resolveLaunch, runProcess: async input => emitCodex(input) }));
    const directories = fs.readdirSync(getDataPath('external-agents'));
    const file = directories.map(dir => path.join(getDataPath('external-agents'), dir, `${run.runId}.json`)).find(file => fs.existsSync(file))!;
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')); stored.status = 'running'; fs.writeFileSync(file, JSON.stringify(stored));
    expect(JSON.parse(await getExternalCliRun({ runId: run.runId }, context)).status).toBe('interrupted');
  });
});

describe('actual child process management', () => {
  it('passes hostile text literally over stdin and decodes split UTF-8 without a shell', async () => {
    const lines: string[] = []; const literal = '中文 & $(not-a-command) `whoami`';
    const result = await runCliProcess({ executable: process.execPath, args: ['-e', 'process.stdin.on("data", b => process.stdout.write(b));'], cwd: workspace(), input: literal + '\n', timeoutMs: 3000, onLine: value => lines.push(value) });
    expect(result.exitCode).toBe(0); expect(lines).toEqual([literal]);
  });
  it('settles a cancelled process before returning', async () => {
    const controller = new AbortController();
    const pending = runCliProcess({ executable: process.execPath, args: ['-e', 'console.log("started"); setInterval(()=>{},1000)'], cwd: workspace(), timeoutMs: 10000, signal: controller.signal, onLine: () => controller.abort() });
    const result = await pending; expect(result.failure).toBe('cancelled');
  }, 15000);
  it('settles a timed-out process and does not reinterpret it as an empty successful reply', async () => {
    const result = await runCliProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: workspace(), timeoutMs: 150 });
    expect(result.failure).toBe('timed_out');
  }, 15000);
});

describe('CLI follows existing intent/route/receipt contracts', () => {
  it.each(['让 Codex 检查这个项目', '用 Claude Code 修改这些文件', '继续 Codex CLI 的任务'])('routes %s to CLI instead of desktop chat', text => {
    expect(hasExplicitToolIntent(text)).toBe(true); expect(isExternalCliRequest(text)).toBe(true);
    const names = ['external_cli_run', 'external_cli_status', 'external_cli_get_run', 'desktop_ai_ask', 'desktop_ai_collect_answer', 'computer_use', 'read_file'];
    const declarations = names.map(name => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } }));
    const route = routeToolsForTurn(text, declarations);
    expect(route.toolNames).toContain('external_cli_run'); expect(route.toolNames).not.toContain('desktop_ai_ask');
    expect(buildActionContract(text).preferredTools[0]).toBe('external_cli_run');
  });
  it.each(['打开 Codex 桌面端聊天窗口', '读取 Codex 聊天记录', '不要调用 Claude'])('does not steal a desktop/history/negative request: %s', text => expect(isExternalCliRequest(text)).toBe(false));
  it('has a complete tool manifest and enough time for a coding task', () => {
    const registry = new ToolRegistry(); registerExternalCliTools(registry);
    expect(registry.getCapabilityManifest().find(tool => tool.toolName === 'external_cli_run')).toMatchObject({ lane: 'agents', operation: 'mutate', configuredSecurityLevel: 'confirm' });
    expect(getToolExecutionTimeoutMs('external_cli_run')).toBeGreaterThan(900000);
    const capability = registry.getCapabilityManifest().find(tool => tool.toolName === 'external_cli_run');
    expect(verifyCapabilityReceipt(capability, { result: JSON.stringify({ ok: true, status: 'completed', exitCode: 0, runId: 'test-run-123', response: 'inspection complete', verificationScope: 'CLI result', artifacts: [] }) }).status).toBe('verified');
  });
});
