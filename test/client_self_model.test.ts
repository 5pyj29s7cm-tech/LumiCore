import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerClientSelfTools } from '../server/tools/definitions/client_self_tools';
import {
  formatClientSelfPrompt,
  getClientActionExpectation,
  getClientSelfAwarenessReport,
  updateClientState,
  verifyClientActionResult,
} from '../server/client/self_model';
import type { ClientStateSnapshot } from '../server/client/self_model';

describe('Lumi client self model', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('verifies client actions against fresh client state instead of intent alone', () => {
    const before = updateClientState('client_self_model_verify_user', {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'home',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: false },
    });
    const after = updateClientState('client_self_model_verify_user', {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'knowledge',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: true },
    });

    const expectation = getClientActionExpectation({ action: 'show_knowledge_base' });
    const verified = verifyClientActionResult(
      { action: 'show_knowledge_base' },
      before,
      after,
      { ok: true, action: 'show_knowledge_base', target: 'knowledge' },
    );

    expect(expectation.expectedState).toContain('surface:knowledge:open');
    expect(verified.status).toBe('verified');
    expect(verified.message).toContain('knowledge base');
    expect(verified.after?.openSurfaces).toContain('knowledge');
  });

  it('marks unconfirmed state changes as pending', () => {
    const before = updateClientState('client_self_model_pending_user', {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'home',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: false },
    });

    const pending = verifyClientActionResult(
      { action: 'show_knowledge_base' },
      before,
      before,
      { ok: true, action: 'show_knowledge_base', target: 'knowledge' },
    );

    expect(pending.status).toBe('pending');
    expect(pending.missing).toContain('surface:knowledge:open');
  });

  it('treats closed overlays as closed even if the active tab label is stale', () => {
    const before = updateClientState('client_self_model_close_user', {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'knowledge',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: true },
    });
    const after = updateClientState('client_self_model_close_user', {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'knowledge',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: false },
    });

    const verified = verifyClientActionResult(
      { action: 'close_app', target: 'knowledge' },
      before,
      after,
      { ok: true, action: 'close_app', target: 'knowledge' },
    );

    expect(verified.status).toBe('verified');
    expect(verified.matched).toContain('surface:knowledge:closed');
  });

  it('pressure-tests common client action expectations across surfaces and modes', () => {
    const cases: Array<{
      name: string;
      args: Record<string, any>;
      before?: Partial<ClientStateSnapshot>;
      after: Partial<ClientStateSnapshot>;
      matched: string;
    }> = [
      {
        name: 'open settings',
        args: { action: 'open_settings' },
        after: {
          activeTab: 'settings',
          windows: { open: ['settings'], focused: 'settings', minimized: [] },
          surfaces: {},
        },
        matched: 'surface:settings:open',
      },
      {
        name: 'open runtime log',
        args: { action: 'open_runtime_log' },
        after: {
          activeTab: 'runtime-log',
          windows: { open: ['runtime-log'], focused: 'runtime-log', minimized: [] },
          surfaces: { runtimeLogOpen: true },
          runtimeLog: { open: true, status: 'ready' },
        },
        matched: 'surface:runtime-log:open',
      },
      {
        name: 'open chat',
        args: { action: 'open_chat' },
        after: {
          activeTab: 'chat',
          windows: { open: [], focused: null, minimized: [] },
          surfaces: { chatOpen: true },
        },
        matched: 'surface:chat:open',
      },
      {
        name: 'open music center',
        args: { action: 'open_music_center' },
        after: {
          activeTab: 'music-center',
          windows: { open: ['music-center'], focused: 'music-center', minimized: [] },
          surfaces: {},
        },
        matched: 'surface:music-center:open',
      },
      {
        name: 'switch assistant mode',
        args: { action: 'set_client_mode', mode: 'assistant' },
        after: {
          mode: 'assistant',
          activeTab: 'home',
          windows: { open: [], focused: null, minimized: [] },
          surfaces: {},
        },
        matched: 'mode:assistant',
      },
      {
        name: 'show music layer',
        args: { action: 'show_music_layer' },
        after: {
          activeTab: 'home',
          windows: { open: [], focused: null, minimized: [] },
          surfaces: { musicLayerVisible: true },
          music: { layerVisible: true, trackName: 'Test Track' },
        },
        matched: 'surface:music-layer:open',
      },
      {
        name: 'disable wallpaper mode',
        args: { action: 'set_wallpaper_mode', enabled: false },
        before: {
          activeTab: 'home',
          windows: { open: [], focused: null, minimized: [] },
          surfaces: { wallpaperMode: true },
        },
        after: {
          activeTab: 'home',
          windows: { open: [], focused: null, minimized: [] },
          surfaces: { wallpaperMode: false },
        },
        matched: 'surface:wallpaper:closed',
      },
    ];

    for (const item of cases) {
      const before = updateClientState(`client_self_model_pressure_${item.name}`, {
        platform: 'desktop',
        mode: 'chat',
        activeTab: 'home',
        windows: { open: [], focused: null, minimized: [] },
        surfaces: {},
        ...(item.before || {}),
      });
      const after = updateClientState(`client_self_model_pressure_${item.name}`, {
        platform: 'desktop',
        mode: 'chat',
        ...item.after,
      });

      const verified = verifyClientActionResult(item.args, before, after, { ok: true, ...item.args });

      expect(verified.status, item.name).toBe('verified');
      expect(verified.matched, item.name).toContain(item.matched);
    }
  });

  it('treats explicit client failure as failed even if state later looks plausible', () => {
    const before = updateClientState('client_self_model_failed_user', {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'home',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: false },
    });
    const after = updateClientState('client_self_model_failed_user', {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'knowledge',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: true },
    });

    const failed = verifyClientActionResult(
      { action: 'show_knowledge_base' },
      before,
      after,
      { ok: false, reason: 'permission_denied' },
    );

    expect(failed.status).toBe('failed');
    expect(failed.message).toBe('permission_denied');
  });

  it('summarizes present client awareness in the self prompt', () => {
    updateClientState('client_self_model_prompt_user', {
      platform: 'desktop',
      mode: 'assistant',
      activeTab: 'home',
      windows: { open: ['runtime-log'], focused: 'runtime-log', minimized: [] },
      surfaces: { runtimeLogOpen: true },
      runtimeLog: { open: true, status: 'ready' },
    });

    const report = getClientSelfAwarenessReport('client_self_model_prompt_user');
    const prompt = formatClientSelfPrompt('client_self_model_prompt_user');

    expect(report.level).toBe('live');
    expect(report.bodySummary).toContain('mode=assistant');
    expect(prompt).toContain('Present-Moment Client Awareness');
    expect(prompt).toContain('Client Action Verification Contract');
    expect(prompt).toContain('verification.status');
  });
});

