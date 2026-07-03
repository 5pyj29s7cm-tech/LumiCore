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
      expect(result.completionMarkerPath).toContain('_completed.txt');

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
      expect(runResult.launchCommand).toContain(runResult.powershellRunnerPath);
      expect(fs.existsSync(runResult.powershellRunnerPath)).toBe(true);
      expect(fs.readFileSync(runResult.powershellRunnerPath, 'utf-8')).toContain(path.basename(result.scriptPath));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
