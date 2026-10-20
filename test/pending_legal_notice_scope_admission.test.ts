import * as preparation from '../server/regions/packs/cn/messaging_turn/execution_preparation';
import './helpers';
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { initDatabase, readDB, flushDBOrThrow, closeDatabase } from '../db_layer';
import * as org from '../server/org/db';
import * as cases from '../server/org/legal_cases';
import * as routing from '../server/org/work_routing';
import { toolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { processWithPersonality } from '../server/regions/packs/cn/messaging_routes';
import { planRemoteOrganizationScope, handleRemoteLegalNoticeIntake } from '../server/regions/packs/cn/legal_notice_intake';
import { savePendingLegalNotice, getPendingLegalNotice } from '../server/messaging/legal_notice_pending';
import { captureMessagingOrganization } from '../server/messaging/turn_authorization';
import { getDisplayText, getRequestText } from '../server/regions/packs/cn/remote_materials';
import { conversationForMessagingTurn } from '../server/regions/packs/cn/messaging_persistence';
import { recordPendingConfirmation, getPendingConfirmation, buildTransportNeutralConfirmationScope } from '../server/tools/pending_confirmation';
import type { IncomingMessage } from '../server/messaging/types';

let seq = 0, user: string, orgId: string, caseId: string, original: string;
beforeAll(async () => { await initDatabase(); registerLegalTools(toolRegistry); });
beforeEach(() => {
  seq++; user = 'notice-select-user-' + seq;
  orgId = org.createOrg('Synthetic notice selection', 'notice-selection-' + seq, user + '-owner').id;
  org.addMember(orgId, user + '-owner', 'owner'); org.addMember(orgId, user, 'member');
  const file = cases.createCase(orgId, user, { title: 'Synthetic explicit case ' + seq, caseNumber: '（2027）沪0101民初' + (9100 + seq) + '号', stage: 'filing' });
  caseId = file.id; original = '请归档到已有案件，案号' + file.caseNumber + '。这是虚构验收通知，不提交法院。';
});
afterEach(() => vi.restoreAllMocks());
function msg(text: string, id = 'notice-choice-' + seq): IncomingMessage {
  return { platform: 'feishu', userId: 'ou-notice-' + seq, userName: 'Synthetic', chatId: 'notice-chat-' + seq,
    chatType: 'private', text, messageId: id, raw: {}, timestamp: new Date().toISOString(), boundUserId: user };
}
function seed() {
  const file = cases.getCase(orgId, caseId, user)!;
  return savePendingLegalNotice({ userId: user, message: msg(original), messageText: original, candidates: [{ orgId, orgName: 'Synthetic notice selection', caseId, caseTitle: file.title, caseNumber: file.caseNumber }] });
}
async function selected(text = '归档到 1') {
  const input = msg(text); const plan = await planRemoteOrganizationScope(input);
  return { input, plan, admitted: captureMessagingOrganization(plan.resolution.message) };
}
function materialCount() { return cases.getCase(orgId, caseId, user)!.materials.length; }

describe('pending legal notice pre-admission scope selection', () => {
  it('keeps the actual user choice and original request separate before scope freezes', async () => {
    seed(); const { input, plan, admitted } = await selected();
    expect(input.boundOrgId).toBeUndefined(); expect(input.text).toBe('归档到 1');
    expect(plan.resolution.kind).toBe('organization'); expect(admitted.boundOrgId).toBe(orgId);
    expect(admitted.text).toBe(input.text); expect(getDisplayText(admitted)).toBe(input.text);
    expect(getRequestText(admitted)).toBe(input.text);
    expect(admitted.legalNoticeSelection?.requestText).toBe(original);
    expect(admitted.legalNoticeSelection?.selectionText).toBe(input.text);
    expect(getPendingLegalNotice(input, user)).not.toBeNull();
  });

  it('executes the explicit choice through the same task, real legal registry receipt and exact case', async () => {
    seed(); const before = materialCount(); const input = msg('归档到 1');
    const reply = await processWithPersonality(input);
    expect(materialCount()).toBeGreaterThan(before);
    const archivedCase = cases.getCase(orgId, caseId, user)!;
    expect(archivedCase).toMatchObject({ id: caseId, orgId, createdBy: user });
    expect(reply).toContain(archivedCase.title);
    expect(reply).toContain(`案件现有材料：共 ${archivedCase.materials.length} 份`);
    expect(reply).not.toContain(caseId);
    for (const material of archivedCase.materials) expect(reply).not.toContain(material.id);
    expect(input.text).toBe('归档到 1'); expect(input.boundOrgId).toBeUndefined();
    expect(getPendingLegalNotice(input, user)).toBeNull();
    const db = readDB();
    const row = db.interactions.find((r: { userId: string; role: string; externalMessageId?: string }) => r.userId === user && r.role === 'user' && r.externalMessageId === input.messageId)!;
    expect(row.message).toBe('归档到 1'); expect(row.domain).toBe('work'); expect(row.orgId).toBe(orgId);
    const item = routing.listOrganizationWorkItems(orgId)[0]; expect(item).toBeTruthy();
    expect(item.requestId).toBe('feishu_bot:' + input.messageId);
    const task = db.conversationActionTasks.find((r: { id: string }) => r.id === item.taskId);
    expect(JSON.stringify(task)).toContain(original);
    expect(db.conversationActionReceipts).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: item.taskId, requestId: item.requestId, toolName: 'legal_message_intake_to_case', outcome: 'verified_success' })]));
    await flushDBOrThrow();
  });

  it('does not choose an ambiguous pending candidate or create organization work', async () => {
    const file = cases.getCase(orgId, caseId, user)!;
    const other = cases.createCase(orgId, user, { title: 'Second synthetic case', caseNumber: '（2027）沪0101民初99998号' });
    savePendingLegalNotice({ userId: user, message: msg(original), messageText: original, candidates: [file, other].map(f => ({ orgId, orgName: 'Synthetic notice selection', caseId: f.id, caseTitle: f.title, caseNumber: f.caseNumber })) });
    const reply = await processWithPersonality(msg('选择'));
    expect(reply).toContain('目前不能唯一确定组织案件'); expect(materialCount()).toBe(0);
    expect(routing.listOrganizationWorkItems(orgId)).toEqual([]); expect(getPendingLegalNotice(msg('选择'), user)).not.toBeNull();
  });

  it('retains an unselected personal notice without implicitly entering its only organization', async () => {
    const input = msg(original);
    const reply = await processWithPersonality(input);
    expect(reply).toContain('目前不能唯一确定组织案件'); expect(input.boundOrgId).toBeUndefined();
    expect(materialCount()).toBe(0); expect(routing.listOrganizationWorkItems(orgId)).toEqual([]);
    expect(getPendingLegalNotice(input, user)?.messageText).toBe(original);
  });

  it('does not bypass organization approval or consume the pending record on refusal', async () => {
    seed(); const department = org.createDepartment(orgId, 'Synthetic approval department').id;
    routing.createOrganizationWorkRoutingRule({ orgId, actorUserId: user + '-owner', name: 'Pending notice approval', keywords: [], departmentId: department, approvalMode: 'admin' });
    const reply = await processWithPersonality(msg('归档到 1'));
    expect(reply).toContain('等待组织管理员审批'); expect(materialCount()).toBe(0);
    expect(getPendingLegalNotice(msg('归档到 1'), user)).not.toBeNull();
    expect(routing.listOrganizationWorkItems(orgId)).toHaveLength(1);
    expect(routing.listOrganizationWorkItems(orgId)[0].status).toBe('waiting_approval');
  });

  it('denies a revoked membership after selection and performs no archive', async () => {
    seed(); const { admitted } = await selected(); org.setMemberStatus(orgId, user, 'suspended');
    const adapter = vi.fn();
    await expect(handleRemoteLegalNoticeIntake(admitted, { domain: 'work', orgId, onAdapterStart: adapter })).rejects.toThrow();
    expect(adapter).not.toHaveBeenCalled(); expect(cases.getCase(orgId, caseId)!.materials).toHaveLength(0);
    expect(getPendingLegalNotice(msg('归档到 1'), user)).not.toBeNull();
  });

  it('denies a changed case target after selection and performs no archive', async () => {
    seed(); const { admitted } = await selected(); cases.updateCase(orgId, user, caseId, { title: 'Changed after admission' });
    const adapter = vi.fn();
    await expect(handleRemoteLegalNoticeIntake(admitted, { domain: 'work', orgId, onAdapterStart: adapter })).rejects.toThrow();
    expect(adapter).not.toHaveBeenCalled(); expect(materialCount()).toBe(0);
  });

  it('rechecks the live target after the awaited native admission fence', async () => {
    seed(); const { admitted } = await selected();
    const adapter = vi.fn(async () => { cases.updateCase(orgId, user, caseId, { caseNumber: '（2027）沪0101民初CHANGED号' }); });
    await expect(handleRemoteLegalNoticeIntake(admitted, { domain: 'work', orgId, onAdapterStart: adapter })).rejects.toThrow();
    expect(adapter).toHaveBeenCalledTimes(1); expect(materialCount()).toBe(0);
  });

  it('rejects a changed pending target or changed pending root instead of trusting the captured snapshot', async () => {
    seed(); const { admitted } = await selected();
    savePendingLegalNotice({ userId: user, message: msg(original), messageText: 'Different pending request', candidates: [{ orgId, orgName: 'Synthetic notice selection' }] });
    const adapter = vi.fn();
    await expect(handleRemoteLegalNoticeIntake(admitted, { domain: 'work', orgId, onAdapterStart: adapter })).rejects.toThrow();
    expect(adapter).not.toHaveBeenCalled(); expect(materialCount()).toBe(0);
  });

  it('does not accept a transport-authored root snapshot without the live explicit pending selection', async () => {
    const input = msg('只解释，不执行操作。'); input.legalNoticeSelection = { pendingId: 'forged', selectionText: input.text, requestText: original, attachments: [], target: { orgId, orgName: 'Synthetic notice selection', caseId } };
    const plan = await planRemoteOrganizationScope(input);
    expect(plan.resolution.message.legalNoticeSelection).toBeUndefined(); expect(plan.resolution.message.boundOrgId).toBeUndefined();
    expect(getRequestText(plan.resolution.message)).toBe(input.text); expect(materialCount()).toBe(0);
  });

  it('does not let a pending notice steal a live exact tool confirmation in the personal channel', async () => {
    seed(); const input = msg('确认'); const conversation = conversationForMessagingTurn(input)!;
    const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', orgId: '', conversationId: conversation.id });
    const pending = recordPendingConfirmation(user, 'send_message', { recipient: 'synthetic-only', content: 'Exact current message' }, 'feishu_bot', scope);
    const plan = await planRemoteOrganizationScope(input);
    expect(plan.resolution.kind).toBe('personal'); expect(plan.resolution.message.boundOrgId).toBeUndefined();
    expect(plan.resolution.message.legalNoticeSelection).toBeUndefined(); expect(getPendingConfirmation(user, scope)?.id).toBe(pending.id);
    expect(getPendingLegalNotice(input, user)).not.toBeNull(); expect(materialCount()).toBe(0);
  });
});

