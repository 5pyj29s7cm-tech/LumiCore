import './helpers';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { makeApp, COOKIE_OPTS, JWT_SECRET } from './helpers';
import { mountAuthRoutes } from '../server/routes/auth';
import { readDatabaseTables, commitDatabaseTables, flushDBOrThrow, querySQL } from '../db_layer';
import { initializeDesktopBootstrapProof, getDesktopBootstrapProofPath, resetDesktopBootstrapStateForTests } from '../server/config/desktop_bootstrap';
import { persistModelRoutingReceipt } from '../server/llm/model_routing_receipts';
import { saveKeys } from '../server/config/keys';
import { resetCircuit, getProviderConfigurationEpoch } from '../server/cloud/circuit_breaker';
import { saveProviderProbe, recentProviderProbeFailure, assessProviderAvailability, readProviderProbe } from '../server/llm/provider_health';
let app: Awaited<ReturnType<typeof makeApp>>;
const previousKey = process.env.OPENAI_API_KEY;
const nativeClientIdentity = { schemaVersion: 1, clientKind: 'tauri', pid: process.pid, startedAtUnixMs: Math.floor((Date.now()-10000)/1000)*1000, executablePath: process.execPath, executableSha256: 'd'.repeat(64), binaryHashUnavailable: false, buildId: 'a'.repeat(40), buildIdSemantics: 'baseline_commit', sourceFingerprint: 'e'.repeat(64), sourceDirty: false, appVersion: '3.1.0' };
const post = (route: string, body: unknown, headers: Record<string,string> = {}) => fetch(app.url+'/api'+route, { method: 'POST', headers: { 'Content-Type':'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
function bootstrap() {
  initializeDesktopBootstrapProof();
  return post('/auth/bootstrap', { nativeClientIdentity }, { 'X-Lumi-Desktop-Bootstrap': JSON.parse(fs.readFileSync(getDesktopBootstrapProofPath(),'utf8')).proof });
}
beforeAll(async()=>{ app=await makeApp(); mountAuthRoutes(app.apiRouter,JWT_SECRET,COOKIE_OPTS); });
afterEach(()=>{resetCircuit();});
afterAll(()=>{ app.cleanup(); resetDesktopBootstrapStateForTests({removeFile:true}); if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey; });
it('starts without a seeded administrator and creates one only after native proof',async()=>{
  expect(readDatabaseTables(['users']).users).toHaveLength(0);
  expect(await querySQL('SELECT uid FROM users')).toHaveLength(0);
  expect((await post('/auth/login',{username:'admin',password:'admin123'})).status).toBe(401);
  expect((await post('/auth/bootstrap',{nativeClientIdentity})).status).toBe(403);
  const first=await bootstrap(); expect(first.status).toBe(200); const body=await first.json();
  expect(body.user.password).toBeUndefined(); expect(body.user.localDesktopIdentity).toBe(true);
  const admin=readDatabaseTables(['users']).users[0];
  expect(await bcrypt.compare('admin123',admin.password)).toBe(false);
  const hash=admin.password;
  const second=await bootstrap();expect(second.status).toBe(200);expect((await second.json()).user.uid).toBe(body.user.uid);
  expect(readDatabaseTables(['users']).users).toHaveLength(1);expect(readDatabaseTables(['users']).users[0].password).toBe(hash);
});
it('preserves an existing administrator credential',async()=>{
  const current=readDatabaseTables(['users']);const admin=current.users[0];const password=await bcrypt.hash('Existing-synthetic-secret',10);
  commitDatabaseTables({...current,users:[{...admin,password,localDesktopIdentity:false}]});await flushDBOrThrow();
  expect((await bootstrap()).status).toBe(200);
  expect(readDatabaseTables(['users']).users[0].password).toBe(password);
});
it('rejects reserved administrator name conflicts without changing the account',async()=>{
  const current=readDatabaseTables(['users']);const account={...current.users[0],role:'user'};
  commitDatabaseTables({...current,users:[account]});await flushDBOrThrow();
  const result=await bootstrap();expect(result.status).toBe(409);expect((await result.json()).code).toBe('LOCAL_ADMIN_IDENTITY_CONFLICT');
  expect(readDatabaseTables(['users']).users).toEqual([account]);
});
it('keeps unchanged credential backoff and removes it immediately after a real change',()=>{
  saveKeys({OPENAI_API_KEY:'synthetic-old'});
  saveProviderProbe({provider:'openai',model:'audit-model',ok:false,testedAt:new Date().toISOString()});
  const epoch=getProviderConfigurationEpoch('openai');
  saveKeys({OPENAI_API_KEY:'synthetic-old'});
  expect(getProviderConfigurationEpoch('openai')).toBe(epoch);expect(recentProviderProbeFailure('openai','audit-model')).toBe(true);
  saveKeys({OPENAI_API_KEY:'synthetic-new',OPENAI_BASE_URL:'https://example.invalid/v1'});
  expect(recentProviderProbeFailure('openai','audit-model')).toBe(false);expect(readProviderProbe('openai')?.ok).toBe(false);
  expect(assessProviderAvailability({provider:'openai',model:'audit-model',configured:true})).toMatchObject({candidateEligible:true,readiness:'unknown'});
});
it('rejects stale probe publication and ignores old successful receipts',()=>{
  const old=getProviderConfigurationEpoch('openai');resetCircuit('openai');
  expect(saveProviderProbe({provider:'openai',model:'audit-model',ok:false,testedAt:new Date().toISOString(),configurationEpoch:old})).toBe(false);
  persistModelRoutingReceipt({userId:'audit',domain:'personal',orgId:'',conversationId:'audit',requestId:'audit',interactionId:'',source:'fixture',status:'succeeded',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),durationMs:0,requestedProvider:'openai',requestedModel:'audit-model',selectionMode:'pinned',selectedProvider:'openai',selectedModel:'audit-model',fallbackReason:'',attempts:[{provider:'openai',model:'audit-model',status:'succeeded',configurationEpoch:old,completedAt:new Date().toISOString()}]});
  expect(assessProviderAvailability({provider:'openai',model:'audit-model',configured:true})).toMatchObject({readiness:'unknown',available:false,candidateEligible:true});
  saveProviderProbe({provider:'openai',model:'audit-model',ok:true,testedAt:new Date().toISOString()});
  expect(assessProviderAvailability({provider:'openai',model:'audit-model',configured:true})).toMatchObject({readiness:'healthy',available:true});
});

it('a stale late receipt cannot hide a newer-configuration successful observation',()=>{
 const old=getProviderConfigurationEpoch('openai');resetCircuit('openai');
 const current=getProviderConfigurationEpoch('openai');
 for(const [epoch,status] of [[current,'succeeded'],[old,'failed']] as const){
  persistModelRoutingReceipt({userId:'audit',domain:'personal',orgId:'',conversationId:'audit',requestId:epoch,interactionId:'',source:'fixture',status,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),durationMs:0,requestedProvider:'openai',requestedModel:'audit-model',selectionMode:'pinned',selectedProvider:'openai',selectedModel:'audit-model',fallbackReason:'',attempts:[{provider:'openai',model:'audit-model',status,configurationEpoch:epoch,completedAt:new Date().toISOString()}]});
 }
 expect(assessProviderAvailability({provider:'openai',model:'audit-model',configured:true})).toMatchObject({readiness:'healthy',available:true,reason:'recent_model_success'});
});
