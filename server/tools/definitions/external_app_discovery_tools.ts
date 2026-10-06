import { getExternalAppAdapters } from '../../external_apps/adapters';
import { getAdapterRegistry } from '../../adapters/registry';
import { getClientStateForScope } from '../../client/self_model';
import { isMessagingSendConfirmationRequired } from '../../autonomy/safety_gate';
import type { ToolRegistry } from '../registry';

export function registerExternalAppDiscoveryTools(registry: ToolRegistry): void {
registry.register({
    name: 'external_app_list_adapters',
    description: 'List Lumi external app adapters and their safety policies for browser, messaging, CAD, and other AI apps.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_args, context) => {
      const userId = context?.userId || 'anonymous';
      const adapterRegistry = getAdapterRegistry({
        userId,
        clientState: getClientStateForScope(userId, { domain: context?.domain, orgId: context?.orgId }) as Record<string, any> | null,
      });
      return JSON.stringify({
        externalAppAutomationGate: 'removed',
        messagingSendRequiresConfirmation: isMessagingSendConfirmationRequired(userId),
        adapters: getExternalAppAdapters(adapterRegistry),
        adapterRegistrySummary: adapterRegistry.summary,
        adapterRegistry: adapterRegistry.adapters.filter(adapter => ['web', 'finance', 'messaging', 'cad_bim', 'ai', 'automation'].includes(adapter.category)),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
