import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ORIGINAL_TOOL_DIR = process.env.LUMI_EXTERNAL_TOOLS_DIR;

afterEach(() => {
  if (ORIGINAL_TOOL_DIR === undefined) delete process.env.LUMI_EXTERNAL_TOOLS_DIR;
  else process.env.LUMI_EXTERNAL_TOOLS_DIR = ORIGINAL_TOOL_DIR;
  vi.resetModules();
});

describe('adapter registry external toolbox awareness', () => {
  it('surfaces staged CAD tools and Nano Banana as explicit adapters', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_external_tools_'));
    try {
      const installers = path.join(root, 'installers');
      const catalog = path.join(root, 'catalog');
      fs.mkdirSync(installers, { recursive: true });
      fs.mkdirSync(catalog, { recursive: true });
      fs.writeFileSync(path.join(installers, 'LibreCAD_2.2.1.5.exe'), '');
      fs.writeFileSync(path.join(installers, 'Sweet Home 3D_7.5.exe'), '');
      fs.writeFileSync(path.join(installers, 'sh3d-mcp-plugin-1.1.0.sh3p'), '');
      fs.writeFileSync(path.join(installers, 'FreeCAD_1.1.1.exe'), '');
      fs.writeFileSync(path.join(installers, 'blender_4.5.10.msi'), '');
      fs.writeFileSync(path.join(catalog, 'lumi_external_tools_catalog.md'), '# catalog');

      process.env.LUMI_EXTERNAL_TOOLS_DIR = root;
      vi.resetModules();
      const { getAdapterRegistry } = await import('../server/adapters/registry');
      const report = getAdapterRegistry({ includePlanned: false });
      const cadToolbox = report.adapters.find(adapter => adapter.id === 'cad_bim.local_toolchain');
      const nanoBanana = report.adapters.find(adapter => adapter.id === 'ai.nano_banana');
      const externalAi = report.adapters.find(adapter => adapter.id === 'ai.external_agents');
      const drafting = report.adapters.find(adapter => adapter.id === 'cad_bim.drafting');

      expect(cadToolbox?.status).toBe('available');
      expect(cadToolbox?.diagnostics).toEqual(expect.arrayContaining([
        'LibreCAD=staged',
        'SweetHome3D=staged',
        'SweetHome3D_MCP=staged',
        'FreeCAD=staged',
        'Blender=staged',
      ]));
      expect(nanoBanana?.status).toBe('requires_setup');
      expect(nanoBanana?.surfaces).toEqual(expect.arrayContaining(['Google AI Studio', 'Gemini app']));
      expect(externalAi?.actions).toEqual(expect.arrayContaining([
        'desktop_ai_list_targets',
        'desktop_ai_ask',
        'desktop_ai_collect_answer',
      ]));
      expect(externalAi?.surfaces).toEqual(expect.arrayContaining(['WorkBuddy', 'Codex desktop']));
      expect(drafting?.actions).toContain('mcp_cad-drafting_cad_renovation_folder_workflow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
