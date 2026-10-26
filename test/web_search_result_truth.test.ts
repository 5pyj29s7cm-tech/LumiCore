import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './helpers';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerWebOpsTools } from '../server/tools/definitions/web_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { executeToolCall } from '../server/tools/execution_engine';
const response = (text: string, url = '', status = 200) => { const r = new Response(text, { status, headers: { 'content-type': 'text/html' } }); if (url) Object.defineProperty(r, 'url', { value: url }); return r; };
const noBing = '<ol id="b_results"><li class="b_no">No results found</li></ol>';
const noDdg = '<div class="no-results">No results found</div>';
const ddg = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.test%2Fguide%3Fmode%3Dread%26lang%3Den&amp;rut=opaque">Example &amp; guide</a><a class="result__snippet">Read the &#x67;uide &quot;now&quot;.</a></div>';
const sequence = (...responses: Response[]) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => { const next = responses.shift(); if (!next) throw new Error('Unexpected request'); return next; });
const registry = new ToolRegistry(); registerWebOpsTools(registry);
const handler = registry.get('web_search')!.handler;
beforeAll(async () => { await initDatabase(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('web search reports retrieved sources rather than empty transport success', () => {
 it('recognizes the Bing homepage redirect and uses the existing DuckDuckGo provider as actual web search', async () => {
   const fetchMock = sequence(response('<title>Bing</title><form>Search</form>', 'https://www.bing.com/?q=guide'), response(ddg)); vi.stubGlobal('fetch', fetchMock);
   const result = decodeToolResult(await handler({ query: 'example guide', maxResults: 2 }, {}));
   expect(result.content).toContain('https://docs.example.test/guide?mode=read&lang=en'); expect(result.content).toContain('Example & guide'); expect(result.content).toContain('Read the guide "now".');
   expect(result.receipt).toMatchObject({ ok: true, status: 'observed', resultCount: 1 });
   expect(String(fetchMock.mock.calls[1][0])).toContain('https://html.duckduckgo.com/html/'); expect(String(fetchMock.mock.calls[1][0])).not.toContain('api.duckduckgo.com');
 });
 it('does not mark HTTP-200 homepages, challenges or unsupported response structure verified', async () => {
   vi.stubGlobal('fetch', sequence(response('<title>Bing</title>', 'https://www.bing.com/'), response('<form id="challenge-form">Human verification</form>')));
   const record = await executeToolCall({ registry, name: 'web_search', arguments: { query: 'ordinary query' }, context: { userId: 'search-result-owner', domain: 'personal', authenticated: true } as any });
   expect(record.receipt).toMatchObject({ ok: false, status: 'partial', reason: 'search_unavailable' }); expect(record.terminalVerification?.status).not.toBe('verified');
   expect(record.result).toContain('unavailable'); expect(record.result).not.toContain('No search results found');
 });
 it('reads the result heading link rather than a decoration or tracking URL', async () => {
   const target = Buffer.from('https://docs.example.test/topic').toString('base64url');
   const html = '<li data-index="0" class="b_algo extra"><a href="https://decoration.example.test">decoration</a><h2><a href="https://www.bing.com/ck/a?u=a1' + target + '&amp;x=1">Topic &amp; docs</a></h2><p class="b_lineclamp2">Real snippet.</p></li>';
   const fetchMock = sequence(response(html)); vi.stubGlobal('fetch', fetchMock); const result = decodeToolResult(await handler({ query: 'topic' }, {}));
   expect(result.content).toContain('https://docs.example.test/topic'); expect(result.content).not.toContain('decoration.example.test'); expect(result.content).not.toContain('/ck/a'); expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it('distinguishes an explicitly empty result page from provider failure without inventing retrieved evidence', async () => {
   vi.stubGlobal('fetch', sequence(response(noBing), response(noDdg))); const result = decodeToolResult(await handler({ query: 'no matches' }, {}));
   expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reason: 'no_results', resultCount: 0 }); expect(result.content).not.toContain('unavailable');
 });
 it.each([response(noDdg, '', 202), response('Denied', '', 403), response('<html><div id="root"></div><script src="app.js"></script></html>'), response('{"AbstractText":"","RelatedTopics":[]}')])('keeps rejected, SPA and non-web fallback responses unavailable', async fallback => {
   vi.stubGlobal('fetch', sequence(response(noBing), fallback)); expect(decodeToolResult(await handler({ query: 'fallback unavailable' }, {})).receipt).toMatchObject({ ok: false, status: 'partial', reason: 'search_unavailable' });
 });
 it('rejects an unrelated result host for an explicit site filter and continues to the existing fallback', async () => {
   vi.stubGlobal('fetch', sequence(response('<li class="b_algo"><h2><a href="https://unrelated.test/">Unrelated</a></h2></li>'), response(ddg)));
   const result = decodeToolResult(await handler({ query: 'guide site:docs.example.test' }, {})); expect(result.content).toContain('https://docs.example.test/guide'); expect(result.content).not.toContain('unrelated.test');
 });
 it('does not accept a result with a non-web or credential-bearing target', async () => {
   vi.stubGlobal('fetch', sequence(response(noBing), response('<a class="result__a" href="javascript:alert(1)">Invalid</a><a class="result__a" href="https://secret:private@example.test/">Invalid</a>')));
   expect(decodeToolResult(await handler({ query: 'invalid target' }, {})).receipt).toMatchObject({ ok: false, status: 'partial' });
 });
 it('propagates caller cancellation instead of falling back after a stopped request', async () => {
   const controller = new AbortController();controller.abort(new Error('user stopped')); const fetchMock = vi.fn(async () => { throw new Error('unexpected'); });vi.stubGlobal('fetch', fetchMock);
   await expect(handler({ query: 'cancelled' }, { executionSignal: controller.signal })).rejects.toThrow('user stopped');
 });
});
