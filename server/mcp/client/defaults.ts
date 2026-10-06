import path from "path";
import type { MCPConfigFile } from './contracts';

export const DEFAULT_RUNTIME_CONFIG = 'mcp_config.json';

export const FACTORY_CONFIG = path.join(process.cwd(), 'server', 'mcp', 'config.example.json');

export const DEFAULT_CONFIG_FILE: MCPConfigFile = {
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      enabled: false,
      source: 'external',
      transport: 'stdio',
      description: 'Legacy external filesystem MCP. Desktop files use Lumi built-in native file tools without npx.',
    },
    sqlite: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', 'data/lumi.db'],
      enabled: false,
      source: 'external',
      transport: 'stdio',
      description: 'SQLite access for the local Lumi database.',
    },
    git: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git', '.'],
      enabled: false,
      source: 'external',
      transport: 'stdio',
      description: 'Git repository inspection tools.',
    },
  },
  remoteDevices: {},
};
