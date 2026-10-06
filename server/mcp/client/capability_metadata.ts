import type { MCPServerConfig } from './contracts';

/** Declared metadata never changes runtime command, enablement or host execution authority. */
export function reconcileMCPDeclaredCapabilities(
  server: MCPServerConfig,
  declarations: Pick<MCPServerConfig, 'capabilityDefault' | 'toolCapabilities'>,
): boolean {
  const nextDefault = declarations.capabilityDefault;
  const nextTools = declarations.toolCapabilities;
  if (
    JSON.stringify(server.capabilityDefault || null) === JSON.stringify(nextDefault || null)
    && JSON.stringify(server.toolCapabilities || null) === JSON.stringify(nextTools || null)
  ) return false;
  if (nextDefault) server.capabilityDefault = JSON.parse(JSON.stringify(nextDefault));
  else delete server.capabilityDefault;
  if (nextTools) server.toolCapabilities = JSON.parse(JSON.stringify(nextTools));
  else delete server.toolCapabilities;
  return true;
}
