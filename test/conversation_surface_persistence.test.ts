import { makeApp, JWT_SECRET } from './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { mountConversationRoutes } from '../server/routes/conversations';
import { addMember, createOrg } from '../server/org/db';
import { getDataPath } from '../server/config/data_path';
import { closeDatabase, flushDBOrThrow, initDatabase, querySQL, readDB, writeDB } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, startIsolatedConversation, startNewConversation } from '../server/conversation/manager';
let app:Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();mountConversationRoutes(app.apiRouter,JWT_SECRET);});
afterAll(()=>app.cleanup());
const auth=(uid:string,orgId='')=>({Authorization:'Bearer '+jwt.sign({uid,username:uid,role:'user',...(orgId?{orgId}:{})},JWT_SECRET),'Content-Type':'application/json'});
async function api(uid:string,route:string,body?:any,orgId=''){const response=await fetch(app.url+'/api/conversations'+route,{method:body===undefined?'GET':'POST',headers:auth(uid,orgId),...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,...await response.json()};}
async function reopen(){await flushDBOrThrow();await closeDatabase();await initDatabase();}
function legacy(uid:string,domain:'personal'|'work',orgId:string,sources:Array<string|{source:string;userId?:string;domain?:string;orgId?:string}>,title='legacy header'){
 const conversation=startIsolatedConversation(uid,'lumi',domain,orgId),db=readDB(),row=db.conversations.find(item=>item.id===conversation.id)!;
 row.title=title;row.status='closed';row.lastActiveAt='2099-01-01T00:00:00Z';
 for(const [index,source] of sources.entries()){const detail=typeof source==='string'?{source}:source;db.interactions.push({id:crypto.randomUUID(),userId:detail.userId||uid,agentId:'lumi',conversationId:row.id,role:'user',message:'surface-proof-'+title+'-'+index,response:'',domain:detail.domain||domain,orgId:detail.orgId??orgId,source:detail.source,timestamp:'2026-01-02T03:04:05Z'} as any);}
 row.messageCount=sources.length;writeDB(db);return conversation.id;
}
describe('creation surface survives the real SQLite projection and reload',()=>{
 it('persists new creation and empty isolated headers without replacing the ordinary active chat',async()=>{
  const uid='surface-new-owner',normal=await api(uid,'/new?domain=personal',{agentId:'lumi'}),normalId=normal.conversation.id;
  const created=await api(uid,'/new?domain=personal&surface=creation',{agentId:'lumi'}),creationId=created.conversation.id;
  const empty=await api(uid,'/new?domain=personal&surface=creation',{agentId:'lumi'}),isolated=await api(uid,'/new?domain=personal',{agentId:'lumi',activation:'isolated'});
  addMessageIdempotent({userId:uid,agentId:'lumi',conversationId:creationId,role:'user',content:'surface-new-creation-only-needle',requestId:crypto.randomUUID(),source:'ai-creation',channel:'chat',domain:'personal',orgId:'',deferActionPreparation:true});
  await reopen();
  const rows=await querySQL('SELECT id,surface,status FROM conversations WHERE userId=?',[uid]);expect(rows.find(row=>row.id===creationId)).toMatchObject({surface:'creation',status:'closed'});expect(rows.find(row=>row.id===empty.conversation.id)).toMatchObject({surface:'creation',status:'closed'});expect(rows.find(row=>row.id===normalId)).toMatchObject({surface:'chat',status:'active'});expect(rows.find(row=>row.id===isolated.conversation.id)).toMatchObject({surface:'chat',status:'closed'});
  const chat=await api(uid,'?domain=personal'),creation=await api(uid,'?domain=personal&surface=creation');expect(chat.conversations.map((row:any)=>row.id)).toEqual(expect.arrayContaining([normalId,isolated.conversation.id]));expect(chat.conversations.some((row:any)=>row.id===creationId||row.id===empty.conversation.id)).toBe(false);expect(creation.conversations.map((row:any)=>row.id)).toEqual(expect.arrayContaining([creationId,empty.conversation.id]));
  const restoredCreation=await api(uid,'/active?domain=personal&agentId=lumi&surface=creation');expect([creationId,empty.conversation.id]).toContain(restoredCreation.activeConversation?.id);expect(restoredCreation.activeConversation?.surface).toBe('creation');
  expect((await api(uid,'/active?domain=personal&agentId=lumi')).activeConversation.id).toBe(normalId);expect(getOrCreateActiveConversation(uid,'lumi','personal').id).toBe(normalId);
  expect((await api(uid,'/search?domain=personal&q=surface-new-creation-only-needle')).results).toEqual([]);expect((await api(uid,'/search?domain=personal&surface=creation&q=surface-new-creation-only-needle')).results.map((row:any)=>row.conversationId)).toEqual([creationId]);expect((await api(uid,'/'+creationId+'/activate?domain=personal',{agentId:'lumi'})).status).toBe(404);
  expect((await api('surface-other-owner','?domain=personal&surface=creation')).conversations.some((row:any)=>row.id===creationId)).toBe(false);
 });
 it('upgrades the old schema using only unmixed exact interaction provenance and preserves every original interaction',async()=>{
  const uid='surface-legacy-owner',normal=startNewConversation(uid,'lumi','personal'),org=createOrg('Synthetic surface org','surface-org-'+Date.now(),uid);addMember(org.id,uid,'owner');addMember(org.id,'surface-work-member','member');
  const pure=legacy(uid,'personal','',['ai-creation','ai-creation'],'pure-creation'),mixed=legacy(uid,'personal','',['ai-creation','command-center-chat'],'mixed-history'),unknown=legacy(uid,'personal','',['ai-creation',''],'unknown-history'),empty=legacy(uid,'personal','',[],'AI creation title alone'),wrongOwner=legacy(uid,'personal','',[{source:'ai-creation',userId:'foreign-source-owner'}],'wrong-owner'),wrongDomain=legacy(uid,'personal','',[{source:'ai-creation',domain:'work',orgId:org.id}],'wrong-domain'),foreign=legacy('foreign-header-owner','personal','',['ai-creation'],'foreign-creation'),work=legacy(uid,'work',org.id,['ai-creation'],'work-creation');
  const seeded=readDB();seeded.conversations.find(row=>row.id===pure)!.status='active';writeDB(seeded);
  await flushDBOrThrow();const before=await querySQL('SELECT * FROM interactions ORDER BY id');await closeDatabase();const old=new DatabaseSync(getDataPath('lumi.db'));try{old.exec('ALTER TABLE conversations DROP COLUMN surface');expect(old.prepare('PRAGMA table_info(conversations)').all().some((row:any)=>row.name==='surface')).toBe(false);}finally{old.close();}await initDatabase();
  const rows=await querySQL('SELECT id,userId,domain,orgId,surface,status FROM conversations'),surface=(id:string)=>rows.find(row=>row.id===id)?.surface;expect(surface(pure)).toBe('creation');expect(surface(work)).toBe('creation');expect(surface(foreign)).toBe('creation');for(const id of [mixed,unknown,empty,wrongOwner,wrongDomain])expect(surface(id)).toBe('chat');expect(await querySQL('SELECT * FROM interactions ORDER BY id')).toEqual(before);
  const chat=await api(uid,'?domain=personal&limit=100'),creation=await api(uid,'?domain=personal&surface=creation');expect(chat.conversations.map((row:any)=>row.id)).toEqual(expect.arrayContaining([normal.id,mixed,unknown,empty,wrongOwner,wrongDomain]));expect(chat.conversations.some((row:any)=>[pure,work,foreign].includes(row.id))).toBe(false);expect(creation.conversations.map((row:any)=>row.id)).toEqual([pure]);const workHistory=await api(uid,'?domain=work&surface=creation',undefined,org.id);expect(workHistory).toMatchObject({status:200});expect(workHistory.conversations.map((row:any)=>row.id)).toEqual([work]);expect((await api('surface-work-member','?domain=work&surface=creation',undefined,org.id)).conversations).toEqual([]);
  expect(getOrCreateActiveConversation(uid,'lumi','personal').id).toBe(normal.id);expect((await api(uid,'/active?domain=personal&agentId=lumi')).activeConversation.id).toBe(normal.id);expect((await api(uid,'/search?domain=personal&q=surface-proof-pure-creation')).results).toEqual([]);expect((await api(uid,'/search?domain=personal&surface=creation&q=surface-proof-pure-creation')).results).toHaveLength(2);expect((await api(uid,'/search?domain=personal&q=surface-proof-mixed-history')).results).toHaveLength(2);
  const next=startNewConversation(uid,'lumi','personal');expect(readDB().conversations.find(row=>row.id===pure)?.status).toBe('active');await reopen();expect((await api(uid,'/active?domain=personal&agentId=lumi')).activeConversation.id).toBe(next.id);expect((await querySQL('SELECT surface FROM conversations WHERE id=?',[pure]))[0]).toMatchObject({surface:'creation'});
 });
});
