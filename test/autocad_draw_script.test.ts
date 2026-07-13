import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolRegistry } from '../server/tools/registry';
import { registerExternalAppTools } from '../server/tools/definitions/external_app_tools';

describe('AutoCAD MCP operation preparation', () => {
  it('registers the operations-only preparation tool and removes legacy script tools', () => {
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const names = registry.getToolDeclarations().map(item => item.function.name);

    expect(names).toContain('cad_prepare_autocad_operations');
    expect(names).not.toContain('cad_generate_autocad_draw_script');
    expect(names).not.toContain('cad_run_autocad_draw_script');
  });

  it('writes validated operations and a manifest without LISP, SCRIPT, or runner artifacts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_operations_'));
    const basePath = path.join(dir, 'visible_plan');
    try {
      const registry = new ToolRegistry();
      registerExternalAppTools(registry);

      const raw = await registry.execute('cad_prepare_autocad_operations', {
        title: 'visible-plan',
        width: 9000,
        height: 7600,
        unit: 'mm',
        sourcePath: 'C:\\Users\\tester\\Desktop\\source-plan.png',
        inferredScale: true,
        confidence: 0.72,
        assumptions: ['One unlabeled wall segment was inferred.'],
        missingForPrecision: ['Confirm the overall depth.'],
        precisionStatus: 'inferred_requires_review',
        wallThickness: 180,
        outputPath: basePath,
        strokeDelayMs: 120,
        rooms: [
          { name: 'Living', x: 0, y: 0, width: 4300, height: 3600 },
          { name: 'Bedroom', x: 4300, y: 0, width: 3000, height: 3600 },
        ],
        walls: [{ x1: 0, y1: 3600, x2: 7300, y2: 3600, thickness: 180 }],
        doors: [{ hingeX: 4200, hingeY: 3600, width: 900, angle: 270, swing: 'left', label: 'D1' }],
        windows: [{ x1: 900, y1: 7600, x2: 2600, y2: 7600, width: 120, label: 'W1' }],
        dimensions: [{ x1: 0, y1: 0, x2: 9000, y2: 0, text: '9000', offset: -500 }],
      }, { allowLocalFileWrites: true });

      const result = JSON.parse(raw);
      expect(result).toMatchObject({
        inferredScale: true,
        confidence: 0.72,
        precisionStatus: 'inferred_requires_review',
        strokeDelayMs: 120,
        requiredPlaybackTool: 'mcp_cad-drafting_autocad_playback_file',
        fallbackAllowed: false,
      });
      expect(result.operationCount).toBeGreaterThan(20);
      expect(fs.existsSync(result.operationsPath)).toBe(true);
      expect(fs.existsSync(result.manifestPath)).toBe(true);
      expect(fs.existsSync(result.completionMarkerPath)).toBe(false);
      expect(result).not.toHaveProperty('lispPath');
      expect(result).not.toHaveProperty('scriptPath');
      expect(result).not.toHaveProperty('powershellRunnerPath');
      expect(result).not.toHaveProperty('launchCommand');
      expect(fs.existsSync(`${basePath}.lsp`)).toBe(false);
      expect(fs.existsSync(`${basePath}.scr`)).toBe(false);
      expect(fs.existsSync(`${basePath}.ps1`)).toBe(false);
      expect(fs.existsSync(`${basePath}_run_autocad.ps1`)).toBe(false);

      const operations = JSON.parse(fs.readFileSync(result.operationsPath, 'utf-8'));
      expect(operations).toMatchObject({ title: result.title, unit: 'mm' });
      expect(operations.operations).toHaveLength(result.operationCount);

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8'));
      expect(manifest).toMatchObject({
        operationCount: result.operationCount,
        strokeDelayMs: 120,
        inferredScale: true,
        missingForPrecision: ['Confirm the overall depth.'],
        operationsPath: result.operationsPath,
        requiredPlaybackTool: 'mcp_cad-drafting_autocad_playback_file',
        fallbackAllowed: false,
      });
      expect(manifest).not.toHaveProperty('lispPath');
      expect(manifest).not.toHaveProperty('scriptPath');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces a visible MCP playback delay of at least 100 ms', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_delay_'));
    try {
      const registry = new ToolRegistry();
      registerExternalAppTools(registry);
      const result = JSON.parse(await registry.execute('cad_prepare_autocad_operations', {
        title: 'delay-probe',
        width: 4000,
        height: 3000,
        outputDirectory: dir,
        strokeDelayMs: 0,
      }, { allowLocalFileWrites: true }));

      expect(result.strokeDelayMs).toBe(100);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to invent fallback dimensions when geometry is incomplete', async () => {
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);

    await expect(registry.execute('cad_generate_dxf', {
      title: 'missing dimensions',
      width: null,
      height: null,
      walls: [{ x1: 0, y1: 0, x2: 1000, y2: 0 }],
    }, {
      userConfirmed: true,
      allowLocalFileWrites: true,
    })).rejects.toThrow(/width and height must be positive finite values/i);
  });
});
