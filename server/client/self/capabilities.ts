import { PERSONAL_CLIENT_SURFACE_ACTIONS } from "../../../shared/client_surfaces";
import { toolRegistry } from "../../tools/registry";
import type { CapabilityLane, CapabilityManifestEntry } from "../../tools/types";
import { selectManifestCapabilities } from "../../tools/capability_projection";
import type { ClientCapabilityKind, ClientCapability } from './contracts';
import { CLIENT_CAPABILITIES } from './catalog';

export function isClientNativeAction(action: string): boolean {
  const name = action.split('(')[0];
  return PERSONAL_CLIENT_SURFACE_ACTIONS.includes(name)
    || name === 'set_client_mode'
    || name === 'close_client_surface'
    || name === 'refresh_client_state'
    || name.startsWith('lap.');
}

export const CLIENT_CAPABILITY_LANES: Partial<Record<ClientCapabilityKind, CapabilityLane[]>> = {
  workspace: ['client', 'files', 'knowledge', 'agents'],
  tool_surface: ['client', 'system', 'agents'],
  media: ['media'],
  meeting: ['client', 'media'],
  organization: ['agents', 'industry', 'knowledge', 'messaging'],
  knowledge: ['knowledge', 'files', 'memory'],
  runtime: ['system', 'client'],
  settings: ['client', 'system'],
  permission: ['client', 'system'],
  system: ['system', 'client', 'agents', 'memory'],
  external_app: ['desktop', 'web', 'messaging', 'cad', 'agents'],
  collaboration: ['agents', 'messaging'],
};

export const CLIENT_CAPABILITY_TERM_STOPWORDS = new Set([
  'client', 'system', 'workspace', 'window', 'mode', 'external', 'app', 'apps',
  'tool', 'tools', 'surface', 'adapter', 'registry', 'advanced',
]);

export function clientCapabilityManifestActions(
  capability: ClientCapability,
  manifest: CapabilityManifestEntry[],
): string[] {
  const terms = `${capability.id} ${capability.label}`
    .toLowerCase()
    .split(/[._\-\s/]+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3 && !CLIENT_CAPABILITY_TERM_STOPWORDS.has(term));
  if (terms.length === 0) return [];
  return selectManifestCapabilities(manifest, {
    lanes: CLIENT_CAPABILITY_LANES[capability.kind],
    terms,
  }).map(entry => entry.toolName);
}

export function getClientCapabilities(
  capabilityManifest: CapabilityManifestEntry[] = toolRegistry.getCapabilityManifest(),
): ClientCapability[] {
  if (!capabilityManifest.length) return CLIENT_CAPABILITIES;
  const availableTools = new Set(capabilityManifest
    .filter(entry => entry.executable && !entry.deprecated)
    .map(entry => entry.toolName));
  return CLIENT_CAPABILITIES.map(capability => ({
    ...capability,
    actions: Array.from(new Set([
      ...capability.actions.filter(isClientNativeAction),
      ...clientCapabilityManifestActions(capability, capabilityManifest),
    ])).filter(action => isClientNativeAction(action) || availableTools.has(action.split('(')[0])),
  }));
}
