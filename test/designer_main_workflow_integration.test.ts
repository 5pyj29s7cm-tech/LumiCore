import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { createOrg, addMember, setMemberStatus } from '../server/org/db';
import { createInteriorProject, personalInteriorProjectScope } from '../server/design/projects';
import { getInteriorProjectWorkflow } from '../server/design/project_workflow';
import { listCurrentIndustryWorkflowContracts, startIndustryWorkflow, startOrReuseIndustryWorkflow, recordIndustryWorkflowExecution } from '../server/industry/workflow_service';
import { completeIndustryWorkflowFromVerifiedReceipts } from '../server/industry/workflow_autocomplete';
import * as toolDefinitions from '../server/tools/definitions';
const registerRuntimeTools = (toolDefinitions as { registerProductVariantTools?: typeof toolDefinitions.registerAllTools }).registerProductVariantTools || toolDefinitions.registerAllTools;
import { ToolRegistry } from '../server/tools/registry';
import type { ToolExecutionRecord } from '../server/tools/types';

beforeAll(async () => { await initDatabase(); });

function fixture() {
  const userId = `design-main-${crypto.randomUUID()}`;
  const scope = {userId, domain: 'personal' as const, orgId: ''};
  const project = createInteriorProject(personalInteriorProjectScope(userId), userId, {name:'Synthetic integration project'});
  const input = {...scope, entryId:'project', sourceInput:'Exact supplied brief, no external generation.', context:{projectId:project.id}};
  const started = startIndustryWorkflow(input);
  const registry = new ToolRegistry(); registerRuntimeTools(registry);
  const context = {...scope, taskId:started.conversationTaskId, requestId:started.requestId, industryWorkflowTaskId:started.task.id,
    industryWorkflowEntryId:'project', industryWorkflowProductLine:'design'};
  const records: ToolExecutionRecord[] = started.contract.requiredToolReceipts!.map(name => ({
    id:crypto.randomUUID(), name, taskId:started.conversationTaskId, requestId:started.requestId, arguments:{},
    result:JSON.stringify({ok:true,taskId:started.task.id,summary:'concept layout risk implementation brief: supplied source facts, constraints, evidence gaps and accountable professional review remain explicit.'}),
    terminalVerification:{status:'verified',strategy:'terminal_receipt',reason:'Synthetic scoped fixture receipt'},
  }));
  return {scope, project, input, started, context, records, registry};
}

