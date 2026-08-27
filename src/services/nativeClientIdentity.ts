import type { NativeClientIdentityClaim } from '../../shared/native_client_identity';
import { isTauriRuntime } from './apiBridge';

let identityPromise: Promise<NativeClientIdentityClaim> | null = null;

function isNativeClientIdentityClaim(value: unknown): value is NativeClientIdentityClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowedKeys = new Set([
    'schemaVersion',
    'clientKind',
    'pid',
    'startedAtUnixMs',
    'executablePath',
    'executableSha256',
    'binaryHashUnavailable',
    'buildId',
    'buildIdSemantics',
    'sourceFingerprint',
    'sourceDirty',
    'appVersion',
  ]);
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.size || keys.some(key => !allowedKeys.has(key))) return false;
  const candidate = value as Partial<NativeClientIdentityClaim>;
  return candidate.schemaVersion === 1
    && candidate.clientKind === 'tauri'
    && Number.isSafeInteger(candidate.pid)
    && Number(candidate.pid) > 0
    && Number.isSafeInteger(candidate.startedAtUnixMs)
    && Number(candidate.startedAtUnixMs) > 0
    && typeof candidate.executablePath === 'string'
    && candidate.executablePath.length > 0
    && typeof candidate.binaryHashUnavailable === 'boolean'
    && (
      (candidate.binaryHashUnavailable && candidate.executableSha256 === null)
      || (!candidate.binaryHashUnavailable
        && typeof candidate.executableSha256 === 'string'
        && /^[a-f0-9]{64}$/i.test(candidate.executableSha256))
    )
    && typeof candidate.buildId === 'string'
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidate.buildId)
    && candidate.buildIdSemantics === 'baseline_commit'
    && typeof candidate.sourceFingerprint === 'string'
    && /^[a-f0-9]{64}$/i.test(candidate.sourceFingerprint)
    && typeof candidate.sourceDirty === 'boolean'
    && typeof candidate.appVersion === 'string'
    && candidate.appVersion.length > 0;
}

/** Reads identity from native code. Web runtimes can never manufacture it. */
export async function getNativeClientIdentity(): Promise<NativeClientIdentityClaim | null> {
  if (!isTauriRuntime()) return null;
  if (!identityPromise) {
    identityPromise = import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<unknown>('get_native_client_identity'))
      .then(value => {
        if (!isNativeClientIdentityClaim(value)) {
          throw new Error('Native client returned an invalid process identity');
        }
        return { ...value };
      })
      .catch(error => {
        identityPromise = null;
        throw error;
      });
  }
  return identityPromise;
}
