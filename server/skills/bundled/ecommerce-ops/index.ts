import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerEcommerceSkillTools } from './tools';
const server = new McpServer({ name: 'ecommerce-ops', version: '1.5.2' }, { capabilities: { tools: {} } });
registerEcommerceSkillTools(server);
await server.connect(new StdioServerTransport());
