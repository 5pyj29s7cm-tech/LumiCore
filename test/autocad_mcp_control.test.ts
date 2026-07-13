import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildAutocadComPlaybackScript,
  readAutocadOperationPayload,
} from '../server/skills/bundled/cad-drafting/autocad_control';

describe('AutoCAD MCP control', () => {
  it('validates generated operations and builds visible COM playback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_mcp_'));
    try {
      const operationsPath = path.join(dir, 'plan_operations.json');
      const markerPath = path.join(dir, 'plan_completed.txt');
      fs.writeFileSync(operationsPath, JSON.stringify({
        version: 1,
        title: 'Visible MCP plan',
        operations: [
          { kind: 'line', layer: 'WALL', x1: 0, y1: 0, x2: 4000, y2: 0 },
          { kind: 'text', layer: 'TEXT', x: 200, y: 200, text: 'Room', height: 180 },
        ],
      }), 'utf-8');

      const payload = readAutocadOperationPayload(operationsPath);
      const script = buildAutocadComPlaybackScript(payload, {
        operationsPath,
        completionMarkerPath: markerPath,
        strokeDelayMs: 450,
      });

      expect(payload.operations).toHaveLength(2);
      expect(script).toContain("GetActiveObject('AutoCAD.Application')");
      expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
      expect(script).toContain("Registry::HKEY_CLASSES_ROOT\\AutoCAD.Application\\CLSID");
      expect(script).toContain('Start-Process -FilePath $acadExecutable');
      expect(script).toContain('$applicationReady = $false');
      expect(script).toContain('$documentCreated = $false');
      expect(script).toContain('[void]$acad.Documents.Add()');
      expect(script).toContain('$readyDeadline = (Get-Date).AddSeconds(120)');
      expect(script).toContain('if ($null -ne $candidateDoc) { $candidateModel = $candidateDoc.ModelSpace }');
      expect(script).toContain('for ($attempt = 1; $attempt -le 20');
      expect(script).toContain('$model.AddLine');
      expect(script).toContain('return ,([double[]]@($x, $y, 0.0))');
      expect(script).toContain('$model.AddText');
      expect(script).toContain('$doc.Regen(1)');
      expect(script).toContain('Start-Sleep -Milliseconds $delayMs');
      expect(script).toContain("transport = 'mcp_autocad_com'");
      expect(script).toContain(markerPath.replace(/'/g, "''"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported operation payloads before AutoCAD is touched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_mcp_invalid_'));
    try {
      const operationsPath = path.join(dir, 'invalid.json');
      fs.writeFileSync(operationsPath, JSON.stringify({
        version: 1,
        title: 'invalid',
        operations: [{ kind: 'erase_everything', layer: '0' }],
      }), 'utf-8');
      expect(() => readAutocadOperationPayload(operationsPath)).toThrow(/invalid or unsupported/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
