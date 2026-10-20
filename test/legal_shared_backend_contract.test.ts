import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { getDataPath } from '../server/config/data_path';
import { mountChatRoutes } from '../server/routes/chat_routes';
import * as cases from '../server/org/legal_cases';
import { getActiveIndustryWorkspaceContext } from '../server/industry/workspace_context';
import { createOrg, addMember } from '../server/org/db';

let app: Awaited<ReturnType<typeof makeApp>>;
const owner='shared-case-http-owner';
const scope=cases.legalWorkspaceNamespace(owner);
const headers=(uid=owner,orgId?:string)=>({'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({uid,username:uid,role:'user',...(orgId?{orgId}:{})},JWT_SECRET)});
const sync=async(input:any,options:any={},auth=headers())=>{
  const response=await fetch(app.url+'/api/legal/client-case-sync',{method:'POST',headers:auth,body:JSON.stringify({case:input,...options})});
  return {status:response.status,data:await response.json() as any};
};
beforeAll(async()=>{app=await makeApp();const none=()=>null;mountChatRoutes(app.apiRouter,JWT_SECRET,{getDeepSeek:none,getGemini:none,getOpenAI:none,getAnthropic:none,getQwen:none});});
afterAll(()=>app.cleanup());

describe('same backend case HTTP and persisted schema contract',()=>{
 it('roundtrips the other edition stored schema through a sparse legacy snapshot without losing fields',async()=>{
  const incoming=process.env.LUMI_CASE_TRANSFER_INPUT ? JSON.parse(fs.readFileSync(process.env.LUMI_CASE_TRANSFER_INPUT,'utf8')) : null;
  let item:any;
  const file=getDataPath(path.join('org','legal_cases.json'));
  if(incoming){
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(incoming.store));
    item=cases.getCase(scope,incoming.caseId,owner)!;
  }else{
    item=cases.createCase(scope,owner,{title:'Synthetic shared schema case',factDate:'2020-02-03',clientPartyName:'Synthetic claimant',clientRole:'plaintiff',objective:'Preserve every supplied fact',notes:'Source facts require review.'});
    cases.addMaterial(scope,owner,item.id,{type:'evidence',source:'import',title:'Original synthetic evidence',content:'ORIGINAL-SOURCE-TAIL',reasoningBasis:'unapproved basis',reasoningLinks:[{issue:'synthetic issue',ruleCitation:'synthetic rule',ruleQuote:'synthetic quote',fact:'synthetic fact',evidence:[],application:'unverified analysis',conclusion:'unapproved conclusion',limitations:'program fixture only'}]});
    cases.recordWorkflowRun(scope,owner,item.id,{tool:'legal_case_strategy',ok:false,status:'partial',materialIds:[],artifacts:[],displayText:'Exact incomplete result preserved as history.'});
    cases.updateCase(scope,owner,item.id,{assetTraceWorkflow:{currentStep:'synthetic',state:'needs_action'},customMainContext:{nested:{key:'MAIN-EXTENSION-TAIL'}}} as any);
    const stored=JSON.parse(fs.readFileSync(file,'utf8'));stored.foreignEnvelope={schemaVersion:7,label:'STORE-EXTENSION-TAIL'};stored.cases.find((c:any)=>c.id===item.id).materials[0].customFileMetadata={locator:'MATERIAL-EXTENSION-TAIL'};fs.writeFileSync(file,JSON.stringify(stored));
    item=cases.getCase(scope,item.id,owner)!;
  }
  expect(item).toBeTruthy();
  const before=structuredClone(item);
  const response=await sync({id:item.id,title:item.title,materials:item.materials.map((m:any)=>({id:m.id,type:m.type,source:m.source,title:m.title,content:m.content}))});
  expect(response.status).toBe(200);
  const saved=cases.getCase(scope,item.id,owner)! as any;
  for(const field of ['factDate','clientPartyName','clientRole','objective','workflowRuns','removedMaterialIds','assetTraceWorkflow','customMainContext','notes','caseNumber','court','judge','createdBy','createdAt']) expect(saved[field]).toEqual(before[field]);
  expect(saved.materials).toEqual(before.materials);
  expect(saved.materials[0].customFileMetadata).toEqual({locator:'MATERIAL-EXTENSION-TAIL'});
  expect(JSON.parse(fs.readFileSync(file,'utf8')).foreignEnvelope).toEqual({schemaVersion:7,label:'STORE-EXTENSION-TAIL'});
  expect(response.data.case).toEqual(saved);
  if(process.env.LUMI_CASE_TRANSFER_OUTPUT){
    const output=path.resolve(process.env.LUMI_CASE_TRANSFER_OUTPUT);fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify({caseId:item.id,edition:process.env.LUMI_CASE_TRANSFER_EDITION,store:JSON.parse(fs.readFileSync(file,'utf8'))},null,2));
  }
 });
 it('keeps newly supplied material extensions but never accepts caller-created execution receipts or owner identities',async()=>{
  const id='schema-forgery-'+Date.now();
  const result=await sync({id,title:'Synthetic input',orgId:'forged-org',createdBy:'forged-owner',workflowRuns:[{tool:'fake',ok:true,status:'verified',artifacts:['C:/secret']}],materials:[{id:'new-material',type:'evidence',source:'import',title:'Synthetic source',content:'FULL-SOURCE',reasoningBasis:'unapproved',customFileMetadata:{locator:'NEW-METADATA'}}]});
  expect(result.status).toBe(200);expect(result.data.case.orgId).toBe(scope);expect(result.data.case.createdBy).toBe(owner);expect(result.data.case.workflowRuns).toBeUndefined();
  expect(result.data.case.materials[0]).toMatchObject({reasoningBasis:'unapproved',customFileMetadata:{locator:'NEW-METADATA'}});
  expect(cases.canReadCaseOutput(scope,owner,'C:/secret')).toBe(false);
 });
 it('activates the exact legal case through the existing workspace owner on either backend edition',async()=>{
  const response=await sync({id:'active-common-case',title:'Synthetic selected case',materials:[]},{activate:true});
  expect(response.status).toBe(200);
  expect(getActiveIndustryWorkspaceContext({userId:owner,domain:'personal',orgId:'',productLine:'legal'})).toMatchObject({productLine:'legal',kind:'case',name:'Synthetic selected case',attributes:{caseId:'active-common-case'}});
 });
 it('keeps server-issued tool materials and deletion tombstones when a stale client snapshot returns',async()=>{
  const item=cases.createCase(scope,owner,{title:'Synthetic stale snapshot'});
  const source=cases.addMaterial(scope,owner,item.id,{type:'evidence',source:'import',title:'Synthetic import',content:'ORIGINAL'})!;
  const tool=cases.addMaterial(scope,owner,item.id,{type:'note',source:'tool',title:'Actual existing result',content:'ACTUAL-TOOL-TAIL'})!;
  const revision=cases.getMaterialReview(scope,owner,item.id,source.id)!.revision;
  cases.removeMaterial(scope,owner,item.id,source.id,revision);
  const result=await sync({id:item.id,materials:[source,{...tool,content:'STALE-CALLER-RESULT'}]});
  expect(result.status).toBe(200);expect(result.data.case.materials.map((m:any)=>m.id)).toEqual([tool.id]);
  expect(result.data.case.materials[0].content).toBe('ACTUAL-TOOL-TAIL');expect(result.data.case.removedMaterialIds).toContain(source.id);
 });
 it('does not unlink archived server materials via caller-only snapshot tombstones',async()=>{
  const item=cases.createCase(scope,owner,{title:'Synthetic protected association'});
  const material=cases.addMaterial(scope,owner,item.id,{type:'evidence',source:'import',title:'Original source',content:'SERVER-SOURCE-RETAINED'})!;
  const response=await sync({id:item.id,removedMaterialIds:[material.id],materials:[]});
  expect(response.status).toBe(200);expect(response.data.case.materials.map((m:any)=>m.id)).toContain(material.id);
  expect(cases.getCase(scope,item.id,owner)!.materials.map(m=>m.id)).toContain(material.id);
 });
 it('scopes sync and delete to the authenticated personal user and refuses work-domain bypass',async()=>{
  const result=await sync({id:'scoped-common-case',title:'Synthetic scope',materials:[]});expect(result.status).toBe(200);
  const removed=await fetch(app.url+'/api/legal/client-case-sync/scoped-common-case',{method:'DELETE',headers:headers('different-user')});
  expect(removed.status).toBe(200);expect((await removed.json() as any).deleted).toBe(false);expect(cases.getCase(scope,'scoped-common-case',owner)).toBeTruthy();
  const org=createOrg('Synthetic common contract org','shared-schema-'+Date.now(),owner);addMember(org.id,owner,'owner');
  expect((await sync({id:'forbidden-work',title:'Synthetic work',materials:[]},{},headers(owner,org.id))).status).toBe(403);
  const deleted=await fetch(app.url+'/api/legal/client-case-sync/scoped-common-case',{method:'DELETE',headers:headers()});expect(deleted.status).toBe(200);expect((await deleted.json() as any).deleted).toBe(true);
 });
 it('rejects invalid sync input and anonymous callers without creating case records',async()=>{
  const before=cases.listCases(scope,'',200,owner).length;
  for(const input of [null,[],{}, {id:'../escape'}, {id:'valid-id',materials:[]}]){
    const response= (input as any)?.id==='valid-id' ? await fetch(app.url+'/api/legal/client-case-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({case:input})}) : null;
    if(response)expect(response.status).toBe(401);else expect((await sync(input)).status).toBe(400);
  }
  expect(cases.listCases(scope,'',200,owner)).toHaveLength(before);
 });
});
