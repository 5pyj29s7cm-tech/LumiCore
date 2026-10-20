import { makeApp } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import originals from './fixtures/legal_bid_six_materials_164.json';
import actual from './fixtures/legal_bid_r24_actual_price_role.json';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { buildMaterialSources } from '../server/regions/packs/cn/legal_reasoning_generation';
import * as documents from '../server/regions/packs/cn/legal_tools/documents';
import * as quality from '../server/regions/packs/cn/legal_work_product_quality';
import { ensureLegalDeliveryRoot } from '../server/regions/packs/cn/legal_tools/context';
import { parseDocument } from '../server/legal/parser';
import * as cases from '../server/org/legal_cases';
import { bidPromptSources, sdkCompletion } from './legal_bid_fixture';

// This integration deliberately imports no new monetary validator. It must reach
// the old registered acceptance owner before demonstrating an actual wrong accept.
const originalBytes = JSON.stringify(originals);
const actualBytes = JSON.stringify(actual);
const sources = buildMaterialSources(originals.materials);
const originalBuild = quality.buildBidChapters;
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterEach(() => {
  expect(JSON.stringify(originals)).toBe(originalBytes);
  expect(JSON.stringify(actual)).toBe(actualBytes);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCircuit();
});
afterAll(() => app.cleanup());

it('does not accept or archive the original R24 wrong total after actual registered draft and review', async () => {
  vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit();
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('OFFLINE_R24_RECEPTION'));
  const userId = 'bid-r24-reception-' + crypto.randomUUID();
  const orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  const file = cases.createCase(orgId, userId, { title: 'Synthetic original R24 wrong-total reception' });
  expect(cases.getCase(orgId, file.id)).toMatchObject({ id: file.id, orgId, createdBy: userId, materials: [] });
  expect(sources).toHaveLength(164);
  // Reuse the frozen six already-parsed materials exactly; this is an acceptance
  // regression, not a new PDF/parser claim. Keep the actual original Source IDs.
  const read = vi.spyOn(documents, 'readBidRequirementInput').mockResolvedValue({
    requirements: originals.materials.map(material => '# ' + material.title + '\n' + material.content).join('\n\n'),
    sources: originals.materials.map(material => material.title), materials: structuredClone(originals.materials), skipped: [],
  });
  vi.spyOn(quality, 'buildBidChapters').mockImplementation(input => {
    const chapter = originalBuild(input).find(item => item.id === 'response')!;
    return [{ ...chapter, sections: chapter.sections.filter(section => section.id === actual.review.sectionId) }];
  });
  const calls: Array<{ phase: string; prompt: string; returned: { entries: typeof actual.draft[]; complete?: boolean; unresolved?: string[] } }> = [];
  const create = vi.fn(async (request: any, options: any) => {
    const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
    const review = prompt.includes('待核对JSON草稿：');
    const returned = review ? { complete: true, unresolved: [], entries: [structuredClone(actual.review)] } : { entries: [structuredClone(actual.draft)] };
    calls.push({ phase: review ? 'review' : 'draft', prompt, returned });
    return sdkCompletion(request, { choices: [{ message: { role: 'assistant', content: JSON.stringify(returned) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, 0, options?.signal);
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  expect(registry.get('legal_generate_bid')).toMatchObject({ name: 'legal_generate_bid' });
  const initial = new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
  const requestId = crypto.randomUUID();
  const context: import('../server/tools/types').ToolContext = { userId, domain: 'personal', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', source: 'legal-r24-reception-test', requestId,
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const result = decodeToolResult(await registry.execute('legal_generate_bid', { caseId: file.id, projectName: 'Original R24 reception ' + file.id, requirements: 'Frozen six parsed originals', persistCase: true }, context));

  // Hard prerequisites: an entry/permission/model/DOCX failure is not evidence
  // that the old acceptance bug was reproduced. They precede the failing oracle.
  expect(read).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(2);
  expect(calls.map(call => call.phase)).toEqual(['draft', 'review']);
  expect(calls[0].returned).toEqual({ entries: [actual.draft] });
  expect(calls[1].returned).toEqual({ complete: true, unresolved: [], entries: [actual.review] });
  for (const call of calls) {
    expect(bidPromptSources(call.prompt)).toEqual(sources);
    const target = JSON.parse(call.prompt.split('\n指定子节：')[1].split('\n')[0]);
    expect(target.map((section: { id: string }) => section.id)).toEqual([actual.review.sectionId]);
  }
  expect(JSON.parse(calls[1].prompt.split('待核对JSON草稿：')[1])).toEqual({ entries: [actual.draft] });
  expect(network).not.toHaveBeenCalled();
  const outputLine = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'));
  expect(outputLine).toBeDefined();
  const docxPath = outputLine!.slice('- DOCX 文件：'.length);
  expect(fs.statSync(docxPath).size).toBeGreaterThan(0);
  expect(fs.readFileSync(docxPath).subarray(0, 2).toString()).toBe('PK');
  const relativeOutput = path.relative(ensureLegalDeliveryRoot(orgId), docxPath);
  expect(relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)).toBe(false);
  const docx = await parseDocument(docxPath);
  expect(docx?.format).toBe('docx');
  expect(docx?.text).toContain(sources.find(source => source.id === actual.review.sectionId)!.quote);
  const checkpoints = fs.readdirSync(getDataDirectory('legal_document_progress')).filter(name => !initial.has(name));
  expect(checkpoints).toHaveLength(1);
  const saved = JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'), checkpoints[0]), 'utf8'));
  const target = saved.documents.response;
  expect(target).toBeDefined();
  expect(JSON.parse(target.markdown).entries.map((entry: { sectionId: string }) => entry.sectionId)).toEqual([actual.review.sectionId]);
  const persistedCase = cases.getCase(orgId, file.id)!;
  expect(persistedCase).toMatchObject({ id: file.id, orgId, createdBy: userId, title: file.title });

  // Fixed business oracle for both before and after: wrong P01-as-total remains
  // an unaccepted draft even when the old paid review claims complete:true.
  // Soft assertions collect the real old generated/reviewed/archive states;
  // any failure still fails this one regression.
  expect.soft(result.receipt).toMatchObject({ ok: false, status: 'partial' });
  expect.soft(target.reviewed).toBe(false);
  expect.soft(JSON.parse(target.markdown)).toEqual({ entries: [actual.draft] });
  expect.soft(persistedCase.materials.filter(material => material.source === 'tool')).toHaveLength(0);
});
