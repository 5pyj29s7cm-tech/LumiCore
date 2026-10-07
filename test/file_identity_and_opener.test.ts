import './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
const captured=vi.hoisted(()=>({command:'',args:[] as string[],options:null as any}));
vi.mock('child_process',async original=>({...await original<typeof import('node:child_process')>(),spawn:(command:string,args:string[],options:any)=>{captured.command=command;captured.args=args;captured.options=options;const process_=new EventEmitter() as any;process_.stderr=new EventEmitter();process_.kill=vi.fn();queueMicrotask(()=>process_.emit('close',0));return process_;}}));
import { isInsideRoot, openPathWithDefaultApp } from '../server/files/knowledge/paths';
import { groupExistingFileMemories, removeFileMemoryReferences, renameFileMemoryReferences } from '../server/files/knowledge/memory_references';
afterEach(()=>vi.restoreAllMocks());
const scope={domain:'personal',userId:'u',orgId:'',dir:'/audit'} as any;
function memories(){return {memories:[
 {id:'A',type:'knowledge',userId:'u',domain:'personal',sourceInteractionId:'/audit/A.txt',content:'[A.txt #1] upper',keywords:['source:a.txt']},
 {id:'a',type:'knowledge',userId:'u',domain:'personal',sourceInteractionId:'/audit/a.txt',content:'[a.txt #1] lower',keywords:['source:a.txt']},
 {id:'other',type:'knowledge',userId:'other',domain:'personal',sourceInteractionId:'/audit/A.txt',content:'[A.txt #1]',keywords:[]},
],knowledgeFiles:[]};}
describe('platform file identity and source ownership',()=>{
 it('rejects case-distinct POSIX sibling roots and prefix lookalikes',()=>{
  expect(isInsideRoot('/audit/Knowledge/secret','/audit/knowledge','linux')).toBe(false);
  expect(isInsideRoot('/audit/knowledge-old/secret','/audit/knowledge','linux')).toBe(false);
  expect(isInsideRoot('/audit/knowledge/ok','/audit/knowledge/','linux')).toBe(true);
  expect(isInsideRoot('/audit/knowledge/../other/secret','/audit/knowledge','linux')).toBe(false);
  expect(isInsideRoot('/audit/knowledge','/','linux')).toBe(true);
 });
 it('retains Windows drive and UNC case semantics',()=>{
  expect(isInsideRoot('D:\\Knowledge\\file.txt','d:\\knowledge','win32')).toBe(true);
  expect(isInsideRoot('\\\\HOST\\Share\\FILE','\\\\host\\share','win32')).toBe(true);
  expect(isInsideRoot('D:\\knowledge-other\\file','D:\\knowledge','win32')).toBe(false);
 });
 it('deletes only the exact POSIX file and preserves other users',()=>{
  const db=memories();expect(removeFileMemoryReferences(db,'A.txt',scope,'linux')).toBe(1);
  expect(db.memories.map(m=>m.id)).toEqual(['a','other']);
 });
 it('renames only the exact source despite conflicting legacy search tags',()=>{
  const db=memories();expect(renameFileMemoryReferences(db,'A.txt','New.txt','/audit/New.txt',scope,'linux')).toBe(1);
  expect(db.memories[0].sourceInteractionId).toBe('/audit/New.txt');
  expect(db.memories[1].sourceInteractionId).toBe('/audit/a.txt');
  expect(db.memories[2].sourceInteractionId).toBe('/audit/A.txt');
 });
 it('retains legacy extensionless names and case-insensitive Windows grouping',()=>{
  const db={memories:[{id:'readme',type:'knowledge',userId:'u',sourceInteractionId:'README',keywords:[],content:''}]};
  expect(groupExistingFileMemories(db,['README'],scope,{userId:'u',platform:'linux'}).get('README')).toHaveLength(1);
  expect(groupExistingFileMemories(memories(),['a.txt'],scope,{userId:'u',platform:'win32'}).get('a.txt')).toHaveLength(2);
 });
 it('uses a structured legacy source header ahead of conflicting case-folded tags',()=>{
  const db=memories();db.memories[0].sourceInteractionId='legacy-upper-uuid';db.memories[1].sourceInteractionId='legacy-lower-uuid';
  expect(removeFileMemoryReferences(db,'a.txt',scope,'linux')).toBe(1);expect(db.memories.map(m=>m.id)).toEqual(['A','other']);
  db.memories[0].keywords=['SOURCE:A.txt'];expect(renameFileMemoryReferences(db,'A.txt','New.txt','/audit/New.txt',scope,'linux')).toBe(1);expect(db.memories[0].keywords).toEqual(['source:New.txt']);
  const ambiguous={memories:[{id:'unknown',type:'knowledge',userId:'u',sourceInteractionId:'uuid',content:'legacy text',keywords:['source:a.txt']}]};
  expect(removeFileMemoryReferences(ambiguous,'a.txt',scope,'linux')).toBe(0);expect(ambiguous.memories).toHaveLength(1);
 });
 it.skipIf(process.platform!=='win32')('binds existing special file and directory paths through PowerShell without command interpolation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lumi-opener-'));
  try{
   for(const name of ["中文 space ' [folder]","中文 space ' [file].txt"]){
    const target=path.join(root,name);if(name.endsWith('.txt'))fs.writeFileSync(target,'fixture');else fs.mkdirSync(target);
    await openPathWithDefaultApp(target);
    expect(captured.args).toContain('-EncodedCommand');expect(captured.args).not.toContain(target);expect(captured.options.env.LUMI_OPEN_TARGET).toBe(target);
    const script=Buffer.from(captured.args.at(-1)!,'base64').toString('utf16le');
    // Exercise the actual binding and Test-Path, while replacing only OS UI launch.
    const capture='[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; function Start-Process { param([string]$FilePath) [Console]::Write($FilePath) }; '+script;
    const result=await new Promise<string>((resolve,reject)=>execFile(captured.command,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(capture,'utf16le').toString('base64')],{env:captured.options.env,windowsHide:true},(error,stdout)=>error?reject(error):resolve(stdout)));
    expect(result).toBe(target);
   }
   const missing=path.join(root,'missing.txt');await openPathWithDefaultApp(missing);
   await expect(new Promise((resolve,reject)=>execFile(captured.command,captured.args,{env:captured.options.env,windowsHide:true},error=>error?reject(error):resolve(null)))).rejects.toThrow();
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 },15000);
});
