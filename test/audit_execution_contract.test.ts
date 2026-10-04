import { resolveUserTurn } from '../server/cognition/turn_resolution';
import { revalidateAcceptedTaskRelation } from '../server/cognition/task_concurrency';
import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildActionContract } from '../server/cognition/action_contract';
import { buildClientSurfaceContinuationBridge } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
const registry = new ToolRegistry();
beforeAll(async () => { await initDatabase(); registerAllTools(registry); });
const plan = (text: string, context = '') => buildLumiExecutionPipeline({
    registry, personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 16 },
    dispatch: { userId: 'audit-regression', channel: 'chat', source: 'chat', text, continuationContext: context, targetIsLumi: true },
});
describe('accepted-turn decision consistency', () => {
    it('retains accepted wording and rejects a changed task revision without reinterpretation', () => {
        const state = { taskId: 'task-original', revision: 2, unfinished: true, status: 'running', goal: '读取文件' } as any;
        const accepted = resolveUserTurn({ requestId: 'request-original', userText: '继续', state });
        const refreshed = revalidateAcceptedTaskRelation(accepted.taskRelation, { ...state, revision: 3 });
        expect(refreshed).toMatchObject({ taskId: 'task-original', revision: 2, binding: 'stale', operation: 'reject_stale' });
        expect(accepted.userText).toBe('继续');
        expect(Object.isFrozen(accepted)).toBe(true);
        expect(Object.isFrozen(accepted.userIntent)).toBe(true);
    });
    it('refuses reuse of a semantic snapshot for a different user request', () => {
        const accepted = resolveUserTurn({ requestId: 'one', userText: '你好' });
        expect(() => buildLumiExecutionPipeline({ registry, acceptedResolution: accepted, requestId: 'two',
            dispatch: { userId: 'audit', channel: 'chat', text: '执行另一个操作', targetIsLumi: true } })).toThrow(/does not match this request/);
    });
    it.each(['后台任务进度怎么样', '后台任务状态', '你现在有在执行的任务吗'])('reads the runtime ledger for %s', text => {
        const p = plan(text);
        expect(p.normalizedIntent.target).toBe('runtime_work');
        expect(p.executionRequested).toBe(true);
        expect(p.modelToolProjection.toolNames).toEqual(['runtime_work_status']);
        expect(p.authorizationPolicy.allowedTools).toEqual(['runtime_work_status']);
    });
    it.each(['你好', '今天心情不太好，陪我聊聊。'])('keeps actual tools off for %s', text => {
        const p = plan(text);
        expect(p.executionRequested).toBe(false);
        expect(p.modelToolProjection.toolNames).toEqual([]);
        expect(p.execution.promptOverlay).toContain('tools=off');
    });
    it('does not authorize an unbound continuation through a UI bridge', () => {
        const bridge = buildClientSurfaceContinuationBridge('继续', [{ role: 'user', content: '看看知识库界面' }]);
        expect(bridge).not.toBe('');
        const p = plan('继续', bridge);
        expect(p.trustedActionContinuation).toBe(false);
        expect(p.executionRequested).toBe(false);
        expect(p.modelToolProjection.toolNames).toEqual([]);
    });
    it.each(['Codex', 'ChatGPT', 'CAD', 'finance', 'status'])('treats %s in a path as file data', dir => {
        const text = '读取 D:/' + dir + '/receipt.txt，告诉我实际文件内容。';
        const p = plan(text);
        expect(p.normalizedIntent.operation).toBe('read');
        expect(p.modelToolProjection.toolNames).toEqual(plan('读取 D:/fixtures/receipt.txt，告诉我实际文件内容。').modelToolProjection.toolNames);
        expect(p.modelToolProjection.toolNames).not.toContain('desktop_ai_collect_answer');
        expect(p.modelToolProjection.toolNames).not.toContain('runtime_work_status');
        expect(buildActionContract(text).kind).not.toBe('external_ai_request');
    });
    it('retains explicitly requested external AI actions', () => {
        expect(buildActionContract('Ask Codex to review this implementation and collect its answer.').kind).toBe('external_ai_request');
    });
});
