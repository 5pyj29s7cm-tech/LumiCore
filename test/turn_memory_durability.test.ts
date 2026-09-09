import './helpers';
import { personalityRegistry } from '../server/personality/registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { addMemory, queryMemories, removeMemory } from '../server/memory/store';
import { isExplicitMemoryRequest, persistTurnMemory, type TurnMemoryInput } from '../server/memory/turn_memory';
import { isOwnerEvolutionEvidence, isTestLearningSource } from '../server/memory/provenance';
vi.mock('../server/llm/embedding_provider', () => ({ generateConfiguredEmbedding: vi.fn(async () => null), getEmbeddingRoute: () => ({ primary: { provider: 'relay', model: 'synthetic' } }) }));

const auth = { isCurrent: () => true, assertCurrent() {}, watch: () => () => {} };
const base = (userText: string): TurnMemoryInput => ({ userId: `turn-memory-${crypto.randomUUID()}`, domain: 'personal', orgId: '',
  userText, channel: 'chat', requestId: crypto.randomUUID(), conversationId: 'synthetic', authorization: auth,
  llmGetters: { getDeepSeek: () => null, getGemini: () => null }, flush: async () => {} });
const save = (text: string) => ({ changes: [{ operation: 'save', type: 'fact', content: text, evidence: text, keywords: ['资料盒'], perspective: 'shared_memory' }] });

