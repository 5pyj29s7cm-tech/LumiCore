import crypto from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildAutocadComPlaybackScript,
  readAutocadOperationPayload,
  runAutocadComPlayback,
} from '../server/skills/bundled/cad-drafting/autocad_control';

describe('AutoCAD MCP control', () => {
  it('validates generated operations and builds visible COM playback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_mcp_'));
    try {
      const operationsPath = path.join(dir, 'plan_operations.json');
      const markerPath = path.join(dir, 'plan_completed.txt');
      const operations = [
        { kind: 'line', layer: 'WALL', x1: 0, y1: 0, x2: 4000, y2: 0 },
        { kind: 'text', layer: 'TEXT', x: 200, y: 200, text: 'Room', height: 180 },
      ];
      const geometryHash = crypto.createHash('sha256').update('verified manual geometry').digest('hex');
      const operationSetId = crypto.createHash('sha256').update(JSON.stringify({ geometryHash, operations })).digest('hex');
      fs.writeFileSync(operationsPath, JSON.stringify({
        version: 2,
        title: 'Visible MCP plan',
        geometryHash,
        geometryVerified: true,
        geometryVerificationRequired: false,
        operationSetId,
        expectedEntityCount: operations.length,
        operations,
      }), 'utf-8');

      const payload = readAutocadOperationPayload(operationsPath);
      const script = buildAutocadComPlaybackScript(payload, {
        operationsPath,
        completionMarkerPath: markerPath,
        strokeDelayMs: 450,
      });

      expect(payload.operations).toHaveLength(2);
      expect(payload.operationSetId).toBe(operationSetId);
      expect(script).toContain("GetActiveObject('AutoCAD.Application')");
      expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
      expect(script).toContain("Registry::HKEY_CLASSES_ROOT\\AutoCAD.Application\\CLSID");
      expect(script).toContain('Start-Process -FilePath $acadExecutable');
      expect(script).toContain('$applicationReady = $false');
      expect(script).toContain('$documentCreated = $false');
      expect(script).toContain('$needsDocument = $createNewDocument');
      expect(script).toContain('$targetDoc = $acad.Documents.Add()');
      expect(script).toContain('$readyDeadline = (Get-Date).AddSeconds(120)');
      expect(script).toContain('if ($null -ne $candidateDoc) { $candidateModel = $candidateDoc.ModelSpace }');
      expect(script).toContain('for ($attempt = 1; $attempt -le 20');
      expect(script).toContain('$model.AddLine');
      expect(script).toContain('return ,([double[]]@($x, $y, 0.0))');
      expect(script).toContain('$model.AddText');
      expect(script).toContain('$doc.Regen(1)');
      expect(script).toContain('$startingEntityCount = if ($resumeCompleted -gt 0)');
      expect(script).toContain('function WaitForEntityCount');
      expect(script).toContain('function WaitForEntityHandles');
      expect(script).toContain('function WaitForDocumentReady');
      expect(script).toContain('function WaitForAcadQuiescent');
      expect(script).toContain('($completed % 50) -eq 0');
      expect(script).toContain('$operationHandle = GetEntityHandle $entity');
      expect(script).toContain('entityHandles = @($createdEntityHandles)');
      expect(script).toContain('entityHandlesVerified = $entityHandlesVerified');
      expect(script).toContain('$observedAfter = WaitForEntityCount $model $expectedAfter 5000');
      expect(script).toContain('$resumeObservedCount -eq ($resumeExpectedCount + 1)');
      expect(script).toContain('UpdatePlaybackState $completed');
      expect(script).toContain('for ($operationIndex = $completed;');
      expect(script).toContain('refusing to duplicate the operation set');
      expect(script).toContain('$entityCountMatches');
      expect(script).toContain('created duplicate entities');
      expect(script).toContain('Start-Sleep -Milliseconds $delayMs');
      expect(script).toContain("transport = 'mcp_autocad_com'");
      expect(script).toContain(markerPath.replace(/'/g, "''"));
      if (process.platform === 'win32') {
        const parsed = spawnSync('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$source = [Console]::In.ReadToEnd(); [void][ScriptBlock]::Create($source)',
        ], { input: script, encoding: 'utf-8', windowsHide: true });
        expect(parsed.status, parsed.stderr).toBe(0);
      }
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

  it('returns a verified existing marker without replaying the same operation set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_autocad_mcp_cached_'));
    try {
      const operationsPath = path.join(dir, 'plan_operations.json');
      const markerPath = path.join(dir, 'plan_completed.json');
      const operations = [{ kind: 'line', layer: 'WALL', x1: 0, y1: 0, x2: 4000, y2: 0 }];
      const geometryHash = crypto.createHash('sha256').update('verified manual geometry').digest('hex');
      const operationSetId = crypto.createHash('sha256').update(JSON.stringify({ geometryHash, operations })).digest('hex');
      fs.writeFileSync(operationsPath, JSON.stringify({
        version: 2,
        title: 'Cached plan',
        geometryHash,
        geometryVerified: true,
        geometryVerificationRequired: false,
        operationSetId,
        expectedEntityCount: operations.length,
        operations,
      }), 'utf-8');
      fs.writeFileSync(markerPath, JSON.stringify({
        status: 'completed',
        transport: 'mcp_autocad_com',
        visiblePlayback: true,
        completionMarkerExists: true,
        geometryVerified: true,
        geometryVerificationRequired: false,
        geometryHash,
        operationSetId,
        operationCount: 1,
        expectedEntityCount: 1,
        entitiesAdded: 1,
        entityCountMatches: true,
      }), 'utf-8');

      const result = await runAutocadComPlayback({
        operationsPath,
        completionMarkerPath: markerPath,
        lockPath: path.join(dir, 'playback.lock'),
      });

      expect(result).toMatchObject({
        status: 'completed',
        operationSetId,
        alreadyCompleted: true,
        entityCountMatches: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
