import './helpers';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import * as memory from '../server/memory';
import * as repository from '../server/memory/repository';
import * as llm from '../server/llm/providers';
import { createPersonalMemoryTasks } from '../server/scheduler/builtins/personal_memory';
import { createGrowthTasks } from '../server/scheduler/builtins/growth';
import { createProactiveContextTasks } from '../server/scheduler/builtins/proactive_context';

beforeAll(async () => { await initDatabase(); });
afterEach(() => vi.restoreAllMocks());
const context = { getAllUserIds: () => ['scheduled-cancel-owner'], getSystemAdminUserIds: () => [], redactSchedulerDiagnostic: (v: unknown) => String(v), getters: {} } as any;
const factories = [createPersonalMemoryTasks, createGrowthTasks, createProactiveContextTasks];
const ids = ['evening_wrapup', 'growth_journal', 'proactive_lumi_scan'];

describe('scheduled builtin cancellation', () => {
  it.each(ids)('%s propagates cancellation and discards a late model result before memory writes', async id => {
    const controller = new AbortController();
    vi.spyOn(memory, 'getDueReminders').mockReturnValue([]);
    vi.spyOn(memory, 'queryMemories').mockReturnValue([{ type: 'habit', content: 'a saved user habit' }] as any);
    vi.spyOn(repository, 'listMemoryRows').mockReturnValue(Array.from({ length: 12 }, (_, i) => ({ id: String(i), type: 'fact', content: 'saved evidence', createdAt: new Date().toISOString(), confidence: 0.8 })) as any);
    const write = vi.spyOn(memory, 'addMemory');
    const call = vi.spyOn(llm, 'makeLLMCall').mockImplementation(async (...args: any[]) => {
      expect(args[2].signal).toBeInstanceOf(AbortSignal);
      expect(args[2].signal.aborted).toBe(false);
      controller.abort(new Error('scheduler cancelled'));
      expect(args[2].signal.aborted).toBe(true);
      return { text: 'late model result' } as any;
    });
    const task = factories.flatMap(factory => factory(context)).find(t => t.id === id)!;
    await expect(task.handler({ signal: controller.signal } as any)).rejects.toThrow('scheduler cancelled');
    expect(call).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
});
