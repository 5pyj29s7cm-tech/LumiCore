import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerFinanceSkillTools } from './tools';
const server = new McpServer({ name: 'finance-office', version: '1.5.0' }, { capabilities: { tools: {} } });
registerFinanceSkillTools(server);
await server.connect(new StdioServerTransport());
