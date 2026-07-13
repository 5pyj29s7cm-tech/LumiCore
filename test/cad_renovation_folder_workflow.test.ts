import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runRenovationFolderWorkflow } from '../server/skills/bundled/cad-drafting/renovation_workflow';

describe('cad renovation folder workflow', () => {
  it('extracts renovation signals and writes DXF/proposal deliverables', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_cad_renovation_'));
    try {
      fs.writeFileSync(path.join(dir, '需求.txt'), `
项目：两室一厅装修
整体尺寸：9000mm x 7600mm
面积：68㎡
房间：玄关、客厅、餐厅、厨房、主卧、次卧、卫生间、阳台
风格：原木 现代简约
预算：18万元
需求：收纳 干湿分离 书桌
约束：承重墙 燃气 下水 采光
`, 'utf-8');
      fs.writeFileSync(path.join(dir, '草稿图.png'), 'not a real image but a reference file', 'utf-8');

      const result = await runRenovationFolderWorkflow({
        folderPath: dir,
        projectName: '两室一厅改造',
        stylePreference: '原木现代',
        writeFiles: true,
        maxFiles: 20,
      });

      expect(result.filesRead.map(file => file.name)).toContain('需求.txt');
      expect(result.referenceImages.map(file => file.name)).toContain('草稿图.png');
      expect(result.signals.rooms.map(room => room.name)).toEqual(expect.arrayContaining(['客厅', '厨房']));
      expect(result.signals.styles).toEqual(expect.arrayContaining(['原木', '现代简约']));
      expect(result.signals.needs).toEqual(expect.arrayContaining(['收纳', '干湿分离', '书桌']));
      expect(result.geometry.calibrated).toBe(true);
      expect(result.geometry.widthMm).toBe(9000);
      expect(result.geometry.heightMm).toBe(7600);
      expect(result.workflowState).toBe('awaiting_image_geometry_extraction');
      expect(result.primaryReferenceImage).toBe(path.join(dir, '草稿图.png'));
      expect(result.recommendedToolCalls.map(call => call.tool)).toEqual([
        'floorplan_extract_geometry',
        'cad_prepare_autocad_operations',
        'mcp_cad-drafting_autocad_playback_file',
        'cad_generate_dxf',
      ]);
      expect(result.warnings.join(' ')).toContain('not visually traced');

      const outputDir = result.outputDir || '';
      const baseDxfPath = path.join(outputDir, '01_户型底图.dxf');
      const proposalPath = path.join(outputDir, '02_装修方案草稿.md');
      const materialsPath = path.join(outputDir, '04_材料清单.csv');

      expect(fs.existsSync(baseDxfPath)).toBe(true);
      expect(fs.readFileSync(baseDxfPath, 'utf-8')).toContain('SECTION');
      expect(fs.readFileSync(baseDxfPath, 'utf-8')).toContain('OUTLINE');
      expect(fs.readFileSync(proposalPath, 'utf-8')).toContain('装修方案');
      expect(fs.readFileSync(materialsPath, 'utf-8')).toContain('类别');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a real package by default unless preview-only is explicit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_cad_renovation_default_write_'));
    try {
      fs.writeFileSync(path.join(dir, '尺寸.txt'), '整体尺寸 8000mm x 6500mm，客厅、厨房、卧室。', 'utf-8');
      const result = await runRenovationFolderWorkflow({ folderPath: dir, projectName: '默认写入项目' });
      expect(result.outputDir).toBe(path.join(dir, 'LumiCAD装修方案'));
      expect(result.cadFiles.every(file => file.path && fs.existsSync(file.path))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns previews without writing files when writeFiles is false', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_cad_renovation_preview_'));
    try {
      fs.writeFileSync(path.join(dir, '资料.txt'), '两室 户型 面积 65㎡ 客厅 厨房 主卧 次卧 卫生间 风格：奶油风', 'utf-8');

      const result = await runRenovationFolderWorkflow({
        folderPath: dir,
        projectName: '预览项目',
        writeFiles: false,
        maxFiles: 5,
      });

      expect(result.outputDir).toBeUndefined();
      expect(result.draftFiles.length).toBeGreaterThan(0);
      expect(result.cadFiles.length).toBeGreaterThan(0);
      expect(result.draftFiles.every(file => !file.path && file.preview.length > 0)).toBe(true);
      expect(result.cadFiles.every(file => !file.path && file.preview && file.preview.length > 0)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'LumiCAD装修方案'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
