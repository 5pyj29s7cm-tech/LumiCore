import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { toolRecordSucceeded } from '../server/tools/receipt_payload';
import { registerCadDeliveryTools } from '../server/tools/definitions/cad_delivery_tools';
import { settleDesignerWorkflow } from '../server/cognition/designer_settlement';
import { designerRequest, verifiedDesignerReceipt } from '../server/cognition/designer_contract';
import { designerStatusRequest } from '../server/cognition/designer_instruction_projection';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { formatMultiDesignWorkflowLedgerStatus } from '../server/conversation/ledger/designer_status';
import { createInteriorProject } from '../server/design/projects';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { formatVerifiedDesignProjectStatus } from '../server/design/status_response';
import { runPreparedLumiTurn } from '../server/cognition/prepared_turn';
const complete = vi.hoisted(() => vi.fn(async (_input: any): Promise<any> => null));
const runModel = vi.hoisted(() => vi.fn(async (_input: any): Promise<any> => ({ text: '', toolCalls: [], usageRecords: [] })));
const delivered = vi.hoisted(() => vi.fn(async (input: any) => ({ finalization: { text: input.responseText, blocked: true }, toolRecords: input.toolRecords })));
vi.mock('../server/industry/workflow_autocomplete', () => ({ completeIndustryWorkflowFromVerifiedReceipts: complete }));
vi.mock('../server/cognition/turn_model', () => ({ runResolvedLumiTurn: runModel }));
vi.mock('../server/cognition/response_delivery', () => ({ finalizeLumiResponseForDelivery: delivered }));
const dirs: string[] = [];
beforeAll(async () => { await (await import('../db_layer')).initDatabase(); });
beforeEach(() => { complete.mockReset(); complete.mockResolvedValue(null); runModel.mockClear(); delivered.mockClear(); });
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const text = '执行当前设计项目的提案 PPT 阶段。';
it('keeps a genuine negated multi-workspace read forbidden while recognizing respectively', () => {
  expect(designerStatusRequest('别列出设计项目、CAD 方案的最近任务状态。')).toBe(false);
  expect(designerStatusRequest('分别列出设计项目、CAD 方案的最近任务状态。')).toBe(true);
});
async function start(overrides: Record<string, any> = {}) {
  const registry = new ToolRegistry();
  const task = { id: 'workflow-current', userId: 'scope-user', domain: 'personal', orgId: '', metadata: { industryWorkflow: {
    productLine: 'design', entryId: 'presentation', requestId: 'request-current', conversationTaskId: 'conversation-task',
  } }, ...overrides };
  registry.register({ name: 'industry_workflow_start', description: 'Isolated synthetic start', parameters: { type: 'object', properties: {} },
    permission: 'user', securityLevel: 'safe', handler: async () => JSON.stringify({ ok: true, persisted: true, task }),
    capability: { id: 'fixture.start', family: 'general', lane: 'general', operation: 'observe', risk: 'low', sideEffects: [{ type: 'local_read', scope: 'fixture', reversible: true }], verification: { strategy: 'terminal_receipt', required: true, requiredFields: [], successSignals: [], limitations: [] } },
  });
  const record = await executeToolCall({ registry, name: 'industry_workflow_start', arguments: {}, context: { userId: 'scope-user', domain: 'personal', taskId: 'conversation-task', requestId: 'request-current' } });
  expect(isCanonicalToolExecutionRecord(record)).toBe(true);
  const model: any = { registry, messages: [], config: {}, context: { userId: 'scope-user', domain: 'personal', taskId: 'conversation-task' }, execution: {
    resolution: { requestId: 'request-current' }, turnIntent: { flow: { designerRequest: designerRequest(text) } }, authorizationPolicy: { allowedTools: ['industry_workflow_complete'] },
  } };
  return { record, model };
}
it('settles a current canonical start through the shared workflow owner with the accepted policy', async () => {
  const { record, model } = await start(); await settleDesignerWorkflow(model, [record]);
  expect(complete).toHaveBeenCalledOnce();
  expect(complete.mock.calls[0]?.[0]).toMatchObject({ context: { userId: 'scope-user', domain: 'personal', requestId: 'request-current', taskId: 'conversation-task', industryWorkflowTaskId: 'workflow-current', industryWorkflowEntryId: 'presentation', toolPolicy: { allowedTools: ['industry_workflow_complete'] } } });
});
it.each([{ userId: 'foreign' }, { domain: 'work', orgId: 'foreign-org' }, { metadata: { industryWorkflow: { productLine: 'design', entryId: 'cad', requestId: 'request-current', conversationTaskId: 'conversation-task' } } }, { metadata: { industryWorkflow: { productLine: 'design', entryId: 'presentation', requestId: 'old', conversationTaskId: 'conversation-task' } } }])('does not settle a start with wrong owner or accepted binding %#', async override => {
  const { record, model } = await start(override); await settleDesignerWorkflow(model, [record]); expect(complete).not.toHaveBeenCalled();
});
it('does not accept an unbranded clone or a current pending confirmation', async () => {
  const { record, model } = await start(); await settleDesignerWorkflow(model, [JSON.parse(JSON.stringify(record))]); expect(complete).not.toHaveBeenCalled();
  await settleDesignerWorkflow(model, [record, { name: 'create_ppt', arguments: {}, result: '', requestId: 'request-current', envelope: { status: 'waiting_confirmation' } } as any]); expect(complete).not.toHaveBeenCalled();
});
it('does not settle a cancelled or pure-status turn', async () => {
  const { record, model } = await start(); model.isCancelled = () => true;
  await settleDesignerWorkflow(model, [record]); expect(complete).not.toHaveBeenCalled();
  model.isCancelled = undefined; model.execution.turnIntent.flow.designerRequest = designerRequest('查询当前设计项目状态');
  await settleDesignerWorkflow(model, [record]); expect(complete).not.toHaveBeenCalled();
});
it.each(['chat', 'voice'])('uses one shared post-loop settlement and publishes its exact record for %s', async source => {
  const { record, model } = await start(); const finished = { ...record, name: 'industry_workflow_complete' };
  runModel.mockResolvedValueOnce({ text: '', toolCalls: [record], usageRecords: [] }); complete.mockResolvedValueOnce(finished);
  model.onToolCall = vi.fn(); model.execution.executionRequested = true;
  const result = await runPreparedLumiTurn({ model, taskText: text, requestId: 'request-current', source });
  expect(runModel).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
  expect(model.onToolCall).toHaveBeenCalledExactlyOnceWith(finished); expect(result.toolRecords).toContain(finished);
});
it('does not auto-settle while the prepared entry is awaiting confirmation or skipped', async () => {
  const { record, model } = await start(); runModel.mockResolvedValueOnce({ text: '', toolCalls: [record], usageRecords: [] });
  await runPreparedLumiTurn({ model, taskText: text, requestId: 'request-current', source: 'voice', finalization: () => ({ pendingConfirmation: true }) });
  expect(complete).not.toHaveBeenCalled();
  await runPreparedLumiTurn({ model, taskText: text, requestId: 'request-current', source: 'chat', skipModel: true, toolRecords: [record] });
  expect(runModel).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
});
it('requires the exact created project in the stage metadata, not merely two successful tool names', () => {
  const request = designerRequest('新建并激活室内设计项目“新项目”；生成项目方案。')!;
  const created: any = { name: 'interior_design_project_create', arguments: {}, requestId: 'r', taskId: 't', result: JSON.stringify({ ok: true, status: 'created', persisted: true, active: true, project: { id: 'p', name: '新项目' } }), terminalVerification: { status: 'verified' } };
  const done = (projectId: string): any => ({ name: 'industry_workflow_complete', arguments: {}, requestId: 'r', taskId: 't', result: JSON.stringify({ ok: true, persisted: true, status: 'verified', verification: { passed: true }, task: { id: 'w', metadata: { industryWorkflow: { productLine: 'design', entryId: 'project', requestId: 'r', conversationTaskId: 't', context: { projectId } } } } }), terminalVerification: { status: 'verified' } });
  expect(verifiedDesignerReceipt([created, done('p')], request, { requestId: 'r', taskId: 't' })).not.toBeNull();
  expect(verifiedDesignerReceipt([created, done('foreign')], request, { requestId: 'r', taskId: 't' })).toBeNull();
  expect(verifiedDesignerReceipt([done('p')], request, { requestId: 'r', taskId: 't' })).toBeNull();
});
it('preserves the current status payload when a later stale status arrives', () => {
  const record = (requestId: string, name: string): any => ({ name: 'interior_design_project_status', arguments: {}, requestId, result: JSON.stringify({ ok: true, persisted: true, project: { id: name, name }, workflow: { nextStage: 'cad', stages: { cad: { status: 'not_started' } } } }), terminalVerification: { status: 'verified' } });
  const result = finalizeLumiResponse({ taskText: '查询当前设计项目的CAD状态', source: 'chat', responseText: '', requestId: 'r', toolRecords: [record('r', 'CURRENT'), record('old', 'STALE')] });
  expect(result.text).toContain('CURRENT'); expect(result.text).not.toContain('STALE'); expect(result.blocked).toBe(false);
});
it.each([
  ['执行当前设计项目的提案 PPT 阶段。', false],
  ['执行当前设计项目的提案 PPT 阶段，然后发邮件给客户。', true],
  ['执行当前设计项目的提案 PPT 阶段；然后执行交付中心阶段。', true],
  ['执行当前设计项目的提案 PPT 阶段；不要发邮件给客户，不要执行交付中心阶段。', false],
])('does not use one completed stage to swallow an extra obligation: %s', (requestText, blocked) => {
  const selected = designerRequest(requestText)!;
  const record: any = { name: 'industry_workflow_complete', arguments: {}, requestId: 'r', taskId: 't', terminalVerification: { status: 'verified' }, result: JSON.stringify({ ok: true, persisted: true, status: 'verified', verification: { passed: true }, task: { id: 'w', metadata: { industryWorkflow: { productLine: 'design', entryId: selected.entryId, requestId: 'r', conversationTaskId: 't' } } } }) };
  const result = finalizeLumiResponse({ taskText: requestText, source: 'chat', responseText: 'All work is complete.', requestId: 'r', taskId: 't', toolRecords: [record] });
  expect(result.blocked).toBe(blocked);
  if (blocked) expect(result.text).toContain('整项保持未完成');
});
it.each(['查询当前设计项目状态；通过微信给王经理发送文件。', '查询当前设计项目状态；发邮件给客户。'])('does not let status evidence complete an independent send: %s', taskText => {
  const record: any = { name: 'interior_design_project_status', arguments: {}, requestId: 'r', result: JSON.stringify({ ok: true, persisted: true, project: { id: 'p' } }), terminalVerification: { status: 'verified' } };
  expect(finalizeLumiResponse({ taskText, source: 'chat', responseText: 'All complete', requestId: 'r', toolRecords: [record] }).blocked).toBe(true);
});
it('does not read a foreign owner conversation or fall back to a different organization project', () => {
  createInteriorProject('work-foreign', 'ledger-owner', { name: 'FOREIGN SECRET' });
  const query = '设计项目、CAD 方案、效果图的最近任务状态与回执';
  for (const conversation of [{ id: 'c', userId: 'someone-else', domain: 'personal' }, { id: 'c', userId: 'ledger-owner', domain: 'work', orgId: '' }, { id: 'c', userId: 'ledger-owner', domain: 'work', orgId: 'work-empty' }]) {
    expect(formatMultiDesignWorkflowLedgerStatus({ conversations: [conversation] }, { conversationId: 'c', userId: 'ledger-owner', query })).toBeNull();
  }
});
it('revokes work-ledger access immediately after current organization membership is removed', () => {
  const org = createOrg('Ledger fixture', 'ledger-fixture', 'ledger-owner'); addMember(org.id, 'ledger-owner', 'owner');
  createInteriorProject(org.id, 'ledger-owner', { name: 'CURRENT WORK LEDGER' });
  const db = { conversations: [{ id: 'work-c', userId: 'ledger-owner', domain: 'work', orgId: org.id }] };
  const input = { conversationId: 'work-c', userId: 'ledger-owner', query: '设计项目、CAD 方案的最近任务状态与回执' };
  expect(formatMultiDesignWorkflowLedgerStatus(db, input)).toContain('CURRENT WORK LEDGER');
  removeMember(org.id, 'ledger-owner'); expect(formatMultiDesignWorkflowLedgerStatus(db, input)).toBeNull();
});
it.each([{}, { cad: { status: 'completed', verificationStatus: 'passed' } }])('does not infer all stages complete from a missing nextStage %#', stages => {
  const text = formatVerifiedDesignProjectStatus({ name: 'interior_design_project_status', arguments: {}, result: JSON.stringify({ ok: true, persisted: true, project: { id: 'p' }, workflow: { stages } }), terminalVerification: { status: 'verified', strategy: 'measured', reason: 'fixture' } });
  expect(text).not.toContain('全部阶段已完成'); expect(text).toContain('下一阶段尚未记录');
});
it('reports all stages complete only when all five persisted stages passed verification', () => {
  const stages = Object.fromEntries(['project', 'cad', 'visualization', 'presentation', 'handoff'].map(id => [id, { status: 'completed', verificationStatus: 'passed' }]));
  const text = formatVerifiedDesignProjectStatus({ name: 'interior_design_project_status', arguments: {}, result: JSON.stringify({ ok: true, persisted: true, project: { id: 'p' }, workflow: { stages } }), terminalVerification: { status: 'verified', strategy: 'measured', reason: 'fixture' } });
  expect(text).toContain('全部阶段已完成');
});
async function cad() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-cad-receipt-')); dirs.push(dir);
  const registry = new ToolRegistry(); registerCadDeliveryTools(registry);
  const record = await executeToolCall({ registry, name: 'cad_generate_dxf', arguments: { width: 1000, height: 800, outputDirectory: dir, openPreview: false }, context: { userId: 'fixture', requestId: 'cad-r', allowLocalFileWrites: true } });
  return { record, payload: JSON.parse(record.result) };
}
it('accepts a canonical generated DXF and actual SVG preview without desktop opening', async () => {
  const { record, payload } = await cad(); expect(payload.opened).toBe(false);
  expect(record.terminalVerification?.status).toBe('verified'); expect(toolRecordSucceeded(record)).toBe(true);
});
it.each(['path', 'previewPath'])('rejects a removed CAD %s even when the old receipt says exists true', async field => {
  const { record, payload } = await cad(); fs.unlinkSync(payload[field]); expect(toolRecordSucceeded(record)).toBe(false);
});
it('does not excuse an explicit preview/open request or an ordinary failed desktop_open', async () => {
  const { record } = await cad(); expect(toolRecordSucceeded({ ...record, arguments: { ...record.arguments, openPreview: true } })).toBe(false);
  expect(toolRecordSucceeded({ ...record, name: 'desktop_open' })).toBe(false);
});
