import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { installCivilCodeFixture, resetAuthorityFixture } from './fixtures/legal_authority_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import * as LegalCases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
beforeEach(() => { resetAuthorityFixture(); installCivilCodeFixture(); });
afterAll(() => app.cleanup());
describe('Remote legal message explicit case-time propagation', () => {
  it.each([
    { factDate: '2026-01-15', expected: 'passed' },
    { factDate: '2019-01-15', expected: 'blocked' },
    { factDate: undefined, expected: 'blocked' },
  ])('keeps original Feishu material and uses factDate=$factDate rather than receipt time', async ({ factDate, expected }) => {
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const tool = registry.get('legal_message_intake_to_case')!;
    expect(tool.parameters.properties.factDate).toMatchObject({ type: 'string' });
    expect(tool.parameters.properties.procedureDate).toMatchObject({ type: 'string' });
    expect(tool.parameters.properties.temporalReviews).toMatchObject({ type: 'array' });
    const evaluate = vi.spyOn(LegalCases, 'evaluateCaseWorkflow');
    const message = '仅为程序接线验收，依据《民法典》第五百八十五条，事实和适用结论仍须复核。';
    try {
      const output = await registry.execute('legal_message_intake_to_case', {
        orgId: 'remote-time-' + expected + '-' + (factDate || 'missing'), userId: 'vitest',
        caseName: '远程时点回归-' + (factDate || 'missing'), platform: 'feishu',
        message, receivedAt: '2026-10-19T12:00:00.000Z', processLinks: false,
        ...(factDate ? { factDate } : {}),
      });
      expect(output).toContain('远程法律消息已入案');
      expect(evaluate).toHaveBeenCalled();
      const [caseFile, options] = evaluate.mock.calls.at(-1)!;
      expect(options?.currentLawGate).toBe(expected);
      expect(caseFile.materials.some(item => item.content.includes(message) && item.source === 'feishu')).toBe(true);
      expect(caseFile.materials.some(item => item.content.includes('2026-10-19T12:00:00.000Z'))).toBe(true);
    } finally { evaluate.mockRestore(); }
  });
});
