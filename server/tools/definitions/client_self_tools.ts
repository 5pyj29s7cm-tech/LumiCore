import type { ToolRegistry } from '../registry';
import { registerClientDiagnosticsTools } from './client_diagnostics_tools';
import { registerClientActionTools } from './client_action_tools';
import { registerClientRecoveryTools } from './client_recovery_tools';

export function registerClientSelfTools(registry: ToolRegistry): void {
  registerClientDiagnosticsTools(registry);
  registerClientActionTools(registry);
  registerClientRecoveryTools(registry);
}
