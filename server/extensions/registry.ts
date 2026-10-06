import { cloneDatabaseValue } from "../db/snapshot_changes";
import crypto from "node:crypto";
import { readDatabaseTables, commitDatabaseTables } from "../../db_layer";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import type { LumiExtensionManifest, ExtensionArrays, ExtensionRevision } from './runtime/contracts';
import { publisherTrustedBy, validateManifest, verifyManifestSignature, digest, unsignedManifest, manifestKind, cleanError } from './runtime/manifest_validation';
import { nowIso, arrays, receipt, pushReceipt } from './runtime/persistence';
import { withActivationLock, persistStrict, activeRuntime, providerClients, registeredTools } from './runtime/runtime_state';
import { extensionRuntimeState, publicRevision } from './runtime/runtime_snapshot';
import { compatibilityProbe } from './runtime/compatibility';
import { unregisterExtensionTools, registerRevisionTools, buildDefinitions } from './runtime/tool_execution';
import { verifyPersistedRevision } from './runtime/revision_verification';

export { LUMI_EXTENSION_API_VERSION } from './runtime/contracts';
export type { ExtensionProviderModel } from './runtime/contracts';
export type { ExtensionAuthConfig } from './runtime/contracts';
export type { OpenAICompatibleProviderManifest } from './runtime/contracts';
export type { ExtensionToolManifest } from './runtime/contracts';
export type { LumiExtensionManifest } from './runtime/contracts';
export type { ExtensionRevisionStatus } from './runtime/contracts';
export type { ExtensionRevision } from './runtime/contracts';
export type { ExtensionCompatibilityReceipt } from './runtime/contracts';
export type { SignedExtensionRuntimeSnapshot } from './runtime/contracts';
export { extensionManifestSigningPayload } from './runtime/manifest_validation';
export { extensionCredentialNamespace } from './runtime/manifest_validation';
export { getExactRegisteredExtensionToolNames } from './runtime/runtime_snapshot';
export { listExtensionRuntimeSnapshots } from './runtime/runtime_snapshot';
export { isExtensionProviderId } from './runtime/provider_access';
export { isRegisteredOpenAICompatibleProvider } from './runtime/provider_access';
export { getRegisteredProviderDefaultModel } from './runtime/provider_access';
export { getRegisteredProviderManifest } from './runtime/provider_access';
export { isRegisteredProviderLocal } from './runtime/provider_access';
export { assertRegisteredProviderModel } from './runtime/provider_access';
export { getRegisteredOpenAIClient } from './runtime/provider_access';
export { listRegisteredProviders } from './runtime/provider_access';
export { testRegisteredExtension } from './runtime/compatibility';
export { listExtensions } from './runtime/runtime_snapshot';
export { listExtensionReceipts } from './runtime/runtime_snapshot';
export { configureExtensionRuntimeForTests } from './runtime/runtime_state';
export { resetExtensionRegistryForTests } from './runtime/runtime_state';

function ensurePublisherTrust(
  manifest: LumiExtensionManifest,
  fingerprint: string,
  userId: string,
  trustPublisher: boolean,
  store: ExtensionArrays,
): void {
  const existing = store.publishers.find(item => item.fingerprint === fingerprint);
  if (existing?.status === 'revoked') throw new Error('Extension publisher key is revoked.');
  if (existing) {
    if (
      existing.publisherId !== manifest.publisher.id
      || existing.publicKey !== manifest.publisher.publicKey
    ) {
      throw new Error('Trusted publisher fingerprint is bound to a different publisher identity.');
    }
    if (publisherTrustedBy(existing, userId)) return;
    if (!trustPublisher) throw new Error('Publisher is not trusted by this user. Confirm this exact manifest and set trustPublisher=true for first use.');
    existing.trustedBy = Array.from(new Set([
      ...(Array.isArray(existing.trustedBy) ? existing.trustedBy : [existing.trustedBy]),
      userId,
    ])).sort();
    existing.updatedAt = nowIso();
    return;
  }
  const impersonated = store.publishers.find(item => (
    item.publisherId === manifest.publisher.id
    && publisherTrustedBy(item, userId)
    && item.status === 'trusted'
  ));
  if (impersonated) throw new Error('Publisher id is already bound to a different trusted key; explicit key rotation is not supported by install.');
  if (!trustPublisher) throw new Error('Publisher is not trusted. Confirm this exact manifest and set trustPublisher=true for first use.');
  const now = nowIso();
  store.publishers.push({
    fingerprint,
    publisherId: manifest.publisher.id,
    publicKey: manifest.publisher.publicKey,
    status: 'trusted',
    trustedBy: [userId],
    createdAt: now,
    updatedAt: now,
  });
}