describe('shared chat and voice memory durability', () => {
  beforeEach(async () => { await initDatabase(); });
  it.each(['chat','voice'] as const)('saves, corrects and recalls from a new %s conversation without old history', async channel => {
    const text='资料盒在北侧书架第三层';
    const input={ ...base(`请记住：${text}`), channel, generatePlan: async () => save(text) };
    const first=await persistTurnMemory(input); expect(first.status).toBe('saved');
    const correction='资料盒现在在南侧柜子第二层';
    const second=await persistTurnMemory({ ...input, requestId: 'correct', conversationId: 'second', userText: `修正资料盒的位置：${correction}`,
      generatePlan: async () => ({ changes: [{ operation:'replace', targetId:first.ids[0], content:correction, evidence:correction, type:'fact', keywords:['资料盒'], perspective:'shared_memory' }] }) });
    expect(second.status).toBe('saved');
    const recalled=queryMemories({userId:input.userId, query:'资料盒',domain:'personal',orgId:''});
    expect(recalled).toHaveLength(1);expect(recalled[0].content).toBe(correction);
  });
  it('does not claim saved until the strict durability fence resolves', async () => {
    let release!:()=>void; const gate=new Promise<void>(r=>{release=r});
    const input=base('请记住：蓝盒子在书架');let settled=false;
    const pending=persistTurnMemory({...input,generatePlan:async()=>save('蓝盒子在书架'),flush:()=>gate}).then(x=>{settled=true;return x});
    await vi.waitFor(()=>expect(readDB().memories.some(m=>m.userId===input.userId)).toBe(true));
    expect(settled).toBe(false);release();expect((await pending).status).toBe('saved');
  });
  it('reports unconfirmed persistence instead of a saved claim on disk failure', async () => {
    const receipt=await persistTurnMemory({...base('请记住：蓝盒子在书架'),generatePlan:async()=>save('蓝盒子在书架'),flush:async()=>{throw Error('disk failure')}});
    expect(receipt.status).toBe('failed');expect(receipt.text).not.toMatch(/^已保存/);
  });
  it('rejects a cross-owner target and leaves every record unchanged', async () => {
    const foreign=addMemory({userId:'foreign-owner',type:'fact',content:'蓝盒子在书架',keywords:['蓝盒子'],confidence:.9,sourceInteractionId:'manual'},{generateEmbedding:false});
    const input=base('修正蓝盒子的位置：蓝盒子在抽屉');
    const receipt=await persistTurnMemory({...input,generatePlan:async()=>({changes:[{operation:'replace',targetId:foreign.id,content:'蓝盒子在抽屉',evidence:'蓝盒子在抽屉',type:'fact',keywords:[]}]})});
    expect(receipt.status).toBe('failed');expect(foreign.content).toBe('蓝盒子在书架');
  });
  it('does not resurrect a target deleted during planning', async () => {
    const input=base('修正资料盒的位置：资料盒在抽屉');
    const old=addMemory({userId:input.userId,type:'fact',content:'资料盒在书架',keywords:['资料盒'],confidence:.9,sourceInteractionId:'manual'},{generateEmbedding:false});
    const result=await persistTurnMemory({...input,generatePlan:async()=>{removeMemory(old.id);return {changes:[{operation:'replace',targetId:old.id,content:'资料盒在抽屉',evidence:'资料盒在抽屉',type:'fact',keywords:[]}]}}});
    expect(result.status).toBe('failed');expect(readDB().memories.some(m=>m.id===old.id)).toBe(false);
  });
  it('skips automatic test learning but honors an explicit shared test fixture', async () => {
    const input={...base('蓝盒子在书架'),source:'local_acceptance_harness',generatePlan:vi.fn(async()=>save('蓝盒子在书架'))};
    expect((await persistTurnMemory(input)).status).toBe('skipped');expect(input.generatePlan).not.toHaveBeenCalled();
    const result=await persistTurnMemory({...input,userText:'请记住：蓝盒子在书架'});
    const row=readDB().memories.find(m=>m.id===result.ids[0]);expect(row?.perspective).toBe('shared_memory');expect(isOwnerEvolutionEvidence(row!)).toBe(false);
  });
  it('does not train associations or increment recall counters while browsing', () => {
    const input=base('unused');const row=addMemory({userId:input.userId,type:'fact',content:'蓝盒子在书架',keywords:['蓝盒子'],confidence:.9,sourceInteractionId:'manual'},{generateEmbedding:false});
    queryMemories({userId:input.userId,query:'蓝盒子'});expect(row.retrieveCount).toBe(0);
    queryMemories({userId:input.userId,query:'蓝盒子',recordRetrieval:true});expect(row.retrieveCount).toBe(1);
  });
  it('recognizes explicit corrections independently of generic conversation classification',()=>{
    expect(isExplicitMemoryRequest('修正青岚项目的设定：资料盒已移到南侧柜子第二层。')).toBe(true);
    expect(isExplicitMemoryRequest('不要记住这段测试内容')).toBe(false);
    expect(isTestLearningSource('local_acceptance_harness')).toBe(true);
    expect(isExplicitMemoryRequest('修改文件资料的位置，移到桌面')).toBe(false);
    expect(isExplicitMemoryRequest('修正工作流的设定，然后保存')).toBe(false);
  });
  it('forgets only the specified memory and keeps unrelated facts', async()=>{
    const input=base('请忘记：蓝盒子在书架');
    const target=addMemory({userId:input.userId,type:'fact',content:'蓝盒子在书架',keywords:['蓝盒子'],confidence:.9,sourceInteractionId:'manual'},{generateEmbedding:false});
    const unrelated=addMemory({userId:input.userId,type:'fact',content:'红袋子在抽屉',keywords:['红袋子'],confidence:.9,sourceInteractionId:'manual'},{generateEmbedding:false});
    const receipt=await persistTurnMemory({...input,generatePlan:async()=>({changes:[{operation:'forget',targetId:target.id,evidence:'蓝盒子在书架'}]})});
    expect(receipt.status).toBe('saved');expect(readDB().memories.some(m=>m.id===target.id)).toBe(false);
    expect(readDB().memories.some(m=>m.id===unrelated.id)).toBe(true);
  });
  it('respects disabled automatic extraction while allowing an explicit user save', async () => {
    const pref = vi.spyOn(personalityRegistry, 'getForUser').mockReturnValue({ memoryPolicy: { autoExtract: false } } as any);
    const plan = vi.fn(async () => save('蓝盒子在书架'));
    const input = { ...base('蓝盒子在书架'), generatePlan: plan };
    try {
      expect((await persistTurnMemory(input)).status).toBe('skipped');
      expect(plan).not.toHaveBeenCalled();
      expect((await persistTurnMemory({ ...input, userText: '请记住：蓝盒子在书架' })).status).toBe('saved');
    } finally { pref.mockRestore(); }
  });

});
