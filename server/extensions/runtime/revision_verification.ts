import { canonicalJson } from '../../../shared/stable_json';
import type { ExtensionRevision, ExtensionArrays, LumiExtensionManifest } from './contracts';
import { arrays } from './persistence';
import { validateManifest, verifyManifestSignature, digest, unsignedManifest, manifestKind, publisherTrustedBy } from './manifest_validation';

/** Re-derive every executable identity field from signed bytes, never DB labels. */
export function verifyPersistedRevision(
  revision: ExtensionRevision,
  store: ExtensionArrays = arrays(),
): LumiExtensionManifest {
  if (!revision || !String(revision.id || '').startsWith('extension_revision_')) {
    throw new Error('Persisted extension revision id is invalid.');
  }
  if (!String(revision.userId || '').trim() || revision.userId === 'anonymous') {
    throw new Error('Persisted extension revision has no authenticated owner.');
  }
  const manifest = validateManifest(revision.manifest);
  const verified = verifyManifestSignature(manifest);
  const manifestDigest = digest(unsignedManifest(manifest));
  const expectedToolNames = (manifest.tools || []).map(tool => tool.name);
  if (
    manifest.id !== revision.extensionId
    || manifest.version !== revision.version
    || manifestKind(manifest) !== revision.kind
    || verified.fingerprint !== revision.signerFingerprint
    || manifestDigest !== revision.manifestDigest
    || canonicalJson(expectedToolNames) !== canonicalJson(revision.toolNames)
  ) {
    throw new Error('Persisted extension identity does not match its signed revision record.');
  }
  const trusted = store.publishers.find(item => (
    item.fingerprint === verified.fingerprint
    && item.publisherId === manifest.publisher.id
    && item.publicKey === manifest.publisher.publicKey
    && publisherTrustedBy(item, revision.userId)
    && item.status === 'trusted'
  ));
  if (!trusted) throw new Error('Persisted extension publisher trust is missing, revoked, or belongs to another user.');
  return manifest;
}
