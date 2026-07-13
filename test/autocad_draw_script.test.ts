import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolRegistry } from '../server/tools/registry';
import { registerExternalAppTools } from '../server/tools/definitions/external_app_tools';

describe('AutoCAD visible draw script', () => {
  it('generates stroke-by-stroke AutoCAD LISP and SCRIPT files from CAD geometry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_script_'));
    try {
      const registry = new ToolRegistry();
      registerExternalAppTools(registry);

      const raw = await registry.execute('cad_generate_autocad_draw_script', {
        title: '两室一厅可视绘图',
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
        outputDirectory: dir,
        strokeDelayMs: 120,
        rooms: [
          { name: '客厅', x: 0, y: 0, width: 4300, height: 3600 },
          { name: '主卧', x: 4300, y: 0, width: 3000, height: 3600 },
        ],
        walls: [
          { x1: 0, y1: 3600, x2: 7300, y2: 3600, thickness: 180 },
        ],
        doors: [
          { hingeX: 4200, hingeY: 3600, width: 900, angle: 270, swing: 'left', label: 'D1' },
        ],
        windows: [
          { x1: 900, y1: 7600, x2: 2600, y2: 7600, width: 120, label: 'W1' },
        ],
        dimensions: [
          { x1: 0, y1: 0, x2: 9000, y2: 0, text: '9000', offset: -500 },
        ],
      }, {
        requestConfirmation: async () => true,
      } as any);

      const result = JSON.parse(raw);
      expect(result.operationCount).toBeGreaterThan(20);
      expect(fs.existsSync(result.lispPath)).toBe(true);
      expect(fs.existsSync(result.scriptPath)).toBe(true);
      expect(fs.existsSync(result.powershellRunnerPath)).toBe(true);
      expect(fs.existsSync(result.manifestPath)).toBe(true);
      expect(fs.existsSync(result.operationsPath)).toBe(true);
      expect(result.completionMarkerPath).toContain('_completed.txt');
      expect(result).toMatchObject({ inferredScale: true, confidence: 0.72, precisionStatus: 'inferred_requires_review' });

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8'));
      expect(manifest).toMatchObject({
        operationCount: result.operationCount,
        strokeDelayMs: 120,
        inferredScale: true,
        missingForPrecision: ['Confirm the overall depth.'],
        operationsPath: result.operationsPath,
      });

      const operations = JSON.parse(fs.readFileSync(result.operationsPath, 'utf-8'));
      expect(operations).toMatchObject({ title: result.title, unit: 'mm' });
      expect(operations.operations).toHaveLength(result.operationCount);

      const lisp = fs.readFileSync(result.lispPath, 'utf-8');
      const script = fs.readFileSync(result.scriptPath, 'utf-8');
      expect(lisp).toContain('(defun c:LUMIDRAW');
      expect(lisp).toContain('_.LINE');
      expect(lisp).toContain('_.ARC');
      expect(lisp).toContain('_.DELAY');
      expect(lisp).toContain('_completed.txt');
      expect(lisp).toContain('客厅');
      expect(script).toContain('LUMIDRAW');
      expect(script.replace(/\\/g, '/')).toContain(result.lispPath.replace(/\\/g, '/'));

      const runRaw = await registry.execute('cad_run_autocad_draw_script', {
        scriptPath: result.scriptPath,
        lispPath: result.lispPath,
        completionMarkerPath: result.completionMarkerPath,
        launch: false,
      }, {
        requestConfirmation: async () => true,
      } as any);
      const runResult = JSON.parse(runRaw);
      expect(runResult.status).toBe('ready_to_launch');
      expect(runResult.manifestFound).toBe(true);
      expect(runResult.estimatedWaitSeconds).toBeGreaterThanOrEqual(45);
      expect(runResult.launchCommand).toContain(runResult.powershellRunnerPath);
      expect(fs.existsSync(runResult.powershellRunnerPath)).toBe(true);
      expect(fs.readFileSync(runResult.powershellRunnerPath, 'utf-8')).toContain(path.basename(result.scriptPath));
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

  it('discovers a custom AutoCAD install through the desktop app index and resolves its shortcut', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_discovery_'));
    const shortcutPath = 'C:\\Users\\Public\\Desktop\\AutoCAD 2026 - 简体中文.lnk';
    try {
      const registry = new ToolRegistry();
      registerExternalAppTools(registry);
      const desktopRelay = async (name: string) => {
        if (name === 'desktop_list_apps') {
          return JSON.stringify([{ app_id: 'autocad', label: 'AutoCAD', path: shortcutPath, score: 130 }]);
        }
        return 'ok';
      };

      const raw = await registry.execute('cad_generate_autocad_draw_script', {
        title: 'custom-install-test',
        width: 4000,
        height: 3000,
        autocadExecutable: 'acad.exe',
        outputDirectory: dir,
        strokeDelayMs: 0,
      }, { desktopRelay, allowLocalFileWrites: true } as any);
      const result = JSON.parse(raw);
      const runner = fs.readFileSync(result.powershellRunnerPath, 'utf-8');

      expect(result.autocadExecutable).toBe(shortcutPath);
      expect(result.autocadExecutableSource).toBe('desktop_app_index');
      expect(runner).toContain(shortcutPath);
      expect(runner.charCodeAt(0)).toBe(0xfeff);
      expect(runner).toContain('CreateShortcut');
      expect(runner).toContain('$shortcut.Arguments');

      const runRaw = await registry.execute('cad_run_autocad_draw_script', {
        scriptPath: result.scriptPath,
        completionMarkerPath: result.completionMarkerPath,
        launch: false,
      }, { desktopRelay, allowLocalFileWrites: true } as any);
      const runResult = JSON.parse(runRaw);
      expect(runResult).toMatchObject({
        status: 'ready_to_launch',
        autocadExecutable: shortcutPath,
        autocadExecutableSource: 'desktop_app_index',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads only the current generated LISP when AutoCAD shows its unsigned-file dialog', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_security_'));
    try {
      const registry = new ToolRegistry();
      registerExternalAppTools(registry);
      let markerPath = '';
      const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];
      const desktopRelay = async (name: string, args: Record<string, any>) => {
        relayCalls.push({ name, args });
        if (name === 'desktop_run_command') return 'started=C:\\AutoCAD\\acad.exe';
        if (name === 'desktop_active_window') {
          return JSON.stringify({
            title: 'Security - Unsigned Executable File',
            process_name: 'acad.exe',
            pid: 4242,
          });
        }
        if (name === 'desktop_ui_snapshot') {
          return JSON.stringify({
            tree: {
              name: 'Security - Unsigned Executable File',
              children: [
                { name: path.basename(markerPath.replace(/_completed\.txt$/i, '.lsp')) },
                { name: 'Load Once', automationId: 'CommandButton_1002' },
              ],
            },
          });
        }
        if (name === 'desktop_ui_invoke') {
          fs.writeFileSync(markerPath, 'completed=1\n', 'utf-8');
          return JSON.stringify({ status: 'ok', method: 'InvokePattern' });
        }
        if (name === 'desktop_running_processes') {
          return JSON.stringify([{ pid: 4242, name: 'acad.exe' }]);
        }
        return 'ok';
      };

      const generatedRaw = await registry.execute('cad_generate_autocad_draw_script', {
        title: 'security-dialog-test',
        width: 4000,
        height: 3000,
        autocadExecutable: 'C:\\AutoCAD\\acad.exe',
        outputDirectory: dir,
        strokeDelayMs: 0,
      }, { desktopRelay, allowLocalFileWrites: true } as any);
      const generated = JSON.parse(generatedRaw);
      markerPath = generated.completionMarkerPath;

      const runRaw = await registry.execute('cad_run_autocad_draw_script', {
        scriptPath: generated.scriptPath,
        lispPath: generated.lispPath,
        completionMarkerPath: markerPath,
        launch: true,
        waitSeconds: 3,
        requireCompletionMarker: true,
      }, { desktopRelay, allowLocalFileWrites: true } as any);
      const result = JSON.parse(runRaw);

      expect(result).toMatchObject({
        status: 'completed',
        completionMarkerExists: true,
        startupDialogDetected: true,
      });
      expect(result.startupDialogActions).toContain('load_once:relay:InvokePattern');
      expect(relayCalls).toContainEqual({
        name: 'desktop_ui_invoke',
        args: expect.objectContaining({ automationId: 'CommandButton_1002', processId: 4242 }),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
