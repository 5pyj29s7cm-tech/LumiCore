import './helpers';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {registerFileOpsTools} from '../server/tools/definitions/file_ops';
import {resolveAcceptedTaskTarget} from '../server/conversation/task_target_anchor';
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import capture from './fixtures/captured-typed-bodies.json';
import {initDatabase} from '../db_layer';
import {ToolRegistry} from '../server/tools/registry';
import {registerOCRTools} from '../server/tools/definitions/ocr_tools';
import {executeToolCall,isCanonicalToolExecutionRecord} from '../server/tools/execution_engine';
import {requestsExactReadOnlyArtifactInspection,documentReadMatchesRequestedTarget} from '../server/cognition/action_desktop_evidence';
import {guardCompletionClaims} from '../server/work_product/completion_guard';
import {finalizeLumiResponse} from '../server/cognition/result_finalizer';
beforeAll(async()=>{await initDatabase();});afterEach(()=>{vi.restoreAllMocks();});beforeEach(()=>{vi.clearAllMocks();vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('OFFLINE_CAPTURE_ONLY'));});
describe('one strict document target parser for OCR and document reads',()=>{
 it('uses the actual registered OCR capability and complete same-turn PNG text as relevant read evidence',async()=>{
  const registry=new ToolRegistry();registerOCRTools(registry);const tool=registry.get('ocr_image_file')!;const handler=vi.fn(async()=>capture.ocr.result);tool.handler=handler;
  const task='请读取图片 '+capture.ocr.arguments.imagePath+' 并逐字返回可见原文。';const requestId=randomUUID(),taskId=randomUUID();
  const context:any={userId:'safe-ocr-'+randomUUID(),requestId,taskId,authenticated:true,authRole:'admin',localExecution:true,actionIntent:task,routedTaskText:task,source:'offline-ocr-safety'};
  const record=await executeToolCall({registry,name:'ocr_image_file',arguments:capture.ocr.arguments,context});
  expect(isCanonicalToolExecutionRecord(record)).toBe(true);expect(record.envelope?.status).toBe('verified_success');expect(handler).toHaveBeenCalledOnce();
  const guard=guardCompletionClaims({task,response:capture.ocr.nativeFinalResponse,requestId,taskId,toolCalls:[record]});
  expect(guard.blocked).toBe(false);
  const result=finalizeLumiResponse({taskText:task,responseText:guard.text,completionGuard:guard,toolRecords:[record],requestId,taskId,source:'chat'});
  expect(result.blocked).toBe(false);expect(result.text).toContain(capture.ocr.nativeFinalResponse);
  const visibleLines=[...capture.ocr.analysis.matchAll(/<p>(.*?)<\/p>/gu)].map(match=>match[1]);
  expect(visibleLines).toHaveLength(10);for(const line of visibleLines)expect(result.text).toContain(line);
  expect(fetch).not.toHaveBeenCalled();
 });
 it.each([
  ['notes.txt','Read notes.txt'],
  ['notes.txt','读取notes.txt'],
  ['notes.txt','Read notes.txt and return all visible text.'],
  ['notes.txt','读取notes.txt，逐字返回完整内容。'],
 ])('preserves a real same-turn relative filename read: %s / %s',async(name,task)=>{
  const folder=path.join(String(process.env.LUMI_DATA_DIR),'relative-read-'+randomUUID());fs.mkdirSync(folder,{recursive:true});
  const filePath=path.join(folder,name),body='RELATIVE_SOURCE_BEGIN\nThe receipt preserves every line.\nRELATIVE_SOURCE_END';fs.writeFileSync(filePath,body,'utf8');
  const registry=new ToolRegistry();registerFileOpsTools(registry);const requestId=randomUUID(),taskId=randomUUID();
  const acceptedTaskTarget=resolveAcceptedTaskTarget({text:task,previousTask:{taskId,target:{path:filePath,status:'confirmed'}}});
  expect(acceptedTaskTarget?.target.path).toBeTruthy();
  const record=await executeToolCall({registry,name:'read_file',arguments:{path:filePath},context:{userId:'relative-read-'+randomUUID(),requestId,taskId,authRole:'admin',localExecution:true,source:'offline-relative-read',acceptedTaskTarget,actionIntent:task,routedTaskText:task}});
  expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
  expect(isCanonicalToolExecutionRecord(record)).toBe(true);expect(record.error).toBeUndefined();expect(record.envelope?.status).toBe('verified_success');expect(record.result).toBe(body);
  expect(documentReadMatchesRequestedTarget(record,task)).toBe(true);expect(documentReadMatchesRequestedTarget(record,'Read another.txt')).toBe(false);
  const guard=guardCompletionClaims({task,response:body,requestId,taskId,toolCalls:[record]});expect(guard.blocked).toBe(false);
  const final=finalizeLumiResponse({taskText:task,responseText:body,completionGuard:guard,toolRecords:[record],requestId,taskId,source:'chat'});
  expect(final.blocked).toBe(false);expect(final.text).toContain(body);expect(fetch).not.toHaveBeenCalled();
 });
 it('keeps the existing RTF filename subject hint without granting unbound target access',()=>{expect(requestsExactReadOnlyArtifactInspection('Read notes.rtf and return its complete contents.')).toBe(true);});
 it.each(['读取我的日历安排。','读取客户端当前状态。'])('does not widen non-file observation into exact artifact completion: %s',task=>{expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);});
});
