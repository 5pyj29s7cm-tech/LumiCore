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

      const raw = await registry.execute('capability_gap_autofix', {
        goal: '让 Lumi 在 AutoCAD 里一笔一笔画图，不要用鼠标硬点',
        domain: 'cad_bim',
        observedFailure: '过去只是生成 DXF 或打开软件，没有把脚本送进 AutoCAD 并验证执行闭环。',
        outputDirectory,
        allowExternalExecution: false,
      }, {
        userId: 'capability_user',
        requestConfirmation: async () => true,
      } as any);

      const result = JSON.parse(raw);
      expect(result.selectedRoute.id).toBe('cad.autocad_script_bridge');
      expect(result.experiment.status).toBe('prepared');
      expect(result.record.status).toBe('experiment_prepared');
      expect(result.record.nextUse.preferredTools).toEqual(expect.arrayContaining([
        'cad_generate_autocad_draw_script',
        'cad_run_autocad_draw_script',
      ]));

      const artifactPaths = result.experiment.artifacts.map((artifact: any) => artifact.path);
      expect(artifactPaths.some((filePath: string) => filePath.endsWith('.lsp'))).toBe(true);
      expect(artifactPaths.some((filePath: string) => filePath.endsWith('.scr'))).toBe(true);
      expect(artifactPaths.some((filePath: string) => filePath.endsWith('.ps1'))).toBe(true);
      for (const artifact of result.experiment.artifacts.filter((item: any) => !item.label.includes('marker'))) {
        expect(fs.existsSync(artifact.path)).toBe(true);
      }

      const listRaw = await registry.execute('capability_learning_list', {
        goal: 'AutoCAD 一笔一笔画图',
      }, {
        userId: 'capability_user',
      } as any);
      const listed = JSON.parse(listRaw);
      expect(listed.records.map((record: any) => record.id)).toContain(result.record.id);

      const planRaw = await registry.execute('self_extension_plan', {
        goal: 'AutoCAD 一笔一笔画图能力',
        domain: 'cad_bim',
      }, {
        userId: 'capability_user',
      } as any);
      const plan = JSON.parse(planRaw);
      expect(plan.existingCoverage.learnedCapabilities.map((record: any) => record.id)).toContain(result.record.id);
      expect(plan.resolution.decision).toBe('reuse_learned_route');
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
      expect(second.record.id).toBe(result.record.id);
      expect(second.note).toContain('Existing learned route reused');

      const afterSecondListRaw = await registry.execute('capability_learning_list', {
        goal: 'AutoCAD 一笔一笔画图',
      }, {
        userId: 'capability_user',
      } as any);
      const afterSecondList = JSON.parse(afterSecondListRaw);
      expect(afterSecondList.records.filter((record: any) => record.selectedRoute.id === 'cad.autocad_script_bridge')).toHaveLength(1);

      const { formatClientSelfPrompt } = await import('../server/client/self_model');
      const prompt = formatClientSelfPrompt('capability_user');
      expect(prompt).toContain('### Learned Capability Routes');
      expect(prompt).toContain('AutoCAD 脚本/API 优先绘图路线');
      expect(prompt).toContain('cad_generate_autocad_draw_script');
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
