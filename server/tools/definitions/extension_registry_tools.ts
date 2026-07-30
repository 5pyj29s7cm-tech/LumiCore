import {
  disableExtension,
  installAndActivateExtension,
  listExtensionReceipts,
  listExtensions,
  rollbackExtension,
  testRegisteredExtension,
} from '../../extensions/registry';
import type { ToolRegistry } from '../registry';

export function registerExtensionRegistryTools(registry: ToolRegistry): void {
  registry.register({
    name: 'extension_registry_list',
    description: 'List locally installed signed Lumi extensions, OpenAI-compatible providers, declared capabilities, permissions, compatibility evidence, activation state, and publisher fingerprints. Secrets are never returned.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => listExtensions(context),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'extension.registry.list', family: 'extension_registry', lane: 'system', source: 'builtin',
      operation: 'observe', risk: 'low', sideEffects: [],
      verification: {
        strategy: 'terminal_receipt', required: true, requiredFields: ['status', 'extensions'],
        requiredValues: { status: 'listed' }, successStatuses: ['listed'],
        successSignals: ['persistent extension registry snapshot'], limitations: [],
      },
    },
    evidence: { capability: 'extension.registry.list', operation: 'observe', assurance: 'observed' },
  });

  registry.register({
    name: 'extension_registry_install',
    description: 'Verify, compatibility-test, stage, and transactionally activate one signed Lumi extension manifest. The immutable confirmation covers the exact manifest and publisher-trust decision. Embedded credentials, unsigned code, undeclared origins, resource escalation, tool collisions, and incompatible revisions are rejected. A failed activation restores the previous active revision.',
    parameters: {
      type: 'object',
      properties: {
        manifest: { type: 'object', description: 'Complete schemaVersion=1 signed extension manifest. It may declare an OpenAI-compatible provider, sandboxed HTTP tools, or both.' },
        trustPublisher: { type: 'boolean', description: 'Required only for first use of this exact Ed25519 publisher key. The confirmation binds this decision to the manifest digest.' },
      },
      required: ['manifest'],
    },
    handler: async (args, context) => installAndActivateExtension({ manifest: args.manifest, trustPublisher: args.trustPublisher === true }, context, registry),
    permission: 'user',
    securityLevel: 'confirm',
    capability: {
      id: 'extension.registry.install', family: 'extension_registry', lane: 'system', source: 'builtin',
      operation: 'mutate', risk: 'high',
      sideEffects: [
        { type: 'installation', scope: 'signed Lumi extension registry', reversible: true },
        { type: 'local_state_change', scope: 'active extension/provider revision', reversible: true },
        { type: 'network_read', scope: 'declared compatibility endpoints', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['status', 'receipt.manifestDigest', 'receipt.signerFingerprint'],
        successStatuses: ['activated', 'already_active'],
        failureStatuses: ['compatibility_failed', 'rolled_back'],
        successSignals: ['signature verified, compatibility probe passed, registry persisted'],
        limitations: ['Activation does not expand the permissions declared by the signed manifest.'],
      },
    },
    evidence: {
      capability: 'extension.registry.install', operation: 'mutate', assurance: 'verified',
      limitations: ['Publisher trust is local and bound to its Ed25519 fingerprint.'],
    },
  });

  registry.register({
    name: 'extension_registry_test',
    description: 'Run the bounded compatibility probes for an installed extension revision without changing which revision is active.',
    parameters: {
      type: 'object',
      properties: {
        extensionId: { type: 'string' },
        version: { type: 'string', description: 'Optional exact revision version; omitted means the active revision.' },
      },
      required: ['extensionId'],
    },
    handler: async (args, context) => JSON.stringify({
      ok: true,
      verified: true,
      verificationStatus: 'verified',
      extensionId: String(args.extensionId || ''),
      compatibility: await testRegisteredExtension(String(args.extensionId || ''), context?.userId, args.version ? String(args.version) : undefined),
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'extension.registry.compatibility', family: 'extension_registry', lane: 'system', source: 'builtin',
      operation: 'test', risk: 'low', sideEffects: [{ type: 'network_read', scope: 'signed extension compatibility endpoints', reversible: true }],
      verification: {
        strategy: 'measured', required: true, requiredFields: ['compatibility.status', 'compatibility.latencyMs'],
        successSignals: ['bounded live compatibility probe'], limitations: [],
      },
    },
    evidence: { capability: 'extension.registry.compatibility', operation: 'test', assurance: 'measured' },
  });

  registry.register({
    name: 'extension_registry_rollback',
    description: 'Transactionally reactivate a previously installed signed revision after rechecking trust, signature, and compatibility. If registration fails, the current active revision is restored.',
    parameters: {
      type: 'object',
      properties: {
        extensionId: { type: 'string' },
        version: { type: 'string', description: 'Optional exact prior version. Omit for the most recently active prior revision.' },
      },
      required: ['extensionId'],
    },
    handler: async (args, context) => rollbackExtension({ extensionId: String(args.extensionId || ''), version: args.version ? String(args.version) : undefined }, context, registry),
    permission: 'user',
    securityLevel: 'confirm',
    capability: {
      id: 'extension.registry.rollback', family: 'extension_registry', lane: 'system', source: 'builtin',
      operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'active extension/provider revision', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true, requiredFields: ['status', 'receipt.revisionId'],
        successStatuses: ['rollback_activated'], failureStatuses: ['rollback_compatibility_failed', 'rollback_failed_previous_restored'],
        successSignals: ['prior signed revision registered and persisted'], limitations: [],
      },
    },
    evidence: { capability: 'extension.registry.rollback', operation: 'mutate', assurance: 'verified' },
  });

  registry.register({
    name: 'extension_registry_disable',
    description: 'Disable one active extension locally, unregister its tools, and make its provider unavailable without deleting revision or audit history.',
    parameters: {
      type: 'object',
      properties: { extensionId: { type: 'string' } },
      required: ['extensionId'],
    },
    handler: async (args, context) => disableExtension(String(args.extensionId || ''), context, registry),
    permission: 'user',
    securityLevel: 'confirm',
    capability: {
      id: 'extension.registry.disable', family: 'extension_registry', lane: 'system', source: 'builtin',
      operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'active extension/provider revision', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true, requiredFields: ['status', 'receipt.revisionId'],
        requiredValues: { status: 'disabled' }, successStatuses: ['disabled'],
        failureStatuses: ['disable_failed_previous_restored'],
        successSignals: ['tools unregistered and active provider removed'], limitations: ['Revision history is retained for audit and rollback.'],
      },
    },
    evidence: { capability: 'extension.registry.disable', operation: 'mutate', assurance: 'verified' },
  });

  registry.register({
    name: 'extension_registry_receipts',
    description: 'Read persistent extension activation, compatibility-failure, rollback, disable, and boot-recovery receipts without exposing credentials or response bodies.',
    parameters: {
      type: 'object',
      properties: { extensionId: { type: 'string' } },
      required: [],
    },
    handler: async (args, context) => listExtensionReceipts(context, args.extensionId ? String(args.extensionId) : undefined),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'extension.registry.receipts', family: 'extension_registry', lane: 'system', source: 'builtin',
      operation: 'observe', risk: 'low', sideEffects: [],
      verification: {
        strategy: 'terminal_receipt', required: true, requiredFields: ['status', 'receipts'],
        requiredValues: { status: 'listed' }, successStatuses: ['listed'],
        successSignals: ['persistent extension activation ledger'], limitations: [],
      },
    },
    evidence: { capability: 'extension.registry.receipts', operation: 'observe', assurance: 'observed' },
  });
}
