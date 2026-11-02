import { hasDesignDeliveryEvidence } from '../server/cognition/contracts/business_evidence';
import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import * as toolDefinitions from '../server/tools/definitions';
import { designerRequest, designerGuidanceRequest } from '../server/cognition/designer_contract';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { getCurrentIndustryCapabilityProfile as hostProfile } from '../server/industry/business_catalog';
import { formatIndustryCapabilityProfilePrompt } from '../server/regions/packs/cn/industry_capability_profile';
import { getIndustryGuidancePreference, setIndustryGuidancePreference } from '../server/industry/user_guidance';

it.each([
  ['status', '\u53ea\u67e5\u8be2\u5f53\u524d\u5df2\u6fc0\u6d3b\u7684\u201c\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85\u201d\u9879\u76ee\u8d26\u672c\uff1a\u63d0\u6848 PPT \u9636\u6bb5\u73b0\u5728\u662f\u4ec0\u4e48\u72b6\u6001\uff1f\u8bf7\u7ed9\u51fa\u9636\u6bb5\u72b6\u6001\u3001\u9a8c\u8bc1\u72b6\u6001\u3001\u963b\u585e\u539f\u56e0\u3001\u5f53\u524d\u4efb\u52a1ID\u548c\u4e0b\u4e00\u6b65\u3002\u4e0d\u8981\u751f\u6210 PPT\uff0c\u4e0d\u8981\u6267\u884c\u65b0\u8bbe\u8ba1\uff0c\u4e0d\u8981\u6253\u5f00\u5916\u90e8\u8f6f\u4ef6\uff0c\u4e0d\u8981\u5916\u53d1\u3002', 'interior_design_project_status'],
  ['visualization', '\u7ee7\u7eed\u5f53\u524d\u5df2\u6fc0\u6d3b\u7684\u201c\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85\u201d\uff0c\u6267\u884c\u201c\u6548\u679c\u56fe\u201d\u9636\u6bb5\u5e76\u5b8c\u6574\u5f52\u6863\u3002\u4ee5\u5df2\u4fdd\u5b58\u7684\u9879\u76ee Brief \u548c\u5df2\u9a8c\u8bc1\u7684 CAD \u9636\u6bb5\u4e3a\u9879\u76ee\u4f9d\u636e\uff1a\u5148\u5f62\u6210\u5ba2\u9910\u5385\u7684\u4e13\u4e1a\u89c6\u89c9\u65b9\u5411\uff0c\u518d\u751f\u6210\u4e00\u5f20\u771f\u5b9e\u672c\u5730\u6548\u679c\u56fe\uff0c\u8981\u6c42\u73b0\u4ee3\u81ea\u7136\u98ce\u3001\u5f00\u653e\u5f0f\u5ba2\u9910\u5385\u3001\u81ea\u7136\u6728\u8272\u4e0e\u6d45\u6696\u7070\u3001\u65e5\u95f4\u81ea\u7136\u5149\u3001\u89c6\u89d2\u80fd\u4f53\u73b0\u5ba2\u5385\u4e0e\u9910\u5385\u5173\u7cfb\uff1b\u6750\u8d28\u3001\u5bb6\u5177\u3001\u706f\u5149\u5747\u6807\u6ce8\u4e3a\u521b\u610f\u65b9\u6848\uff0c\u4e0d\u5f97\u5192\u5145\u73b0\u573a\u4e8b\u5b9e\u3002\u751f\u6210\u540e\u5fc5\u987b\u9a8c\u8bc1\u771f\u5b9e\u56fe\u7247\u6587\u4ef6\u3001\u9879\u76ee\u5f52\u5c5e\u548c\u6548\u679c\u56fe\u9636\u6bb5\u8d26\u672c\u3002\u4e0d\u8981\u6253\u5f00\u6216\u4fee\u6539\u5916\u90e8\u8f6f\u4ef6\uff0c\u4e0d\u8981\u5916\u53d1\uff1b\u7f3a\u5c11\u89c6\u89c9\u65b9\u5411\u56de\u6267\u3001\u771f\u5b9e\u56fe\u7247\u6216\u9a8c\u8bc1\u56de\u6267\u4e2d\u7684\u4efb\u610f\u4e00\u9879\uff0c\u5c31\u660e\u786e\u505c\u6b62\u4e3a\u672a\u5b8c\u6210\u3002', 'generate_image'],
] as const)('retains an explicit design %s request with scoped negative guards', (_label, text, expected) => {
  const registry = new ToolRegistry(); registerRuntime(registry);
  const pipeline = buildLumiExecutionPipeline({ userText: text, dispatch: { userId: 'shared-design-negative-guards', channel: 'chat', source: 'chat', text: _label === 'visualization' ? text + '\n\n- prior task status: blocked' : text }, registry });
  expect(pipeline.modelToolProjection.toolNames).toContain(expected);
});
beforeAll(async () => { await initDatabase(); });
const registerRuntime = (toolDefinitions as { registerProductVariantTools?: typeof toolDefinitions.registerAllTools }).registerProductVariantTools || toolDefinitions.registerAllTools;

