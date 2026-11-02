import './helpers';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as DB from '../db_layer';
import { makeApp, JWT_SECRET } from './helpers';
import { registerKnowledgeImportRoutes } from '../server/files/knowledge/import_routes';
import { createInteriorProject, personalInteriorProjectScope } from '../server/design/projects';
import { listInteriorProjectAssets } from '../server/design/project_assets';
import { getPersonalKnowledgeDirectory } from '../server/files/knowledge_directory';
import { createOrg, addMember, logAudit, removeMember } from '../server/org/db';
import { runSerializedMutation } from '../server/persistence/durable_scope_mutation';

let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app=await makeApp();registerKnowledgeImportRoutes(app.apiRouter); });
afterEach(()=>vi.restoreAllMocks());afterAll(()=>app.cleanup());
async function setup() {
  const user=`upload-${crypto.randomUUID()}`,scope=personalInteriorProjectScope(user);
  const project=createInteriorProject(scope,user,{name:'Synthetic upload project'});await DB.flushDBOrThrow();
  return {user,scope,project};
}
function upload(x: Awaited<ReturnType<typeof setup>> & {orgId?:string},name:string,options:{category?:string;batchId?:string}={}) {
  const body=new FormData();body.append('files',new Blob(['Synthetic unsupported binary content.'],{type:'application/octet-stream'}),'fixture-'+name+'.bin');
  body.append('interiorProjectId',x.project.id);body.append('interiorAssetCategory',options.category || 'reference');
  if(options.batchId){body.append('uploadBatchId',options.batchId);body.append('uploadItemIds',JSON.stringify(['synthetic-item']));}
  if(x.orgId)body.append('domain','work');
  return fetch(`${app.url}/api/files/upload${x.orgId?'?domain=work':''}`,{method:'POST',headers:{Cookie:`token=${jwt.sign({uid:x.user,username:x.user,role:'user',...(x.orgId?{orgId:x.orgId}:{})},JWT_SECRET)}`},body});
}
describe('durable design upload associations',()=>{
  it('rolls back an unsaved project association and keeps the already uploaded knowledge bytes',async()=>{
    const x=await setup(), flush=DB.flushDBOrThrow;let failed=false;
    vi.spyOn(DB,'flushDBOrThrow').mockImplementation(async()=>{
      if(!failed && listInteriorProjectAssets(x.scope,x.project.id).length){failed=true;throw new Error('Synthetic association flush failure');}
      await flush();
    });
    const response=await upload(x,'rollback');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({code:'PROJECT_ASSET_PERSISTENCE_UNAVAILABLE',knowledgeFilesRetained:true,associationState:'rolled_back'});
    expect(listInteriorProjectAssets(x.scope,x.project.id)).toEqual([]);
    const meta=DB.readDatabaseTables(['knowledgeFiles']).knowledgeFiles.find((row:any)=>row.userId===x.user);
    expect(meta?.filename).toContain('fixture-rollback');
    expect(fs.existsSync(`${getPersonalKnowledgeDirectory(x.user).dir}/${meta.filename}`)).toBe(true);
    await flush();
    expect(await DB.querySQL('SELECT id FROM interior_project_assets WHERE projectId = ?', [x.project.id])).toEqual([]);
  });

  it('reports a verified association only after its persistence barrier',async()=>{
    const x=await setup(), flush=DB.flushDBOrThrow;
    let entered!:()=>void, release!:()=>void;
    const waiting=new Promise<void>(r=>{entered=r;}), barrier=new Promise<void>(r=>{release=r;});
    vi.spyOn(DB,'flushDBOrThrow').mockImplementation(async()=>{
      if(listInteriorProjectAssets(x.scope,x.project.id).length){entered();await barrier;}await flush();
    });
    let delivered=false;const pending=upload(x,'barrier').then(response=>{delivered=true;return response;});
    await waiting;expect(delivered).toBe(false);release();
    const response=await pending;expect(response.status).toBe(200);
    const payload=await response.json() as any;
    expect(payload.files[0].interiorProjectAsset).toMatchObject({projectId:x.project.id,mimeType:'application/octet-stream',rawSize:37});
    expect((await DB.querySQL('SELECT id FROM interior_project_assets WHERE projectId = ?',[x.project.id]))).toHaveLength(1);
  });

  it('reports unknown disk outcome when rollback persistence also fails without retaining the failed in-memory association',async()=>{
    const x=await setup(),flush=DB.flushDBOrThrow;let associationFailed=false;
    vi.spyOn(DB,'flushDBOrThrow').mockImplementation(async()=>{
      if(associationFailed || listInteriorProjectAssets(x.scope,x.project.id).length){associationFailed=true;throw new Error('Synthetic persistent disk failure');}
      await flush();
    });
    const response=await upload(x,'unknown');expect(response.status).toBe(503);
    const body=await response.json() as any;
    expect(body).toMatchObject({associationState:'unknown',knowledgeFilesRetained:true});
    expect(body.files[0].interiorProjectAsset).toBeUndefined();
    expect(listInteriorProjectAssets(x.scope,x.project.id)).toEqual([]);
    expect(DB.readDatabaseTables(['knowledgeFiles']).knowledgeFiles.some((row:any)=>row.userId===x.user)).toBe(true);
    await flush();
    expect(await DB.querySQL('SELECT id FROM interior_project_assets WHERE projectId = ?',[x.project.id])).toEqual([]);
  });

  it('restores an existing association on idempotent upload retry rather than deleting or recategorizing it',async()=>{
    const x=await setup(),batchId=crypto.randomUUID();
    const initial=await upload(x,'replay',{batchId});expect(initial.status).toBe(200);
    const original=listInteriorProjectAssets(x.scope,x.project.id)[0],flush=DB.flushDBOrThrow;let failed=false;
    vi.spyOn(DB,'flushDBOrThrow').mockImplementation(async()=>{
      if(!failed && listInteriorProjectAssets(x.scope,x.project.id)[0]?.category==='cad'){failed=true;throw new Error('Synthetic recategorization failure');}
      await flush();
    });
    const response=await upload(x,'replay',{batchId,category:'cad'});expect(response.status).toBe(503);
    expect((await response.json() as any).associationState).toBe('rolled_back');
    expect(listInteriorProjectAssets(x.scope,x.project.id)).toEqual([original]);
    expect(DB.readDatabaseTables(['knowledgeFiles']).knowledgeFiles.filter((row:any)=>row.userId===x.user)).toHaveLength(1);
  });

  it('serializes same-project associations and preserves a later successful upload after an earlier failure',async()=>{
    const x=await setup(),flush=DB.flushDBOrThrow;
    let entered!:()=>void,release!:()=>void,claimed=false;
    const waiting=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;});
    vi.spyOn(DB,'flushDBOrThrow').mockImplementation(async()=>{
      if(!claimed && listInteriorProjectAssets(x.scope,x.project.id).length){claimed=true;entered();await barrier;throw new Error('Synthetic first association failure');}
      await flush();
    });
    const first=upload(x,'first');await waiting;
    let delivered=false;const second=upload(x,'second').then(response=>{delivered=true;return response;});
    await vi.waitFor(()=>expect(DB.readDatabaseTables(['knowledgeFiles']).knowledgeFiles.filter((row:any)=>row.userId===x.user)).toHaveLength(2));
    expect(delivered).toBe(false);expect(listInteriorProjectAssets(x.scope,x.project.id)).toHaveLength(1);
    release();expect((await first).status).toBe(503);expect((await second).status).toBe(200);
    const remaining=listInteriorProjectAssets(x.scope,x.project.id);expect(remaining).toHaveLength(1);
    expect(remaining[0].displayName).toContain('second');
    expect(await DB.querySQL('SELECT id FROM interior_project_assets WHERE projectId = ?',[x.project.id])).toEqual([{id:remaining[0].id}]);
  });

  it('rolls back only its organization audit row and keeps an unrelated concurrent audit entry',async()=>{
    const user=`upload-org-${crypto.randomUUID()}`,org=createOrg('Synthetic upload org',`upload-${crypto.randomUUID()}`,user);
    addMember(org.id,user,'owner');const project=createInteriorProject(org.id,user,{name:'Synthetic org project'});await DB.flushDBOrThrow();
    const x={user,orgId:org.id,scope:org.id,project},flush=DB.flushDBOrThrow;let failed=false;
    vi.spyOn(DB,'flushDBOrThrow').mockImplementation(async()=>{
      if(!failed && listInteriorProjectAssets(x.scope,x.project.id).length){
        failed=true;logAudit({orgId:org.id,userId:user,action:'synthetic.unrelated',resourceType:'test',resourceId:'unrelated',details:{fixture:true},ipAddress:'127.0.0.1',userAgent:'test'});
        throw new Error('Synthetic org association failure');
      }
      await flush();
    });
    const response=await upload(x,'org');expect(response.status).toBe(503);
    expect((await response.json() as any).associationState).toBe('rolled_back');
    expect(listInteriorProjectAssets(x.scope,x.project.id)).toEqual([]);
    const rows=DB.readDatabaseTables(['auditLog']).auditLog.filter((row:any)=>row.orgId===org.id);
    expect(rows.some((row:any)=>row.action==='synthetic.unrelated')).toBe(true);
    expect(rows.some((row:any)=>row.action==='interior_project.assets_uploaded')).toBe(false);
  });

  it('rechecks revoked organization membership after waiting for the project mutation lock',async()=>{
    const user=`upload-revoke-${crypto.randomUUID()}`,org=createOrg('Synthetic revoke org',`revoke-${crypto.randomUUID()}`,user);
    addMember(org.id,user,'owner');const project=createInteriorProject(org.id,user,{name:'Synthetic locked project'});await DB.flushDBOrThrow();
    let entered!:()=>void,release!:()=>void;
    const waiting=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;});
    const lock=runSerializedMutation(`interior-project:${org.id}`,async()=>{entered();await barrier;});await waiting;
    const pending=upload({user,orgId:org.id,scope:org.id,project},'revoked');
    try {
      await vi.waitFor(()=>expect(DB.readDatabaseTables(['knowledgeFiles']).knowledgeFiles.some((row:any)=>row.orgId===org.id)).toBe(true));
      removeMember(org.id,user);
    } finally { release();await lock; }
    expect((await pending).status).toBe(403);
    expect(listInteriorProjectAssets(org.id,project.id)).toEqual([]);
  });
});