function assertTrustedLocalExtensionAdministrator(context: ToolContext | undefined, action: string): void {
  if (
    context?.authenticated !== true
    || context.authRole !== 'admin'
    || context.localExecution !== true
    || context.executionBoundary !== 'trusted_local'
    || context.domain === 'work'
    || Boolean(context.orgId)
  ) {
    throw new Error(`${action} requires the authenticated local desktop administrator in the personal workspace.`);
  }
}

export async function installAndActivateExtension(
  input: { manifest: unknown; trustPublisher?: boolean },
  context?: ToolContext,
  registry?: ToolRegistry,
): Promise<string> {
  assertTrustedLocalExtensionAdministrator(context, 'Extension installation');
  if (context?.userConfirmed !== true) throw new Error('Extension installation requires confirmation bound to the exact signed manifest.');
  const targetRegistry = registry || context?.toolRegistry;
  if (!targetRegistry) throw new Error('Tool registry is unavailable for transactional extension activation.');
  return withActivationLock(async () => {
    const manifest = validateManifest(input.manifest);
    const { fingerprint } = verifyManifestSignature(manifest);
    const userId = context?.userId || 'anonymous';
    const manifestDigest = digest(unsignedManifest(manifest));
    const db = readDatabaseTables(["extensionActivationReceipts","extensionPublishers","extensionRevisions"]);
    const store = arrays(db);
    const ownerConflict = store.revisions.find(item => item.extensionId === manifest.id && item.userId !== userId);
    if (ownerConflict) throw new Error('Extension id is already owned by a different local user.');
    const signerConflict = store.revisions.find(item => item.extensionId === manifest.id && item.signerFingerprint !== fingerprint);
    if (signerConflict) throw new Error('Extension signer does not match the immutable publisher key bound to this extension id.');
    const sameVersion = store.revisions.find(item => item.extensionId === manifest.id && item.version === manifest.version);
    if (sameVersion && sameVersion.manifestDigest !== manifestDigest) {
      throw new Error('Extension version is immutable and already exists with a different manifest digest.');
    }
    ensurePublisherTrust(manifest, fingerprint, userId, input.trustPublisher === true, store);
    if (sameVersion?.status === 'active') {
      const runtime = extensionRuntimeState(sameVersion, targetRegistry);
      return JSON.stringify({
        ok: runtime.usable,
        verified: true,
        verificationStatus: runtime.usable ? 'verified' : 'unverified',
        status: runtime.usable ? 'already_active' : 'runtime_unavailable',
        extensionId: sameVersion.extensionId,
        revisionId: sameVersion.id,
        manifestDigest: sameVersion.manifestDigest,
        signerFingerprint: sameVersion.signerFingerprint,
        ...runtime,
        revision: publicRevision(sameVersion, targetRegistry),
      }, null, 2);
    }
    const now = nowIso();
    const revision: ExtensionRevision = sameVersion || {
      id: `extension_revision_${crypto.randomUUID()}`,
      extensionId: manifest.id,
      userId,
      version: manifest.version,
      kind: manifestKind(manifest),
      status: 'staged',
      manifestDigest,
      signerFingerprint: fingerprint,
      manifest,
      toolNames: (manifest.tools || []).map(tool => tool.name),
      createdAt: now,
      updatedAt: now,
    };
    if (!sameVersion) store.revisions.push(revision);
    revision.status = 'staged';
    revision.error = undefined;
    revision.updatedAt = now;
    commitDatabaseTables(db);

    const compatibility = await compatibilityProbe(manifest);
    revision.compatibility = compatibility;
    if (!compatibility.ok) {
      revision.status = 'failed';
      revision.error = compatibility.error;
      revision.updatedAt = nowIso();
      const failedReceipt = receipt(revision, 'compatibility_failed', '', compatibility.error);
      pushReceipt(store, failedReceipt);
      commitDatabaseTables(db);
      await persistStrict();
      return JSON.stringify({
        ok: false,
        verified: true,
        status: 'compatibility_failed',
        rollback: 'not_required_active_revision_unchanged',
        receipt: failedReceipt,
        revision: publicRevision(revision),
      }, null, 2);
    }

    const oldActive = store.revisions.find(item => item.extensionId === manifest.id && item.status === 'active');
    const arraySnapshot = {
      publishers: cloneDatabaseValue(store.publishers),
      revisions: cloneDatabaseValue(store.revisions),
      receipts: cloneDatabaseValue(store.receipts),
    };
    try {
      unregisterExtensionTools(targetRegistry, manifest.id);
      registerRevisionTools(targetRegistry, revision);
      if (oldActive) {
        oldActive.status = 'inactive';
        oldActive.updatedAt = nowIso();
      }
      revision.status = 'active';
      revision.activatedAt = nowIso();
      revision.updatedAt = revision.activatedAt;
      activeRuntime.set(manifest.id, revision);
      providerClients.delete(manifest.id);
      const runtime = extensionRuntimeState(revision, targetRegistry);
      if (!runtime.usable) {
        throw new Error(`Signed extension activation did not produce an exact callable runtime (${runtime.runtimeStatus}).`);
      }
      const activatedReceipt = receipt(revision, 'activated', oldActive?.id || '');
      pushReceipt(store, activatedReceipt);
      commitDatabaseTables(db);
      await persistStrict();
      return JSON.stringify({
        ok: true,
        verified: true,
        verificationStatus: 'verified',
        status: 'activated',
        extensionId: revision.extensionId,
        revisionId: revision.id,
        manifestDigest: revision.manifestDigest,
        signerFingerprint: revision.signerFingerprint,
        ...runtime,
        receipt: activatedReceipt,
        revision: publicRevision(revision, targetRegistry),
      }, null, 2);
    } catch (error) {
      unregisterExtensionTools(targetRegistry, manifest.id);
      db.extensionPublishers = arraySnapshot.publishers;
      db.extensionRevisions = arraySnapshot.revisions;
      db.extensionActivationReceipts = arraySnapshot.receipts;
      activeRuntime.delete(manifest.id);
      providerClients.delete(manifest.id);
      const restored = arrays(db);
      const failed = restored.revisions.find(item => item.id === revision.id) || revision;
      failed.status = 'failed';
      failed.error = cleanError(error);
      failed.updatedAt = nowIso();
      // Rebuild closures from the restored record, never from the old object
      // which the unsuccessful activation already changed to inactive.
      let runtimeRestored = true;
      if (oldActive) {
        try {
          const previous = restored.revisions.find(item => item.id === oldActive.id && item.status === 'active');
          if (!previous) throw new Error('Previous active revision is missing from the rollback snapshot.');
          registerRevisionTools(targetRegistry, previous);
          activeRuntime.set(manifest.id, previous);
          if (!extensionRuntimeState(previous, targetRegistry).usable) throw new Error('Previous extension runtime could not be restored.');
        } catch (restoreError) {
          runtimeRestored = false;
          unregisterExtensionTools(targetRegistry, manifest.id);
          activeRuntime.delete(manifest.id);
          failed.error = cleanError(`${failed.error}; rollback: ${cleanError(restoreError)}`);
        }
      }
      const rollbackStatus = runtimeRestored ? 'rolled_back' : 'rollback_failed';
      const rollbackReceipt = receipt(failed, rollbackStatus, oldActive?.id || '', failed.error);
      pushReceipt(restored, rollbackReceipt);
      commitDatabaseTables(db);
      let persisted = true;
      try { await persistStrict(); } catch { persisted = false; }
      return JSON.stringify({
        ok: false,
        verified: runtimeRestored && persisted,
        verificationStatus: runtimeRestored && persisted ? 'verified' : 'unverified',
        persistence: persisted ? 'committed' : 'pending',
        status: rollbackStatus,
        rollback: !runtimeRestored ? 'runtime_unavailable' : oldActive ? 'previous_revision_restored' : 'new_revision_removed_from_runtime',
        receipt: rollbackReceipt,
        error: failed.error,
      }, null, 2);
    }
  });
}

