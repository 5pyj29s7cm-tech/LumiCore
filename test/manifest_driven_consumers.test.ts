import { describe, expect, it } from 'vitest';
import { getAdapterRegistry } from '../server/adapters/registry';
import { getClientCapabilities } from '../server/client/self_model';
import { ToolRegistry } from '../server/tools/registry';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';

function runtimeDiagnosticsManifest() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'runtime_probe_added_after_release',
    description: 'Inspect runtime diagnostics for the local agent.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'public',
    securityLevel: 'safe',
    capability: {
      id: 'runtime.diagnostics.probe-v2',
      family: 'runtime',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'none', scope: 'runtime diagnostics', reversible: true }],
      tags: ['runtime', 'diagnostics'],
      intents: ['inspect runtime diagnostics'],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['status'],
        successStatuses: ['observed'],
        successSignals: ['runtime diagnostic receipt'],
        limitations: [],
      },
    },
    handler: async () => JSON.stringify({ status: 'observed' }),
  });
  return registry.getCapabilityManifest();
}

describe('manifest-driven capability consumers', () => {
  it('adds a newly registered capability to client self-awareness without a tool-name patch', () => {
    const capabilities = getClientCapabilities(runtimeDiagnosticsManifest());
    const runtime = capabilities.find(item => item.id === 'workspace.runtime_diagnostics');
    expect(runtime?.actions).toContain('runtime_probe_added_after_release');
  });

  it('adds the same capability to the matching adapter without a second catalog entry', () => {
    const report = getAdapterRegistry({
      userId: 'manifest-consumer-test',
      capabilityManifest: runtimeDiagnosticsManifest(),
      clientState: { updatedAt: Date.now() },
    });
    const runtime = report.adapters.find(item => item.id === 'workspace.runtime_diagnostics');
    expect(runtime?.actions).toContain('runtime_probe_added_after_release');
  });

  it('routes a newly registered capability from manifest semantics without a tool-name rule', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'runtime_probe_added_after_release',
      description: 'Inspect runtime diagnostics for the local agent.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'runtime.diagnostics.probe-v2',
        family: 'runtime',
        lane: 'system',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'none', scope: 'runtime diagnostics', reversible: true }],
        tags: ['runtime', 'diagnostics'],
        intents: ['inspect runtime diagnostics'],
        verification: {
          strategy: 'terminal_receipt', required: true, requiredFields: ['status'],
          successStatuses: ['observed'], successSignals: ['diagnostic receipt'], limitations: [],
        },
      },
      handler: async () => JSON.stringify({ status: 'observed' }),
    });

    const route = routeToolsForTurn(
      'inspect runtime diagnostics',
      registry.getToolDeclarations(),
      { capabilityManifest: registry.getCapabilityManifest(), enableMcpHealthGate: false },
    );
    expect(route.toolNames).toContain('runtime_probe_added_after_release');
  });

  it('accepts verified evidence from a newly named capability without an action-specific name check', () => {
    const task = 'Message Alice that the meeting starts at three.';
    const contract = buildActionContract(task);
    expect(hasCoreActionEvidence(contract, [{
      name: 'deliver_payload_v2',
      arguments: { recipient: 'Alice' },
      result: JSON.stringify({ ok: true, status: 'sent', recipient: 'Alice' }),
      evidence: {
        capability: 'message.delivery.v2',
        operation: 'communicate',
        assurance: 'verified',
        scope: ['Alice'],
      },
      capability: {
        capabilityId: 'message.delivery.v2',
        lane: 'messaging',
        operation: 'communicate',
        risk: 'medium',
        sideEffects: [{ type: 'external_communication', scope: 'Alice', reversible: false }],
        verification: {
          strategy: 'provider_ack', required: true, requiredFields: ['status'],
          successStatuses: ['sent'], successSignals: ['provider acknowledgement'], limitations: [],
        },
      },
      terminalVerification: {
        status: 'verified', strategy: 'provider_ack', reason: 'Provider acknowledged delivery.',
      },
    }], task)).toBe(true);
  });
});
