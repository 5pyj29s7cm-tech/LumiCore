import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';

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

async function tryBingSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const { response, text: html } = await fetchText(
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&mkt=zh-CN`,
      8000, signal, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    );
    if (!response.ok) return null;

    const results: string[] = [];

    // Bing 2024+ HTML: <li class="b_algo"> blocks
    const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    let blockMatch;
    while ((blockMatch = blockRe.exec(html)) !== null && results.length < maxResults) {
      const block = blockMatch[1];
      const urlMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>/i);
      const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const title = h2Match ? h2Match[1].replace(/<[^>]+>/g, '').trim() : (urlMatch ? urlMatch[1] : '');
      const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
        || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (urlMatch) {
        results.push(`${title}\n${snippet}\n${urlMatch[1]}`);
      }
    }

    // Fallback: broader extraction if b_algo blocks not found
    if (results.length === 0) {
      const broadRe = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>\s*<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
      let m;
      while ((m = broadRe.exec(html)) !== null && results.length < maxResults) {
        results.push(`${m[2].replace(/<[^>]+>/g, '').trim()}\n${m[1]}`);
      }
    }
    return results.length > 0 ? results.join('\n\n') : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function webSearchHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const query = String(args.query || '');
  if (!query.trim()) throw new Error('Search query is required.');

  const maxResults = Math.min(Math.max(Number(args.maxResults) || 5, 1), 10);

  // Bing first — works in China, returns real search results
  const bingResults = await tryBingSearch(query, maxResults, context?.executionSignal);
  if (bingResults) return bingResults;

  // Fallback: DuckDuckGo Instant Answers (useful for definitions/facts)
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const { response, text } = await fetchText(url, 5000, context?.executionSignal);

    if (response.ok) {
      const data = JSON.parse(text);
      const results: string[] = [];

      if (data.AbstractText) {
        results.push(`${data.AbstractText}${data.AbstractURL ? ` (${data.AbstractURL})` : ''}`);
      }

      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics.slice(0, maxResults)) {
          if (topic.Text && topic.FirstURL) {
            results.push(`${topic.Text}\n${topic.FirstURL}`);
          }
        }
      }

      if (data.Results && Array.isArray(data.Results)) {
        for (const r of data.Results.slice(0, maxResults)) {
          if (r.Text && r.FirstURL) {
            results.push(`${r.Text}\n${r.FirstURL}`);
          }
        }
      }

      if (results.length > 0) return results.join('\n\n');
    }
  } catch {
    context?.executionSignal?.throwIfAborted();
    // DDG unavailable
  }

  return `No search results found for "${query}". Try different search terms or use url_fetch on a known news site.`;
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
    description: 'Search the web via Bing (cn.bing.com). Returns formatted results with titles, snippets, and URLs. For Chinese news, use specific terms like "AI 人工智能 最新进展 2025". If results are poor, try url_fetch on known news sites like techcrunch.com, theverge.com, or 36kr.com.',
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
