import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { ToolRegistry } from '../server/tools/registry';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
import { addMessageIdempotent, getOrCreateActiveConversation, prepareConversationActionExecution, setConversationActionExecutionStatus } from '../server/conversation/manager';
const calls = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock('../server/agents/computer_use', () => ({ computerUseLoop: calls.loop }));
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/generic_external_commit_action_boundary.json'), 'utf8'));
let network: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NO_NETWORK')); await initDatabase(); });
afterAll(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });
const context = { userId: 'intent-boundary-isolated', domain: 'personal', source: 'offline', authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' as const, userConfirmed: true, currentTurnExecutionRequested: true, desktopRelay: vi.fn(), llmGetters: { getDeepSeek: () => null, getGemini: () => null } };
describe('generic commit ownership at selected desktop action', () => {
  it.each(fixture.sourceCases)('$id never steals a whole source/negative turn as an external mutation', f => {
    expect(normalizeActionIntent(f.text).sideEffectClass).not.toBe('external_commit');
  });
  it('keeps the exact original defendant request out of the signature lane', () => {
    expect(normalizeActionIntent(fixture.actualDefendant.text).sideEffectClass).not.toBe('external_commit');
  });
  it.each(fixture.positiveCases)('$id refuses the real args.task before the computer loop despite userConfirmed', async f => {
    const registry = new ToolRegistry(); registerComputerUseTool(registry);
    calls.loop.mockReset().mockRejectedValue(new Error('OFFLINE_LOOP_SENTINEL'));
    const desktop = vi.fn();
    await expect(registry.execute('computer_use', { task: f.text }, { ...context, actionIntent: '仅检查当前页面', desktopRelay: desktop })).rejects.toThrow('final external commit');
    expect(calls.loop).not.toHaveBeenCalled(); expect(desktop).not.toHaveBeenCalled();
  });
  it('does not let payment in old continuation context become a new desktop commit', async () => {
    const registry = new ToolRegistry(); registerComputerUseTool(registry);
    calls.loop.mockReset().mockRejectedValue(new Error('OFFLINE_LOOP_SENTINEL'));
    const text = fixture.sourceCases.find(f => f.id === 'history-not-authority').text;
    await expect(registry.execute('computer_use', { task: text }, { ...context, actionIntent: text })).rejects.toThrow('OFFLINE_LOOP_SENTINEL');
    expect(calls.loop).toHaveBeenCalledOnce();
  });
  it('retains the already supported messaging/media external check', async () => {
    const registry = new ToolRegistry(); registerComputerUseTool(registry);
    calls.loop.mockReset().mockRejectedValue(new Error('OFFLINE_LOOP_SENTINEL'));
    for (const task of ['给张勇发「明天见」', '帮我生成一张猫的图片']) {
      await expect(registry.execute('computer_use', { task }, { ...context, actionIntent: task })).rejects.toThrow('final external commit');
    }
    expect(calls.loop).not.toHaveBeenCalled();
  });
  it('keeps the original legal goal and its waiting-confirmation task binding', () => {
    const text = fixture.actualDefendant.text;
    const userId = 'ledger-original-legal-task';
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = 'intent-boundary-original-request';
    const userMessageId = addMessageIdempotent({ userId, agentId: 'lumi', conversationId: conversation.id, role: 'user', content: text, requestId, deferActionPreparation: true, domain: 'personal' });
    const created = prepareConversationActionExecution({ userId, conversationId: conversation.id, userText: text, requestId, userMessageId, forceTask: true, toolPolicy: { allowedTools: ['legal_generate_litigation_packet'], requireConfirmation: ['legal_generate_litigation_packet'], forbiddenTools: [], maxIterations: 4 } });
    const expectedGoal = text.replace(/\s+/gu, ' ').trim().slice(0,700);
    expect(created.state?.goal).toBe(expectedGoal);
    expect(created.state?.goal).not.toMatch(/^signature:/);
    setConversationActionExecutionStatus(conversation.id, userId, 'waiting_confirmation', { requestId });
    const task = (readDB().conversationActionTasks || []).find(row => row.id === created.state?.taskId);
    expect(task).toMatchObject({ goal: expectedGoal, status: 'waiting_confirmation', rootUserMessageId: userMessageId });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState?.taskId).toBe(created.state?.taskId);
  });
});
