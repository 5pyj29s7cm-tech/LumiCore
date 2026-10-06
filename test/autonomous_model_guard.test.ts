import './helpers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initDatabase, querySQL } from '../db_layer';
import { enqueue, getTaskHistory, getTaskQueue, resetAutonomousTaskQueueForTest } from '../server/autonomy/task_queue';
import { executeNextAutonomousTask } from '../server/autonomy/task_executor';
import { resetRealtimeUserActivityForTests } from '../server/autonomy/foreground_activity';
import { ToolRegistry, toolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
const model = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/adapter', async original => ({ ...await original<typeof import('../server/llm/adapter')>(), runWithTools: model }));
vi.mock('../server/llm/user_preferences', async original => ({ ...await original<typeof import('../server/llm/user_preferences')>(),
  getUserPreferredLLMConfig: () => ({ provider: 'deepseek', model: 'synthetic-model' }) }));
beforeEach(async () => { await initDatabase(); model.mockReset(); resetRealtimeUserActivityForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  toolRegistry.register({ name: 'web_search', description: 'Synthetic public source', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async () => JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/source' }] }) });
});
afterEach(() => { resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true }); toolRegistry.unregister('web_search'); });
it.each([false, true])('preserves the final model guard after a real successful autonomous substep: blocked=%s', async blocked => {
  const userId = 'autonomous-guard-' + blocked;
  const task = enqueue({ userId, title: 'Research a public standard', description: 'Research the current public standard and summarize the result.',
    source: 'user_request', priority: 5, mode: 'analysis' })!;
  let receipt: Awaited<ReturnType<typeof executeToolCall>>;
  model.mockImplementationOnce(async (...args: any[]) => {
    receipt = await executeToolCall({ registry: args[1] as ToolRegistry, id: task.id + ':source', name: 'web_search', arguments: { query: 'synthetic standard' }, context: args[11] });
    expect(receipt.error).toBeUndefined(); await args[3]?.(receipt);
    return { text: 'Research completed with a current public source.', toolCalls: [receipt], usageRecords: [],
      ...(blocked ? { completionGuard: { text: 'The model response could not be completed.', blocked: true, reason: 'conversation_response_incomplete' } } : {}) };
  });
  const emit = vi.fn();
  await executeNextAutonomousTask({ to: () => ({ emit }) } as any, { getDeepSeek: () => null, getGemini: () => null }, userId);
  expect(model).toHaveBeenCalledOnce();
  const history = [...getTaskHistory(50, 0, userId), ...getTaskQueue(userId)].find(item => item.id === task.id)!;
  const completed = emit.mock.calls.some(([event]) => event === 'autonomous:task_completed');
  expect(completed).toBe(!blocked);
  expect(history.status === 'completed').toBe(!blocked);
  if (blocked) { expect(history.verified).not.toBe(true); expect(history.checkpoint?.receipts?.some(item => item.id === receipt!.id)).toBe(true); }
  expect((await querySQL<{status: string}>('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id]))[0].status === 'completed').toBe(!blocked);
});
