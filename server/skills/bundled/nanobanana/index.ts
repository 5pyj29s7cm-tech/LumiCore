import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1';

async function handler(args: any) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    return { content: [{ type: 'text' as const, text: 'SILICONFLOW_API_KEY not configured. Add it in Settings > Generative Models > Generation Model Providers.' }], isError: true };
  }

  const { prompt, model, size, n } = args;
  if (!prompt) {
    return { content: [{ type: 'text' as const, text: 'prompt is required' }], isError: true };
  }

  try {
    const response = await fetch(`${SILICONFLOW_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'Kwai-Kolors/Kolors',
        prompt,
        n: Math.min(n || 1, 4),
        size: size || '1024x1024',
      }),
    });

    const data = await response.json() as any;
    if (!response.ok) {
      return { content: [{ type: 'text' as const, text: `SiliconFlow error (${response.status}): ${data.message || data.error || 'unknown'}` }], isError: true };
    }

    const urls = data.data?.map((img: any) => img.url).filter(Boolean) || [];
    if (urls.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No images generated — the prompt may have been rejected by the safety filter.' }], isError: true };
    }

    const result = JSON.stringify({
      success: true,
      prompt,
      images: urls,
      model: model || 'Kwai-Kolors/Kolors',
      provider: 'siliconflow',
      remainingCredits: data.credits,
    }, null, 2);

    return { content: [{ type: 'text' as const, text: result }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Image generation failed: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'nanobanana', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('generate_image', {
  description: 'Generate AI images using Nano Banana via SiliconFlow. Fast, affordable, good quality — ideal for batch generation. Supports Kwai-Kolors/Kolors (general purpose) and stabilityai/stable-diffusion-3-5-large (photorealism).',
  inputSchema: {
    prompt: z.string().describe('Detailed image description. Be specific about subject, style, lighting, colors.'),
    model: z.string().optional().describe('Model ID. Default: "Kwai-Kolors/Kolors". Also try "stabilityai/stable-diffusion-3-5-large".'),
    size: z.string().optional().describe('Image size, e.g. "1024x1024", "1024x576".'),
    n: z.number().optional().describe('Number of images (1-4, default 1).'),
  },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
