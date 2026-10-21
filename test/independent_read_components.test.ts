import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/defendant_three_read_request_20261021.json';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { buildActionEvidenceContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolExecutionRecord } from '../server/tools/types';
const current = {taskId:'independent-read-task', requestId:'independent-read-request'};
let texts: string[], paths: string[], rows: ToolExecutionRecord[], missing: ToolExecutionRecord, task: string;
const core = (records: ToolExecutionRecord[], text=task, scope=current) => hasCoreActionEvidence(buildActionEvidenceContract(text),records,text,undefined,scope);
beforeAll(async()=>{
 await initDatabase();
 const dir=fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR),'independent-reads-'));
 paths=[path.join(dir,'case-a','source.md'),path.join(dir,'case-b','source.md'),path.join(dir,'third.md')];
 texts=['# First full source\nFIRST-END','## Second full source\nSECOND-END','### Third full source\nTHIRD-END'];
 for(let i=0;i<paths.length;i++){fs.mkdirSync(path.dirname(paths[i]),{recursive:true});fs.writeFileSync(paths[i],texts[i]);}
 task=fixture.documents.reduce((text,doc,i)=>text.replace(doc.path,paths[i]),fixture.prompt);
 const registry=new ToolRegistry(); registerFileOpsTools(registry);
 const read=(source:string,id:string)=>executeToolCall({registry,id,name:'read_file',arguments:{path:source},context:{...current,turnId:current.requestId,userId:'independent-read-user',source:'chat',domain:'personal',authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:task,routedTaskText:task}});
 rows=await Promise.all(paths.map((source,i)=>read(source,'source-'+i)));
 missing=await read(path.join(dir,'missing.md'),'missing-source');
 expect(rows.every(isCanonicalToolExecutionRecord)).toBe(true);expect(rows.map(r=>({name:r.name,error:r.error,status:r.envelope?.status,result:r.result}))).toEqual(texts.map(result=>({name:'read_file',error:undefined,status:'verified_success',result}))); 
});
describe('independently requested file reads use existing all-component evidence',()=>{
 it('recognizes the original unchanged three-source request as exactly three evidence components',()=>{const c=buildActionEvidenceContract(fixture.prompt);expect(c.components).toHaveLength(3);for(let i=0;i<3;i++)expect(c.components![i].text).toContain(fixture.documents[i].path);});
 it.each([1,2])('keeps the whole request incomplete after only %s canonical reads',count=>{expect(core(rows.slice(0,count))).toBe(false);expect(finalizeLumiResponse({...current,taskText:task,responseText:'Three files completed.',toolRecords:rows.slice(0,count),source:'chat'}).blocked).toBe(true);});
 it('delivers all three complete canonical bodies when every independent read succeeds',()=>{expect(core(rows)).toBe(true);const final=finalizeLumiResponse({...current,taskText:task,responseText:'',toolRecords:rows,source:'chat'});expect(final.blocked).toBe(false);for(const body of texts)expect(final.text).toContain(body);});
 it('does not substitute a successful same-named file in another directory',()=>{expect(core([rows[0],rows[0],rows[2]])).toBe(false);});
 it('does not replace the missing third source with a canonical failed read',()=>{expect(core([rows[0],rows[1],missing])).toBe(false);});
 it.each(['taskId','requestId'] as const)('does not consume another current %s',key=>{expect(core(rows,task,{...current,[key]:'foreign'})).toBe(false);});
 it('does not turn a negative file mention into an independent read',()=>{const text='完整读取文件 '+paths[0]+'。不要读取文件 '+paths[1]+'。完整读取文件 '+paths[2]+'。';expect(buildActionEvidenceContract(text).components).toHaveLength(2);expect(core([rows[0],rows[2]],text)).toBe(true);expect(core([rows[1],rows[2]],text)).toBe(false);});
 it('does not turn a quoted read sentence into an independent read',()=>{const text='Read '+paths[0]+'. The note says "Read '+paths[1]+'.". Read '+paths[2]+'.';expect(buildActionEvidenceContract(text).components).toHaveLength(2);expect(core([rows[0],rows[2]],text)).toBe(true);});
 it('does not turn a quoted path queried inside a source into an independent read',()=>{const text='完整读取文件 '+paths[0]+'，检查其是否引用“'+paths[1]+'”。完整读取文件 '+paths[2]+'。';expect(buildActionEvidenceContract(text).components).toHaveLength(2);expect(core([rows[0],rows[2]],text)).toBe(true);expect(core([rows[1],rows[2]],text)).toBe(false);});
});
