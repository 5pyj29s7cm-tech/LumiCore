import './helpers';
import { describe, expect, it } from 'vitest';
import type { Memory } from '../server/memory/types';

describe('retrieved context entity grounding', () => {
  it('labels recalled memory as sourced evidence with an unconfirmed entity binding', async () => {
    const { formatMemoriesForContext } = await import('../server/memory/store');
    const recalled: Memory = {
      id: 'memory-old-project',
      userId: 'memory-grounding-user',
      type: 'fact',
      content: 'Aurora customer follow-up requires a requirements draft before external delivery.',
      keywords: ['Aurora', 'customer', 'follow-up'],
      confidence: 0.93,
      sourceInteractionId: 'conversation-old-project-turn-7',
      createdAt: '2026-08-17T18:02:28.511Z',
      updatedAt: '2026-08-17T18:02:28.511Z',
      lastRetrievedAt: null,
      retrieveCount: 0,
      tier: 'episodic',
      perspective: 'owner_trait',
      importance: 0.6,
      parentId: null,
      agentId: '',
      nodeType: 'leaf',
      source: 'chat',
      domain: 'personal',
      orgId: '',
    };

    const context = formatMemoriesForContext([recalled], {
      currentTurnText: 'Remember the random code Aurora-29. It has no meaning yet.',
    });

    expect(context).toContain('source=chat');
    expect(context).toContain('interaction=conversation-old-project-turn-7');
    expect(context).toContain('recorded=2026-08-17T18:02:28.511Z');
    expect(context).toContain('memory-confidence=0.93');
    expect(context).toContain('entity-binding=unconfirmed');
    expect(context).toContain('exact token');
    expect(context).toContain('not whether a current name, code, person, customer, project, or task is the same entity');
  });

  it('does not disclose unrelated task fields in ordinary chat even when a new code shares its name stem', async () => {
    const { initDatabase } = await import('../db_layer');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { buildLumiRuntimeCapabilityContext } = await import('../server/cognition/capability_context');
    await initDatabase();

    const userId = 'runtime-entity-grounding-ordinary';
    const oldTask = createWorkTakeoverTask({
      userId,
      category: 'customer',
      title: 'Aurora customer follow-up loop',
      nextActions: ['organize customer requirements', 'send after approval'],
      confirmationRequired: ['external delivery requires confirmation'],
      source: 'chat',
      status: 'in_progress',
    });
    const text = 'Remember the random code Aurora-29. How would you help me complete my work today?';
    const flow = buildLumiTurnFlow({
      userId,
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.workTakeover.strength).toBe('none');
    expect(flow.workTakeover.shouldResumeTask).toBe(false);

    const context = buildLumiRuntimeCapabilityContext({
      userId,
      text,
      flow,
      toolRegistry: new ToolRegistry(),
      domain: 'personal',
      orgId: '',
    });

    expect(context).toContain('Unfinished task inventory: available (details disclosed=0)');
    expect(context).toContain('details are intentionally omitted');
    expect(context).not.toContain(oldTask.id);
    expect(context).not.toContain(oldTask.title);
    expect(context).not.toContain('organize customer requirements');
    expect(context).not.toContain('external delivery requires confirmation');
  });

  it('keeps ambiguous task recall available as an explicitly unbound candidate', async () => {
    const { initDatabase } = await import('../db_layer');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { buildLumiRuntimeCapabilityContext } = await import('../server/cognition/capability_context');
    await initDatabase();

    const userId = 'runtime-entity-grounding-hint';
    const task = createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: 'Quarterly report follow-up',
      nextActions: ['review missing evidence'],
      source: 'chat',
      status: 'in_progress',
    });
    const text = 'What is the next step?';
    const flow = buildLumiTurnFlow({
      userId,
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.workTakeover.strength).toBe('hint');
    expect(flow.workTakeover.shouldResumeTask).toBe(false);

    const context = buildLumiRuntimeCapabilityContext({
      userId,
      text,
      flow,
      toolRegistry: new ToolRegistry(),
    });

    expect(context).toContain('Unbound active task candidates');
    expect(context).toContain(task.id);
    expect(context).toContain('source=persisted work-takeover ledger');
    expect(context).toContain('binding=unconfirmed-candidate');
    expect(context).toContain('it is not entity identity');
  });

  it('preserves a ledger-backed task binding for an explicit continuation', async () => {
    const { initDatabase } = await import('../db_layer');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { buildLumiRuntimeCapabilityContext } = await import('../server/cognition/capability_context');
    await initDatabase();

    const userId = 'runtime-entity-grounding-direct';
    const task = createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: 'Explicit continuation task',
      nextActions: ['perform the next verified step'],
      source: 'chat',
      status: 'in_progress',
    });
    const text = 'Continue this task now.';
    const flow = buildLumiTurnFlow({
      userId,
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.workTakeover.shouldResumeTask).toBe(true);

    const context = buildLumiRuntimeCapabilityContext({
      userId,
      text,
      flow,
      toolRegistry: new ToolRegistry(),
    });

    expect(context).toContain('Bound active task evidence');
    expect(context).toContain(task.id);
    expect(context).toContain('binding=confirmed-by-current-turn');
  });
});
