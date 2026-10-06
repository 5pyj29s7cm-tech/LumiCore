import type { ToolRegistry } from "../../tools/registry";
import type { ToolContext } from "../../tools/types";
import type { ExtensionRevision, SignedExtensionRuntimeSnapshot } from './contracts';
import { verifyPersistedRevision } from './revision_verification';
import { invalidateRevisionRuntime } from './runtime_revision';
import { activeRuntime, registeredTools } from './runtime_state';
import { credentialValue } from './network_request';
import { arrays } from './persistence';
import { extensionCredentialNamespace, publisherTrustedBy } from './manifest_validation';
import { LUMI_EXTENSION_API_VERSION } from './contracts';

export function extensionRuntimeState(
  revision: ExtensionRevision,
  registry?: ToolRegistry,
): {
  registered: boolean;
  usable: boolean;
  runtimeStatus: string;
  registeredToolNames: string[];
  declaredToolCount: number;
  keyReady: boolean;
} {
  let identityValid = false;
  try {
    verifyPersistedRevision(revision);
    identityValid = true;
  } catch {
    invalidateRevisionRuntime(revision);
  }
  const active = identityValid
    && revision.status === 'active'
    && activeRuntime.get(revision.extensionId)?.id === revision.id;
  const declaredToolNames = [...revision.toolNames];
  const registeredToolNames = declaredToolNames.filter(name => {
    const owner = registeredTools.get(name);
    if (
      !owner
      || owner.extensionId !== revision.extensionId
      || owner.revisionId !== revision.id
      || owner.userId !== revision.userId
      || (registry && owner.registry !== registry)
    ) return false;
    const targetRegistry = registry || owner.registry;
    const definition = targetRegistry.get(name);
    const manifest = targetRegistry.getCapabilityManifestEntry(name);
    return Boolean(
      definition
      && manifest?.executable === true
      && manifest.source === 'adapter'
      && manifest.provider === revision.extensionId
      && manifest.provenance.kind === 'adapter'
      && manifest.provenance.provider === revision.extensionId
      && definition.capability?.prerequisites?.includes(`active signed revision ${revision.id}`)
      && definition.capability?.prerequisites?.includes(`manifest digest ${revision.manifestDigest}`)
    );
  });
  const allDeclaredToolsRegistered = registeredToolNames.length === declaredToolNames.length;
  const keyReady = (revision.manifest.permissions.credentialRefs || [])
    .every(name => Boolean(credentialValue(name)));
  // Provider-only extensions have no ToolDefinition to register, so their
  // active runtime identity is the executable boundary. Tool/hybrid revisions
  // additionally require every signed declaration to be present with the
  // exact revision provenance in this registry.
  const registered = active && allDeclaredToolsRegistered;
  const usable = registered && keyReady && revision.compatibility?.ok === true;
  const runtimeStatus = revision.status !== 'active'
    ? revision.status
    : !active || !allDeclaredToolsRegistered
      ? 'registration_missing'
      : !keyReady
        ? 'needs_configuration'
        : revision.compatibility?.ok !== true
          ? 'compatibility_unverified'
          : 'registered';
  return {
    registered,
    usable,
    runtimeStatus,
    registeredToolNames,
    declaredToolCount: declaredToolNames.length,
    keyReady,
  };
}

/**
 * Server-owned proof used by the model/tool loop after a verified activation
 * receipt. Manifest-declared names are only candidates: callers receive the
 * intersection with the exact active revision and current ToolRegistry.
 */
export function getExactRegisteredExtensionToolNames(input: {
  extensionId: string;
  revisionId: string;
  userId: string;
  manifestDigest: string;
  registry: ToolRegistry;
}): string[] {
  const revision = activeRuntime.get(input.extensionId);
  if (
    !revision
    || revision.status !== 'active'
    || revision.id !== input.revisionId
    || revision.userId !== input.userId
    || revision.manifestDigest !== input.manifestDigest
  ) return [];
  const runtime = extensionRuntimeState(revision, input.registry);
  return runtime.usable ? runtime.registeredToolNames : [];
}

