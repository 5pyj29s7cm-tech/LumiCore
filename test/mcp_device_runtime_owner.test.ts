import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpManager, mcpRegistryToolName, recoverServerTools, validateMCPServerConfig } from '../server/mcp';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';

afterEach(() => vi.restoreAllMocks());
describe('temporary device MCP runtime', () => {
  it('keeps its server-owned configuration and checks the local owner before any call', async () => {
    const registry = new ToolRegistry();
    const config = { enabled: true, source: 'external' as const, transport: 'ws' as const,
      url: 'ws://127.0.0.1:43210/device?token=synthetic-private-token', runtimeOwnerUid: 'owner-a' };
    const name = mcpRegistryToolName('fixture_device', 'self.inspect');
    await recoverServerTools('fixture_device', [{ serverName: 'fixture_device', rawName: 'self.inspect', name,
      inputSchema: { type: 'object', properties: {} } }], registry, config);
    const definition = registry.get(name)!;
    expect(definition.internalVisibility).toEqual({ ownerUserId: 'owner-a' });
    expect(registry.getToolDeclarations({ context: { userId: 'owner-b' } }).some(item => item.function.name === name)).toBe(false);
    expect(registry.getToolDeclarations({ context: { userId: 'owner-a' } }).some(item => item.function.name === name)).toBe(true);
    expect(registry.getCapabilityManifest(undefined, { context: { userId: 'owner-b' } })).toEqual([]);
    const call = vi.spyOn(mcpManager, 'callToolForServer').mockResolvedValue('{"status":"observed"}');
    for (const context of [undefined, {}, { authenticated: true, userId: 'owner-b', localExecution: true, executionBoundary: 'trusted_local' },
      { authenticated: true, userId: 'owner-a', localExecution: false, executionBoundary: 'remote' }]) {
      expect(() => definition.preflight?.({}, context as ToolContext)).toThrow(/owning user/);
      await expect(definition.handler({}, context as ToolContext)).rejects.toThrow(/owning user/);
    }
    expect(call).not.toHaveBeenCalled();
    const context = { authenticated: true, userId: 'owner-a', localExecution: true, executionBoundary: 'trusted_local' } as ToolContext;
    definition.preflight?.({}, context);
    await expect(definition.handler({}, context)).resolves.toContain('observed');
    expect(call).toHaveBeenCalledWith('fixture_device', 'self.inspect', {}, expect.objectContaining({ configuration: config }));
    expect(definition.securityLevel).toBe('confirm');
  });
  it('does not accept a device-owner binding from ordinary MCP configuration input', () => {
    expect(() => validateMCPServerConfig('fixture', { enabled: true, transport: 'ws',
      url: 'ws://127.0.0.1:43210', runtimeOwnerUid: 'owner-a' })).toThrow(/runtime-managed/);
  });
});
