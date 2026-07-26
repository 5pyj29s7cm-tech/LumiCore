import { describe, expect, it } from 'vitest';
import {
  resolveMCPToolCapability,
  resolveMCPToolOperation,
  resolveMCPToolSecurity,
} from '../server/mcp';
import type { MCPServerConfig, MCPToolDef } from '../server/mcp';

function tool(annotations?: MCPToolDef['annotations']): MCPToolDef {
  return {
    serverName: 'demo',
    name: 'mcp_demo_action',
    inputSchema: { type: 'object', properties: {} },
    annotations,
  };
}

describe('MCP standard tool annotations', () => {
  it('allows explicitly read-only tools without weakening unknown tools', () => {
    expect(resolveMCPToolSecurity(tool({ readOnlyHint: true }))).toBe('safe');
    expect(resolveMCPToolOperation(tool({ readOnlyHint: true }))).toBe('observe');
    expect(resolveMCPToolSecurity(tool())).toBe('confirm');
    expect(resolveMCPToolOperation(tool())).toBeUndefined();
  });

  it('keeps destructive metadata authoritative over a conflicting read-only hint', () => {
    const conflicting = tool({ readOnlyHint: true, destructiveHint: true });
    expect(resolveMCPToolSecurity(conflicting)).toBe('confirm');
    expect(resolveMCPToolOperation(conflicting)).toBe('mutate');
  });

  it('projects declared Skill side effects into security and the canonical capability manifest', () => {
    const declaration: NonNullable<MCPServerConfig['toolCapabilities']>[string] = {
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'desktop_control', scope: 'visible AutoCAD drawing', reversible: false },
        { type: 'process_execution', scope: 'audited AutoCAD bridge', reversible: false },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['status', 'visible'],
        requiredValues: { status: 'completed', visible: true },
        successStatuses: ['completed'],
        successSignals: ['verified visible document'],
        limitations: ['Requires AutoCAD.'],
      },
      trust: 'official',
      lane: 'cad',
    };
    const config: MCPServerConfig = {
      enabled: true,
      source: 'local',
      toolCapabilities: { autocad_new_document: declaration },
    };
    const declaredTool: MCPToolDef = {
      serverName: 'cad-drafting',
      name: 'mcp_cad-drafting_autocad_new_document',
      inputSchema: { type: 'object', properties: {} },
    };

    expect(resolveMCPToolSecurity(declaredTool, config)).toBe('confirm');
    expect(resolveMCPToolOperation(declaredTool, config)).toBe('mutate');
    expect(resolveMCPToolCapability(declaredTool, config)).toMatchObject({
      id: 'skill.cad-drafting.autocad_new_document',
      lane: 'cad',
      operation: 'mutate',
      risk: 'high',
      source: 'skill',
      provider: 'cad-drafting',
      provenance: { trust: 'official' },
      sideEffects: [
        { type: 'desktop_control' },
        { type: 'process_execution' },
      ],
      verification: {
        strategy: 'state_diff',
        requiredFields: ['status', 'visible'],
      },
    });
  });

  it('allows a declared read-only network capability but keeps undeclared MCP tools conservative', () => {
    const declaredRead: MCPServerConfig = {
      enabled: true,
      source: 'local',
      capabilityDefault: {
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'network_read', scope: 'public weather endpoint', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: [],
          successSignals: ['weather payload'],
          limitations: ['External data may be stale.'],
        },
      },
    };
    expect(resolveMCPToolSecurity(tool(), declaredRead)).toBe('safe');
    expect(resolveMCPToolOperation(tool(), declaredRead)).toBe('observe');
    expect(resolveMCPToolSecurity(tool())).toBe('confirm');
  });
});