describe('Designer capability in a shared non-Designer host', () => {
  it('keeps the host identity and all original workflow families', () => {
    expect(hostProfile().variantId).not.toBe('designer-client');
    expect(hostProfile().productLine).not.toBe('design');
    expect(hostProfile().entries.map(entry => entry.entryId)).toEqual(expect.arrayContaining(['research', 'packet', 'project', 'cad', 'visualization', 'presentation', 'handoff']));
    expect(formatIndustryCapabilityProfilePrompt('执行设计项目方案阶段。')).toContain('does not change the application identity');
  });
  it.each(['新建一个项目。', '创建工作项目，名称“采购管理”。', '查询当前项目进度。', 'What is the project status?', 'What is the current status of software design?', '教我怎么用这个版本。', '请审核这份合同。'])('does not hijack a non-design request: %s', text => {
    expect(designerRequest(text)).toBeNull();
    expect(designerGuidanceRequest(text)).toBeNull();
  });
  it.each(['不要新建并激活室内设计项目。', '假设新建并激活室内设计项目会如何？', '解释“新建并激活室内设计项目”这句话。', '新建；不要激活；室内设计项目。'])('does not recover authorization across a veto, quote, or sentence: %s', text => {
    expect(designerRequest(text)).toBeNull();
  });
  it('preserves explicit coordinated project creation and the original preference namespace', () => {
    expect(designerRequest('新建并激活室内设计项目“合成项目”。')).toMatchObject({ kind: 'create', expectedProjectName: '合成项目', requiresStage: false });
    const scope = { userId: 'shared-guide-fixture', domain: 'personal' as const, orgId: '' };
    setIndustryGuidancePreference(scope, { level: 'professional', familiarEntryId: 'cad' });
    expect(getIndustryGuidancePreference(scope)).toMatchObject({ level: 'professional', familiarEntryIds: ['cad'] });
    expect(getIndustryGuidancePreference({ ...scope, userId: 'other' }).familiarEntryIds).toEqual([]);
  });
  it('leaves explicit no-tool policy authoritative over a design request', () => {
    const registry = new ToolRegistry(); registerRuntime(registry);
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'shared-design-no-tool', channel: 'chat', source: 'chat', text: '不要调用任何工具，只解释设计项目的CAD阶段。' }, registry });
    expect(pipeline.modelToolProjection.toolNames).toEqual([]);
  });
});

it('does not let a failed BIM output join an unrelated successful observation', () => {
  const failed = { name: 'bim_export', arguments: {}, error: 'Synthetic export failed', result: JSON.stringify({ path: 'D:/synthetic/model.ifc', status: 'completed' }), terminalVerification: { status: 'failed' as const, strategy: 'measured' as const, reason: 'failed' } };
  const observation = { name: 'get_system_info', arguments: {}, result: JSON.stringify({ ok: true, status: 'observed' }), terminalVerification: { status: 'verified' as const, strategy: 'measured' as const, reason: 'observation' } };
  expect(designerRequest('Create a BIM model.')).toBeNull();
  expect(hasDesignDeliveryEvidence([failed, observation], 'Create a BIM model.')).toBe(false);
});
