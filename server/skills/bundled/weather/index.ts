import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function handler(args: any) {
  const city = String(args.city || 'Beijing');
  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'LumiCore/3.0' } });
    if (!res.ok) throw new Error(`Weather API returned ${res.status}`);
    const data: any = await res.json();
    const current = data.current_condition?.[0];
    if (!current) throw new Error(`No weather data for "${city}"`);
    const forecast = data.weather?.[0];
    const result = JSON.stringify({
      city: city,
      temperature: `${current.temp_C}°C`,
      feelsLike: `${current.FeelsLikeC}°C`,
      humidity: `${current.humidity}%`,
      wind: `${current.winddir16Point} ${current.windspeedKmph}km/h`,
      condition: current.weatherDesc?.[0]?.value || 'Unknown',
      visibility: `${current.visibility}km`,
      today: forecast ? `${forecast.mintempC}°C ~ ${forecast.maxtempC}°C` : 'N/A',
    }, null, 2);
    return { content: [{ type: 'text' as const, text: result }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Weather lookup failed: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'weather', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('get_weather', {
  description: 'Get real-time weather for any city. Returns temperature, humidity, wind, and forecast.',
  inputSchema: { city: z.string().describe('City name in English, e.g. "Tokyo" or "London"') },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
