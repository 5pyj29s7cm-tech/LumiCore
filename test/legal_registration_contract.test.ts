import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { CASE_ARCHIVE_FIELDS, defineLegalTool } from '../server/regions/packs/cn/legal_tools/tool_contracts';
import type { ToolRegistry } from '../server/tools/registry';
import type { ToolDefinition } from '../server/tools/types';

const archiveKeys = ['caseId', 'caseName', 'caseType', 'persistCase', 'orgId', 'userId'];
function publicContract(definitions: ToolDefinition[]) {
  const rows = JSON.parse(JSON.stringify(definitions));
  for (const tool of rows) {
    if (archiveKeys.every(key => tool.parameters.properties[key])) {
      // The shared archive fields deliberately use one consistent explanation.
      // Their types, requiredness, rights and all other tool metadata stay fixed.
      for (const key of archiveKeys) delete tool.parameters.properties[key].description;
    }
  }
  return rows;
}

describe('legal registration public contract', () => {
  it('preserves ordered tool identities, schemas, rights and capability evidence from the original registry', () => {
    const definitions: ToolDefinition[] = [];
    registerLegalTools({ register: (definition: ToolDefinition) => { definitions.push(definition); return true; } } as unknown as ToolRegistry);
    const expected = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/legal_registration_contract.json'), 'utf8'));

    // All reviewed tools accept time inputs without making them required.
    for (const tool of definitions) {
      for (const key of ['factDate', 'procedureDate', 'temporalReviews']) {
        expect(tool.parameters.required || []).not.toContain(key);
      }
      expect(tool.parameters.properties).toMatchObject({ factDate: { type: 'string' }, procedureDate: { type: 'string' }, temporalReviews: { type: 'array' } });
    }
    const comparable = JSON.parse(JSON.stringify(definitions));
    const quoteTool = comparable.find((row: ToolDefinition) => row.name === 'legal_verify_citation');
    expect(quoteTool.parameters.required || []).not.toContain('quotedText');
    expect(quoteTool.parameters.properties.quotedText).toMatchObject({ type: 'string' });
    delete quoteTool.parameters.properties.quotedText;
    // Reviewed contract/bid parity extends these existing tool schemas only.
    for (const name of ['legal_generate_bid', 'legal_review_contract', 'legal_draft_contract']) {
      const current = comparable.find((row: ToolDefinition) => row.name === name)!;
      const prior = expected.find((row: ToolDefinition) => row.name === name)!;
      const extension = name === 'legal_generate_bid'
        ? { password: { type: 'string' }, passwords: { type: 'object' }, useModel: { type: 'boolean' }, outputDir: { type: 'string' } }
        : name === 'legal_review_contract'
          ? { sourceOnly: { type: 'boolean' }, omitSpecificLawCitations: { type: 'boolean' } }
          : { templateText: { type: 'string' }, templatePath: { type: 'string' } };
      expect(current.parameters.properties).toMatchObject(extension);
      expect(current.parameters.required || []).toEqual(prior.parameters.required || []);
      for (const key of Object.keys(extension)) {
        expect(current.parameters.required || []).not.toContain(key);
        expect(prior.parameters.properties).not.toHaveProperty(key);
        delete current.parameters.properties[key];
      }
      expect(current.description).toMatch(name === 'legal_generate_bid' ? /完整招标文件/ : name === 'legal_review_contract' ? /分段核对/ : /完整修改稿/);
      current.description = prior.description;
      if (name === 'legal_draft_contract') {
        expect(current.parameters.properties.type).toMatchObject({ type: 'string' });
        current.parameters.properties.type.description = prior.parameters.properties.type.description;
      }
      if (name === 'legal_generate_bid') {
        expect(current.capability).toMatchObject({ id: 'legal.bid.generate', operation: 'create', risk: 'medium', verification: { strategy: 'artifact', required: true, successStatuses: ['generated'], requiredArtifactCollections: ['artifacts'] } });
        expect(current.capability!.sideEffects).toEqual(expect.arrayContaining([
          ...prior.capability!.sideEffects,
          { type: 'local_write', scope: 'reviewable bid response DOCX artifact', reversible: true },
        ]));
        current.capability = prior.capability;
      } else if (name === 'legal_review_contract') {
        expect(current.capability).toMatchObject({ id: 'legal.contract.review', operation: 'create', risk: 'low', verification: { strategy: 'terminal_receipt', required: true, successStatuses: ['reviewed'] } });
        expect(current.capability!.sideEffects).toEqual([
          { type: 'local_read', scope: 'provided contract text and optional local legal reference data', reversible: true },
          { type: 'local_state_change', scope: 'optional legal case contract-review archive', reversible: true },
          { type: 'network_read', scope: 'configured legal review model when source-only mode is not requested', reversible: true },
        ]);
        expect(current.evidence).toEqual({ capability: 'legal.contract.review', operation: 'create', assurance: 'verified', subjectArgument: 'contract' });
        delete current.capability; delete current.evidence;
      }
    }
    const sourceExtensions = [
      ['legal_search_subject_cases', 'legal.subject-cases.search', 'authorized case or enforcement source for the explicitly supplied subject'],
      ['legal_search_public_footprint', 'legal.public-footprint.search', 'public search results for the explicitly supplied subject name'],
    ] as const;
    for (const [name, capability, scope] of sourceExtensions) {
      const current = comparable.find((tool: ToolDefinition) => tool.name === name)!;
      expect(expected.some((tool: ToolDefinition) => tool.name === name)).toBe(false);
      expect(current).toMatchObject({ permission:'user', securityLevel:'safe', parameters:{type:'object',required:['name']} });
      expect(Object.keys(current.parameters.properties).sort()).toEqual(['factDate','procedureDate','temporalReviews','name','subjectType',...(name==='legal_search_subject_cases'?['scope']:[])].sort());
      expect(current.parameters.properties.name).toMatchObject({type:'string'});
      expect(current.parameters.properties.subjectType).toMatchObject({type:'string',enum:['enterprise','individual']});
      if (name==='legal_search_subject_cases') expect(current.parameters.properties.scope).toMatchObject({type:'string',enum:['cases','enforcement']});
      expect(current.capability).toMatchObject({id:capability,operation:'observe',risk:'low',verification:{strategy:'terminal_receipt',required:true,successStatuses:['observed']}});
      expect(current.capability.sideEffects).toEqual([{type:'network_read',scope,reversible:true}]);
      expect(current.evidence).toEqual({capability,operation:'observe',assurance:'verified',subjectArgument:'name'});
      const real = definitions.find(tool=>tool.name===name)!;
      expect(real.serverOwnedArgumentBinder?.({name:'Synthetic',persistCase:true,confirmedForKb:true})).toMatchObject({name:'Synthetic',persistCase:false,confirmedForKb:false});
    }
    const plan = comparable.find((tool:ToolDefinition)=>tool.name==='legal_external_research_plan')!;
    expect(plan.capability).toMatchObject({id:'legal.external-research-plan.create',operation:'create',risk:'low',verification:{strategy:'terminal_receipt',required:true,successStatuses:['planned']}});
    expect(plan.capability.sideEffects).toEqual([{type:'local_state_change',scope:'optional authorized case archive of the generated research plan',reversible:true}]);
    expect(plan.evidence).toEqual({capability:'legal.external-research-plan.create',operation:'create',assurance:'verified',subjectArgument:'caseId'});
    delete plan.capability;delete plan.evidence;
    // The earlier authoritative-source change clarified exact-text queries
    // and the official-web default; keep those three reviewed descriptions explicit.
    const authority = comparable.find((tool:ToolDefinition)=>tool.name==='legal_search_external_authorities')!;
    const priorAuthority = expected.find((tool:ToolDefinition)=>tool.name===authority.name)!;
    expect(authority.description).toBe('法条原文查询用“法名+条号”；同法多条一次查，不同法源分查。未知条号可用法名或主题定位。按授权来源检索；仅据实际原文核验，目录、摘要不算正文。');
    expect(authority.parameters.properties.query.description).toBe('法名+具体条号，同法多条一次查；未知条号可用法名或主题定位。不同法源分查。');
    expect(authority.parameters.properties.includeOfficialWeb.description).toBe('是否同时查询国家法律法规数据库公开来源；法规/混合检索默认启用，显式 false 可关闭');
    authority.description=priorAuthority.description;
    authority.parameters.properties.query.description=priorAuthority.parameters.properties.query.description;
    authority.parameters.properties.includeOfficialWeb.description=priorAuthority.parameters.properties.includeOfficialWeb.description;
    // Keep the original 34 schemas, rights and ordered identities strict.
    const originalTools = comparable.filter((tool:ToolDefinition)=>!sourceExtensions.some(([name])=>name===tool.name));
    expect(publicContract(originalTools)).toEqual(publicContract(expected));
    expect(new Set(definitions.map(tool => tool.name)).size).toBe(36);
    const archiveTools = definitions.filter(tool => archiveKeys.every(key => tool.parameters.properties[key]));
    expect(archiveTools).toHaveLength(17);
    for (const tool of archiveTools) {
      for (const key of archiveKeys) {
        // The original 16 keep the shared schema; the reviewed tender tool retains its explicit explanations.
        const expectedField = tool.name === 'legal_search_tender_projects'
          ? expected.find((row: ToolDefinition) => row.name === tool.name)!.parameters.properties[key]
          : CASE_ARCHIVE_FIELDS[key];
        expect(tool.parameters.properties[key]).toEqual(expectedField);
      }
    }
  });

  it('rejects a cancelled attempt before calling the legal handler', async () => {
    const controller = new AbortController();
    const handler = vi.fn(async () => 'receipt');
    const tool = defineLegalTool({ name: 'test', description: 'test', properties: {}, handler });
    controller.abort();
    await expect(tool.handler({}, { executionSignal: controller.signal } as any)).rejects.toMatchObject({ name: 'AbortError' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a late result after cancellation while retaining the original attempt signal', async () => {
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    const gate = new Promise<string>(done => { resolve = done; });
    const tool = defineLegalTool({ name: 'test', description: 'test', properties: {}, handler: () => gate });
    const attempt = tool.handler({}, { executionSignal: controller.signal } as any);
    controller.abort(); resolve('late receipt');
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('isolates mutable schema projections while keeping an authorized handler result unchanged', async () => {
    const properties = { nested: { type: 'object', properties: { value: { type: 'string' } } } };
    const tool = defineLegalTool({ name: 'test', description: 'test', properties, handler: async () => 'receipt' });
    properties.nested.properties.value.type = 'number';
    expect(tool.parameters.properties.nested.properties.value.type).toBe('string');
    await expect(tool.handler({})).resolves.toBe('receipt');
  });
});
