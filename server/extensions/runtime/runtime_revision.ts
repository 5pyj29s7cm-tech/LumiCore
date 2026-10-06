import type { ExtensionRevision } from './contracts';
import { activeRuntime, providerClients, registeredTools } from './runtime_state';
import { arrays } from './persistence';
import { verifyPersistedRevision } from './revision_verification';

export function invalidateRevisionRuntime(revision: ExtensionRevision): void {
  // A queued call may still hold an older, now inactive revision. Reject that
  // call without withdrawing the newer revision that owns this extension id.
  if (activeRuntime.get(revision.extensionId)?.id === revision.id) {
    activeRuntime.delete(revision.extensionId);
  }
  if (providerClients.get(revision.extensionId)?.revisionId === revision.id) {
    providerClients.delete(revision.extensionId);
  }
  for (const [name, owner] of registeredTools) {
    if (owner.extensionId === revision.extensionId && owner.revisionId === revision.id) {
      owner.registry.unregister(name);
      registeredTools.delete(name);
    }
  }
}

export function assertCurrentExecutableRevision(revision: ExtensionRevision): void {
  try {
    const store = arrays();
    const current = store.revisions.find(item => item.id === revision.id && item.userId === revision.userId);
    if (!current) throw new Error('Signed extension revision is no longer persisted.');
    verifyPersistedRevision(current, store);
    verifyPersistedRevision(revision, store);
    if (current.manifestDigest !== revision.manifestDigest || current.signerFingerprint !== revision.signerFingerprint || current.extensionId !== revision.extensionId) {
      throw new Error('Signed extension revision identity changed after runtime registration.');
    }
    if (
      current.status !== 'active'
      || revision.status !== 'active'
      || activeRuntime.get(revision.extensionId)?.id !== revision.id
    ) {
      throw new Error('Signed extension revision is not the current active runtime.');
    }
  } catch (error) {
    invalidateRevisionRuntime(revision);
    throw error;
  }
}

function activeRevisionFromDb(extensionId: string): ExtensionRevision | null {
  try {
    const store = arrays();
    const revision = store.revisions.find(item => item.extensionId === extensionId && item.status === 'active') || null;
    if (!revision) return null;
    verifyPersistedRevision(revision, store);
    return revision;
  } catch {
    return null;
  }
}

export function runtimeRevision(extensionId: string): ExtensionRevision | null {
  const cached = activeRuntime.get(extensionId);
  if (cached?.status === 'active') {
    try {
      verifyPersistedRevision(cached);
      return cached;
    } catch {
      invalidateRevisionRuntime(cached);
      return null;
    }
  }
  const persisted = activeRevisionFromDb(extensionId);
  if (persisted) activeRuntime.set(extensionId, persisted);
  return persisted;
}

export function assertRevisionOwner(revision: ExtensionRevision, userId?: string): void {
  if (revision.userId !== (userId || 'anonymous')) throw new Error('Extension is not available in this user scope.');
}
