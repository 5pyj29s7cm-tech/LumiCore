import crypto from "crypto";
import { getJwtSecret } from "../../config/local_identity";
import type { MCPServerConfig } from './contracts';

export function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableConfigValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => ![
        'cachedTools',
        'cachedToolsFingerprint',
        'cachedToolsAttestation',
        'toolCount',
        // Installation state is an authorization gate, not a transport/tool
        // declaration. Pending is checked separately before routing/calls.
        'installationState',
      ].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableConfigValue(item)]),
  );
}

/**
 * Identifies the runtime/config declaration that a cached inventory belongs
 * to. A cache without this exact fingerprint is never treated as routable.
 */
export function mcpServerConfigFingerprint(config: MCPServerConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableConfigValue(config)))
    .digest('hex');
}

export function publicCommandIdentity(command: unknown): { basename: string; runnerCategory: string } {
  const basename = String(command || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com|ps1)$/i, '') || '';
  const runnerCategory = (() => {
    if (['npm', 'npx', 'pnpm', 'yarn', 'bunx'].includes(basename)) return 'package_runner';
    if (['node', 'nodejs', 'tsx', 'ts-node', 'deno', 'bun'].includes(basename)) return 'javascript_runtime';
    if (['python', 'python3', 'py', 'pip', 'pip3', 'uv', 'uvx'].includes(basename)) return 'python_runtime';
    if (['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish'].includes(basename)) return 'shell';
    if (['java', 'dotnet', 'ruby', 'php', 'perl'].includes(basename)) return 'language_runtime';
    return basename ? 'executable' : 'none';
  })();
  return { basename, runnerCategory };
}

export function publicArgumentShape(argument: unknown): string {
  const value = String(argument || '');
  const longFlag = value.match(/^(--[A-Za-z][A-Za-z0-9_-]{0,63})(?:=(.*))?$/);
  if (longFlag) {
    return `long:${longFlag[1].toLowerCase()}${value.includes('=') ? '=<value>' : ''}`;
  }
  const shortFlag = value.match(/^(-[A-Za-z0-9])(?:(?:=)?(.+))?$/);
  if (shortFlag) {
    return `short:${shortFlag[1].toLowerCase()}${shortFlag[2] ? '=<value>' : ''}`;
  }
  return '<value>';
}

export function publicEndpointIdentity(value: unknown): string {
  const endpoint = String(value || '').trim();
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<invalid-endpoint>';
  }
}

/**
 * Public runtime identity used in capability manifests. Unlike the private
 * cache fingerprint, it hashes only non-sensitive transport structure. It
 * intentionally excludes cwd, ordinary argument values, URL credentials and
 * queries, and every environment/header value so a published capability
 * manifest cannot become an offline oracle for private configuration.
 */
export function mcpPublicRuntimeContractFingerprint(config: MCPServerConfig): string {
  const contract = {
    transport: config.transport || 'stdio',
    endpoint: publicEndpointIdentity(config.url),
    command: publicCommandIdentity(config.command),
    argumentShape: (config.args || []).map(publicArgumentShape),
    envKeys: Object.keys(config.env || {}).sort(),
    headerKeys: Object.keys(config.headers || {}).map(key => key.toLowerCase()).sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function ownServerConfig(
  config: Record<string, MCPServerConfig>,
  name: string,
): MCPServerConfig | undefined {
  return Object.prototype.hasOwnProperty.call(config, name) ? config[name] : undefined;
}

export function mcpToolInventoryAttestation(config: MCPServerConfig): Buffer {
  return crypto.createHmac('sha256', getJwtSecret()).update(JSON.stringify({
    fingerprint: config.cachedToolsFingerprint,
    tools: stableConfigValue(config.cachedTools),
  })).digest();
}

export function hasCurrentCachedToolInventory(config: MCPServerConfig): boolean {
    const current = Boolean(
      config.cachedTools?.length
      && config.cachedToolsFingerprint
      && config.cachedToolsFingerprint === mcpServerConfigFingerprint(config),
    );
    if (!current || config.source !== 'local') return current;
    if (!config.cachedToolsAttestation) return false;
    const expected = mcpToolInventoryAttestation(config);
    let supplied: Buffer;
    try { supplied = Buffer.from(config.cachedToolsAttestation, 'base64url'); } catch { return false; }
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }
