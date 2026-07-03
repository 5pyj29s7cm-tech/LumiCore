import { describe, expect, it } from 'vitest';
import { getExternalControlCandidate, listExternalControlCandidates } from '../server/external_control/candidates';

describe('external control candidates', () => {
  it('exposes browser and desktop UI control upgrades', () => {
    const candidates = listExternalControlCandidates();
    const ids = candidates.map(candidate => candidate.id);

    expect(ids).toEqual(expect.arrayContaining([
      'playwright-mcp',
      'windows-uia-snapshot',
      'vision-computer-use-loop',
    ]));
  });

  it('includes UIA action tools for native desktop control', () => {
    const candidate = getExternalControlCandidate('windows-uia-snapshot');

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
    expect(candidate?.mcp?.config.command).toBe('npx');
    expect(candidate?.mcp?.config.args).toEqual(expect.arrayContaining(['@playwright/mcp@latest']));
    expect(candidate?.mcp?.config.enabled).toBe(false);
    expect(candidate?.industries).toContain('ecommerce');
  });

  it('filters candidates by industry and layer', () => {
    const browser = listExternalControlCandidates({ layer: 'browser', industry: 'short_video' });

    expect(browser.map(candidate => candidate.id)).toContain('playwright-mcp');
    expect(browser.every(candidate => candidate.layer === 'browser')).toBe(true);
  });
});
