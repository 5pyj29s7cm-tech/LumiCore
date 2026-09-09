import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import * as EDB from '../server/org/db';
import { queryAuditLog, getAuditStats, exportAuditCSV } from '../server/org/audit';
import { inspectLegalReasoningStructure } from '../server/regions/packs/cn/legal_reasoning_structure';
import { ToolRegistry } from '../server/tools/registry';
import { registerPdfTools } from '../server/tools/definitions/pdf_tools';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import * as Cases from '../server/org/legal_cases';
import { makeLLMCall } from '../server/llm/providers';
import { createWeChatAdapter } from '../server/messaging/wechat-clawbot';
import { extractPdfTextContent } from '../server/utils/pdf_text';

vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
vi.mock('../server/legal/sources', async original => ({ ...await original<typeof import('../server/legal/sources')>(), searchMOHURDTemplates: vi.fn(async () => []) }));
beforeAll(async () => { await initDatabase(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('business remediation truthful boundaries', () => {
  it('filters, counts and exports actual organization audit entries without changing limit zero', () => {
    const orgId = `audit-contract-${Date.now()}`;
    EDB.logAudit({ orgId, userId: 'actor', action: 'create', resourceType: 'document', resourceId: 'one', details: { source: 'synthetic' } });
    EDB.logAudit({ orgId: 'another-org', userId: 'actor', action: 'create', resourceType: 'document', resourceId: 'other', details: { source: 'synthetic' } });
    expect(EDB.listAuditLog(orgId, 0)).toEqual([]);
    expect(queryAuditLog(orgId, { userId: 'actor' })).toHaveLength(1);
    expect(queryAuditLog(orgId, { action: 'delete' })).toEqual([]);
    expect(getAuditStats(orgId).totalEntries).toBe(1);
    expect(exportAuditCSV(orgId).split('\n')).toHaveLength(2);
  });

  it('does not treat keywords or blank template labels as verified legal reasoning', () => {
    expect(inspectLegalReasoningStructure('三段论 大前提 小前提 涵摄')).toMatchObject({ passed: false, legalValidityVerified: false });
    expect(inspectLegalReasoningStructure('大前提：待填写\n小前提：待补充\n结论：待核验')).toMatchObject({ passed: false });
    expect(inspectLegalReasoningStructure('Major premise: A synthetic statute supplies the obligation at issue.\nMinor premise: The synthetic delivery receipt supports a completed delivery.\nConclusion: The disputed obligation must be assessed against that evidence.')).toMatchObject({ passed: true, legalValidityVerified: false });
  });

  it('creates a real searchable CJK PDF with an installed font and fails missing images', async () => {
    const registry = new ToolRegistry(); registerPdfTools(registry);
    const handler = registry.get('create_pdf')!.handler;
    const result = JSON.parse(await handler({ title: 'synthetic-cjk', content: '中文法律资料与数字人测试。' }, {}));
    expect(fs.readFileSync(result.path).subarray(0, 5).toString()).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    expect((await PDFDocument.load(fs.readFileSync(result.path))).getPageCount()).toBe(1);
    expect((await extractPdfTextContent(result.path)).text).toContain('中文法律资料');
    await expect(handler({ images: [{ path: path.join(path.dirname(result.path), 'nonexistent-required.png') }] }, {})).rejects.toThrow(/Required PDF image/);
  });

  it('rejects provider errors and missing acknowledgement instead of returning a local send ID', async () => {
    const adapter = createWeChatAdapter({ botToken: 'synthetic', botId: 'synthetic', baseUrl: 'https://wechat.invalid', enabled: false });
    for (const receipt of [{ errcode: 123, errmsg: 'denied' }, { ret: 0, errcode: 321 }, {}, { ret: '' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(receipt))));
      await expect(adapter.sendMessage('synthetic-person', { platform: 'wechat', text: 'synthetic' })).rejects.toThrow(/WeChat send/);
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ret: '0', message_id: 'remote-accepted' }))));
    await expect(adapter.sendMessage('synthetic-person', { platform: 'wechat', text: 'synthetic' })).resolves.toBe('remote-accepted');
  });

  it('propagates registry cancellation to legal model work and prevents late case archival', async () => {
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const controller = new AbortController();
    let resolve!: (value: any) => void;
    vi.mocked(makeLLMCall).mockImplementationOnce(async (...args) => {
      expect(args[2].signal).toBe(controller.signal);
      return new Promise(done => { resolve = done; });
    });
    const orgId = `legal-cancel-${Date.now()}`;
    const pending = registry.get('legal_generate_bid')!.handler({ requirements: 'Synthetic tender', projectName: 'Synthetic', caseName: 'Late draft', persistCase: true, orgId }, {
      userId: 'synthetic', executionSignal: controller.signal,
      llmGetters: { getDeepSeek: () => null, getGemini: () => null },
    });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    controller.abort(new DOMException('cancelled', 'AbortError'));
    resolve({ text: 'A late synthetic draft that must not be archived' });
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(Cases.listCases(orgId, '', 100, 'synthetic')).toEqual([]);
  });
});
