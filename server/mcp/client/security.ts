import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { MCPToolDef } from './contracts';

// Database isolation alone is insufficient: migration/installation also touches
// executable packages. Test workers must never scan the real user's Skills.
export const PENDING_SKILL_MARKER = '.lumi-pending';

export const RESERVED_RUNTIME_NAMES = new Set(['.', '..', '__proto__', 'constructor', 'prototype']);

export const FORBIDDEN_MANAGED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

export function normalizeSkillInstallName(name: string): string {
  const requested = String(name || '').trim();
  if (RESERVED_RUNTIME_NAMES.has(requested.toLowerCase())) {
    throw new Error('Invalid skill name');
  }
  const normalized = requested
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  if (!normalized) throw new Error('Invalid skill name');
  return normalized;
}

/**
 * Runtime/config server names are identifiers, never path fragments or object
 * prototype keys. Unlike install names, they are not silently rewritten: a
 * caller must address the exact configured server it intends to mutate.
 */
export function requireSafeMCPServerName(name: string): string {
  const requested = String(name || '').trim();
  if (
    !requested
    || requested.length > 80
    || RESERVED_RUNTIME_NAMES.has(requested.toLowerCase())
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)
  ) {
    throw new Error('Invalid MCP server or skill name');
  }
  return requested;
}

export function requireSafeMCPToolName(name: string): string {
  const requested = String(name || '').trim();
  if (
    !requested
    || requested.length > 128
    || RESERVED_RUNTIME_NAMES.has(requested.toLowerCase())
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)
  ) {
    throw new Error('Invalid MCP tool name');
  }
  return requested;
}

export function mcpRegistryToolName(serverName: string, rawToolName: string): string {
  return `mcp_${requireSafeMCPServerName(serverName)}_${requireSafeMCPToolName(rawToolName)}`;
}

export function mapMCPTools(serverName: string, tools: Awaited<ReturnType<Client['listTools']>>['tools']): MCPToolDef[] {
  return tools.map(tool => {
    const rawName = requireSafeMCPToolName(tool.name);
    return {
      serverName,
      name: mcpRegistryToolName(serverName, rawName),
      rawName,
      description: tool.description || `${rawName} (from MCP server: ${serverName})`,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      annotations: tool.annotations,
    };
  });
}
