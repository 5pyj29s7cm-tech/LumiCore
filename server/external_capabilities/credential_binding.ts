import crypto from 'node:crypto';
import { getJwtSecret } from '../config/local_identity';
import { getKey, isPersistableKeyName, type KeyStore } from '../config/keys';

export interface ExternalCapabilityCredentialBinding {
  /** Internal installation-bound revision. Never return this through routes or manifests. */
  revision: string;
  available: boolean;
  invalidReference: boolean;
  missingCount: number;
}

function credentialValue(reference: string): string {
  const environmentValue = String(process.env[reference] || '').trim();
  return environmentValue || String(getKey(reference as keyof KeyStore) || '').trim();
}

/**
 * Resolve credential references without ever copying their values into package
 * state, logs, receipts, or model-visible manifests. The revision is an
 * installation-keyed HMAC so a leaked database cannot be used to test guessed
 * credential values with an offline dictionary attack.
 */
export function resolveExternalCapabilityCredentialBinding(
  ownerUserId: string,
  credentialRefs: readonly string[],
): ExternalCapabilityCredentialBinding {
  const references = Array.from(new Set(credentialRefs.map(item => String(item || '').trim())))
    .sort((left, right) => left.localeCompare(right));
  const hmac = crypto.createHmac('sha256', getJwtSecret())
    .update('lumi:external-capability:credential-revision:v1\0')
    .update(String(ownerUserId || '').trim())
    .update('\0');
  let invalidReference = false;
  let missingCount = 0;
  for (const reference of references) {
    const validReference = isPersistableKeyName(reference);
    const value = validReference ? credentialValue(reference) : '';
    if (!validReference) invalidReference = true;
    if (!value) missingCount += 1;
    hmac
      .update(reference)
      .update('\0')
      .update(validReference ? 'approved' : 'invalid')
      .update('\0')
      .update(value ? 'present' : 'missing')
      .update('\0');
    if (value) hmac.update(value);
    hmac.update('\0');
  }
  return {
    revision: hmac.digest('hex'),
    available: !invalidReference && missingCount === 0,
    invalidReference,
    missingCount,
  };
}

export function sameExternalCapabilityCredentialRevision(left: unknown, right: unknown): boolean {
  const leftText = String(left || '');
  const rightText = String(right || '');
  if (!/^[a-f0-9]{64}$/.test(leftText) || !/^[a-f0-9]{64}$/.test(rightText)) return false;
  return crypto.timingSafeEqual(Buffer.from(leftText, 'hex'), Buffer.from(rightText, 'hex'));
}
