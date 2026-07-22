import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerClientSelfTools } from '../server/tools/definitions/client_self_tools';
import {
  formatClientSelfPrompt,
  getClientActionExpectation,
  getClientCapabilities,
  getClientInterfaceSurfaces,
  getClientSelfAwarenessReport,
  getClientStateForScope,
  normalizeClientActionTarget,
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

  it('includes real client and organization surfaces in the interface map', () => {
    const ids = getClientInterfaceSurfaces().map(surface => surface.id);

    expect(ids).toEqual(expect.arrayContaining([
      'widget',
      'org-dashboard',
      'org-knowledge',
      'org-lumi',
      'org-messaging',
      'org-legal',
      'org-spatial-design',
      'org-brand-design',
    ]));
    expect(ids).not.toContain('subscription');
  });

  it('verifies an exact organization workspace destination', () => {
    const before = updateClientState('client_self_model_org_view_user', {
      platform: 'desktop',
      mode: 'assistant',
      activeTab: 'home',
      workDomain: 'work',
      org: { connected: true, id: 'org-view-test', role: 'owner' },
      orgWorkspace: { activeView: 'dashboard', availableViews: ['dashboard', 'legal'], visible: false },
      windows: { open: [], focused: null, minimized: [] },
      surfaces: {},
    });
    const after = updateClientState('client_self_model_org_view_user', {
      platform: 'desktop',
      mode: 'assistant',
      activeTab: 'org',
      workDomain: 'work',
      org: { connected: true, id: 'org-view-test', role: 'owner' },
      orgWorkspace: { activeView: 'legal', availableViews: ['dashboard', 'legal'], visible: true },
      windows: { open: [], focused: null, minimized: [] },
      surfaces: {},
    });

    const args = { action: 'open_organization_workspace', section: 'legal' };
    const expectation = getClientActionExpectation(args);
    const verified = verifyClientActionResult(args, before, after, { ok: true, section: 'legal' });

    expect(expectation.expectedState).toEqual(expect.arrayContaining(['surface:org:open', 'org-view:legal']));
    expect(verified.status).toBe('verified');
    expect(verified.after?.openSurfaces).toContain('org:legal');
  });

  it('exposes local machine, visible desktop, and background runtime awareness', () => {
    const capabilities = getClientCapabilities();
    const localMachine = capabilities.find(capability => capability.id === 'system.local_machine_awareness');
    const backgroundRuntime = capabilities.find(capability => capability.id === 'runtime.background_residency');

    expect(localMachine?.actions).toEqual(expect.arrayContaining([
      'desktop_capability_status',
      'desktop_system_info',
      'desktop_list_apps',
      'desktop_list_files',
      'desktop_path_info',
      'desktop_running_processes',
      'desktop_active_window',
      'desktop_capture_screen',
    ]));
    expect(localMachine?.notes).toContain('local machine');
    expect(backgroundRuntime?.actions).toEqual(expect.arrayContaining([
      'client_get_state',
      'client_health_check',
      'open_runtime_log',
      'desktop_idle_time',
      'desktop_poll_activity',
      'autonomy_list_workflows',
      'autonomy_register_workflow',
    ]));
    expect(backgroundRuntime?.notes).toContain('hidden-to-background');
    expect(backgroundRuntime?.notes).toContain('autonomous workflow execution');
  });

  it('normalizes user-facing surface names to client target ids', () => {
    expect(normalizeClientActionTarget('个性化')).toBe('personalization');
    expect(normalizeClientActionTarget('头像工作室')).toBe('personalization');
    expect(normalizeClientActionTarget('声音工作室')).toBe('personalization');
    expect(normalizeClientActionTarget('记忆头像')).toBe('memory-avatar');
    expect(normalizeClientActionTarget('工作队列')).toBe('plans');
    expect(normalizeClientActionTarget('通知面板')).toBe('notifications');
    expect(normalizeClientActionTarget('提醒面板')).toBe('reminders');
    expect(normalizeClientActionTarget('电脑适配中心')).toBe('kernel');
    expect(normalizeClientActionTarget('主屏幕')).toBe('home');
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
          settings: { activeSection: 'general' },
        },
        matched: 'surface:settings:open',
      },
      {
        name: 'open runtime diagnostics',
        args: { action: 'open_runtime_log' },
        after: {
          activeTab: 'kernel',
          windows: { open: ['kernel'], focused: 'kernel', minimized: [] },
          surfaces: { runtimeLogOpen: false },
          runtimeLog: { open: false, status: 'ready' },
        },
        matched: 'surface:kernel:open',
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
      {
        name: 'enter widget mode',
        args: { action: 'enter_widget_mode' },
        after: {
          activeTab: 'home',
          windows: { open: [], focused: null, minimized: [] },
          surfaces: { widgetMode: true },
        },
        matched: 'surface:widget:open',
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
      windows: { open: ['kernel'], focused: 'kernel', minimized: [] },
      surfaces: { runtimeLogOpen: false },
      runtimeLog: { open: false, status: 'ready' },
      runtime: {
        autostartSupported: true,
        autostartEnabled: true,
        closeToBackground: true,
        startedInBackground: false,
        backendNodeRunning: true,
        backendPythonRunning: true,
        nodeRestarts: 1,
        pythonRestarts: 0,
        globalShortcut: 'Alt+Space',
      },
    });

    const report = getClientSelfAwarenessReport('client_self_model_prompt_user');
    const prompt = formatClientSelfPrompt('client_self_model_prompt_user');

    expect(report.level).toBe('live');
    expect(report.bodySummary).toContain('mode=assistant');
    expect(report.knows.join('\n')).toContain('local machine identity');
    expect(report.habits.join('\n')).toContain('resident runtime');
    expect(prompt).toContain('Keep three maps separate and current');
    expect(prompt).toContain('local machine');
    expect(prompt).toContain('visible desktop');
    expect(prompt).toContain('background runtime');
    expect(prompt).toContain('desktop_system_info');
    expect(prompt).toContain('autostartSupported=true');
    expect(prompt).toContain('closeToBackground=true');
    expect(prompt).toContain('backendNode=running');
    expect(prompt).toContain('Present-Moment Client Awareness');
    expect(prompt).toContain('Client Action Verification Contract');
    expect(prompt).toContain('verification.status');
  });

  it('describes one Lumi with scoped knowledge and hides live work state from personal context', () => {
    const userId = 'client_self_model_unified_scope_user';
    updateClientState(userId, {
      platform: 'desktop',
      mode: 'assistant',
      activeTab: 'org',
      workDomain: 'work',
      org: { connected: true, id: 'unified-scope-org', name: 'Private Work Org', role: 'owner' },
      orgWorkspace: { activeView: 'kb', availableViews: ['dashboard', 'kb', 'chat'], visible: true },
      knowledge: {
        domain: 'work',
        orgId: 'unified-scope-org',
        totalFiles: 5,
        indexedFiles: 3,
        partialFiles: 1,
        failedFiles: 1,
        orgArticles: { total: 7, published: 6, indexed: 5, missingIndex: 1, stale: 1 },
      },
      windows: { open: [], focused: null, minimized: [] },
      surfaces: {},
    });

    const workPrompt = formatClientSelfPrompt(userId, { domain: 'work', orgId: 'unified-scope-org' });
    const personalPrompt = formatClientSelfPrompt(userId, { domain: 'personal', orgId: '' });

    expect(workPrompt).toContain('same Lumi');
    expect(workPrompt).toContain('active=kb');
    expect(workPrompt).toContain('orgArticles=7');
    expect(workPrompt).toContain('Never load the organization creator\'s personal data for an employee');
    expect(personalPrompt).toContain('same continuous Lumi');
    expect(personalPrompt).toContain('No live desktop client state has been reported yet.');
    expect(personalPrompt).not.toContain('Private Work Org');
    expect(personalPrompt).not.toContain('orgArticles=7');
    expect(getClientStateForScope(userId, { domain: 'personal' })).toBeNull();
    expect(getClientStateForScope(userId, { domain: 'work', orgId: 'another-org' })).toBeNull();
    expect(getClientStateForScope(userId, { domain: 'work', orgId: 'unified-scope-org' })?.orgWorkspace?.activeView).toBe('kb');
  });
});

