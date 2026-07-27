import { describe, expect, it } from 'vitest';
import type { LumiExecutionDecision } from '../server/cognition/execution_decision';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import {
  applyLumiRoutingShadowGuard,
  compareLumiRoutingShadow,
} from '../server/cognition/routing_shadow_guard';
import { executeForegroundMessagingAction } from '../server/cognition/foreground_messaging_execution';
import { ToolRegistry } from '../server/tools/registry';

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

describe('normalized/legacy routing shadow guard', () => {
  it('normalizes high-consequence external commits without relying on one action word', () => {
    expect(normalizeActionIntent('把这份合同提交到供应商门户')).toMatchObject({
      kind: 'external_submit', sideEffectClass: 'external_commit', operation: 'mutate',
    });
    expect(normalizeActionIntent('支付给供应商 500 元')).toMatchObject({
      kind: 'payment', sideEffectClass: 'external_commit', operation: 'mutate',
    });
    expect(normalizeActionIntent('我没有让你提交这份合同')).not.toMatchObject({
      sideEffectClass: 'external_commit',
    });
  });

  it('blocks every external tool when a read is misrouted as send', () => {
    const legacy = execution(['wechat_read_recent_chat', 'wechat_send_message']);
    const comparison = compareLumiRoutingShadow({
      normalizedIntent: normalizeActionIntent('看一下张勇最近给我发什么消息了'),
      execution: legacy,
      manifest,
    });
    const guarded = applyLumiRoutingShadowGuard(legacy, comparison);
    expect(comparison.externalCommitBlocked).toBe(true);
    expect(guarded.toolPolicy.forbiddenTools).toContain('wechat_send_message');
    expect(guarded.toolRoute?.toolNames).toEqual(['wechat_read_recent_chat']);
  });

  it('allows an exact outbound route to proceed to strict confirmation', () => {
    const legacy = execution(['wechat_send_message']);
    const comparison = compareLumiRoutingShadow({
      normalizedIntent: normalizeActionIntent('给张勇发「明天上午十点开会」'),
      execution: legacy,
      manifest,
    });
    expect(comparison.aligned).toBe(true);
    expect(comparison.externalCommitBlocked).toBe(false);
    expect(applyLumiRoutingShadowGuard(legacy, comparison)).toBe(legacy);
  });

  it('fails closed when normalized send has no matching legacy commit route', () => {
    const legacy = execution(['wechat_read_recent_chat']);
    const comparison = compareLumiRoutingShadow({
      normalizedIntent: normalizeActionIntent('给张勇发「明天见」'),
      execution: legacy,
      manifest,
    });
    expect(comparison.externalCommitBlocked).toBe(true);
    expect(comparison.blockedExternalTools).toContain('wechat_send_message');
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
