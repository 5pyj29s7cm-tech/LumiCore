import './helpers';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import {beforeAll,expect,it} from 'vitest';
import {initDatabase,closeDatabase} from '../db_layer';
import {getDataPath} from '../server/config/data_path';
import {ToolRegistry} from '../server/tools/registry';
import {registerMemoryAvatarTools} from '../server/tools/definitions/memory_avatar_tools';
import {deleteMemoryAvatarMedia} from '../server/memory_avatar/media';
import {validMemoryAvatar} from '../src/services/memoryAvatarService';
const registry=new ToolRegistry();registerMemoryAvatarTools(registry);
let sequence=0;
const context={userId:'avatar-author',localExecution:true,domain:'personal',allowLocalFileWrites:true};
const run=async(name:string,args:any,extra={})=>JSON.parse(await registry.execute(name,args,{...context,idempotencyKey:`authoring-${++sequence}`,...extra}));
beforeAll(()=>initDatabase());
it('creates, imports, configures and reopens the same owned person without moving source files',async()=>{
  const createArgs={name:'Synthetic test person',publicBrief:'Approved public identity.'};
  const created=await run('memory_avatar_create',createArgs,{idempotencyKey:'stable-create'});
  expect((await run('memory_avatar_create',createArgs,{idempotencyKey:'stable-create'})).avatarId).toBe(created.avatarId);
  const imports=[];
  for(const [title,color] of [['normal','#445566'],['blink','#665544'],['speech','#446655']]){
    const file=getDataPath(`${title}.png`);await sharp({create:{width:32,height:32,channels:3,background:color}} as any).png().toFile(file);
    const args={avatarId:created.avatarId,filePath:file,title};
    const imported=await run('memory_avatar_import_image',args,{idempotencyKey:title});imports.push(imported.importedMedia.id);
    expect((await fs.stat(file)).size).toBeGreaterThan(0);
    expect((await run('memory_avatar_import_image',args,{idempotencyKey:title})).importedMedia.id).toBe(imported.importedMedia.id);
  }
  const before=await run('memory_avatar_read',{avatarId:created.avatarId});
  const saved=await run('memory_avatar_configure_animation',{avatarId:created.avatarId,revision:before.revision,idleMediaId:imports[0],blinkMediaId:imports[1],speakMediaId:imports[2]});
  expect(saved.animation).toEqual({configured:true,blink:true,speech:true,breathing:true,backgroundMotion:true});
  await closeDatabase();await initDatabase();
  const reopened=await run('memory_avatar_read',{avatarId:created.avatarId});expect(reopened.avatar.presentation).toEqual(saved.avatar.presentation);
  const other=await run('memory_avatar_create',{name:'Other'});
  await expect(run('memory_avatar_configure_animation',{avatarId:other.avatarId,revision:other.revision,idleMediaId:imports[0]})).rejects.toThrow(/belonging/);
  await expect(run('memory_avatar_read',{avatarId:created.avatarId},{userId:'someone-else'})).rejects.toThrow(/not found/);
  const removed=await deleteMemoryAvatarMedia(context.userId,created.avatarId,imports[1],reopened.revision);
  expect(removed.presentation?.mode).toBe('human3d');expect(validMemoryAvatar(removed)).toBe(true);
});
it('rejects network/workspace callers and fake duplicate expressions',async()=>{
  await expect(run('memory_avatar_create',{name:'x'},{localExecution:false})).rejects.toThrow();
  await expect(run('memory_avatar_create',{name:'x'},{domain:'work',orgId:'org'})).rejects.toThrow();
  const a=await run('memory_avatar_create',{name:'No fake frames'});
  const file=getDataPath('same.png');await sharp({create:{width:32,height:32,channels:3,background:'#abcdef'}} as any).png().toFile(file);
  const one=await run('memory_avatar_import_image',{avatarId:a.avatarId,filePath:file,title:'one'});
  const two=await run('memory_avatar_import_image',{avatarId:a.avatarId,filePath:file,title:'two'});
  await expect(run('memory_avatar_configure_animation',{avatarId:a.avatarId,revision:two.revision,idleMediaId:one.importedMedia.id,blinkMediaId:two.importedMedia.id})).rejects.toThrow(/different images/);
  expect((await run('memory_avatar_read',{avatarId:a.avatarId})).revision).toBe(two.revision);
});
