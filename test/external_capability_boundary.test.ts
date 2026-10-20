import { describe, expect, it, vi } from 'vitest';
import type { LumiExecutionDecision } from '../server/cognition/execution_decision';
import { genericExternalCommit, normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import {
  restrictMediaGenerationTools,
} from '../server/cognition/external_capability_boundary';
import { executeForegroundMessagingAction } from '../server/cognition/foreground_messaging_execution';
import { ToolRegistry } from '../server/tools/registry';
import { buildModelCapabilityPolicy } from '../server/cognition/capability_selection';

import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';

const desktopBoundaryCalls = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock('../server/agents/computer_use', () => ({ computerUseLoop: desktopBoundaryCalls.loop }));

function execution(toolNames: string[]): LumiExecutionDecision {
  return {
    allowToolUse: true,
    selfRepairToolPolicy: null,
    clientActionToolPolicy: null,
    baseToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 4 },
    toolRoute: {
      toolNames,
      categories: ['messaging'],
      reasons: [],
      totalAvailable: 2,
      maxTools: 10,
      truncated: false,
      unavailableMcpServers: [],
    },
    toolPolicy: { allowedTools: toolNames, forbiddenTools: [], requireConfirmation: ['wechat_send_message'], maxIterations: 4 },
    maxIterations: 4,
    promptOverlay: '',
  };
}

const manifest: any[] = [
  {
    toolName: 'wechat_read_recent_chat', family: 'messaging', lane: 'messaging',
    sideEffects: [{ type: 'network_read', scope: 'chat', reversible: true }],
  },
  {
    toolName: 'wechat_send_message', family: 'messaging', lane: 'messaging',
    sideEffects: [{ type: 'external_communication', scope: 'recipient', reversible: false }],
  },
];

describe('accepted instruction / selected capability boundary', () => {
  it('refuses high-consequence selected desktop actions while preserving the original negated request', async () => {
    const registry = new ToolRegistry(); registerComputerUseTool(registry);
    const desktopRelay = vi.fn();
    desktopBoundaryCalls.loop.mockReset().mockRejectedValue(new Error('OFFLINE_DESKTOP_LOOP_SENTINEL'));
    const context = { userId: 'external-boundary-offline', domain: 'personal', source: 'offline', authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' as const, userConfirmed: true, currentTurnExecutionRequested: true, desktopRelay, llmGetters: { getDeepSeek: () => null, getGemini: () => null } };
    for (const { text, kind } of [
      { text: '把这份合同提交到供应商门户', kind: 'external_submit' },
      { text: '支付给供应商 500 元', kind: 'payment' },
    ]) {
      expect(genericExternalCommit(text)).toMatchObject({ kind, sideEffectClass: 'external_commit', operation: 'mutate' });
      await expect(registry.execute('computer_use', { task: text }, { ...context, actionIntent: text })).rejects.toThrow('final external commit');
    }
    expect(desktopBoundaryCalls.loop).not.toHaveBeenCalled();
    expect(normalizeActionIntent('我没有让你提交这份合同')).not.toMatchObject({
      sideEffectClass: 'external_commit',
    });
    await expect(registry.execute('computer_use', { task: '我没有让你提交这份合同' }, { ...context, actionIntent: '我没有让你提交这份合同' })).rejects.toThrow('OFFLINE_DESKTOP_LOOP_SENTINEL');
    expect(desktopBoundaryCalls.loop).toHaveBeenCalledOnce();
    expect(desktopBoundaryCalls.loop).toHaveBeenCalledWith('我没有让你提交这份合同', expect.any(Object));
    expect(desktopRelay).not.toHaveBeenCalled();
  });

  it('candidate send exposure does not fabricate an action-time grant or block the read route', () => {
    const routed = execution(['wechat_read_recent_chat', 'wechat_send_message']);
    const guarded = restrictMediaGenerationTools({ normalizedIntent: normalizeActionIntent('看一下张勇最近给我发什么消息了'), execution: routed, manifest });
    expect(guarded).toBe(routed);
    expect(guarded.toolPolicy.requireConfirmation).toContain('wechat_send_message');
    expect(guarded.toolRoute?.toolNames).toContain('wechat_read_recent_chat');
    expect(guarded.promptOverlay).not.toContain('External Commit Authorization Boundary');
  });

  it('retains the actual outbound confirmation policy without inventing a preselected action', () => {
    const routed = execution(['wechat_send_message']);
    const guarded = restrictMediaGenerationTools({ normalizedIntent: normalizeActionIntent('给张勇发「明天上午十点开会」'), execution: routed, manifest });
    expect(guarded).toBe(routed);
    expect(guarded.toolPolicy.requireConfirmation).toContain('wechat_send_message');
  });

  it('does not turn a route with no actual send call into a failed external task', async () => {
    const routed = execution(['wechat_read_recent_chat']);
    expect(restrictMediaGenerationTools({ normalizedIntent: normalizeActionIntent('给张勇发「明天见」'), execution: routed, manifest })).toBe(routed);
    const registry = new ToolRegistry();
    await expect(registry.execute('wechat_send_message', { contact: '张勇', message: '明天见' }, { userId: 'unregistered-send-user' })).rejects.toThrow('not found in registry');
  });
});

describe('shared foreground messaging execution', () => {
  it('rejects a send call whose normalized semantics are read-only', async () => {
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register({
      name: 'wechat_send_message',
      description: 'send',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'safe',
      handler: async () => {
        calls += 1;
        return JSON.stringify({ sent: true, verificationStatus: 'verified' });
      },
    } as any);
    const result = await executeForegroundMessagingAction({
      action: 'send',
      normalizedIntent: normalizeActionIntent('看一下张勇最近给我发什么消息了'),
      arguments: { contact: '张勇', message: '最近给我发什么消息了' },
      registry,
      context: { userId: 'shadow-user', userConfirmed: true },
    });
    expect(result.record.error).toContain('rejected normalized intent');
    expect(result.record.envelope?.status).toBe('failed');
    expect(calls).toBe(0);
  });

  it('executes an exactly bound send through the canonical registry once', async () => {
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register({
      name: 'wechat_send_message',
      description: 'send',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'safe',
      handler: async () => {
        calls += 1;
        return JSON.stringify({ sent: true, verificationStatus: 'verified' });
      },
    } as any);
    const result = await executeForegroundMessagingAction({
      action: 'send',
      normalizedIntent: normalizeActionIntent('给张勇发「明天见」'),
      arguments: { contact: '张勇', message: '明天见' },
      registry,
      context: { userId: 'shadow-user', userConfirmed: true },
    });
    expect(result.record.error).toBeFalsy();
    expect(JSON.parse(result.record.result).sent).toBe(true);
    expect(result.record.envelope?.status).toBe('verified_success');
    expect(calls).toBe(1);
  });
});
