import './helpers';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { beforeAll, describe, expect, it } from 'vitest';
beforeAll(async () => { await (await import('../db_layer')).initDatabase(); });
import {
  parseDeterministicDesignProjectCreateArguments,
  isDesignProjectCreateAndSchemeRequest,
} from '../server/cognition/designer_project_brief';

describe('designer project creation quick route', () => {
  it('binds an explicit named brief to the durable project creation tool', () => {
    const command = parseDeterministicDesignProjectCreateArguments(
      '新建并激活一个室内设计项目，名称“设计师版稳定性验收住宅”，类型为住宅，地点上海浦东，建筑面积89平方米，居住者为两位成人和一名6岁儿童，预算35万元，偏好现代自然风。需求：开放式客餐厅、独立家政区；约束：承重结构未知。请保存 Brief。',
    );
    expect(command).toEqual(expect.objectContaining({
        name: '设计师版稳定性验收住宅',
        projectType: 'residential',
        location: '上海浦东',
        area: '89平方米',
        occupants: '两位成人和一名6岁儿童',
        budget: '35万元',
        style: '现代自然风',
        requirements: '开放式客餐厅、独立家政区',
        constraints: '承重结构未知',
    }));
  });

  it('parses a quoted project name and equals-delimited inline brief fields', () => {
    const request = '新建并激活室内设计项目“暮蓝-26验收住宅”；类型=住宅；地点=上海；面积=88㎡；居住者=2成人1儿童；预算=32万元；风格=侘寂+原木；需求=两室一厅、儿童学习区、充足收纳；约束=不改承重结构、不猜测现场尺寸。请创建持久项目并生成可审核的项目方案。';
    const command = parseDeterministicDesignProjectCreateArguments(request);

    expect(command).toEqual(expect.objectContaining({
        name: '暮蓝-26验收住宅',
        projectType: 'residential',
        location: '上海',
        area: '88㎡',
        occupants: '2成人1儿童',
        budget: '32万元',
        style: '侘寂+原木',
        requirements: '两室一厅、儿童学习区、充足收纳',
        constraints: '不改承重结构、不猜测现场尺寸',
    }));
    expect(isDesignProjectCreateAndSchemeRequest(request)).toBe(true);
  });

  it('does not create a project when the name is missing', () => {
    expect(parseDeterministicDesignProjectCreateArguments('新建一个室内设计项目')).toBeNull();
  });

  it('renders a current verified container receipt without completing a requested later stage', () => {
    const request = '\u65b0\u5efa\u5ba4\u5185\u8bbe\u8ba1\u9879\u76ee\uff0c\u540d\u79f0\u201c\u9a8c\u6536\u9879\u76ee\u201d';
    const record = {
      name: 'interior_design_project_create', arguments: {}, requestId: 'create-current',
      result: JSON.stringify({ ok: true, status: 'created', persisted: true, active: true,
        project: { id: 'project-1', name: '\u9a8c\u6536\u9879\u76ee', projectType: 'residential', brief: {} } }),
      terminalVerification: { status: 'verified' as const, strategy: 'measured' as const, reason: 'synthetic persistent receipt' },
    };
    const result = finalizeLumiResponse({ taskText: request, responseText: 'All stages delivered.', source: 'chat', requestId: 'create-current', toolRecords: [record] });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('project-1');
    expect(result.text).toContain('CAD');
    expect(result.text).not.toContain('All stages delivered.');
    const laterStage = finalizeLumiResponse({ taskText: request + '\u5e76\u751f\u6210\u53ef\u5ba1\u6838\u7684\u9879\u76ee\u65b9\u6848', responseText: 'All stages delivered.', source: 'chat', requestId: 'create-current', toolRecords: [record] });
    expect(laterStage.blocked).toBe(true);
  });
});