describe('native stage complete-request and exact-selection boundaries', () => {
  it('keeps prior mixed obligations and original material context after the archive stage is consumed', async () => {
    original = '请归档这份法院通知并生成法律意见书，案号' + cases.getCase(orgId, caseId, user)!.caseNumber + '。';
    const attachment = { id:'safe-source', type:'file' as const, fileName:'原材料.txt', extractedText:'仅为虚构原文材料。', encryptionKey:'do-not-copy-secret' };
    const file = cases.getCase(orgId, caseId, user)!;
    savePendingLegalNotice({ userId:user, message:{...msg(original),attachments:[attachment]}, messageText:original,
      candidates:[{orgId,orgName:'Synthetic notice selection',caseId,caseTitle:file.title,caseNumber:file.caseNumber}] });
    const input = msg('归档到 1'); const reply = await processWithPersonality(input);
    const db = readDB(); const userRow = db.interactions.find((row: { externalMessageId?: string; role: string; userId: string }) => row.externalMessageId === input.messageId && row.role === 'user' && row.userId === user)!;
    expect(userRow.message).toBe(input.text);
    const task = db.conversationActionTasks.find((row: { rootUserMessageId: string }) => row.rootUserMessageId === userRow.id)!;
    expect(task.goal).toContain(input.text); expect(task.goal).not.toContain(original);
    expect(task.status).not.toBe('completed');
    const archivedCase = cases.getCase(orgId, caseId, user)!;
    expect(archivedCase).toMatchObject({ id: caseId, orgId, createdBy: user });
    expect(reply).toContain(archivedCase.title);
    expect(reply).toContain(`案件现有材料：共 ${archivedCase.materials.length} 份`);
    expect(reply).not.toContain(caseId);
    for (const material of archivedCase.materials) expect(reply).not.toContain(material.id);
    expect(reply).toContain('当前仅核验入案阶段'); expect(reply).not.toContain('法律意见书已生成');
    expect(db.conversationActionReceipts.filter((row: { taskId: string; toolName: string }) => row.taskId === task.id && row.toolName === 'legal_generate_opinion')).toEqual([]);
    const saved = JSON.parse(task.context).remoteLegalNoticeSelection;
    expect(saved).toMatchObject({selectionText:input.text,requestText:original,attachments:[{id:'safe-source',fileName:'原材料.txt',extractedText:attachment.extractedText}]});
    expect(JSON.stringify(saved)).not.toContain('do-not-copy-secret');
    expect(getPendingLegalNotice(input,user)).toBeNull(); await flushDBOrThrow();
  });
  it.each(['归档到1吗？','归档到 1，然后打开 WPS。'])('never treats the prefix of %s as an exact cross-domain archive grant', async current => {
    seed(); const input = msg(current); const admitted: string[] = [];
    const prepare = preparation.prepareMessagingExecution;
    vi.spyOn(preparation,'prepareMessagingExecution').mockImplementation(async context => {admitted.push(context.executionPlan.resolution.userText); return prepare(context);});
    const reply = await processWithPersonality(input);
    expect(input.text).toBe(current); expect(input.boundOrgId).toBeUndefined();
    expect(admitted).toEqual([]); expect(materialCount()).toBe(0);
    expect(routing.listOrganizationWorkItems(orgId)).toEqual([]); expect(getPendingLegalNotice(input,user)).not.toBeNull();
    expect(reply).toContain('目前不能唯一确定组织案件');
    expect(readDB().conversationActionTasks.filter((task: {userId:string;status:string}) => task.userId===user && task.status==='completed')).toEqual([]);
  });
  it('does not use a registered legacy link tool when the unified archive tool is missing', async () => {
    seed(); const input=msg('归档到 1'); const pending=getPendingLegalNotice(input,user)!;
    const modern=toolRegistry.get('legal_message_intake_to_case')!; expect(modern).toBeTruthy();
    expect(toolRegistry.get('legal_process_notice_link')).toBeTruthy();
    const beforeCases=cases.listCases(orgId,'',20,user).map(item=>({id:item.id,materials:item.materials}));
    const beforeReminders=readDB().reminders.filter((row:{userId:string})=>row.userId===user);
    const execute=vi.spyOn(toolRegistry,'execute'); const fetch=vi.spyOn(globalThis,'fetch');
    toolRegistry.unregister('legal_message_intake_to_case');
    try {
      const reply=await processWithPersonality(input);
      expect(reply).toContain('当前法律消息入案工具未注册');
      expect(cases.listCases(orgId,'',20,user).map(item=>({id:item.id,materials:item.materials}))).toEqual(beforeCases);
      expect(readDB().reminders.filter((row:{userId:string})=>row.userId===user)).toEqual(beforeReminders);
      expect(execute.mock.calls.filter(call=>call[0]==='legal_process_notice_link')).toEqual([]);
      expect(fetch).not.toHaveBeenCalled(); expect(getPendingLegalNotice(input,user)?.id).toBe(pending.id);
      expect(routing.listOrganizationWorkItems(orgId)).toEqual([]);
    } finally { toolRegistry.register(modern); }
  });
});