export async function rollbackExtension(
  input: { extensionId: string; version?: string },
  context?: ToolContext,
  registry?: ToolRegistry,
): Promise<string> {
  assertTrustedLocalExtensionAdministrator(context, 'Extension rollback');
  if (context?.userConfirmed !== true) throw new Error('Extension rollback requires explicit confirmation.');
  const targetRegistry = registry || context?.toolRegistry;
  if (!targetRegistry) throw new Error('Tool registry is unavailable for rollback.');
  return withActivationLock(async () => {
    const userId = context?.userId || 'anonymous';
    const db = readDatabaseTables(["extensionActivationReceipts","extensionPublishers","extensionRevisions"]);
    const store = arrays(db);
    const candidates = store.revisions.filter(item => item.extensionId === input.extensionId && item.userId === userId && item.status !== 'active');
    const target = input.version
      ? candidates.find(item => item.version === input.version)
      : candidates
        // Failed/staged installs have a creation date but have never owned
        // the active runtime. Default rollback must not turn into an upgrade.
        .filter(item => Number.isFinite(Date.parse(item.activatedAt || '')))
        .sort((a, b) => Date.parse(b.activatedAt!) - Date.parse(a.activatedAt!))[0];
    if (!target) throw new Error('No prior extension revision is available for rollback.');
    verifyPersistedRevision(target, store);
    const compatibility = await compatibilityProbe(target.manifest);
    target.compatibility = compatibility;
    if (!compatibility.ok) {
      const failedReceipt = receipt(target, 'rollback_compatibility_failed', '', compatibility.error);
      pushReceipt(store, failedReceipt);
      commitDatabaseTables(db);
      await persistStrict();
      return JSON.stringify({ ok: false, verified: true, status: 'rollback_compatibility_failed', receipt: failedReceipt }, null, 2);
    }
    const current = store.revisions.find(item => item.extensionId === input.extensionId && item.status === 'active');
    if (current) verifyPersistedRevision(current, store);
    const currentDefinitions = current ? buildDefinitions(current) : [];
    const currentSnapshot = current ? cloneDatabaseValue(current) : null;
    const targetSnapshot = cloneDatabaseValue(target);
    try {
      unregisterExtensionTools(targetRegistry, input.extensionId);
      registerRevisionTools(targetRegistry, target);
      if (current) {
        current.status = 'inactive';
        current.updatedAt = nowIso();
      }
      target.status = 'active';
      target.activatedAt = nowIso();
      target.updatedAt = target.activatedAt;
      activeRuntime.set(input.extensionId, target);
      providerClients.delete(input.extensionId);
      const runtime = extensionRuntimeState(target, targetRegistry);
      if (!runtime.usable) {
        throw new Error(`Signed extension rollback did not produce an exact callable runtime (${runtime.runtimeStatus}).`);
      }
      const rollbackReceipt = receipt(target, 'rollback_activated', current?.id || '');
      pushReceipt(store, rollbackReceipt);
      commitDatabaseTables(db);
      await persistStrict();
      return JSON.stringify({
        ok: true,
        verified: true,
        verificationStatus: 'verified',
        status: 'rollback_activated',
        extensionId: target.extensionId,
        revisionId: target.id,
        manifestDigest: target.manifestDigest,
        signerFingerprint: target.signerFingerprint,
        ...runtime,
        receipt: rollbackReceipt,
        revision: publicRevision(target, targetRegistry),
      }, null, 2);
    } catch (error) {
      unregisterExtensionTools(targetRegistry, input.extensionId);
      Object.assign(target, targetSnapshot);
      for (const definition of currentDefinitions) {
        if (targetRegistry.register(definition)) registeredTools.set(definition.name, {
          extensionId: input.extensionId,
          revisionId: current!.id,
          userId: current!.userId,
          registry: targetRegistry,
        });
      }
      if (current) {
        Object.assign(current, currentSnapshot);
        activeRuntime.set(input.extensionId, current);
      } else {
        activeRuntime.delete(input.extensionId);
      }
      const failedReceipt = receipt(target, 'rollback_failed_previous_restored', current?.id || '', cleanError(error));
      pushReceipt(store, failedReceipt);
      commitDatabaseTables(db);
      try { await persistStrict(); } catch {}
      return JSON.stringify({ ok: false, verified: true, status: 'rollback_failed_previous_restored', receipt: failedReceipt }, null, 2);
    }
  });
}

