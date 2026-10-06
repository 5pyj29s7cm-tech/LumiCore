import type { LumiExtensionManifest, ExtensionCompatibilityReceipt } from './contracts';
import { endpointUrl } from './network_policy';
import { boundedFetch, authHeaders, parseJsonObject } from './network_request';
import { nowIso, arrays } from './persistence';
import { cleanError } from './manifest_validation';
import { verifyPersistedRevision } from './revision_verification';

export async function compatibilityProbe(manifest: LumiExtensionManifest): Promise<ExtensionCompatibilityReceipt> {
  const startedAt = Date.now();
  try {
    let providerModels: string[] | undefined;
    let pluginHealth: string | undefined;
    if (manifest.provider) {
      const url = endpointUrl(manifest, manifest.provider.modelsPath || '/models');
      const { response, text } = await boundedFetch(manifest, url, { method: 'GET', headers: authHeaders(manifest, 'provider') });
      if (!response.ok) throw new Error(`Provider models probe failed with HTTP ${response.status}.`);
      const payload = parseJsonObject(text, 'Provider models probe');
      providerModels = Array.isArray(payload.data)
        ? payload.data.map((item: any) => String(item?.id || '')).filter(Boolean).slice(0, 256)
        : [];
      if (!providerModels.includes(manifest.provider.defaultModel)) {
        throw new Error(`Provider compatibility probe did not report declared default model ${manifest.provider.defaultModel}.`);
      }
    }
    if (manifest.health?.path) {
      const url = endpointUrl(manifest, manifest.health.path);
      const { response } = await boundedFetch(manifest, url, { method: 'GET', headers: authHeaders(manifest) });
      if (!response.ok) throw new Error(`Extension health probe failed with HTTP ${response.status}.`);
      pluginHealth = `http_${response.status}`;
    }
    return {
      ok: true,
      status: 'compatible',
      checkedAt: nowIso(),
      latencyMs: Date.now() - startedAt,
      ...(providerModels ? { providerModels } : {}),
      ...(pluginHealth ? { pluginHealth } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'incompatible',
      checkedAt: nowIso(),
      latencyMs: Date.now() - startedAt,
      error: cleanError(error),
    };
  }
}

export async function testRegisteredExtension(extensionId: string, userId?: string, version?: string): Promise<ExtensionCompatibilityReceipt> {
  const store = arrays();
  const revision = store.revisions.find(item => (
    item.extensionId === extensionId
    && item.userId === (userId || 'anonymous')
    && (!version || item.version === version)
    && (version ? true : item.status === 'active')
  ));
  if (!revision) throw new Error('Extension revision was not found in this user scope.');
  verifyPersistedRevision(revision, store);
  return compatibilityProbe(revision.manifest);
}
