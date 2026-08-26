// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: () => true };
});

import { buildCommandCenterCosmosAgents, buildCommandCenterCosmosTasks } from './CommandCenterPanel';
import { LocalAgentSphere, type LocalAgentCosmosLabels } from './LocalAgentSphere';

const labels: LocalAgentCosmosLabels = {
  aria: 'Live command cosmos',
  liveState: 'Live state',
  lumi: 'Lumi',
  agents: 'Agents',
  active: 'Active',
  ready: 'Ready',
  working: 'Working',
  paused: 'Paused',
  attention: 'Attention',
  noWorkers: 'No workers',
  noTasks: 'No tasks',
};

describe('LocalAgentSphere command cosmos', () => {
  let canvasContextSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    canvasContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(cleanup);
  afterAll(() => canvasContextSpy.mockRestore());

  it('maps real agents and their active task receipts into inspectable orbital bodies and routes', () => {
    const taskRecords = [{
      id: 'task-42',
      title: 'Verify launch evidence',
      status: 'running',
      workerNames: ['Research'],
    }];
    const agents = buildCommandCenterCosmosAgents([
      { id: 'lumi', name: 'Lumi' },
      { id: 'agent-research', name: 'Research', category: 'research', runtime: 'internal' },
      { id: 'agent-design', name: 'Design', category: 'design', runtime: 'external', healthStatus: 'offline' },
    ], taskRecords);
    const tasks = buildCommandCenterCosmosTasks(taskRecords, agents);

    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ id: 'agent-research', state: 'working', taskId: 'task-42' });
    expect(agents[1]).toMatchObject({ id: 'agent-design', state: 'attention' });
    expect(tasks[0]).toMatchObject({ id: 'task-42', active: true, workerIds: ['agent-research'] });

    const { container } = render(
      <LocalAgentSphere
        t={{}}
        variant="command-center"
        cosmosAgents={agents}
        cosmosTasks={tasks}
        cosmosState="working"
        cosmosLabels={labels}
      />,
    );

    const root = container.querySelector('[data-local-agent-sphere]');
    expect(root?.getAttribute('data-variant')).toBe('command-center');
    expect(root?.getAttribute('data-performance')).toBe('balanced');
    expect(root?.getAttribute('data-reduced-motion')).toBe('true');
    expect(root?.querySelectorAll('[data-cosmos-agent-id]')).toHaveLength(2);
    expect(root?.querySelector('[data-cosmos-agent-id="agent-research"]')?.getAttribute('data-cosmos-agent-state')).toBe('working');
    expect(root?.querySelector('[data-cosmos-agent-id="agent-research"]')?.getAttribute('data-task-id')).toBe('task-42');
    expect(root?.querySelector('[data-task-route][data-task-id="task-42"]')?.getAttribute('data-worker-id')).toBe('agent-research');
    expect(root?.querySelector('[data-active-task-count="1"]')).not.toBeNull();
  });

  it('shows only real unassigned task signals and has explicit empty states', () => {
    const { container, rerender } = render(
      <LocalAgentSphere
        t={{}}
        variant="command-center"
        cosmosTasks={[{
          id: 'task-unassigned',
          title: 'Awaiting worker',
          status: 'queued',
          workerIds: [],
        }]}
        cosmosLabels={labels}
      />,
    );

    expect(container.querySelectorAll('[data-cosmos-unassigned-task]')).toHaveLength(1);
    expect(container.querySelector('[data-cosmos-unassigned-task]')?.getAttribute('data-task-id')).toBe('task-unassigned');
    expect(container.querySelector('[data-empty="agents"]')?.textContent).toContain('No workers');

    rerender(
      <LocalAgentSphere
        t={{}}
        variant="command-center"
        cosmosAgents={[{ id: 'agent-idle', name: 'Idle', category: 'general', runtime: 'internal', state: 'ready' }]}
        cosmosTasks={[]}
        cosmosLabels={labels}
      />,
    );

    expect(container.querySelector('[data-empty="agents"]')).toBeNull();
    expect(container.querySelector('[data-empty="tasks"]')?.textContent).toContain('No tasks');
    expect(container.querySelectorAll('[data-cosmos-unassigned-task]')).toHaveLength(0);
  });
});
