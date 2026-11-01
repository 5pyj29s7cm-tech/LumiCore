import crypto from 'node:crypto';
import path from 'node:path';

export const CURRENT_FORMAL_CLIENT_IDS = Object.freeze(['main', 'designer-client', 'legal-client']);
export const CURRENT_FORMAL_BUSINESS_LINES = Object.freeze(['ecommerce', 'finance']);
const APP_IDENTIFIERS = { main: 'com.lumiai.os', 'designer-client': 'com.lumiai.designer', 'legal-client': 'com.lumiai.legal' };
const text = value => String(value ?? '').trim();
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const topologyJson = value => JSON.stringify(stable(value));
const hash = value => crypto.createHash('sha256').update(topologyJson(value)).digest('hex');
function check(ok, code) { if (!ok) throw new Error(code); }
function location(value) {
  const input = text(value);
  check(input && !input.includes('\0') && !input.split(/[\\/]/).includes('..'), 'current_topology_path_invalid');
  const windows = /^[a-z]:[\\/]/i.test(input);
  check(windows || (input.startsWith('/') && !input.includes('\\')), 'current_topology_path_not_absolute');
  const api = windows ? path.win32 : path.posix;
  const normalized = api.normalize(input);
  check(normalized !== api.parse(normalized).root, 'current_topology_path_is_root');
  return { value: normalized, identity: (windows ? normalized.toLowerCase() : normalized).replaceAll('\\', '/') };
}
export const currentFormalLocationDigest = value => crypto.createHash('sha256').update(location(value).value, 'utf8').digest('hex');
function identifier(value) {
  const result = text(value);
  check(result.length > 0 && result.length <= 200 && !/[\x00-\x1f]/.test(result), 'current_scope_identifier_invalid');
  return result;
}
export function normalizeFormalClientTopology(input) {
  check(Array.isArray(input?.clients) && input.clients.length === 3, 'current_client_count_invalid');
  const clients = CURRENT_FORMAL_CLIENT_IDS.map(clientId => {
    const matches = input.clients.filter(item => item?.clientId === clientId);
    check(matches.length === 1, 'current_client_identity_invalid');
    const raw = matches[0], coreSha = text(raw.coreSha).toLowerCase(), sourceSha = text(raw.sourceSha).toLowerCase();
    check(/^[a-f0-9]{40}$/.test(coreSha) && /^[a-f0-9]{40}$/.test(sourceSha), 'current_client_sha_invalid');
    check(clientId !== 'main' || coreSha === sourceSha, 'current_main_source_mismatch');
    const appIdentifier = text(raw.appIdentifier), nativeIdentityFingerprint = text(raw.nativeIdentityFingerprint).toLowerCase(), sourceFingerprint = text(raw.sourceFingerprint).toLowerCase();
    check(appIdentifier === APP_IDENTIFIERS[clientId] && /^[a-f0-9]{64}$/.test(nativeIdentityFingerprint) && /^[a-f0-9]{64}$/.test(sourceFingerprint), 'current_client_runtime_identity_invalid');
    const identity = { clientId, appIdentifier, nativeIdentityFingerprint, sourceFingerprint, coreSha, sourceSha, dataRoot: location(raw.dataRoot).value, webviewProfile: location(raw.webviewProfile).value };
    return { ...identity, fingerprint: hash(identity) };
  });
  check(new Set(clients.map(item => item.coreSha)).size === 1, 'current_core_sha_not_shared');
  const paths = clients.flatMap(item => [location(item.dataRoot).identity, location(item.webviewProfile).identity]);
  check(new Set(paths).size === paths.length, 'current_client_paths_not_distinct');
  check(!paths.some((value, index) => paths.some((other, otherIndex) => index !== otherIndex && other.startsWith(value.replace(/\/$/, '') + '/'))), 'current_client_paths_overlap');
  check(new Set(clients.map(item => item.nativeIdentityFingerprint)).size === 3, 'current_native_identity_reused');
  check(Array.isArray(input?.businessScopes) && input.businessScopes.length === 2, 'current_business_scope_count_invalid');
  const businessScopes = CURRENT_FORMAL_BUSINESS_LINES.map(productLine => {
    const matches = input.businessScopes.filter(item => item?.productLine === productLine);
    check(matches.length === 1 && matches[0].clientId === 'main', 'current_business_client_invalid');
    const raw = matches[0], domain = text(raw.domain), orgId = text(raw.orgId);
    check((domain === 'personal' && !orgId) || (domain === 'work' && orgId), 'current_business_domain_invalid');
    const scope = { clientId: 'main', productLine, userId: identifier(raw.userId), domain, orgId, workspaceId: identifier(raw.workspaceId) };
    check(scope.workspaceId !== '_unbound', 'current_business_workspace_unbound');
    if (orgId) identifier(orgId);
    return { ...scope, fingerprint: hash(scope) };
  });
  return { clients, businessScopes };
}

export function validateCurrentClientRuntime(binding, actual) {
  check(actual?.clientKind === 'tauri' && actual.appIdentifier === binding.appIdentifier
    && actual.identityFingerprint === binding.nativeIdentityFingerprint
    && actual.buildId === binding.sourceSha && actual.sourceFingerprint === binding.sourceFingerprint && actual.sourceDirty === false
    && actual.osAttested === true && actual.trustLevel === 'os_attested_native_claim'
    && actual.webviewProfileBound === true && actual.webviewProfileTrustLevel === 'native_attested'
    && actual.dataRootSha256 === currentFormalLocationDigest(binding.dataRoot)
    && actual.webviewProfileSha256 === currentFormalLocationDigest(binding.webviewProfile)
    && /^[a-f0-9]{64}$/.test(text(actual.executableSha256))
    && Number.isSafeInteger(actual.pid) && actual.pid > 0 && Number.isFinite(Date.parse(actual.startedAt))
    && text(actual.deviceId) && text(actual.executionSessionId), 'current_native_runtime_binding_invalid');
  return true;
}

export function currentFormalScenarioBinding(topology, productLine) {
  const clientId = productLine === 'design' ? 'designer-client' : productLine === 'legal' ? 'legal-client' : 'main';
  const client = topology.clients.find(item => item.clientId === clientId);
  check(client && ['design', 'legal', ...CURRENT_FORMAL_BUSINESS_LINES].includes(productLine), 'current_scenario_client_invalid');
  const identity = { ...client, ...(clientId === 'main' ? { businessScope: topology.businessScopes.find(item => item.productLine === productLine) } : {}) };
  return { ...identity, dataRootMode: 'formal_persistent', webviewProfileMode: 'formal_persistent', fingerprint: hash(identity) };
}

// This checks a signed producer's declared topology, never adjudicates acceptance itself.
export function validateCurrentTopologyCompletion(payload) {
  const topology = normalizeFormalClientTopology(payload?.clientTopology);
  check(topologyJson(topology) === topologyJson(payload.clientTopology), 'current_topology_changed');
  check(Array.isArray(payload.completedClients) && payload.completedClients.length === 3, 'current_clients_not_proven');
  for (const client of topology.clients) {
    const matches = payload.completedClients.filter(item => item?.clientId === client.clientId);
    check(matches.length === 1 && matches[0].fingerprint === client.fingerprint, 'current_clients_not_proven');
    validateCurrentClientRuntime(client, matches[0].nativeClient);
  }
  check(topologyJson(payload.completedBusinessScopes) === topologyJson(topology.businessScopes), 'current_business_scopes_not_proven');
  check(topologyJson(payload.completedBusinessLoops) === topologyJson(['design', 'ecommerce', 'finance', 'legal']), 'current_business_loops_not_proven');
  return true;
}
