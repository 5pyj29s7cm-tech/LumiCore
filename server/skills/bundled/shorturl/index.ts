import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function handler(args: any) {
  const url = String(args.url || '').trim();
  if (!url) return { content: [{ type: 'text' as const, text: 'Error: "url" parameter is required' }], isError: true };
  try {
    // Use is.gd API (no key required)
    const apiUrl = `https://is.gd/create.php?format=json&url=${encodeURIComponent(url)}`;
    const res = await fetch(apiUrl, { headers: { 'User-Agent': 'LumiCore/3.0' } });
    if (!res.ok) throw new Error(`Shortener API returned ${res.status}`);
    const data: any = await res.json();
    if (data.errorcode) throw new Error(data.errormessage || 'Unknown error');
    const result = JSON.stringify({
      original: url,
      short: data.shorturl,
      service: 'is.gd',
    }, null, 2);
    return { content: [{ type: 'text' as const, text: result }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `URL shortening failed: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'shorturl', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('shorten_url', {
  description: 'Shorten a long URL using is.gd. Returns the shortened URL.',
  inputSchema: { url: z.string().describe('The long URL to shorten') },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
