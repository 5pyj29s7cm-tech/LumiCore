import './helpers';
import { describe, expect, it } from 'vitest';
import { translations } from '../src/lib/translations';
import { getPersonalClientSurfaceByAction } from '../shared/client_surfaces';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { hasClientActionIntent, hasClientActionOnlyIntent, shouldAllowToolUseForTurn } from '../server/cognition/tool_intent';
import { getClientActionExpectation, getClientCapabilities, getClientInterfaceSurfaces, normalizeClientActionTarget, verifyClientActionResult, type ClientStateSnapshot } from '../server/client/self_model';

const aliases = ['记忆领地', 'Memory Territory', '记忆化身', '记忆头像', '记忆空间', 'memory avatar', 'memory avatars', 'memory sanctuary'];
describe('memory territory navigation compatibility', () => {
  it('shows the new destination name in the shell and client self model without renaming its stable action', () => {
    expect(translations.zh.memoryAvatars).toBe('记忆领地');
    expect(translations.en.memoryAvatars).toBe('Memory Territory');
    expect(getPersonalClientSurfaceByAction('open_memory_avatar')).toMatchObject({ id: 'memory-avatar', target: 'memory-avatar', label: 'Memory Territory' });
    expect(getClientCapabilities([]).find(capability => capability.id === 'workspace.memory_avatar')).toMatchObject({ label: 'Memory Territory', actions: ['open_memory_avatar', 'close_client_surface(memory-avatar)'] });
    expect(getClientInterfaceSurfaces().find(surface => surface.id === 'memory-avatar')?.label).toBe('Memory Territory');
  });
  it.each(aliases)('routes the spoken or typed alias %s through the same native action', alias => {
    const command = /[\u3400-\u9fff]/u.test(alias) ? `打开${alias}` : `Open ${alias}`;
    const intent = normalizeActionIntent(command);
    expect(intent).toMatchObject({ kind: 'client_navigation', target: 'memory-avatar', clientAction: 'open_memory_avatar', sideEffectClass: 'none' });
    expect(hasClientActionIntent(command)).toBe(true);
    expect(hasClientActionOnlyIntent(command)).toBe(true);
    for (const source of ['chat', 'voice']) {
      expect(shouldAllowToolUseForTurn(command, source, 'assistant')).toBe(true);
      expect(shouldAllowToolUseForTurn(command, source, 'meeting')).toBe(true);
    }
    expect(normalizeClientActionTarget(alias)).toBe('memory-avatar');
  });
  it('keeps interface questions in conversation and requires visible client state to confirm navigation', () => {
    expect(hasClientActionOnlyIntent('记忆领地是什么？')).toBe(false);
    expect(hasClientActionIntent('What is Memory Territory?')).toBe(false);
    const action = { action: 'open_memory_avatar', target: '记忆领地' };
    const before: ClientStateSnapshot = { platform: 'desktop', mode: 'assistant', workDomain: 'personal', activeTab: 'home', surfaces: { memoryAvatarOpen: false } };
    const after: ClientStateSnapshot = { ...before, surfaces: { memoryAvatarOpen: true } };
    const receipt = { ok: true, action: 'open_memory_avatar', target: 'memory-avatar' };
    expect(getClientActionExpectation(action)).toMatchObject({ target: 'memory-avatar', expectedState: ['surface:memory-avatar:open'] });
    expect(verifyClientActionResult(action, before, before, receipt).status).toBe('pending');
    const verified = verifyClientActionResult(action, before, after, receipt);
    expect(verified.status).toBe('verified'); expect(verified.message).toContain('Memory Territory');
  });
});
