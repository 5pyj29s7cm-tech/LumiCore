/**
 * Privacy mode for Lumi's built-in AI and tool execution.
 *
 * A saved preference takes effect on the next backend start. This is not an
 * operating-system firewall and does not control other applications.
 */

import fs from 'node:fs';
import { writeJsonAtomic } from './atomic_json';
import { isIP } from 'node:net';
import { getDataPath } from './data_path';

export type PrivacyMode = 'strict' | 'standard';

const PRIVACY_ENV = 'LUMI_PRIVACY';
let startupMode: PrivacyMode | undefined;

export function getConfiguredPrivacyMode(): PrivacyMode {
  try {
    const value = JSON.parse(fs.readFileSync(getDataPath('privacy.json'), 'utf8'));
    if (value?.version !== 1 || !['strict', 'standard'].includes(value.mode)) {
      throw new Error('Invalid privacy configuration.');
    }
    return value.mode;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'standard';
    // An unreadable or damaged file must never silently turn privacy off.
    throw new Error('Cannot read privacy configuration. Repair privacy.json before starting Lumi.', { cause: error });
  }
}

export function isPrivacyModeLocked(): boolean {
  return process.env[PRIVACY_ENV] === 'strict';
}

export function getPrivacyMode(): PrivacyMode {
  startupMode ??= getConfiguredPrivacyMode();
  return isPrivacyModeLocked() ? 'strict' : startupMode;
}

export function savePrivacyMode(mode: PrivacyMode): void {
  if (mode !== 'strict' && mode !== 'standard') throw new Error('Invalid privacy mode.');
  getPrivacyMode(); // Freeze the active mode before changing the saved one.
  if (isPrivacyModeLocked()) throw new Error('Privacy mode is enforced by the environment.');
  const destination = getDataPath('privacy.json');
  writeJsonAtomic(destination, { version: 1, mode });
}

export function requireLocalEndpoint(value: string, operation = 'Local AI processing'): void {
  if (!isStrictPrivacy()) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`[Privacy] ${operation}: invalid local endpoint.`); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '::1'
    || (isIP(host) === 4 && host.startsWith('127.'))
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
  if (!local || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`[Privacy] ${operation}: strict mode requires an endpoint on this computer.`);
  }
}

/** Local SDKs may follow redirects by default. Check every request and prevent
 * a local endpoint from redirecting a prompt to a remote service. */
export const localPrivacyFetch: typeof fetch = (input, init) => {
  requireLocalEndpoint(input instanceof Request ? input.url : String(input));
  return fetch(input, { ...init, ...(isStrictPrivacy() ? { redirect: 'error' as const } : {}) });
};

export function isStrictPrivacy(): boolean {
  return getPrivacyMode() === 'strict';
}

export function isProviderLocalOnly(provider: string): boolean {
  return provider === 'ollama' || provider === 'lmstudio';
}

export function requireLocalProvider(provider: string): void {
  if (isStrictPrivacy() && !isProviderLocalOnly(provider)) {
    throw new Error(
      `[Privacy] Strict mode active. ` +
      `Cloud provider "${provider}" is blocked. Use ollama or lmstudio.`
    );
  }
}

export function requireNotStrict(operation: string): void {
  if (isStrictPrivacy()) {
    throw new Error(
      `[Privacy] Strict mode: "${operation}" is unavailable under the current privacy policy.`
    );
  }
}