/** Structured, read-only runtime truth for planners and diagnostics. */
export function listExtensionRuntimeSnapshots(
  context?: ToolContext,
  registry?: ToolRegistry,
): SignedExtensionRuntimeSnapshot[] {
  const userId = context?.userId || 'anonymous';
  return arrays().revisions
    .filter(revision => revision.userId === userId)
    .map(revision => {
      const runtime = extensionRuntimeState(revision, registry || context?.toolRegistry);
      return {
        extensionId: revision.extensionId,
        revisionId: revision.id,
        name: revision.manifest.name,
        version: revision.version,
        kind: revision.kind,
        revisionStatus: revision.status,
        manifestDigest: revision.manifestDigest,
        signerFingerprint: revision.signerFingerprint,
        ...runtime,
        providerId: revision.manifest.provider?.id || '',
        providerModelIds: revision.manifest.provider?.models.map(model => model.id) || [],
      };
    });
}

export function publicRevision(revision: ExtensionRevision, registry?: ToolRegistry): Record<string, unknown> {
  const runtime = extensionRuntimeState(revision, registry);
  return {
    id: revision.id,
    extensionId: revision.extensionId,
    userId: revision.userId,
    version: revision.version,
    kind: revision.kind,
    status: revision.status,
    manifestDigest: revision.manifestDigest,
    signerFingerprint: revision.signerFingerprint,
    publisherId: revision.manifest.publisher.id,
    credentialNamespace: extensionCredentialNamespace(revision.extensionId),
    toolNames: [...revision.toolNames],
    ...runtime,
    provider: revision.manifest.provider ? {
      id: revision.manifest.provider.id,
      protocol: revision.manifest.provider.protocol,
      baseUrlOrigin: new URL(revision.manifest.provider.baseUrl).origin,
      local: revision.manifest.provider.local === true,
      defaultModel: revision.manifest.provider.defaultModel,
      models: revision.manifest.provider.models.map(model => ({ ...model })),
      auth: {
        type: revision.manifest.provider.auth.type,
        credentialRef: revision.manifest.provider.auth.credentialRef || '',
        configured: revision.manifest.provider.auth.type === 'none'
          || Boolean(credentialValue(revision.manifest.provider.auth.credentialRef!)),
      },
    } : null,
    permissions: {
      ...revision.manifest.permissions,
      credentialRefs: revision.manifest.permissions.credentialRefs?.map(name => ({ name, configured: Boolean(credentialValue(name)) })),
    },
    compatibility: revision.compatibility,
    error: revision.error || null,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
    activatedAt: revision.activatedAt || null,
    disabledAt: revision.disabledAt || null,
  };
}

export function listExtensions(context?: ToolContext, registry?: ToolRegistry): string {
  const userId = context?.userId || 'anonymous';
  const store = arrays();
  return JSON.stringify({
    ok: true,
    verified: true,
    status: 'listed',
    extensionApiVersion: LUMI_EXTENSION_API_VERSION,
    extensions: store.revisions
      .filter(item => item.userId === userId)
      .map(item => publicRevision(item, registry || context?.toolRegistry)),
    trustedPublishers: store.publishers.filter(item => (
      item.status === 'trusted' && publisherTrustedBy(item, userId)
    )).map(item => ({
      publisherId: item.publisherId,
      fingerprint: item.fingerprint,
      status: item.status,
      credentialsStored: false,
    })),
  }, null, 2);
}

export function listExtensionReceipts(context?: ToolContext, extensionId?: string): string {
  const userId = context?.userId || 'anonymous';
  const receipts = arrays().receipts.filter(item => item.userId === userId && (!extensionId || item.extensionId === extensionId));
  return JSON.stringify({ ok: true, verified: true, status: 'listed', receipts: receipts.slice(-100), count: receipts.length }, null, 2);
}
