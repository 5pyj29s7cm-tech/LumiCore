import { readFileSync } from 'node:fs';
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

  it('routes industry packages through adapters instead of direct core scripts', () => {
    const adapters = readRepoFile('server/work_takeover/industry_package_adapters.ts');
    const packages = readRepoFile('server/work_takeover/industry_packages.ts');
    const planner = readRepoFile('server/work_takeover/execution_planner.ts');

    expect(adapters).toContain("getIndustryPackageAdapter");
    expect(packages).toContain("getIndustryPackageAdapter('design_delivery')");
    expect(packages).toContain("getIndustryPackageAdapter('ecommerce_growth')");
    expect(packages).not.toMatch(/skills\/bundled\/.*\/workflows/);
    expect(planner).toContain('work_takeover_task_prepare_industry_package');
  });

  it('keeps the operating kernel explicit about skill and adapter reuse', () => {
    const kernel = readRepoFile('server/cognition/operating_kernel.ts');

    expect(kernel).toContain('Industry work stays in reusable skills, adapters, task packages, and learned routes');
    expect(kernel).toContain('Do not bake one-off demo scripts into the chat/voice/task core');
  });
});
