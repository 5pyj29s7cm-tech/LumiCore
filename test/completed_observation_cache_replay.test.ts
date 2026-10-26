import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
const registry = vi.hoisted(() => ({ snapshot: null as any, authorized: true }));
vi.mock('../server/socket/chat_execution_registry', () => ({ getChatExecution: () => registry.snapshot, markChatExecutionCancelling: vi.fn() }));
vi.mock('../server/socket/scope', () => ({ resolveAuthorizedSocketScope: () => registry.authorized ? ({ domain: 'personal', orgId: '' }) : null }));
import { reconcileCompletedChatReplay } from '../server/socket/chat/phases/completed_terminal_replay';
import { registerChatExecutionControls } from '../server/socket/chat/connection_controls';

function fixture() {
  registry.authorized = true;
  const suffix = Date.now() + '-' + Math.random();
  const userId = 'cached-observation-' + suffix;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const requestId = 'cached-request-' + suffix;
  const taskId = 'cached-task-' + suffix;
  const assistantId = 'cached-assistant-' + suffix;
  const now = new Date().toISOString();
  const goal = 'Compare the two supplied events and explain their order. Answer in chat. Do not create files.';
  const text = 'Event one precedes event two. Their order alone does not establish causation.';
  const feedback = { status: 'completed', completed: ['Analysis delivered.'], incomplete: [], blockers: [], nextSteps: [] };
  const records: any[] = [{ id: 'observation-' + suffix, taskId, requestId, name: 'web_search', arguments: { query: 'background' },
    result: 'Search unavailable', error: 'search_unavailable', terminalVerification: { status: 'failed', strategy: 'terminal_receipt' },
    capability: { capabilityId: 'web_search', lane: 'web', operation: 'observe', risk: 'low', sideEffects: [{ type: 'network_read', scope: 'public', reversible: true }], verification: { strategy: 'terminal_receipt', required: true, requiredFields: [], successSignals: [], limitations: [] } } }];
  const state: any = { version: 2, taskId, status: 'blocked', goal, latestInstruction: goal, receipts: [], sourcePaths: [], evidenceTools: [], toolSummaries: [], latestBlocker: 'search_unavailable', unfinished: true, revision: 2, updatedAt: now };
  const task: any = { id: taskId, userId, conversationId: conversation.id, domain: 'personal', orgId: '', parentTaskId: '', rootUserMessageId: 'user-' + suffix, intentKind: 'none', operation: 'read', goal, target: '', status: 'blocked', blocker: 'search_unavailable', activeRequestId: '', completionSource: '', revision: 2, createdAt: now, updatedAt: now, completedAt: '', context: JSON.stringify({ actionState: state, taskFinalization: { outcome: 'blocked', requestId, reason: 'search_unavailable', finalizedAt: now } }) };
  const turn: any = { id: 'turn-' + suffix, userId, conversationId: conversation.id, domain: 'personal', orgId: '', requestId, userMessageId: 'user-' + suffix, taskId, channel: 'chat', source: 'test', status: 'terminal', terminalMessageId: assistantId, terminalReason: 'task_outcome:blocked', revision: 2, createdAt: now, updatedAt: now, terminalAt: now, leaseOwnerId: '', leaseEpoch: '', leaseAcquiredAt: '', leaseHeartbeatAt: '', leaseExpiresAt: '' };
  const assistant: any = { id: assistantId, userId, agentId: 'lumi', conversationId: conversation.id, role: 'assistant', message: text, response: '', requestId, domain: 'personal', source: 'test', channel: 'chat', timestamp: now, receivedAt: now, toolCalls: JSON.stringify(records), completionFeedback: JSON.stringify(feedback) };
  const db = readDB();
  db.conversationActionTasks.push(task); db.conversationActionTurns.push(turn); db.interactions.push(assistant);
  const conv: any = db.conversations.find(x => x.id === conversation.id);
  conv.actionContinuationState = state;
  writeDB(db);
  registry.snapshot = { requestId, source: 'test', conversationId: conversation.id, terminal: true, status: 'completed', createdAt: now, updatedAt: now,
    terminalEvent: { event: 'agent:response', payload: { requestId, source: 'test', conversationId: conversation.id, text, finalized: true, blocked: false, completionFeedback: feedback } } };
  return { scope: { userId, domain: 'personal' as const, orgId: '', source: 'test', conversationId: conversation.id }, requestId, taskId, assistantId, task, turn, assistant, records, feedback, state, conv };
}
function rows(f: ReturnType<typeof fixture>) { const db=readDB(); return { task: db.conversationActionTasks.find(x=>x.id===f.taskId) as any, turn: db.conversationActionTurns.find(x=>x.conversationId===f.scope.conversationId&&x.userId===f.scope.userId&&x.requestId===f.requestId), assistant: db.interactions.find(x=>x.id===f.assistantId), conversation: db.conversations.find(x=>x.id===f.scope.conversationId) as any }; }
describe('exact completed observation terminal replay', () => {
  beforeAll(async () => { await initDatabase(); });
  it('converges only the same durable observation reply and keeps its original body unchanged', async () => {
    const f=fixture(); const body=JSON.stringify(rows(f).assistant); const cached=JSON.stringify(registry.snapshot);
    expect(await reconcileCompletedChatReplay(f.scope,f.requestId)).toBe(true);
    expect(rows(f).task).toMatchObject({status:'completed',blocker:'',activeRequestId:''});
    expect(rows(f).turn).toMatchObject({status:'terminal',terminalMessageId:f.assistantId,terminalReason:'task_outcome:completed'});
    expect(rows(f).conversation.actionContinuationState).toBeUndefined();
    expect(JSON.stringify(rows(f).assistant)).toBe(body); expect(JSON.stringify(registry.snapshot)).toBe(cached);
    const revision=rows(f).task.revision; expect(await reconcileCompletedChatReplay(f.scope,f.requestId)).toBe(false); expect(rows(f).task.revision).toBe(revision);
  });
  it('uses execution_resume without rerunning chat or inference and preserves the cached payload', async () => {
    const f=fixture(); const handlers: Record<string,Function>={}; const emit=vi.fn(); const ack=vi.fn();
    const socket:any={on:(event:string,handler:Function)=>{handlers[event]=handler;},emit,data:{authenticatedUserId:f.scope.userId}};
    registerChatExecutionControls(socket,()=>f.scope.userId,{} as any);
    await handlers['agent:execution_resume']({requestId:f.requestId,source:'test',conversationId:f.scope.conversationId},ack);
    expect(rows(f).task.status).toBe('completed'); expect(rows(f).turn?.terminalReason).toBe('task_outcome:completed');
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ok:true}));
    expect(emit).toHaveBeenCalledWith('agent:response',{...registry.snapshot.terminalEvent.payload,replayed:true});
  });
  it('returns a cache miss from execution_resume without starting a new request', async () => {
    const f=fixture(); registry.snapshot=null; const handlers: Record<string,Function>={};const emit=vi.fn();const ack=vi.fn();
    const socket:any={on:(event:string,handler:Function)=>{handlers[event]=handler;},emit};
    registerChatExecutionControls(socket,()=>f.scope.userId,{} as any);
    await handlers['agent:execution_resume']({requestId:f.requestId,source:'test',conversationId:f.scope.conversationId},ack);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ok:false,code:'EXECUTION_NOT_FOUND'}));
    expect(emit).not.toHaveBeenCalled();expect(rows(f).task.status).toBe('blocked');
  });
  it('does not replay after access is revoked during the durable reconciliation wait', async () => {
    const f=fixture();const handlers: Record<string,Function>={};const emit=vi.fn();const ack=vi.fn();
    const socket:any={on:(event:string,handler:Function)=>{handlers[event]=handler;},emit};
    registerChatExecutionControls(socket,()=>f.scope.userId,{} as any);
    const pending=handlers['agent:execution_resume']({requestId:f.requestId,source:'test',conversationId:f.scope.conversationId},ack);
    registry.authorized=false;await pending;
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ok:false}));expect(emit).not.toHaveBeenCalled();
  });
  it('does not replay a cache removed during the durable reconciliation wait', async () => {
    const f=fixture();const handlers: Record<string,Function>={};const emit=vi.fn();const ack=vi.fn();
    const socket:any={on:(event:string,handler:Function)=>{handlers[event]=handler;},emit};
    registerChatExecutionControls(socket,()=>f.scope.userId,{} as any);
    const pending=handlers['agent:execution_resume']({requestId:f.requestId,source:'test',conversationId:f.scope.conversationId},ack);
    registry.snapshot=null;await pending;
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ok:false,code:'EXECUTION_NOT_FOUND'}));expect(emit).not.toHaveBeenCalled();
  });
  it.each(['cancelled task','failed task','blocked cached receipt','cancelled cached receipt','sidecar','different request','different task finalization','new active owner','new pending owner','different assistant','different response body','blocked assistant disposition','missing completed feedback','real action goal','current instruction action','capsule instruction action','durable side effect','unknown capability','foreign record','expired cache','new task request','new unbound request','false physical claim','false source claim','quarantined task'])(
    'does not promote %s from a completion cache', async kind => {
      const f=fixture(); const db=readDB(); const r=rows(f); const context=JSON.parse(r.task.context);
      if(kind==='cancelled task'){r.task.status='cancelled';r.task.completionSource='superseded';}
      if(kind==='failed task')r.task.status='failed';
      if(kind==='blocked cached receipt')registry.snapshot.terminalEvent.payload.blocked=true;
      if(kind==='cancelled cached receipt')registry.snapshot.status='cancelled';
      if(kind==='expired cache')registry.snapshot.updatedAt=new Date(Date.now()-31*60*1000).toISOString();
      if(kind==='new unbound request')db.conversationActionTurns.push({...f.turn,id:'unbound-'+f.turn.id,taskId:'',requestId:'successor',status:'accepted'});
      if(kind==='new task request')db.conversationActionTurns.push({...f.turn,id:'successor-'+f.turn.id,requestId:'successor',status:'accepted'});
      if(kind==='sidecar')registry.snapshot.sidecar=true;
      if(kind==='different request')registry.snapshot.requestId='another-request';
      if(kind==='different task finalization'){context.taskFinalization.requestId='successor';r.task.context=JSON.stringify(context);}
      if(kind==='new active owner')r.task.activeRequestId='successor';
      if(kind==='new pending owner')r.conversation.pendingActionContinuation={requestId:'successor'};
      if(kind==='different assistant')r.turn!.terminalMessageId='other-assistant';
      if(kind==='different response body')registry.snapshot.terminalEvent.payload.text+=' extra';
      if(kind==='blocked assistant disposition')(r.assistant as any).terminalTaskDisposition={outcome:'blocked',taskId:f.taskId,requestId:f.requestId};
      if(kind==='missing completed feedback')(r.assistant as any).completionFeedback=JSON.stringify({status:'blocked'});
      if(kind==='real action goal')r.task.goal='Read the complete contents of D:/unknown/source.docx and explain them.';
      if(kind==='current instruction action'){context.actionState.latestInstruction='Send the result to the reviewer.';r.task.context=JSON.stringify(context);}
      if(kind==='capsule instruction action'){context.actionState.taskCapsule={schemaVersion:1,taskId:f.taskId,goal:f.task.goal,currentInstruction:'Read the complete file D:/unknown/source.docx.'};r.task.context=JSON.stringify(context);}
      if(kind==='durable side effect'){f.records[0].capability.operation='mutate';(r.assistant as any).toolCalls=JSON.stringify(f.records);}
      if(kind==='unknown capability'){delete f.records[0].capability;(r.assistant as any).toolCalls=JSON.stringify(f.records);}
      if(kind==='foreign record'){f.records[0].requestId='another-request';(r.assistant as any).toolCalls=JSON.stringify(f.records);}
      if(kind==='false physical claim'||kind==='false source claim'){const text=kind==='false physical claim'?'I have saved the requested file.':'I have searched and verified the original sources.';(r.assistant as any).message=text;registry.snapshot.terminalEvent.payload.text=text;}
      if(kind==='quarantined task'){context.terminalPersistence={status:'persistence_unknown',requestId:f.requestId};r.task.context=JSON.stringify(context);}
      writeDB(db); const before=JSON.stringify(rows(f));
      expect(await reconcileCompletedChatReplay(f.scope,f.requestId)).toBe(false);
      expect(JSON.stringify(rows(f))).toBe(before);
    });
});
