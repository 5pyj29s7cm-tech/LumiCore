import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('core capability boundaries', () => {
  it('keeps industry workflows out of the chat, voice, and task cores', () => {
    const coreSources = [
      'server/socket/chat.ts',
      'server/socket/voice.ts',
      'server/socket/task.ts',
      'server/cognition/turn_flow.ts',
      'server/cognition/turn_dispatch.ts',
      'server/cognition/capability_selection.ts',
      'server/cognition/execution_decision.ts',
    ].map(readRepoFile).join('\n');

    expect(coreSources).not.toMatch(/skills\/bundled\/(?:cad-drafting|ecommerce-ops|sales-customer-ops|desktop-automation)\/workflows/);
    expect(coreSources).not.toMatch(/create(?:DesignDelivery|EcommerceGrowth|CustomerTakeover|SelfIntro)/);
    expect(coreSources).toContain('buildLumiCapabilitySelection');
  });

  it('routes industry work to real domain tools and keeps scripted packages removed', () => {
    const planner = readRepoFile('server/work_takeover/execution_planner.ts');
    const tools = readRepoFile('server/tools/definitions/work_takeover_tools.ts');
    const cadSkill = readRepoFile('server/skills/bundled/cad-drafting/index.ts');

    expect(existsSync(path.join(process.cwd(), 'server/work_takeover/industry_package_adapters.ts'))).toBe(false);
    expect(existsSync(path.join(process.cwd(), 'server/work_takeover/industry_packages.ts'))).toBe(false);
    expect(existsSync(path.join(process.cwd(), 'server/skills/bundled/ecommerce-ops/delivery_package.ts'))).toBe(false);
    expect(existsSync(path.join(process.cwd(), 'server/skills/bundled/cad-drafting/delivery_package.ts'))).toBe(false);
    expect(planner).toContain('mcp_sales-customer-ops_lead_score');
    expect(planner).toContain('mcp_ecommerce-ops_campaign_roi_analyzer');
    expect(planner).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(planner).toContain('generate_video');
    expect(`${planner}\n${tools}`).not.toMatch(/work_takeover_task_prepare_(?:industry_package|ecommerce_growth|design_delivery)/);
    expect(`${planner}\n${tools}`).not.toContain('work_takeover_real_smoke_run');
    expect(tools).not.toContain('outcomeEvidence:');
    expect(cadSkill).not.toContain('cad_generate_simple_dxf');
  });

  it('keeps the operating kernel explicit about skill and adapter reuse', () => {
    const kernel = readRepoFile('server/cognition/operating_kernel.ts');

    expect(kernel).toContain('Industry work stays in reusable skills, adapters, task records, and learned routes');
    expect(kernel).toContain('Do not bake one-off demo scripts into the chat/voice/task core');
    expect(kernel).toContain('never treat a generated local coordination artifact as proof of external completion');
  });
});