describe('server-bound native capability keeps existing policy and exact call boundary', () => {
  it('cannot widen a scoped personality forbidden policy for an exact pending choice', async () => {
    seed(); const {personalityRegistry}=await import('../server/personality/registry');
    const personality={...personalityRegistry.getDefault(),toolPolicy:{allowedTools:[],requireConfirmation:[],forbiddenTools:['*'],maxIterations:0}};
    const policies: string[][]=[]; const prepare=preparation.prepareMessagingExecution;
    vi.spyOn(preparation,'prepareMessagingExecution').mockImplementation(async context=>{policies.push(context.executionPlan.authorizationPolicy.forbiddenTools);return prepare(context);});
    const input=msg('归档到 1'); await processWithPersonality(input,{personalityRegistry:{getForUser:()=>personality,getDefault:()=>personality}});
    expect(policies).toEqual([['*']]); expect(materialCount()).toBe(0);
    expect(getPendingLegalNotice(input,user)).not.toBeNull(); expect(routing.listOrganizationWorkItems(orgId)).toEqual([]);
  });
  it('does not write for a viewer even when that user has a previously saved pending target', async () => {
    seed(); org.updateMemberRole(orgId,user,'viewer'); const input=msg('归档到 1');
    await processWithPersonality(input); expect(materialCount()).toBe(0);
    expect(getPendingLegalNotice(input,user)).not.toBeNull(); expect(routing.listOrganizationWorkItems(orgId)).toEqual([]);
  });
  it('rejects a changed registered manifest after admission before the actual archive adapter', async () => {
    seed(); const definition=toolRegistry.get('legal_message_intake_to_case')!;
    const prepare=preparation.prepareMessagingExecution;
    vi.spyOn(preparation,'prepareMessagingExecution').mockImplementation(async context=>{
      const prepared=await prepare(context); toolRegistry.unregister(definition.name);
      toolRegistry.register({...definition,capability:{...definition.capability,risk:'critical'}}); return prepared;
    });
    const input=msg('归档到 1');
    try { await processWithPersonality(input); expect(materialCount()).toBe(0); expect(getPendingLegalNotice(input,user)).not.toBeNull(); }
    finally {toolRegistry.unregister(definition.name);toolRegistry.register(definition);}
  });
  it('rejects a changed frozen arguments digest without losing the original current user text', async () => {
    seed(); const prepare=preparation.prepareMessagingExecution; const accepted: string[]=[];
    vi.spyOn(preparation,'prepareMessagingExecution').mockImplementation(async context=>{
      accepted.push(context.executionPlan.resolution.userText); const prepared=await prepare(context);
      if(prepared.context?.msg.legalNoticeSelection?.execution) {
        const selection=prepared.context.msg.legalNoticeSelection;
        prepared.context.msg.legalNoticeSelection={...selection,execution:{...selection.execution!,argumentsDigest:'0'.repeat(64)}};
      }
      return prepared;
    });
    const execute=vi.spyOn(toolRegistry,'execute'); const input=msg('归档到 1'); const reply=await processWithPersonality(input);
    expect(accepted).toEqual([input.text]); expect(materialCount()).toBe(0);
    expect(execute.mock.calls.filter(call=>call[0]==='legal_message_intake_to_case')).toEqual([]);
    expect(getPendingLegalNotice(input,user)).not.toBeNull();
    expect(routing.listOrganizationWorkItems(orgId)).toEqual([]);
    const db=readDB(), requestId='feishu_bot:'+input.messageId;
    const userRow=db.interactions.find((row:any)=>row.userId===user&&row.role==='user'&&row.externalMessageId===input.messageId)!;
    expect(userRow).toMatchObject({userId:user,requestId,orgId,domain:'work',message:input.text});
    const turn=db.conversationActionTurns.find((row:any)=>row.userId===user&&row.requestId===requestId&&row.conversationId===userRow.conversationId)!;
    expect(turn).toMatchObject({userId:user,requestId,userMessageId:userRow.id,orgId,domain:'work'});
    expect(turn.taskId).toBeTruthy();
    const task=db.conversationActionTasks.find((row:any)=>row.id===turn.taskId)!;
    expect(task).toMatchObject({userId:user,orgId,domain:'work',status:'blocked',conversationId:userRow.conversationId});
    const context=JSON.parse(task.context);
    expect(context.taskFinalization).toMatchObject({requestId,outcome:'blocked'});
    expect(context.actionState.unfinished).toBe(true);
    expect(context.remoteLegalNoticeSelection.target).toMatchObject({orgId,caseId});
    expect(context.remoteLegalNoticeSelection.requestText).toBe(original);
    expect(getPendingLegalNotice(input,user)?.messageText).toBe(original);
    expect(reply).toContain('本步执行校验未通过');
    expect(reply).not.toContain('语言模型暂时不可用');
    expect(reply).not.toContain('0'.repeat(64));
    expect(reply).not.toContain(requestId); expect(reply).not.toContain(task.id);
  });
});

