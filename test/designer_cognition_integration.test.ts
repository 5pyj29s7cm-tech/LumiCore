import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { registerAllTools } from '../server/tools/definitions';

let registry: ToolRegistry;
beforeAll(async () => { const { initDatabase } = await import('../db_layer'); await initDatabase(); registry = new ToolRegistry(); registerAllTools(registry); });
const statusText = '查询当前设计项目的 CAD 方案阶段状态和下一阶段';
const createText = '新建并激活一个室内设计项目，名称“离线合成项目”，面积88平方米。';
const pipeline = (text: string, extra: object = {}) => buildLumiExecutionPipeline({ requestId: 'designer-current-request', dispatch: { userId: 'designer-cognition-fixture', channel: 'chat', source: 'chat', text, operationMode: 'assistant' }, registry, ...extra });
const statusRecord = (extra: object = {}) => ({ name: 'interior_design_project_status', arguments: {}, requestId: 'designer-current-request', result: JSON.stringify({ ok: true, status: 'observed', persisted: true, project: { id: 'project-fixture', name: 'Synthetic project' }, workflow: { nextStage: 'visualization', stages: { cad: { status: 'completed', verificationStatus: 'passed', currentTaskId: 'wt-fixture', artifacts: [{ path: 'D:/synthetic-fixture/a.dxf' }] }, visualization: { status: 'not_started' } } } }), terminalVerification: { status: 'verified' as const, strategy: 'measured' as const, reason: 'synthetic ledger fixture' }, ...extra });

describe('Designer cognition on the modular Main pipeline', () => {
  it('routes a fresh project status query to the exact read-only project ledger', () => {
    const p = pipeline(statusText);
    expect(p.modelToolProjection.toolNames).toEqual(['interior_design_project_status']);
    expect(p.authorizationPolicy.allowedTools).toEqual(['interior_design_project_status']);
    expect(buildActionContract(statusText).kind).toBe('design_delivery');
  });
  it('routes explicit project creation to the durable project container without starting a stage', () => {
    const p = pipeline(createText);
    expect(p.modelToolProjection.toolNames).toContain('interior_design_project_create');
    expect(p.modelToolProjection.toolNames).not.toContain('industry_workflow_start');
    expect(p.modelToolProjection.toolNames).not.toContain('generate_image');
    expect(p.execution.promptOverlay).toContain('explicit project name');
  });
  it('routes explicit presentation stage to its exact workflow and real output tools', () => {
    const p = pipeline('执行当前设计项目的提案 PPT 阶段。');
    expect(p.modelToolProjection.toolNames).toContain('industry_workflow_start');
    expect(p.modelToolProjection.toolNames).toContain('industry_workflow_complete');
    expect(p.modelToolProjection.toolNames).toContain('create_ppt');
    expect(p.modelToolProjection.toolNames).not.toContain('send_email');
    expect(p.modelToolProjection.toolNames).not.toContain('run_command');
  });
  it.each(['不要新建设计项目。', '如果新建设计项目会怎样？', '解释“执行当前设计项目的提案 PPT 阶段”这句话。', '不要调用任何工具，只说如何创建设计项目。'])('does not authorize project or workflow mutation from %s', text => {
    const p = pipeline(text);
    expect(p.modelToolProjection.toolNames).not.toContain('interior_design_project_create');
    expect(p.modelToolProjection.toolNames).not.toContain('industry_workflow_start');
  });
  it('retains an explicit no-mutation veto on a workflow-shaped turn', () => {
    const p = pipeline('执行当前设计项目的提案 PPT 阶段，但禁止任何修改和写入。');
    expect(p.modelToolProjection.toolNames).not.toContain('create_ppt');
    expect(p.modelToolProjection.toolNames).not.toContain('industry_workflow_start');
  });
  it('retains caller-denied tools and confirmation requirements', () => {
    const p = pipeline(createText, { personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: ['interior_design_project_select'], requireConfirmation: ['interior_design_project_create'], maxIterations: 4 } });
    expect(p.modelToolProjection.toolNames).not.toContain('interior_design_project_select');
    expect(p.authorizationPolicy.requireConfirmation).toContain('interior_design_project_create');
  });
  it('uses current verified ledger evidence rather than arbitrary model completion prose', () => {
    const result = finalizeLumiResponse({ taskText: statusText, responseText: 'Everything, including customer delivery, is complete.', source: 'chat', requestId: 'designer-current-request', toolRecords: [statusRecord()] });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('wt-fixture');
    expect(result.text).toContain('D:/synthetic-fixture/a.dxf');
    expect(result.text).not.toContain('customer delivery');
  });
  it.each([
    { requestId: 'old-request' },
    { terminalVerification: { status: 'failed', strategy: 'measured', reason: 'failed' } },
    { result: JSON.stringify({ ok: true, persisted: false, project: { id: 'project-fixture' } }) },
  ])('rejects stale or unverified project status receipt %#', extra => {
    const result = finalizeLumiResponse({ taskText: statusText, responseText: '已查询并完成设计项目状态检查。', source: 'chat', requestId: 'designer-current-request', toolRecords: [statusRecord(extra) as any] });
    expect(result.blocked).toBe(true);
  });
  it('does not use a project container receipt as completed design deliverables', () => {
    const record = { ...statusRecord(), name: 'interior_design_project_create', result: JSON.stringify({ ok: true, status: 'created', persisted: true, active: true, project: { id: 'project-fixture', name: '离线合成项目' } }) };
    expect(hasCoreActionEvidence(buildActionContract(createText), [record], createText)).toBe(true);
    const task = '执行当前设计项目的提案 PPT 阶段。';
    expect(hasCoreActionEvidence(buildActionContract(task), [record], task)).toBe(false);
  });
});
