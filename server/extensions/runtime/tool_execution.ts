import type { ToolRegistry } from "../../tools/registry";
import type { ToolContext, ToolDefinition } from "../../tools/types";
import type { ExtensionRevision, ExtensionToolManifest } from './contracts';
import { assertCurrentExecutableRevision } from './runtime_revision';
import { runWithConcurrency } from './concurrency';
import { endpointUrl } from './network_policy';
import { boundedFetch, authHeaders, parseJsonObject } from './network_request';
import { digest } from './manifest_validation';
import { verifyPersistedRevision } from './revision_verification';
import { registeredTools } from './runtime_state';

async function invokeExtensionTool(
  revision: ExtensionRevision,
  tool: ExtensionToolManifest,
  args: Record<string, any>,
  context?: ToolContext,
): Promise<string> {
  if ((context?.userId || 'anonymous') !== revision.userId) throw new Error('Extension tool is not authorized for this user.');
  assertCurrentExecutableRevision(revision);
  return runWithConcurrency(revision, async () => {
    const url = endpointUrl(revision.manifest, tool.endpointPath);
    const request = {
      extensionId: revision.extensionId,
      revisionId: revision.id,
      tool: tool.name,
      arguments: args,
      context: {
        taskId: context?.taskId || '',
        requestId: context?.requestId || '',
        idempotencyKey: context?.idempotencyKey || '',
        domain: context?.domain || 'personal',
        orgId: context?.orgId || '',
      },
    };
    const { response, text } = await boundedFetch(revision.manifest, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(revision.manifest) },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Extension tool ${tool.name} failed with HTTP ${response.status}.`);
    const upstream = parseJsonObject(text, `Extension tool ${tool.name}`);
    const providerClaimedVerified = upstream.verified === true && upstream.verificationStatus === 'verified';
    return JSON.stringify({
      ...upstream,
      ok: upstream.ok === true,
      verified: false,
      verificationStatus: 'unverified',
      providerClaimedVerified,
      status: upstream.status || (upstream.ok === true ? 'provider_reported' : 'unknown'),
      extensionId: revision.extensionId,
      extensionVersion: revision.version,
      revisionId: revision.id,
      manifestDigest: revision.manifestDigest,
      signerFingerprint: revision.signerFingerprint,
      endpointOrigin: url.origin,
    });
  });
}

async function reconcileExtensionTool(
  revision: ExtensionRevision,
  tool: ExtensionToolManifest,
  args: Record<string, any>,
  context: ToolContext | undefined,
  idempotencyKey: string,
): Promise<string | null> {
  if (!tool.reconcilePath || (context?.userId || 'anonymous') !== revision.userId) return null;
  assertCurrentExecutableRevision(revision);
  return runWithConcurrency(revision, async () => {
    const url = endpointUrl(revision.manifest, tool.reconcilePath!);
    const { response, text } = await boundedFetch(revision.manifest, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(revision.manifest) },
      body: JSON.stringify({ idempotencyKey, inputDigest: digest(args), extensionId: revision.extensionId, tool: tool.name }),
    });
    if (!response.ok) return null;
    const upstream = parseJsonObject(text, `Extension reconciliation ${tool.name}`);
    if (upstream.verified !== true || upstream.verificationStatus !== 'verified') return null;
    return JSON.stringify({
      ...upstream,
      ok: upstream.ok === true,
      verified: false,
      verificationStatus: 'unverified',
      providerClaimedVerified: true,
      reconciled: true,
      extensionId: revision.extensionId,
      revisionId: revision.id,
      manifestDigest: revision.manifestDigest,
    });
  });
}

function buildToolDefinition(revision: ExtensionRevision, tool: ExtensionToolManifest): ToolDefinition {
  const hostSideEffects = tool.capability.sideEffects.some(effect => (
    effect.type === 'external_communication' || effect.type === 'external_state_change'
  ))
    ? tool.capability.sideEffects
    : [
      ...tool.capability.sideEffects,
      {
        type: 'external_communication' as const,
        scope: `user-reviewed signed extension ${revision.extensionId}`,
        reversible: false,
      },
    ];
  return {
    name: tool.name,
    description: `${tool.description} Signed extension ${revision.extensionId}@${revision.version}; execution is restricted to its exact origin, credential references, timeout, byte, and concurrency budgets.`,
    parameters: tool.parameters,
    permission: tool.permission,
    // A third-party signature authenticates bytes and publisher identity; it
    // cannot prove that a POST endpoint declared as "observe" is read-only.
    // Host policy therefore imposes a confirmation/external-commit floor. A
    // manifest may tighten this to forbidden, but can never relax it to safe.
    securityLevel: tool.securityLevel === 'forbidden' ? 'forbidden' : 'confirm',
    routingHints: tool.routingHints,
    capability: {
      ...tool.capability,
      risk: tool.capability.risk === 'critical' ? 'critical' : 'high',
      sideEffects: hostSideEffects,
      source: 'adapter',
      provider: revision.extensionId,
      provenance: { kind: 'adapter', provider: revision.extensionId, trust: 'user-reviewed' },
      prerequisites: [
        `active signed revision ${revision.id}`,
        `manifest digest ${revision.manifestDigest}`,
      ],
    },
    evidence: {
      capability: tool.capability.id,
      operation: tool.capability.operation,
      assurance: 'declared',
      limitations: [
        `Evidence is bound to signed extension revision ${revision.id}.`,
        'The extension provider cannot independently verify its own business outcome; host-owned corroboration is required.',
        ...(tool.capability.verification.limitations || []),
      ],
    },
    handler: (args, context) => invokeExtensionTool(revision, tool, args, context),
    ...(tool.reconcilePath ? {
      reconcileExternalCommit: (args: Record<string, any>, context: ToolContext | undefined, idempotencyKey: string) => (
        reconcileExtensionTool(revision, tool, args, context, idempotencyKey)
      ),
    } : {}),
  };
}

export function buildDefinitions(revision: ExtensionRevision): ToolDefinition[] {
  return (revision.manifest.tools || []).map(tool => buildToolDefinition(revision, tool));
}

export function registerRevisionTools(registry: ToolRegistry, revision: ExtensionRevision): void {
  verifyPersistedRevision(revision);
  const definitions = buildDefinitions(revision);
  const registered: string[] = [];
  try {
    for (const definition of definitions) {
      const owner = registeredTools.get(definition.name);
      if (registry.get(definition.name) && owner?.extensionId !== revision.extensionId) {
        throw new Error(`Tool name collision: ${definition.name} is already owned by another capability.`);
      }
      if (registry.get(definition.name)) registry.unregister(definition.name);
      if (!registry.register(definition)) throw new Error(`Tool registration failed for ${definition.name}.`);
      registered.push(definition.name);
      registeredTools.set(definition.name, {
        extensionId: revision.extensionId,
        revisionId: revision.id,
        userId: revision.userId,
        registry,
      });
    }
  } catch (error) {
    for (const name of registered) {
      registry.unregister(name);
      registeredTools.delete(name);
    }
    throw error;
  }
}

export function unregisterExtensionTools(registry: ToolRegistry, extensionId: string): string[] {
  const removed: string[] = [];
  for (const [name, owner] of [...registeredTools.entries()]) {
    if (owner.extensionId !== extensionId || owner.registry !== registry) continue;
    registry.unregister(name);
    registeredTools.delete(name);
    removed.push(name);
  }
  return removed;
}
