import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPClientManager } from '../server/mcp/client';

const tempPaths: string[] = [];

afterEach(() => {
  for (const target of tempPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe('desktop filesystem MCP migration', () => {
  it('disables the legacy npx filesystem server in favor of built-in native file tools', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-mcp-migration-'));
    tempPaths.push(root);
    const configPath = path.join(root, 'mcp_config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          enabled: true,
          source: 'external',
          transport: 'stdio',
        },
      },
    }));
    const manager = new MCPClientManager(configPath);
    expect(manager.getConfig().filesystem.enabled).toBe(false);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.migrations.desktopBuiltinFilesystem).toBe(2);
  });
});