export async function disableExtension(
  extensionId: string,
  context?: ToolContext,
  registry?: ToolRegistry,
): Promise<string> {
  assertTrustedLocalExtensionAdministrator(context, 'Disabling an extension');
  if (context?.userConfirmed !== true) throw new Error('Disabling an extension requires explicit confirmation.');
  const targetRegistry = registry || context?.toolRegistry;
  if (!targetRegistry) throw new Error('Tool registry is unavailable for extension disable.');
  return withActivationLock(async () => {
    const db = readDatabaseTables(["extensionActivationReceipts","extensionPublishers","extensionRevisions"]);
    const store = arrays(db);
    const revision = store.revisions.find(item => item.extensionId === extensionId && item.status === 'active' && item.userId === (context?.userId || 'anonymous'));
    if (!revision) throw new Error('Active extension was not found in this user scope.');
    verifyPersistedRevision(revision, store);
    const revisionSnapshot = cloneDatabaseValue(revision);
    const definitions = buildDefinitions(revision);
    try {
      unregisterExtensionTools(targetRegistry, extensionId);
      revision.status = 'disabled';
      revision.disabledAt = nowIso();
      revision.updatedAt = revision.disabledAt;
      activeRuntime.delete(extensionId);
      providerClients.delete(extensionId);
      const disabledReceipt = receipt(revision, 'disabled', revision.id);
      pushReceipt(store, disabledReceipt);
      commitDatabaseTables(db);
      await persistStrict();
      return JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified', status: 'disabled', receipt: disabledReceipt }, null, 2);
    } catch (error) {
      Object.assign(revision, revisionSnapshot);
      for (const definition of definitions) {
        if (targetRegistry.register(definition)) registeredTools.set(definition.name, {
          extensionId,
          revisionId: revision.id,
          userId: revision.userId,
          registry: targetRegistry,
        });
      }
      activeRuntime.set(extensionId, revision);
      providerClients.delete(extensionId);
      const failedReceipt = receipt(revision, 'disable_failed_previous_restored', revision.id, cleanError(error));
      pushReceipt(store, failedReceipt);
      commitDatabaseTables(db);
      try { await persistStrict(); } catch {}
      return JSON.stringify({
        ok: false,
        verified: true,
        verificationStatus: 'verified',
        status: 'disable_failed_previous_restored',
        receipt: failedReceipt,
      }, null, 2);
    }
  });
}

export async function hydrateActiveExtensions(registry: ToolRegistry): Promise<{ activated: number; failed: number; errors: string[] }> {
  const db = readDatabaseTables(["extensionActivationReceipts","extensionPublishers","extensionRevisions"]);
  const store = arrays(db);
  let activated = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const revision of store.revisions.filter(item => item.status === 'active')) {
    try {
      verifyPersistedRevision(revision, store);
      registerRevisionTools(registry, revision);
      activeRuntime.set(revision.extensionId, revision);
      activated += 1;
    } catch (error) {
      revision.status = 'boot_failed';
      revision.error = cleanError(error);
      revision.updatedAt = nowIso();
      pushReceipt(store, receipt(revision, 'boot_failed', '', revision.error));
      errors.push(`${revision.extensionId}: ${revision.error}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    commitDatabaseTables(db);
    await persistStrict().catch(() => undefined);
  }
  return { activated, failed, errors };
}
