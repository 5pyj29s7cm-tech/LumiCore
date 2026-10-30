import './helpers';
import { afterAll, beforeAll, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountIndustryWorkflowRoutes } from '../server/routes/industry_workflow_routes';
import { mountConversationRoutes } from '../server/routes/conversations';
import { addMessageIdempotent, startNewConversation } from '../server/conversation/manager';
import { ToolRegistry } from '../server/tools/registry';
import { createWorkTakeoverTask } from '../server/work_takeover/tasks';
let base='', cleanup=()=>{};
const uid='business-remediation-owner', headers=(user=uid)=>({'Content-Type':'application/json',Authorization:`Bearer ${jwt.sign({uid:user,role:'user'},JWT_SECRET)}`});
beforeAll(async()=>{const app=await makeApp();base=app.url;cleanup=app.cleanup;mountIndustryWorkflowRoutes(app.apiRouter,new ToolRegistry());mountConversationRoutes(app.apiRouter,JWT_SECRET);});
afterAll(()=>cleanup());
it('persists bounded original report drafts per account and rejects malformed input',async()=>{
  const url=base+'/api/business/drafts/ecommerce/_unbound';
  const draft={sources:{orders:{name:'fixture.csv',table:{headers:['sku','revenue'],rows:[{sku:'A',revenue:120}]},mapping:{sku:'sku'}}},selectedPlatform:'generic',grossMarginPercent:35,targetStockDays:30,pasteValue:'',archiveTaskId:''};
  const saved=await fetch(url,{method:'PUT',headers:headers(),body:JSON.stringify({draft})});expect(saved.status).toBe(200);expect(await saved.json()).toMatchObject({persisted:true,record:{draft}});
  const restored=await fetch(url,{headers:headers()});expect(await restored.json()).toMatchObject({record:{draft}});
  expect(await (await fetch(url,{headers:headers('other-user')})).json()).toEqual({record:null});
  const invalid=await fetch(url,{method:'PUT',headers:headers(),body:JSON.stringify({draft:{...draft,sources:{orders:{table:{headers:[],rows:'invalid'}}}}})});expect(invalid.status).toBe(400);
  expect(await (await fetch(url,{headers:headers()})).json()).toMatchObject({record:{draft}});
  expect((await fetch(base+'/api/business/drafts/ecommerce/foreign-workspace',{headers:headers()})).status).toBe(404);
});
it('uses stable before-message cursors and cannot reuse a foreign conversation or cursor',async()=>{
  const conversation=startNewConversation(uid,'lumi','personal','');
  const append=(text:string)=>addMessageIdempotent({userId:uid,agentId:'lumi',conversationId:conversation.id,role:'user',content:text,requestId:crypto.randomUUID(),source:'fixture',channel:'chat',domain:'personal',orgId:'',deferActionPreparation:true});
  for(let i=0;i<5;i++) append('source-'+i);
  const url=base+`/api/conversations/${conversation.id}/messages?domain=personal&page=1&limit=2`;
  const first=await (await fetch(url,{headers:headers()})).json();expect(first.messages.map((m:any)=>m.message)).toEqual(['source-3','source-4']);expect(first.hasMore).toBe(true);
  append('new concurrent message');
  const second=await (await fetch(url+'&before='+encodeURIComponent(first.nextCursor),{headers:headers()})).json();expect(second.messages.map((m:any)=>m.message)).toEqual(['source-1','source-2']);
  const last=await (await fetch(url+'&before='+encodeURIComponent(second.nextCursor),{headers:headers()})).json();expect(last.messages.map((m:any)=>m.message)).toEqual(['source-0']);expect(last.hasMore).toBe(false);
  expect((await fetch(url+'&before=foreign-cursor',{headers:headers()})).status).toBe(400);
  expect((await fetch(url,{headers:headers('other-user')})).status).toBe(403);
});

it('pages industry history before limiting and rejects cross-account or workspace cursors',async()=>{
  const create=(userId=uid,workspace='store-a')=>createWorkTakeoverTask({userId,domain:'personal',orgId:'',category:'general_work',title:'Pagination fixture',metadata:{industryWorkflow:{productLine:'ecommerce',entryId:'store-data',context:{industryWorkspace:{id:workspace}}}}});
  const ids=new Set(Array.from({length:53},()=>create().id));
  const foreign=create(uid+'-foreign').id,otherWorkspace=create(uid,'store-b').id;
  const url=base+'/api/industry/workflows?entryId=store-data&workspaceId=store-a';
  const first=await(await fetch(url,{headers:headers()})).json();expect(first.tasks).toHaveLength(50);expect(first.nextCursor).toBeTruthy();
  const fresh=create();
  const next=await(await fetch(url+'&before='+encodeURIComponent(first.nextCursor),{headers:headers()})).json();
  const got=[...first.tasks,...next.tasks].map((task:any)=>task.id);
  expect(new Set(got)).toEqual(ids);expect(got).toHaveLength(53);expect(got).not.toContain(fresh.id);expect(next.nextCursor).toBeNull();
  for(const cursor of [foreign,otherWorkspace])expect((await fetch(url+'&before='+encodeURIComponent(cursor),{headers:headers()})).status).toBe(400);
});
it('does not reuse an idempotent task from another selected business workspace', async () => {
  const selectNew = async (name: string) => {
    const response = await fetch(base + '/api/business/workspaces', { method: 'POST', headers: headers(), body: JSON.stringify({ productLine: 'finance', name }) });
    expect(response.status).toBe(200); return (await response.json()).item;
  };
  const start = async () => {
    const response = await fetch(base + '/api/industry/workflows', { method: 'POST', headers: headers(), body: JSON.stringify({ entryId: 'accounting', sourceInput: 'Synthetic same source', idempotencyKey: 'fixture-same-source' }) });
    expect(response.status).toBe(201); return await response.json();
  };
  const firstWorkspace = await selectNew('Fixture company A'), first = await start();
  expect(first.task.metadata.industryWorkflow.context.industryWorkspace.id).toBe(firstWorkspace.id);
  expect((await start()).task.id).toBe(first.task.id);
  const secondWorkspace = await selectNew('Fixture company B'), second = await start();
  expect(second.task.id).not.toBe(first.task.id);
  expect(second.task.metadata.industryWorkflow.context.industryWorkspace.id).toBe(secondWorkspace.id);
  expect((await start()).task.id).toBe(second.task.id);
});
