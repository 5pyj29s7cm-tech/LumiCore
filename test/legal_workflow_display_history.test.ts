import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { toolRegistry } from '../server/tools/registry';
import { defineLegalTool, withLegalReceipt, legalCapability } from '../server/regions/packs/cn/legal_tools/tool_contracts';
import { encodeToolResult } from '../server/tools/result_envelope';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';
import { addMember, createOrg } from '../server/org/db';
let app:Awaited<ReturnType<typeof makeApp>>, cases:typeof import('../server/org/legal_cases');
const uid='history-http-owner';let status='partial', exactMaterial=false;
const headers=(id=uid,orgId?:string,orgRole?:string)=>({'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({uid:id,username:id,role:'user',...(orgId?{orgId,orgRole}:{})},JWT_SECRET)});
const post=(tool:string,args:any,auth=headers())=>fetch(app.url+'/api/legal/tool/'+tool,{method:'POST',headers:auth,body:JSON.stringify({args})});
beforeAll(async()=>{
  app=await makeApp();cases=await import('../server/org/legal_cases');
  const {authority_knowledgeTools}=await import('../server/regions/packs/cn/legal_tools/definitions_authority_knowledge');
  const probe=defineLegalTool({name:'legal_case_strategy',description:'Isolated display history fixture',properties:{caseId:{type:'string'}},handler:withLegalReceipt(async(args,context)=>{ const text='Original '+status+' result. No source evidence is added.'; if(exactMaterial) cases.addMaterial(cases.legalWorkspaceNamespace(context.userId),context.userId,args.caseId,{title:'Exact returned result',type:'note',source:'tool',content:text}); return encodeToolResult(text,{ok:status==='observed',status}); },{status:'observed'}),
    capability:legalCapability({id:'legal.history.probe',operation:'observe',risk:'low',successStatuses:['observed'],sideEffects:[]})});
  toolRegistry.register(probe);toolRegistry.register(authority_knowledgeTools().find(t=>t.name==='legal_verify_citation')!);
  const unavailable=()=>null;mountChatRoutes(app.apiRouter,JWT_SECRET,{getDeepSeek:unavailable,getGemini:unavailable,getRelay:unavailable} as any);
});
afterAll(()=>{toolRegistry.unregister('legal_case_strategy');toolRegistry.unregister('legal_verify_citation');app.cleanup();});
beforeEach(()=>{status='partial';exactMaterial=false;});
function newCase(owner=uid,orgId=cases.legalWorkspaceNamespace(owner)) {return cases.createCase(orgId,owner,{title:'Isolated virtual history case',notes:'ORIGINAL_NOTES'});}
it('returns a precise personal case history snapshot for partial without material archive or source-fingerprint change',async()=>{
  const item=newCase();cases.addMaterial(item.orgId,uid,item.id,{title:'Original evidence',type:'evidence',source:'manual',content:'ORIGINAL_EVIDENCE'});
  const before=cases.getCase(item.orgId,item.id)!;const basis=legalCaseSourceFingerprint(before);
  const response=await post('legal_case_strategy',{caseId:item.id});expect(response.status).toBe(200);const data=await response.json();
  expect(data.receipt).toMatchObject({ok:false,status:'partial',persisted:false,changedCaseIds:[]});
  expect(data.verification.status).not.toBe('verified');expect(data.caseUpdates).toHaveLength(1);expect(data.caseUpdates[0].id).toBe(item.id);
  const after=cases.getCase(item.orgId,item.id)!;expect(after.materials).toEqual(before.materials);expect(after.notes).toBe(before.notes);
  expect(after.workflowRuns![0]).toMatchObject({tool:'legal_case_strategy',displayText:data.text,ok:false,status:'partial',materialIds:[],basis});
  expect(legalCaseSourceFingerprint(after)).toBe(basis);
});
it('records a returned successful query without inventing an archived material',async()=>{
  status='observed';const item=newCase();const data=await(await post('legal_case_strategy',{caseId:item.id})).json();
  expect(data.verification.status).toBe('verified');expect(data.receipt).toMatchObject({ok:true,status:'observed',persisted:false,changedCaseIds:[]});
  expect(data.caseUpdates[0].materials).toHaveLength(0);expect(data.caseUpdates[0].workflowRuns[0]).toMatchObject({ok:true,status:'observed',displayText:data.text});
});
it('preserves the real no-receipt citation success without manufacturing ok true in its stored history',async()=>{
  const item=newCase();const response=await post('legal_verify_citation',{caseId:item.id,text:'This source text contains no specific legal citation.'});
  expect(response.status).toBe(200);const data=await response.json();expect(data.verification.status).toBe('verified');expect(data.receipt).toEqual({});
  const run=data.caseUpdates[0].workflowRuns[0];expect(run).toMatchObject({tool:'legal_verify_citation',displayText:data.text,ok:false,status:'unverified',materialIds:[]});
});
it('lets an organization viewer read citation results without writing history',async()=>{
  const org=createOrg('History viewer fixture','history-viewer-'+Date.now(),uid);addMember(org.id,'history-viewer','viewer');
  const item=newCase(uid,org.id);const response=await post('legal_verify_citation',{caseId:item.id,text:'No specific citation.'},headers('history-viewer',org.id,'viewer'));
  expect(response.status).toBe(200);const data=await response.json();expect(data.verification.status).toBe('verified');expect(data.caseUpdates[0].id).toBe(item.id);
  expect(cases.getCase(org.id,item.id)!.workflowRuns||[]).toHaveLength(0);
});
it('never returns or writes a case in another personal scope',async()=>{
  const item=newCase('history-other-owner');const response=await post('legal_case_strategy',{caseId:item.id});expect(response.status).toBe(500);const data=await response.json();
  expect(data.code).toBe('LEGAL_TOOL_EXECUTION_FAILED');expect(data.caseUpdates).toBeUndefined();expect(cases.getCase(item.orgId,item.id)!.workflowRuns||[]).toHaveLength(0);
});
it('does not select or create a history case when no explicit caseId or business mutation is supplied',async()=>{
  const item=newCase();const data=await(await post('legal_case_strategy',{})).json();expect(data.caseUpdates).toEqual([]);expect(cases.getCase(item.orgId,item.id)!.workflowRuns||[]).toHaveLength(0);
});

it('reuses an exactly identical new material instead of storing its body twice',async()=>{
  status='observed';exactMaterial=true;const item=newCase();const data=await(await post('legal_case_strategy',{caseId:item.id})).json();
  expect(data.verification.status).toBe('verified');const current=data.caseUpdates[0],run=current.workflowRuns[0];
  expect(current.materials).toHaveLength(1);expect(run.materialIds).toEqual([current.materials[0].id]);expect(current.materials[0].content).toBe(data.text);expect(run.displayText).toBeUndefined();
});

it.each(['partial','observed'])('respects persistCase false without history or any case change for a returned %s result',async returnedStatus=>{
  status=returnedStatus;const item=newCase();const before=cases.getCase(item.orgId,item.id)!;
  const response=await post('legal_case_strategy',{caseId:item.id,persistCase:false});expect(response.status).toBe(200);const data=await response.json();
  expect(data.receipt).toMatchObject({ok:returnedStatus==='observed',status:returnedStatus,persisted:false,changedCaseIds:[]});
  expect(data.text).toContain('Original '+returnedStatus+' result');
  expect(cases.getCase(item.orgId,item.id)).toEqual(before);expect(data.caseUpdates).toEqual([before]);
});
