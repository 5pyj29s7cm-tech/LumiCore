import './helpers';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolRegistry } from '../server/tools/registry';
import { registerExternalAppTools } from '../server/tools/definitions/external_app_tools';
import { registerSelfExtensionTools } from '../server/tools/definitions/self_extension_tools';

describe('capability gap autofix', () => {
  it('persists a learned AutoCAD route with a minimal verified experiment', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_capability_autofix_'));
    try {
      const { initDatabase } = await import('../db_layer');
      await initDatabase();

      const registry = new ToolRegistry();
      registerExternalAppTools(registry);
      registerSelfExtensionTools(registry);
      registry.register({
        name: 'mcp_cad-drafting_autocad_playback_file',
        description: 'Test-only AutoCAD MCP declaration.',
        parameters: { type: 'object', properties: {} },
        handler: async () => JSON.stringify({ status: 'not_called' }),
        permission: 'user',
        securityLevel: 'safe',
      });

      const raw = await registry.execute('capability_gap_autofix', {
        goal: '让 Lumi 在 AutoCAD 里一笔一笔画图，不要用鼠标硬点',
        domain: 'cad_bim',
        observedFailure: '过去只是生成 DXF 或打开软件，没有通过 MCP/COM 在 AutoCAD 中完成实体绘制和验收。',
        outputDirectory,
        allowExternalExecution: false,
      }, {
        userId: 'capability_user',
        requestConfirmation: async () => true,
      } as any);

      const result = JSON.parse(raw);
      expect(result.selectedRoute.id).toBe('cad.autocad_mcp_playback');
      expect(result.selectedRoute.fallbackTools).toEqual([]);
      expect(result.experiment.status).toBe('prepared');
      expect(result.record.status).toBe('experiment_prepared');
      expect(result.record.nextUse.preferredTools).toEqual(expect.arrayContaining([
        'cad_prepare_autocad_operations',
        'mcp_cad-drafting_autocad_playback_file',
      ]));

      const artifactPaths = result.experiment.artifacts.map((artifact: any) => artifact.path);
      expect(artifactPaths.some((filePath: string) => filePath.endsWith('_operations.json'))).toBe(true);
      expect(artifactPaths.some((filePath: string) => filePath.endsWith('_manifest.json'))).toBe(true);
      expect(artifactPaths.some((filePath: string) => /\.(?:lsp|scr|ps1)$/i.test(filePath))).toBe(false);
      for (const artifact of result.experiment.artifacts) {
        expect(fs.existsSync(artifact.path)).toBe(true);
      }

      const listRaw = await registry.execute('capability_learning_list', {
        goal: 'AutoCAD 一笔一笔画图',
      }, {
        userId: 'capability_user',
      } as any);
      const listed = JSON.parse(listRaw);
      expect(listed.records.map((record: any) => record.id)).toContain(result.record.id);
      expect(listed.records.find((record: any) => record.id === result.record.id)?.status)
        .toBe('experiment_prepared');

      const planRaw = await registry.execute('self_extension_plan', {
        goal: 'AutoCAD 一笔一笔画图能力',
        domain: 'cad_bim',
      }, {
        userId: 'capability_user',
      } as any);
      const plan = JSON.parse(planRaw);
      const preparedCoverage = plan.existingCoverage.learnedCapabilities
        .find((record: any) => record.id === result.record.id);
      expect(preparedCoverage?.verified).toBe(false);
      expect(plan.resolution.decision).toBe('use_existing_coverage');
      expect(plan.resolution.shouldCreateNewCapability).toBe(false);

      const secondRaw = await registry.execute('capability_gap_autofix', {
        goal: 'AutoCAD 一笔一笔画图能力',
        domain: 'cad_bim',
        outputDirectory,
        allowExternalExecution: false,
      }, {
        userId: 'capability_user',
        requestConfirmation: async () => true,
      } as any);
      const second = JSON.parse(secondRaw);
      expect(second.reusedExistingCoverage).toBe(true);
      expect(second.record.id).not.toBe(result.record.id);
      expect(second.record.status).toBe('hypothesis');
      expect(second.note).toContain('Existing coverage reused');

      const afterSecondListRaw = await registry.execute('capability_learning_list', {
        goal: 'AutoCAD 一笔一笔画图',
      }, {
        userId: 'capability_user',
      } as any);
      const afterSecondList = JSON.parse(afterSecondListRaw);
      expect(afterSecondList.records.filter((record: any) => record.selectedRoute.id === 'cad.autocad_mcp_playback')).toHaveLength(1);

      const { formatClientSelfPrompt } = await import('../server/client/self_model');
      const prompt = formatClientSelfPrompt('capability_user');
      expect(prompt).toContain('No persisted learned capability routes yet');
      expect(prompt).not.toContain('AutoCAD MCP/COM drawing route');
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
