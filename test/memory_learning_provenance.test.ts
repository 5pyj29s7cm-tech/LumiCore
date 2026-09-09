import './helpers';
import { expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { addMemory, queryMemories } from '../server/memory/store';
import { repairTestMemoryProvenance } from '../server/memory/provenance';
import { beginEvolutionSynthesis, recordEvolutionSynthesisSuccess } from '../server/personality/evolution_synthesis_guard';

it('archives exact test provenance and contaminated growth while preserving real preferences and recovery data', async()=>{
  await initDatabase();const userId='provenance-repair-owner';
  const polluted=addMemory({userId,type:'fact',content:'用户安装 LC-SKILL-订单汇总-V16',keywords:[],confidence:.9,sourceInteractionId:'old-probe'},{generateEmbedding:false});
  const real=addMemory({userId,type:'preference',content:'用户喜欢简短直接的回答',keywords:[],confidence:.9,sourceInteractionId:'manual'},{generateEmbedding:false,source:'manual'});
  const db=readDB();db.settings=db.settings.filter(x=>x.key!=='memory_test_provenance_repair_v1');
  const key='personality_user_state:lumi:personal:'+userId;
  db.settings.push({key,value:JSON.stringify({schemaVersion:1,growthState:{ownerExpressions:['this is isolated read-only verification']},lastEvolvedAt:'2026-09-01',personalityVersion:'2.50'})});writeDB(db);
  expect(repairTestMemoryProvenance()).toBeGreaterThan(0);
  expect(readDB().memories.some(x=>x.id===polluted.id)).toBe(true);
  expect(queryMemories({userId}).map(x=>x.id)).toEqual([real.id]);
  const state=JSON.parse(readDB().settings.find(x=>x.key===key)!.value);expect(state.growthState).toBeUndefined();
  const recovery=readDB().settings.find(x=>x.key==='memory_test_provenance_repair_v1')!;
  expect(recovery.value).toContain('this is isolated read-only verification');
  expect(repairTestMemoryProvenance()).toBe(0);
});

it('deduplicates an analyzed evidence set and accepts changed evidence at the same bounded count',()=>{
  const scope={userId:'same-size-evolution',domain:'personal' as const,orgId:''};
  const first={fingerprint:'first-50',memoryCount:50,latestEvidenceAt:'2026-09-08T10:00:00.000Z'};
  expect(beginEvolutionSynthesis(scope,first).allowed).toBe(true);recordEvolutionSynthesisSuccess(scope,first);
  expect(beginEvolutionSynthesis(scope,first)).toMatchObject({allowed:false,reason:'already_analyzed'});
  const changed={...first,fingerprint:'changed-50',latestEvidenceAt:'2026-09-09T10:00:00.000Z'};
  expect(beginEvolutionSynthesis(scope,changed).allowed).toBe(true);
});