describe('a consumed native stage cannot expand its mutation on a later continuation', () => {
  it('does not re-archive changed material arguments after durable reload merely because the user says continue', async () => {
    seed(); const first=msg('归档到 1'); let originalArgs: Record<string, unknown>|undefined;
    const prepare=preparation.prepareMessagingExecution;
    vi.spyOn(preparation,'prepareMessagingExecution').mockImplementation(async context=>{
      const prepared=await prepare(context);
      if(prepared.context){ const observe=prepared.context.remoteToolContext.onToolRecord;
        prepared.context.remoteToolContext.onToolRecord=record=>{observe(record);if(record.name==='legal_message_intake_to_case'&&record.envelope?.status==='verified_success') originalArgs={...record.arguments};}; }
      return prepared;
    });
    const {personalityRegistry}=await import('../server/personality/registry');
    const originalDenies=Array.from({length:160},(_,index)=>'unchanged_denied_tool_'+index);
    const base=personalityRegistry.getDefault(); const personality={...base,toolPolicy:{...base.toolPolicy,forbiddenTools:originalDenies}};
    await processWithPersonality(first,{personalityRegistry:{getForUser:()=>personality,getDefault:()=>personality}});
    expect(originalArgs).toBeTruthy(); const before=materialCount(); expect(before).toBe(1);
    const originalTask=readDB().conversationActionTasks.find((row:{id:string})=>row.id===routing.listOrganizationWorkItems(orgId)[0].taskId)!;
    const taskId=originalTask.id, savedBefore=JSON.parse(originalTask.context);
    expect(savedBefore.nativeLegalStage.receipt).toMatchObject({taskId,requestId:'feishu_bot:'+first.messageId,orgId,pendingId:savedBefore.remoteLegalNoticeSelection.pendingId});
    expect(savedBefore.actionState.policySnapshot.forbiddenTools).toEqual([...originalDenies,'legal_message_intake_to_case']);
    await flushDBOrThrow(); await closeDatabase(); await initDatabase();
    const loaded=readDB().conversationActionTasks.find((row:{id:string})=>row.id===taskId)!;
    expect(JSON.parse(loaded.context).actionState.policySnapshot.forbiddenTools).toEqual([...originalDenies,'legal_message_intake_to_case']);
    expect(getPendingLegalNotice(first,user)).toBeNull(); const execute=vi.spyOn(toolRegistry,'execute'); let selected=false;
    const sdk=vi.fn(async (input:{tools?:Array<{function:{name:string}}>} )=>{
      const canArchive=input.tools?.some(tool=>tool.function.name==='legal_message_intake_to_case');
      if(canArchive&&!selected){selected=true;return {choices:[{message:{content:'',tool_calls:[{id:'changed-archive-call',type:'function',function:{name:'legal_message_intake_to_case',arguments:JSON.stringify({...originalArgs,message:String(originalArgs!.message)+'\n未获新指令的追加材料。'})}}]}}]};}
      return {choices:[{message:{content:input.tools?'没有新的可执行入案结果。':JSON.stringify({memories:[],reminders:[]})}}]};
    });
    const next=msg('继续',first.messageId+'-continue'); await processWithPersonality(next,{llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create:sdk}}})}});
    expect(execute.mock.calls.filter(call=>call[0]==='legal_message_intake_to_case')).toEqual([]);
    expect(materialCount()).toBe(before); expect(getPendingLegalNotice(next,user)).toBeNull();
    const restored=readDB().conversationActionTasks.find((row:{id:string})=>row.id===taskId)!;
    expect(restored).toMatchObject({id:taskId,userId:user,domain:'work',orgId,status:'blocked'});
    expect(restored.goal).toBe(first.text); expect(JSON.stringify(restored)).toContain(original);
    expect(JSON.parse(restored.context).actionState.policySnapshot.forbiddenTools).toEqual([...originalDenies,'legal_message_intake_to_case']);
    expect(readDB().conversationActionTurns.find((row:{requestId:string})=>row.requestId==='feishu_bot:'+next.messageId)).toMatchObject({taskId,domain:'work',orgId});
  });

  it('permits a genuinely new live complete pending choice as a distinct task without dropping old denies', async () => {
    seed(); const first=msg('归档到 1'); await processWithPersonality(first);
    const oldItem=routing.listOrganizationWorkItems(orgId)[0], oldTaskId=oldItem.taskId;
    const oldState=JSON.parse(readDB().conversationActionTasks.find((row:{id:string})=>row.id===oldTaskId)!.context);
    expect(oldState.actionState.policySnapshot.forbiddenTools).toContain('legal_message_intake_to_case');
    const next=msg('归档到 1',first.messageId+'-new-explicit'); const caseFile=cases.getCase(orgId,caseId,user)!;
    const pending=savePendingLegalNotice({userId:user,message:next,messageText:original+'\n这是另一次明确提供的新材料。',candidates:[{orgId,orgName:'Synthetic notice selection',caseId,caseTitle:caseFile.title,caseNumber:caseFile.caseNumber}]});
    const before=materialCount(); const reply=await processWithPersonality(next);
    expect(materialCount()).toBe(before+1); expect(getPendingLegalNotice(next,user)).toBeNull();
    const archivedCase = cases.getCase(orgId, caseId, user)!;
    expect(archivedCase).toMatchObject({ id: caseId, orgId, createdBy: user });
    expect(reply).toContain(archivedCase.title);
    expect(reply).toContain(`案件现有材料：共 ${archivedCase.materials.length} 份`);
    expect(reply).not.toContain(caseId);
    for (const material of archivedCase.materials) expect(reply).not.toContain(material.id);
    const newItem=routing.listOrganizationWorkItems(orgId).find(item=>item.requestId==='feishu_bot:'+next.messageId)!;
    expect(newItem).toBeTruthy(); expect(newItem.taskId).not.toBe(oldTaskId);
    const newTask=readDB().conversationActionTasks.find((row:{id:string})=>row.id===newItem.taskId)!;
    expect(newTask).toMatchObject({goal:next.text,orgId,userId:user,status:'blocked'});
    expect(JSON.parse(newTask.context).remoteLegalNoticeSelection.pendingId).toBe(pending.id);
    expect(JSON.parse(readDB().conversationActionTasks.find((row:{id:string})=>row.id===oldTaskId)!.context).actionState.policySnapshot.forbiddenTools).toContain('legal_message_intake_to_case');
  });
});

