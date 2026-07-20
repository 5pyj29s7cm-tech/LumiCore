import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/components/SystemExplorer';

describe('computer adaptation report truthfulness', () => {
  it('keeps launch-only macOS and disconnected MCP states partial', () => {
    const report = buildReport({
      software: {
        installedApps: ['Safari', 'AutoCAD 2026'],
        nodeVersion: 'v24.0.0',
        pythonVersion: 'Python 3.9.6',
      },
    } as any, {
      microphone: 'granted',
      camera: 'prompt',
    }, {
      skillCount: 4,
      enabledSkillCount: 1,
      connectedSkillCount: 0,
      toolCount: 212,
    }, {
      openai: { available: true },
    }, true, {
      platform: 'macos',
      shell_available: true,
      app_discovery_available: true,
      app_launch_available: true,
      screen_capture_available: false,
      input_available: false,
      accessibility_permission: 'required',
      screen_recording_permission: 'required',
    }, null, true);

    expect(report.capabilities.find(item => item.id === 'desktop_shell')?.status).toBe('partial');
    expect(report.capabilities.find(item => item.id === 'mcp')?.status).toBe('partial');
    expect(report.capabilities.find(item => item.id === 'knowledge_files')?.status).toBe('partial');
    expect(report.capabilities.find(item => item.id === 'cad')?.status).toBe('ready');
    expect(report.suggestions.some(item => item.id === 'mcp-disconnected')).toBe(true);
  });
});
