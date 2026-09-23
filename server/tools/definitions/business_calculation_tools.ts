import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerFinanceSkillTools } from '../../skills/bundled/finance-office/tools';
import { registerEcommerceSkillTools } from '../../skills/bundled/ecommerce-ops/tools';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { ToolRegistry } from '../registry';

/** Desktop and MCP share schemas and calculations, with one executor. */
export function registerBusinessCalculationTools(registry: ToolRegistry): void {
  for (const [line, register] of [['finance', registerFinanceSkillTools], ['ecommerce', registerEcommerceSkillTools]] as const) {
    register({ registerTool(name, config, handler) {
      const input = z.object(config.inputSchema).strict();
      const id = `business.${line}.${name}`;
      registry.register({
        name: `business_${line}_${name}`, description: config.description,
        routingHints: [line === 'finance' ? 'finance accounting invoice reconciliation tax workpaper' : 'ecommerce orders inventory reviews settlement'],
        parameters: zodToJsonSchema(input, { $refStrategy: 'none' }) as any,
        handler: async args => {
          const result = await handler(input.parse(args));
          if (result.isError) throw new Error(result.content?.[0]?.text || 'Business calculation failed');
          const payload = JSON.parse(result.content.find((item: any) => item.type === 'text')?.text || '{}');
          return JSON.stringify(line === 'finance' ? payload : { ...payload, ok: true, status: 'calculated', sourceBasis: 'user_provided_inputs' });
        },
        permission: 'user', securityLevel: 'safe',
        capability: capabilityContract({
          id, family: 'industry', lane: 'industry', operation: 'observe', risk: 'low',
          sideEffects: [{ type: 'none', scope: 'supplied business records', reversible: true }],
          verification: { strategy: 'measured', required: true,
            requiredFields: line === 'finance' ? ['auditReceipt.tool', 'auditReceipt.sourceBasis', 'auditReceipt.calculationPolicy'] : ['ok', 'status', 'sourceBasis'],
            ...(line === 'finance' ? { requiredValues: { 'auditReceipt.sourceBasis': 'user_provided_inputs' } } : { requiredValues: { ok: true }, successStatuses: ['calculated'] }),
            successSignals: ['validated input calculated by the domain implementation'], limitations: ['Input-dependent calculation; not proof of external submission or source completeness.'] },
        }),
        evidence: capabilityEvidence({ id, operation: 'observe', limitations: ['No external account, ledger, submission, payment, or message is changed.'] }),
      });
    } });
  }
}