describe('native single-case proof for a newly selected case', () => {
  it('retains committed progress but blocks an actual canonical producer that also writes an extra case and never replays it', async () => {
    original='请新建案件并归档这份虚构法院通知。开庭日期2099年12月31日9时。'; const input=msg('归档到 1'); const title='Synthetic requested new case '+seq;
    savePendingLegalNotice({userId:user,message:input,messageText:original,candidates:[{orgId,orgName:'Synthetic notice selection',caseTitle:title}]});
    const definition=toolRegistry.get('legal_message_intake_to_case')!;
    const {encodeToolResult,decodeToolResult}=await import('../server/tools/result_envelope');
    const {createHash}=await import('node:crypto'); let outerRecord: import('../server/tools/types').ToolExecutionRecord|undefined;
    const prepare=preparation.prepareMessagingExecution;
    vi.spyOn(preparation,'prepareMessagingExecution').mockImplementation(async context=>{
      const prepared=await prepare(context);if(prepared.context){const observe=prepared.context.remoteToolContext.onToolRecord;
        prepared.context.remoteToolContext.onToolRecord=record=>{observe(record);if(record.name==='legal_message_intake_to_case'&&record.envelope?.status==='verified_success')outerRecord=record;};}return prepared;
    });
    toolRegistry.unregister(definition.name);toolRegistry.register({...definition,handler:async(args,context)=>{
      const decoded=decodeToolResult(await definition.handler(args,context));const receipt=decoded.receipt as {changedCaseIds:string[];materialSources:Array<{caseId:string;materialId:string;sourceDigest:string}>};
      const extra=cases.createCase(orgId,user,{title:'Unselected extra synthetic case '+seq});
      const material=cases.addMaterial(orgId,user,extra.id,{type:'note',title:'Unselected synthetic material',content:'Second real local write from the same canonical adapter.',source:'tool'})!;
      const sourceDigest=createHash('sha256').update(JSON.stringify([material.source,material.title,material.content,material.fileName||'',material.localPath||''])).digest('hex');
      return encodeToolResult(decoded.content,{...receipt,changedCaseIds:[...receipt.changedCaseIds,extra.id],materialSources:[...receipt.materialSources,{caseId:extra.id,materialId:material.id,sourceDigest}]});
    }});
    const execute=vi.spyOn(toolRegistry,'execute');
    try {
      const reply=await processWithPersonality(input);expect(outerRecord?.envelope?.status).toBe('verified_success');
      expect((outerRecord!.receipt as {changedCaseIds:string[]}).changedCaseIds).toHaveLength(2);
      const wrote=cases.listCases(orgId,'',20,user).filter(item=>item.materials.length>0);expect(wrote).toHaveLength(2);
      expect(readDB().reminders.filter((row:{userId:string})=>row.userId===user)).toEqual([]);
      const taskId=routing.listOrganizationWorkItems(orgId)[0].taskId;
      const task=readDB().conversationActionTasks.find((row:{id:string})=>row.id===taskId)!;
      const saved=JSON.parse(task.context);expect(saved.nativeLegalStage.receipt.disposition).toBe('blocked');expect(saved.nativeLegalStage.receipt.archive).toBeUndefined();
      expect(task.status).toBe('blocked');expect(reply).toContain('入案工具已执行；当前案件材料核验未通过');expect(getPendingLegalNotice(input,user)).toBeNull();
      expect(saved.actionState.policySnapshot.forbiddenTools).toContain(definition.name);
      const call=outerRecord!;const sdk=vi.fn(async(options:{tools?:Array<{function:{name:string}}>})=>({choices:[{message:options.tools?.some(tool=>tool.function.name===definition.name)
        ?{content:'',tool_calls:[{id:'r13-forbidden-replay',type:'function',function:{name:definition.name,arguments:JSON.stringify({...call.arguments,message:'Another unapproved changed material'})}}]}
        :{content:JSON.stringify({memories:[],reminders:[]})}}]}));
      await processWithPersonality(msg('继续',input.messageId+'-continue'),{llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create:sdk}}})}});
      expect(execute.mock.calls.filter(call=>call[0]===definition.name)).toHaveLength(1);
      expect(cases.listCases(orgId,'',20,user).filter(item=>item.materials.length>0)).toHaveLength(2);
      expect(readDB().conversationActionTasks.find((row:{id:string})=>row.id===taskId)!.status).toBe('blocked');
    } finally {toolRegistry.unregister(definition.name);toolRegistry.register(definition);}
  });
});