describe('client self tools', () => {
  it('scopes client state and personal autonomy data to the active workspace', async () => {
    const userId = 'client_self_tool_scope_user';
    updateClientState(userId, {
      platform: 'desktop',
      mode: 'assistant',
      activeTab: 'org',
      workDomain: 'work',
      org: { connected: true, id: 'client-self-scope-org', name: 'Scoped Tool Org', role: 'owner' },
      orgWorkspace: { activeView: 'chat', availableViews: ['dashboard', 'chat'], visible: true },
      knowledge: { domain: 'work', orgId: 'client-self-scope-org', totalFiles: 2, indexedFiles: 2 },
      windows: { open: [], focused: null, minimized: [] },
      surfaces: {},
    });

    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    const personal = JSON.parse(await registry.execute('client_get_state', {}, {
      userId,
      domain: 'personal',
      orgId: '',
    }));
    const work = JSON.parse(await registry.execute('client_get_state', {}, {
      userId,
      domain: 'work',
      orgId: 'client-self-scope-org',
    }));

    expect(personal.state).toBeNull();
    expect(JSON.stringify(personal)).not.toContain('Scoped Tool Org');
    expect(personal.autonomyGate.externalAppAutomationGate).toBe('removed');
    expect(personal.autonomyGate).not.toHaveProperty('externalAppAutomationEnabled');
    expect(personal.autonomyWorkflows.every((workflow: any) => (
      workflow.policyScope === 'unattended_background_workflow'
      && !Object.prototype.hasOwnProperty.call(workflow, 'externalAppsAllowed')
    ))).toBe(true);
    expect(work.state.orgWorkspace.activeView).toBe('chat');
    expect(work.scope).toEqual({ domain: 'work', orgId: 'client-self-scope-org' });
    expect(work.autonomyGate).toBeNull();
    expect(work.autonomyWorkflows).toEqual([]);
  });

  it('declares all client-native surfaces that the self model routes to', () => {
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);

    const declaration = registry.getToolDeclarations()
      .find(item => item.function.name === 'client_action');
    const actionEnum = declaration?.function.parameters.properties.action.enum || [];

    expect(actionEnum).toEqual(expect.arrayContaining([
      'enter_widget_mode',
      'show_desktop_widget',
      'exit_widget_mode',
      'expand_from_widget',
    ]));
    expect(actionEnum).not.toEqual(expect.arrayContaining([
      'open_subscription',
      'open_activation',
      'open_billing',
      'customer_takeover_panel',
      'design_delivery_panel',
      'ecommerce_growth_panel',
    ]));
  });

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