describe('client self tools', () => {
  it('wraps client_action with before/after state verification', async () => {
    const userId = 'client_self_tool_user';
    updateClientState(userId, {
      platform: 'desktop',
      mode: 'chat',
      activeTab: 'home',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: false },
    });

    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    const calls: Array<{ name: string; args: Record<string, any> }> = [];

    const output = await registry.execute('client_action', {
      action: 'show_knowledge_base',
    }, {
      userId,
      desktopRelay: async (name, args) => {
        calls.push({ name, args });
        if (args.action === 'show_knowledge_base') {
          updateClientState(userId, {
            platform: 'desktop',
            mode: 'chat',
            activeTab: 'knowledge',
            windows: { open: [], focused: null, minimized: [] },
            surfaces: { knowledgeOpen: true },
          });
          return JSON.stringify({ ok: true, action: 'show_knowledge_base', target: 'knowledge' });
        }
        if (args.action === 'refresh_client_state') {
          updateClientState(userId, {
            platform: 'desktop',
            mode: 'chat',
            activeTab: 'knowledge',
            windows: { open: [], focused: null, minimized: [] },
            surfaces: { knowledgeOpen: true },
          });
          return JSON.stringify({ ok: true, action: 'refresh_client_state' });
        }
        return JSON.stringify({ ok: true });
      },
    });

    const parsed = JSON.parse(output);
    expect(calls.map(call => call.args.action)).toEqual(['show_knowledge_base', 'refresh_client_state']);
    expect(parsed.verification.status).toBe('verified');
    expect(parsed.after.openSurfaces).toContain('knowledge');
    expect(parsed.say).toContain('knowledge base');
  });
});
