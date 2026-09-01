import { describe, expect, it } from 'vitest';
import { getExternalControlCandidate, listExternalControlCandidates } from '../server/external_control/candidates';
import { ToolRegistry } from '../server/tools/registry';
import { registerExternalControlTools } from '../server/tools/definitions/external_control_tools';

describe('external control candidates', () => {
  it('exposes browser and desktop UI control upgrades', () => {
    const candidates = listExternalControlCandidates();
    const ids = candidates.map(candidate => candidate.id);

    expect(ids).toEqual(expect.arrayContaining([
      'playwright-mcp',
      'native-accessibility',
      'vision-computer-use-loop',
    ]));
  });

  it('includes the shared native accessibility actions for Windows and macOS', () => {
    const candidate = getExternalControlCandidate('native-accessibility');

    expect(candidate?.actions).toEqual(expect.arrayContaining([
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_click',
      'desktop_ui_invoke',
      'desktop_ui_type',
    ]));
  });

  it('describes Playwright MCP as a disabled curated MCP server by default', () => {
    const candidate = getExternalControlCandidate('playwright-mcp');

    expect(candidate?.mcp?.serverName).toBe('playwright');
    expect(candidate?.mcp?.config.command).toBe(process.execPath);
    expect(candidate?.mcp?.config.args).toHaveLength(1);
    expect(candidate?.mcp?.config.args?.[0]).toMatch(/[\\/]@playwright[\\/]mcp[\\/]cli\.js$/i);
    expect(candidate?.mcp?.config.cwd).toMatch(/[\\/]@playwright[\\/]mcp$/i);
    expect(candidate?.mcp?.config.args).not.toContain('-y');
    expect(candidate?.mcp?.config.enabled).toBe(false);
    expect(candidate?.mcp?.config.description).toContain('@playwright/mcp@0.0.79');
    expect(candidate?.industries).toContain('ecommerce');
  });

  it('filters candidates by industry and layer', () => {
    const browser = listExternalControlCandidates({ layer: 'browser', industry: 'short_video' });

    expect(browser.map(candidate => candidate.id)).toContain('playwright-mcp');
    expect(browser.every(candidate => candidate.layer === 'browser')).toBe(true);
  });

  it('does not let organization Lumi rewrite the host MCP configuration', async () => {
    const registry = new ToolRegistry();
    registerExternalControlTools(registry);

    await expect(registry.execute('external_control_configure_candidate', {
      candidateId: 'playwright-mcp',
      enabled: false,
    }, {
      userId: 'organization-member',
      authenticated: true,
      authRole: 'admin',
      localExecution: true,
      executionBoundary: 'trusted_local',
      domain: 'work',
      orgId: 'organization-id',
      userConfirmed: true,
    })).rejects.toThrow(/cannot change this computer's MCP configuration/i);
  });
});
