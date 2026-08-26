import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
let cheerio: any = null;
async function getCheerio() {
  if (!cheerio) cheerio = await import('cheerio');
  return cheerio;
}

async function handler(args: any) {
  const url = String(args.url || '').trim();
  const selector = args.selector ? String(args.selector) : null;
  try {
    if (!url) throw new Error('URL is required');
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LumiCore/3.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const c = await getCheerio();
    const $ = c.load(html);

    if (selector) {
      const elements: string[] = [];
      $(selector).each((_i, el) => {
        const text = $(el).text().trim();
        if (text) elements.push(text);
      });
      const result = JSON.stringify({
        url,
        selector,
        count: elements.length,
        results: elements.slice(0, 50),
      }, null, 2);
      return { content: [{ type: 'text' as const, text: result }] };
    }

    // No selector: extract page metadata + text summary
    const title = $('title').text().trim();
    const description = $('meta[name="description"]').attr('content') || '';
    const headings: string[] = [];
    $('h1, h2, h3').each((_i, el) => {
      const h = $(el).text().trim();
      if (h) headings.push(h);
    });
    const links: { text: string; href: string }[] = [];
    $('a[href]').each((_i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (text && href && !href.startsWith('#') && links.length < 30) {
        links.push({ text: text.slice(0, 80), href });
      }
    });
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);

    const result = JSON.stringify({
      url,
      title,
      description,
      headings: headings.slice(0, 20),
      links,
      textPreview: bodyText,
    }, null, 2);
    return { content: [{ type: 'text' as const, text: result }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Web scraping failed: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'web-scraper', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('scrape_webpage', {
  description: 'Scrape a webpage: extract title, headings, links, page text, or use a CSS selector to target specific elements.',
  inputSchema: {
    url: z.string().describe('The webpage URL to scrape'),
    selector: z.string().optional().describe('CSS selector for targeted extraction (e.g. "p.article", "div.content")'),
  },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
