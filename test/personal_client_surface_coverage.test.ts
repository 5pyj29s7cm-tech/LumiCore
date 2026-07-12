import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_SETTINGS_SECTIONS,
  PERSONAL_CLIENT_LAUNCHER_IDS,
  PERSONAL_CLIENT_SURFACES,
  PERSONAL_CLIENT_SURFACE_ACTIONS,
  normalizeClientSettingsSection,
} from '../shared/client_surfaces';
import {
  getClientActionExpectation,
  getClientInterfaceSurfaces,
  verifyClientActionResult,
  type ClientStateSnapshot,
} from '../server/client/self_model';
import { ToolRegistry } from '../server/tools/registry';
import { registerClientSelfTools } from '../server/tools/definitions/client_self_tools';
import { hasClientActionOnlyIntent } from '../server/cognition/tool_intent';

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

function sourceBlock(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing source block: ${start} -> ${end}`);
  return text.slice(from, to);
}

function quotedPropertyValues(text: string, property: string): string[] {
  const pattern = new RegExp(`${property}:\\s*'([^']+)'`, 'g');
  return Array.from(text.matchAll(pattern), match => match[1]);
}

function openStateFor(target: string, settingsSection?: string): ClientStateSnapshot {
  const base: ClientStateSnapshot = {
    platform: 'desktop',
    mode: 'assistant',
    workDomain: 'personal',
    activeTab: target,
    viewMode: 'personal',
    windows: { open: [target], focused: target, minimized: [] },
    surfaces: {},
  };

  if (target === 'home') {
    return { ...base, activeTab: 'home', windows: { open: [], focused: null, minimized: [] } };
  }
  if (target === 'nexus') {
    return {
      ...base,
      activeTab: 'home',
      viewMode: 'world',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { nexusOpen: true },
    };
  }
  if (target === 'app-launcher') {
    return {
      ...base,
      activeTab: 'home',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { appLauncherOpen: true },
    };
  }
  if (target === 'knowledge') {
    return {
      ...base,
      activeTab: 'knowledge',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { knowledgeOpen: true },
    };
  }
  if (target === 'chat') {
    return {
      ...base,
      activeTab: 'chat',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { chatOpen: true },
    };
  }
  if (target === 'notifications') {
    return {
      ...base,
      activeTab: 'home',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { notificationsOpen: true },
    };
  }
  if (target === 'memory-avatar') {
    return {
      ...base,
      activeTab: 'home',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: { memoryAvatarOpen: true },
    };
  }
  if (target === 'settings') {
    return {
      ...base,
      activeTab: 'settings',
      windows: { open: ['settings'], focused: 'settings', minimized: [] },
      settings: { activeSection: settingsSection || 'general' },
    };
  }
  return base;
}

describe('complete personal-client surface contract', () => {
  it('registers every launcher entry rendered by the main desktop program', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const desktopIcons = sourceBlock(desktop, 'const desktopIcons = [', 'const desktopIconAreaHeight');
    const appIcons = sourceBlock(desktop, 'const appIcons = [', 'const desktopAppEntries');
    const utilityIcons = sourceBlock(desktop, 'const utilityAppEntries = [', 'const allAppEntries');
    const renderedLauncherIds = Array.from(new Set([
      ...quotedPropertyValues(desktopIcons, 'windowId'),
      ...quotedPropertyValues(appIcons, 'id'),
      ...quotedPropertyValues(utilityIcons, 'id'),
    ])).sort();

    expect([...PERSONAL_CLIENT_LAUNCHER_IDS].sort()).toEqual(renderedLauncherIds);
    expect(desktop).toContain('getPersonalClientSurfaceByAction(action)');
    expect(desktop).toContain('appLauncherOpen: isSearchOpen');
    expect(desktop).toContain('notificationsOpen: isNotificationPanelOpen');
    expect(desktop).toContain('memoryAvatarOpen: memoryLabOpen');
    expect(desktop).toContain('activeSection: settingsSection');
  });

  it('exposes every registered action and settings destination to Lumi', () => {
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    const declaration = registry.getToolDeclarations()
      .find(item => item.function.name === 'client_action');
    const actionEnum = declaration?.function.parameters.properties.action.enum || [];
    const interfaces = getClientInterfaceSurfaces();
    const interfaceIds = interfaces.map(surface => surface.id);

    expect(actionEnum).toEqual(expect.arrayContaining(PERSONAL_CLIENT_SURFACE_ACTIONS));
    expect(interfaceIds).toEqual(expect.arrayContaining(PERSONAL_CLIENT_SURFACES.map(surface => surface.id)));
    expect(interfaceIds).toEqual(expect.arrayContaining(
      CLIENT_SETTINGS_SECTIONS.map(section => `settings-${section.id}`),
    ));
  });

  it('verifies every registered personal surface against real client state', () => {
    const before: ClientStateSnapshot = {
      platform: 'desktop',
      mode: 'assistant',
      workDomain: 'work',
      activeTab: 'org',
      viewMode: 'personal',
      windows: { open: [], focused: null, minimized: [] },
      surfaces: {},
    };

    for (const surface of PERSONAL_CLIENT_SURFACES) {
      const action = surface.actions[0];
      const args = { action };
      const after = openStateFor(surface.target, surface.settingsSection);
      const expectation = getClientActionExpectation(args);
      const result = verifyClientActionResult(args, before, after, {
        ok: true,
        action,
        target: surface.target,
      });

      expect(expectation.expectedState.length, surface.id).toBeGreaterThan(0);
      expect(result.status, surface.id).toBe('verified');
      expect(result.matched, surface.id).toEqual(expect.arrayContaining(expectation.expectedState));
    }
  });

  it('normalizes public settings names to actual Settings component sections', () => {
    expect(normalizeClientSettingsSection('autonomy')).toBe('neural');
    expect(normalizeClientSettingsSection('llm')).toBe('llm-providers');
    expect(normalizeClientSettingsSection('vision')).toBe('vision-models');
    expect(normalizeClientSettingsSection('voice cloning')).toBe('voice');
    expect(getClientActionExpectation({ action: 'open_settings', section: 'autonomy' }).expectedState)
      .toContain('settings-section:neural');
    expect(getClientActionExpectation({ action: 'open_mcp_settings' }).expectedState)
      .toContain('settings-section:mcp');
    expect(getClientActionExpectation({ action: 'open_voice_forge' }).expectedState)
      .toContain('settings-section:voice');
  });

  it('routes missing Chinese and English interface commands as client actions', () => {
    for (const command of [
      '打开人格实验室',
      '返回个人工作区',
      '打开应用启动器',
      '打开终端',
      '打开模型用量',
      '打开个人资料',
      '打开 MCP 设置',
      '打开语音工坊',
      '打开技能生成器',
      'open personality lab',
      'open token dashboard',
      'open voice forge',
      'open agent ecosystem',
    ]) {
      expect(hasClientActionOnlyIntent(command), command).toBe(true);
    }
  });
});
