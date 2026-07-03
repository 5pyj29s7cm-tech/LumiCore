import './helpers';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('work takeover real smoke run', () => {
  it('runs a verifiable closed loop from a customer message to package, packet, verification, and task report', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_real_smoke_'));
    try {
      const { initDatabase } = await import('../db_layer');
      const { ToolRegistry } = await import('../server/tools/registry');
      const { registerWorkTakeoverTools } = await import('../server/tools/definitions/work_takeover_tools');
      await initDatabase();

      const registry = new ToolRegistry();
      registerWorkTakeoverTools(registry);

      const raw = await registry.execute('work_takeover_real_smoke_run', {
        message: '客户微信：帮我接管抖店账号，主推商品空气炸锅，预算500元，今天先做短视频脚本、图文提示词、发布草稿和微信客服回复，不要正式发布。',
        contact: '王总',
        source: 'wechat',
        maxSteps: 3,
        mode: 'visible_external_work',
        includeDesktopVerification: false,
        outputDirectory,
      }, {
        userId: 'real_smoke_user',
        domain: 'personal',
        orgId: 'real_smoke_org',
      } as any);

      const result = JSON.parse(raw);
      expect(result.createdTask).toBe(true);
      expect(result.industryPackage.kind).toBe('ecommerce_growth');
      expect(result.controlRoutes.map((route: any) => route.id)).toContain('playwright_browser');
      expect(result.packet.folderPath).toContain(outputDirectory);
      expect(fs.existsSync(result.packet.folderPath)).toBe(true);
      expect(result.verification.passed).toBe(true);
      expect(result.report.humanSummary).toContain('安全闭环');
      expect(result.report.humanSummary).not.toContain(outputDirectory);
      expect(result.task.metadata.workTakeoverRealSmokeRun.report.humanSummary).toBe(result.report.humanSummary);
      expect(result.task.artifacts.map((artifact: any) => artifact.label)).toContain('真实闭环小测试记录');
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