describe('Designer preserves Main workflow and authorization owners', () => {
  it('retains all Main business contracts and the complete tool catalog alongside five project stages', () => {
    const contracts = listCurrentIndustryWorkflowContracts();
    expect(contracts.filter(x => x.productLine==='design').map(x=>x.entryId)).toEqual(['project','cad','visualization','presentation','handoff']);
    for (const [line,count] of [['ecommerce',5],['finance',6],['legal',7]] as const) expect(contracts.filter(x=>x.productLine===line)).toHaveLength(count);
    const main = new ToolRegistry();
    registerRuntimeTools(main);
    const names = (r:ToolRegistry) => r.list().map(tool=>tool.name).sort();
    expect(names(main)).toEqual(expect.arrayContaining(['interior_design_project_create','design_delivery_package_create',
      'industry_ecommerce_listing_action_queue','legal_search_subject_cases','legal_search_public_footprint']));
    expect(new Set(names(main)).size).toBe(names(main).length);
    for (const contract of contracts.filter(item => item.productLine === 'design')) {
      for (const name of contract.executionTools || []) {
        if (!name.startsWith('mcp_')) expect(names(main), name).toContain(name);
      }
    }
  });

  it('keeps project scope exact and does not reuse a stage for different source facts', () => {
    const x=fixture();
    expect(()=>startIndustryWorkflow({...x.input,userId:'another-user'})).toThrow(/not found/i);
    const same=startIndustryWorkflow(x.input); expect(same.task.id).toBe(x.started.task.id); expect(same.reused).toBe(true);
    const changed=startIndustryWorkflow({...x.input,sourceInput:'Different source facts require a separate attempt.'});
    expect(changed.task.id).not.toBe(x.started.task.id);
    expect(changed.task.metadata.industryWorkflow.inputDigest).not.toBe(x.started.task.metadata.industryWorkflow.inputDigest);
  });

  it('does not let an older stage completion replace the later source-bound attempt', () => {
    const x=fixture();
    const later=startIndustryWorkflow({...x.input,sourceInput:'A new brief version with different measured facts.'});
    const old=recordIndustryWorkflowExecution({...x.scope,taskId:x.started.task.id,toolRecords:x.records,
      resultText:'concept layout risk implementation brief: scoped source, fixed conditions, evidence gaps, reviewer boundaries and next actions recorded for accountable review.'});
    expect(old.verification.passed).toBe(true);
    const stage=getInteriorProjectWorkflow(x.project.orgId,x.project.id)!.stages.project;
    expect(stage.currentTaskId).toBe(later.task.id);expect(stage.status).toBe('in_progress');
  });

  it('rejects attempts to resume a bound task under another project or standalone mode', () => {
    const x=fixture();
    expect(()=>startOrReuseIndustryWorkflow({...x.input,context:{projectId:'another-project'}},x.started.task.id)).toThrow(/requested design project/);
    expect(()=>startOrReuseIndustryWorkflow({...x.input,context:{mode:'standalone'}},x.started.task.id)).toThrow(/standalone/);
  });

  it('rejects another delivered task in the same user scope when completion is bound to the current task',async()=>{
    const x=fixture();
    const delivered=recordIndustryWorkflowExecution({...x.scope,taskId:x.started.task.id,toolRecords:x.records,
      resultText:'concept layout risk implementation brief: scoped source, fixed conditions, evidence gaps, reviewer boundaries and next actions recorded for accountable review.'});
    expect(delivered.verification.passed).toBe(true);
    const current=startIndustryWorkflow({...x.input,sourceInput:'The next explicit source-bound attempt.'});
    const tool=x.registry.get('industry_workflow_complete')!;
    await expect(tool.handler({taskId:x.started.task.id},{...x.context,taskId:current.conversationTaskId,requestId:current.requestId,industryWorkflowTaskId:current.task.id})).rejects.toThrow(/bound industry workflow/i);
    expect(JSON.parse(await tool.handler({taskId:x.started.task.id},x.context))).toMatchObject({ok:true,reused:true,task:{id:x.started.task.id}});
  });

  it('denies organization viewer and revoked membership even at a direct design handler boundary', async () => {
    const x=fixture(); const org=createOrg('Synthetic studio',`studio-${crypto.randomUUID()}`,x.scope.userId);
    const member=`member-${crypto.randomUUID()}`;addMember(org.id,member,'viewer');
    const tool=x.registry.get('interior_design_project_create')!;
    const context={userId:member,domain:'work' as const,orgId:org.id};
    await expect(tool.handler({name:'Denied viewer project'},context)).rejects.toThrow(/membership/i);
    const writable=`writer-${crypto.randomUUID()}`;addMember(org.id,writable,'member');setMemberStatus(org.id,writable,'suspended');
    await expect(tool.handler({name:'Denied revoked project'},{...context,userId:writable})).rejects.toThrow(/membership/i);
  });

  it('does not let a context override remove contract-required receipts', async () => {
    const x=fixture();
    const result=await completeIndustryWorkflowFromVerifiedReceipts({registry:x.registry,records:x.records.slice(0,1),
      context:{...x.context,industryWorkflowRequiredToolReceipts:[x.records[0].name]}});
    expect(result).toBeNull();expect(getInteriorProjectWorkflow(x.project.orgId,x.project.id)?.stages.project.status).toBe('in_progress');
  });

  it('ignores copied prior-request receipts and foreign completion attempts', async () => {
    const x=fixture();
    expect(await completeIndustryWorkflowFromVerifiedReceipts({registry:x.registry,records:x.records.map(record=>({...record,requestId:'older-request'})),context:x.context})).toBeNull();
    expect(await completeIndustryWorkflowFromVerifiedReceipts({registry:x.registry,records:x.records,context:{...x.context,userId:'another-user'}})).toBeNull();
    expect(await completeIndustryWorkflowFromVerifiedReceipts({registry:x.registry,records:x.records,context:{...x.context,requestId:'later-turn'}})).toBeNull();
    expect(getInteriorProjectWorkflow(x.project.orgId,x.project.id)?.stages.project.status).toBe('in_progress');
  });
});
