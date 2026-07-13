import './helpers';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('work takeover capability reuse probe', () => {
  it('pressure-tests a real task without growing duplicate capabilities', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_reuse_probe_'));
    try {
      const { initDatabase } = await import('../db_layer');
      const { ToolRegistry } = await import('../server/tools/registry');
      const { registerWorkTakeoverTools } = await import('../server/tools/definitions/work_takeover_tools');
      const { registerSelfExtensionTools } = await import('../server/tools/definitions/self_extension_tools');
      const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
      await initDatabase();

      const registry = new ToolRegistry();
      registerWorkTakeoverTools(registry);
      registerSelfExtensionTools(registry);
      registerExternalAppTools(registry);

      const raw = await registry.execute('work_takeover_capability_reuse_probe', {
        message: '客户微信：接管抖店账号，主推商品空气炸锅，预算500元，今天先做短视频脚本、图文提示词、发布草稿和微信客服回复，不要正式发布。',
        contact: '王总',
        source: 'wechat',
        maxSteps: 3,
        outputDirectory,
      }, {
        userId: 'reuse_probe_user',
        domain: 'personal',
        orgId: 'reuse_probe_org',
      } as any);

      const result = JSON.parse(raw);
      expect(result.createdTask).toBe(true);
      expect(result).not.toHaveProperty('industryPackage');
      expect(result.packet.folderPath).toContain(outputDirectory);
      expect(fs.existsSync(result.packet.folderPath)).toBe(true);
      expect(result.plan.capabilities.map((capability: any) => capability.id)).toContain('ecommerce.operations');
      expect(result.plan.capabilities.flatMap((capability: any) => capability.tools)).toEqual(expect.arrayContaining([
        'mcp_ecommerce-ops_campaign_roi_analyzer',
        'mcp_content-ops_short_video_script',
        'generate_video',
      ]));
      expect(result.plan.capabilities.flatMap((capability: any) => capability.tools)).not.toContain('work_takeover_task_prepare_industry_package');
      expect(result.capabilityReuseAudit.summary.generatedNewCapability).toBe(false);
      expect(result.capabilityReuseAudit.summary.reusedCapabilities).toBeGreaterThan(0);
      expect(result.capabilityReuseAudit.summary.needsCapabilityWork).toBe(0);
      expect(result.capabilityReuseAudit.summary.duplicateRiskCount).toBe(0);
      expect(result.capabilityReuseAudit.summary.stableEnoughForTaskRun).toBe(true);
      expect(result.capabilityReuseAudit.items.some((item: any) => item.verdict !== 'needs_capability_work')).toBe(true);
      expect(result.verification.passed).toBe(true);
      expect(result.report.humanSummary).toContain('能力复用压测');
      expect(result.report.humanSummary).not.toContain(outputDirectory);
      expect(result.task.metadata.workTakeoverCapabilityReuseProbe.capabilityReuseAudit.summary.generatedNewCapability).toBe(false);
      expect(result.task.artifacts.map((artifact: any) => artifact.label)).toContain('能力复用压测记录');
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
