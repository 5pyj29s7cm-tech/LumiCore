import { describe, expect, it, vi } from 'vitest';
import baseline from './fixtures/scheduler_builtin_contract.json';
import { registerScheduledTasks, scheduler } from '../server/scheduler';
import * as database from '../db_layer';

describe('scheduler builtin registration compatibility', () => {
  it('keeps all 27 task names, order, schedules, audit modes and execution classes', () => {
    const tasks: any[] = [];
    const spy = vi.spyOn(scheduler, 'register').mockImplementation(task => { tasks.push(task); });
    try { registerScheduledTasks(() => null, () => null); } finally { spy.mockRestore(); }
    expect(tasks.map(({ handler, ...metadata }) => metadata)).toEqual(baseline);
    expect(tasks.every(task => typeof task.handler === 'function')).toBe(true);
    expect(new Set(tasks.map(task => task.id)).size).toBe(27);
  });
  it('does not read users, invoke models or execute handlers while creating task definitions', () => {
    const getClient = vi.fn(), read = vi.spyOn(database, 'readDB'), registrations = vi.spyOn(scheduler, 'register').mockImplementation(() => {});
    try {
      registerScheduledTasks(getClient, getClient);
      expect(read).not.toHaveBeenCalled(); expect(getClient).not.toHaveBeenCalled();
      expect(registrations).toHaveBeenCalledTimes(27);
    } finally { registrations.mockRestore(); read.mockRestore(); }
  });
});
