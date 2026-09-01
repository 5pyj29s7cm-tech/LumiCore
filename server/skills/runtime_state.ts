import { loadKeys } from '../config/keys';
import { mcpManager } from '../mcp/client';
import type { CapabilityManifestEntry } from '../tools/types';

export type ExtensionRuntimeStatus =
  | 'callable'
  | 'configuration_required'
  | 'disabled'
  | 'broken'
  | 'installed_unregistered'
  | 'configured_without_package'
  | 'not_configured';

export interface ExtensionRuntimeState {
  name: string;
  description: string;
  packagePresent: boolean;
  configured: boolean;
  enabled: boolean;
  keyReady: boolean;
  broken: boolean;
  connected: boolean;
  healthStatus: string;
  registered: boolean;
  usable: boolean;
  status: ExtensionRuntimeStatus;
  toolNames: string[];
  manifestCapabilityIds: string[];
}

function configuredKeyReady(config: Record<string, any> | undefined): boolean {
  if (!config?.requiresApiKey) return true;
  const keyName = String(config.apiKeyEnv || '').trim();
  if (!keyName) return false;
  let stored = '';
  try { stored = String(loadKeys()[keyName] || '').trim(); } catch {}
  return Boolean(stored || String(process.env[keyName] || '').trim());
}

function runtimeStatus(input: Omit<ExtensionRuntimeState, 'status'>): ExtensionRuntimeStatus {
  if (input.broken) return 'broken';
  if (!input.configured) return input.packagePresent ? 'not_configured' : 'configured_without_package';
  if (!input.enabled) return 'disabled';
  if (!input.keyReady) return 'configuration_required';
  if (input.usable) return 'callable';
  if (!input.packagePresent) return 'configured_without_package';
  return 'installed_unregistered';
}

/**
 * One truthful availability projection shared by Skill Hall, self-extension,
 * settings, and model-facing discovery. A directory alone is never callable.
 */
export function getExtensionRuntimeStates(
  manifest: CapabilityManifestEntry[] = [],
): ExtensionRuntimeState[] {
  const localSkills = mcpManager.listLocalSkills();
  const config = mcpManager.getConfig();
  const health = mcpManager.getServerHealth();
  const connected = new Set(mcpManager.getConnectedServers());
  const localByName = new Map(localSkills.map(skill => [skill.name, skill]));
  const names = new Set([...Object.keys(config), ...localSkills.map(skill => skill.name)]);

  return Array.from(names).sort().map(name => {
    const local = localByName.get(name);
    const serverConfig = Object.prototype.hasOwnProperty.call(config, name) ? config[name] : undefined;
    const manifestEntries = manifest.filter(entry => (
      entry.executable
      && entry.provenance.provider === name
      && (entry.source === 'skill' || entry.source === 'mcp')
    ));
    const base = {
      name,
      description: local?.description || String(serverConfig?.description || name),
      packagePresent: Boolean(local),
      configured: Boolean(serverConfig),
      enabled: serverConfig?.enabled === true,
      keyReady: configuredKeyReady(serverConfig),
      broken: local?.broken === true,
      connected: connected.has(name),
      healthStatus: String(health[name]?.status || 'unknown'),
      registered: manifestEntries.length > 0,
      usable: Boolean(
        serverConfig?.enabled === true
        && configuredKeyReady(serverConfig)
        && local?.broken !== true
        && manifestEntries.length > 0
      ),
      toolNames: manifestEntries.map(entry => entry.toolName),
      manifestCapabilityIds: manifestEntries.map(entry => entry.capabilityId),
    };
    return { ...base, status: runtimeStatus(base) };
  });
}

export function getExtensionRuntimeState(
  name: string,
  manifest: CapabilityManifestEntry[] = [],
): ExtensionRuntimeState | undefined {
  return getExtensionRuntimeStates(manifest).find(state => state.name === name);
}
