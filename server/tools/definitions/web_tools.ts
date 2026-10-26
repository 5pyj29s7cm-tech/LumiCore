import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { encodeToolResult } from '../result_envelope';

async function fetchText(url: string, timeoutMs: number, parent?: AbortSignal, headers?: Record<string, string>) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new DOMException('Web response timed out.', 'AbortError')), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelBody = () => { void reader?.cancel(controller.signal.reason).catch(() => {}); };
  controller.signal.addEventListener('abort', cancelBody, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const maxBytes = 2 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Web response exceeds the 2 MiB text limit.');
    }
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      controller.signal.throwIfAborted();
      const part = await reader.read();
      controller.signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('Web response exceeds the 2 MiB text limit.');
      chunks.push(part.value);
    }
    return { response, text: Buffer.concat(chunks, size).toString('utf8') };
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelBody);
    if (reader) {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    }
  }
}

type SearchResult = { title: string; snippet: string; url: string };

function searchText(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_all, code: string) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_all, name: string) =>
    ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[name] || ''))
    .replace(/\s+/g, ' ').trim();
}

function searchTarget(href: string, base: string): string | null {
  try {
    let target = new URL(searchText(href), base);
    if ((target.hostname === 'bing.com' || target.hostname.endsWith('.bing.com')) && target.pathname === '/ck/a') {
      const encoded = target.searchParams.get('u') || '';
      if (!encoded.startsWith('a1')) return null;
      target = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
    } else if ((target.hostname === 'duckduckgo.com' || target.hostname.endsWith('.duckduckgo.com')) && target.pathname === '/l/') {
      target = new URL(target.searchParams.get('uddg') || '');
    }
    return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password ? target.href : null;
  } catch { return null; }
}

function matchingSearchResults(results: SearchResult[], query: string): SearchResult[] {
  const sites = [...query.matchAll(/(?:^|\s)site:([^\s]+)/gi)].map(match => match[1].replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase());
  const seen = new Set<string>();
  return results.filter(result => {
    const url = new URL(result.url);
    const matches = !sites.length || sites.some(site => {
      const slash = site.indexOf('/'), host = slash < 0 ? site : site.slice(0, slash);
      return (url.hostname === host || url.hostname.endsWith('.' + host)) && (slash < 0 || url.pathname.startsWith(site.slice(slash)));
    });
    if (!matches || seen.has(result.url)) return false;
    seen.add(result.url); return true;
  });
}

async function fetchSearchPage(url: string, query: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const { response, text } = await fetchText(url, timeoutMs, signal, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
  if (response.status !== 200) throw new Error('HTTP ' + response.status + ' did not return completed search results');
  if (response.url) {
    const final = new URL(response.url), expected = new URL(url);
    const providerDomain = expected.hostname.split('.').slice(-2).join('.');
    if (!(final.hostname === providerDomain || final.hostname.endsWith('.' + providerDomain)) || final.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')
      || final.searchParams.get('q') !== query) {
      throw new Error('Response redirected away from the requested search page');
    }
  }
  return text;
}

async function tryBingSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const html = await fetchSearchPage(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&mkt=zh-CN`, query, 8000, signal);
  const rows: SearchResult[] = [];
  for (const match of html.matchAll(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = match[1], heading = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    const link = heading?.[1].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const url = link && searchTarget(link[1], 'https://www.bing.com');
    if (url && link) rows.push({ title: searchText(link[2]), snippet: searchText(block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ''), url });
  }
  const results = matchingSearchResults(rows, query).slice(0, maxResults);
  if (results.length || /class=["'][^"']*\bb_no\b/i.test(html)) return results;
  throw new Error('Search results unavailable: homepage, challenge, or unsupported page structure');
}

async function tryDuckDuckGoSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const html = await fetchSearchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, query, 5000, signal);
  const matches = [...html.matchAll(/<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const rows: SearchResult[] = [];
  for (let index = 0; index < matches.length; index++) {
    const anchor = matches[index], href = anchor[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const url = href && searchTarget(href, 'https://html.duckduckgo.com');
    const body = html.slice((anchor.index || 0) + anchor[0].length, matches[index + 1]?.index);
    if (url) rows.push({ title: searchText(anchor[1]), snippet: searchText(body.match(/<(?:a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i)?.[1] || ''), url });
  }
  const results = matchingSearchResults(rows, query).slice(0, maxResults);
  if (results.length || /class=["'][^"']*\bno-results\b/i.test(html)) return results;
  throw new Error('Search results unavailable: challenge or unsupported page structure');
}

async function webSearchHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('Search query is required.');
  const maxResults = Math.min(Math.max(Number(args.maxResults) || 5, 1), 10);
  const failures: string[] = [];
  for (const [provider, search] of [['Bing', tryBingSearch], ['DuckDuckGo', tryDuckDuckGoSearch]] as const) {
    context?.executionSignal?.throwIfAborted();
    try {
      const results = await search(query, maxResults, context?.executionSignal);
      if (results.length) return encodeToolResult(results.map(row => `${row.title}\n${row.snippet}\n${row.url}`).join('\n\n'),
        { ok: true, status: 'observed', resultCount: results.length, provider });
    } catch (error) {
      context?.executionSignal?.throwIfAborted();
      failures.push(provider + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  return encodeToolResult(failures.length ? 'Web search unavailable: ' + failures.join('; ')
    : `Both search pages explicitly returned no matching results for "${query}". No source was retrieved.`,
    { ok: false, status: 'partial', reason: failures.length ? 'search_unavailable' : 'no_results', resultCount: 0 });
}

async function urlFetchHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const url = String(args.url || '');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL must start with http:// or https://');
  }

  const maxChars = Math.min(Math.max(Number(args.maxChars) || 10000, 100), 50000);

  try {
    const { response, text: body } = await fetchText(url, 15000, context?.executionSignal, { 'User-Agent': 'LumiAI/2.0 (Agent Tool)' });

    if (response.status === 401 || response.status === 403) {
      return `URL fetch requires authentication (${response.status}). Ask the user to authorize a web login profile, then use web_login_run and url_fetch_logged_in for this site.`;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('application/json') && !contentType.includes('application/xml')) {
      throw new Error(`Unsupported content type: ${contentType}. Only text, JSON, and XML are supported.`);
    }

    let text = body;
    // Strip HTML tags
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();

    if (looksLikeLoginWall(text)) {
      return 'This page appears to require login or interactive verification. Ask the user to authorize a web login profile, then use web_login_run and url_fetch_logged_in.';
    }

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} characters]`;
    }

    return text || '(No text content extracted)';
  } catch (err: any) {
    context?.executionSignal?.throwIfAborted();
    if (err.name === 'AbortError') {
      return `URL fetch timed out for "${url}".`;
    }
    return `URL fetch failed: ${err.message}`;
  }
}

function looksLikeLoginWall(text: string): boolean {
  const sample = text.slice(0, 4000).toLowerCase();
  const loginTerms = [
    'sign in', 'log in', 'login required', 'please login', 'please sign in',
    '验证码', '登录', '请登录', '账号密码', '扫码登录', '安全验证',
  ];
  return loginTerms.some(term => sample.includes(term.toLowerCase()))
    && !sample.includes('article')
    && text.length < 8000;
}

export function registerWebOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'web_search',
    description: 'Search public web pages through the existing Bing and DuckDuckGo providers. Returns retrieved titles, snippets, and original source URLs. Search snippets are candidates; use url_fetch to verify source content. Unavailable search pages and zero results are reported without claiming retrieved evidence.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { type: 'number', description: 'Maximum results (1-10, default 5)' },
      },
      required: ['query'],
    },
    handler: webSearchHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'url_fetch',
    description: 'Fetch and extract text content from a URL. Strips HTML tags and returns plain text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (must start with http:// or https://)' },
        maxChars: { type: 'number', description: 'Maximum characters to return (default 10000, max 50000)' },
      },
      required: ['url'],
    },
    handler: urlFetchHandler,
    permission: 'user',
    securityLevel: 'safe',
  });
}
