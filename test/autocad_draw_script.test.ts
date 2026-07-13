import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolRegistry } from '../server/tools/registry';
import { registerExternalAppTools } from '../server/tools/definitions/external_app_tools';
import { validateCadGeometry, writeCadGeometryReceipt } from '../server/cad/geometry_verification';

const VERIFIED_VISUAL = {
  approved: true,
  score: 0.97,
  outerBoundaryMatches: true,
  wallTopologyMatches: true,
  openingsMatch: true,
  dimensionAnchorsMatch: true,
  criticalMismatches: [],
  notes: [],
};

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

      const sourcePath = path.join(dir, 'source-plan.png');
      fs.writeFileSync(sourcePath, Buffer.from('verified source image'));
      const geometry = {
        width: 9000,
        height: 7600,
        unit: 'mm',
        sourceTopology: { isRectangular: false, outerVertexCount: 6, visibleNotches: 1, visibleProjections: 0 },
        outerBoundary: [
          { x: 0, y: 0 },
          { x: 9000, y: 0 },
          { x: 9000, y: 7600 },
          { x: 7300, y: 7600 },
          { x: 7300, y: 7000 },
          { x: 0, y: 7000 },
        ],
        inferredScale: false,
        confidence: 0.72,
        wallThickness: 180,
        assumptions: [],
        missingForPrecision: ['Confirm the overall depth on site.'],
        precisionStatus: 'source_verified_draft',
        rooms: [
          { name: 'Living', x: 0, y: 0, width: 4300, height: 3600 },
          { name: 'Bedroom', x: 4300, y: 0, width: 3000, height: 3600 },
        ],
        walls: [{ x1: 0, y1: 3600, x2: 7300, y2: 3600, thickness: 180 }],
        doors: [{ hingeX: 4200, hingeY: 3600, width: 900, angle: 270, swing: 'left', label: 'D1' }],
        windows: [{ x1: 900, y1: 7000, x2: 2600, y2: 7000, width: 120, label: 'W1' }],
        dimensions: [{ x1: 0, y1: 0, x2: 9000, y2: 0, text: '9000', offset: -500 }],
      };
      const validation = validateCadGeometry(geometry, { sourceGrounded: true });
      expect(validation.passed).toBe(true);
      const { receiptPath } = writeCadGeometryReceipt({
        sourcePath,
        geometry,
        validation,
        visualVerification: VERIFIED_VISUAL,
        outputDirectory: dir,
      });

      const raw = await registry.execute('cad_prepare_autocad_operations', {
        title: 'visible-plan',
        geometryReceiptPath: receiptPath,
        outputPath: basePath,
        strokeDelayMs: 120,
      }, { allowLocalFileWrites: true });

      const result = JSON.parse(raw);
      expect(result).toMatchObject({
        inferredScale: false,
        confidence: 0.72,
        precisionStatus: 'source_verified_draft',
        strokeDelayMs: 120,
        geometryVerified: true,
        geometryVerificationRequired: true,
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
      expect(operations.geometryVerified).toBe(true);
      expect(operations.operationSetId).toBe(result.operationSetId);
      expect(operations.operations.filter((item: any) => item.layer === 'OUTLINE')).toHaveLength(6);

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8'));
      expect(manifest).toMatchObject({
        operationCount: result.operationCount,
        strokeDelayMs: 120,
        inferredScale: false,
        missingForPrecision: ['Confirm the overall depth on site.'],
        operationsPath: result.operationsPath,
        geometryVerified: true,
        geometryReceiptPath: receiptPath,
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

  it('rejects image-grounded geometry without a verified receipt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_unverified_'));
    try {
      const sourcePath = path.join(dir, 'plan.png');
      fs.writeFileSync(sourcePath, Buffer.from('source'));
      const registry = new ToolRegistry();
      registerExternalAppTools(registry);

      await expect(registry.execute('cad_prepare_autocad_operations', {
        title: 'unverified',
        sourcePath,
        width: 4000,
        height: 3000,
        inferredScale: false,
        sourceTopology: { isRectangular: true },
        outerBoundary: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }],
        walls: [{ x1: 0, y1: 0, x2: 4000, y2: 0 }],
        dimensions: [{ x1: 0, y1: 0, x2: 4000, y2: 0, text: '4000' }],
      }, { allowLocalFileWrites: true })).rejects.toThrow(/geometryReceiptPath/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not accept hand-written geometry for an attached image task', async () => {
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);

    await expect(registry.execute('cad_prepare_autocad_operations', {
      title: 'fabricated-from-chat',
      width: 4000,
      height: 3000,
      walls: [{ x1: 0, y1: 0, x2: 4000, y2: 0 }],
    }, {
      allowLocalFileWrites: true,
      actionIntent: 'Draw the attached source image in AutoCAD.',
    } as any)).rejects.toThrow(/sourcePath.*verified geometry receipt/i);
  });
});
