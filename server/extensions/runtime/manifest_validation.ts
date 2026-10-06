import { canonicalJson } from '../../../shared/stable_json';
import { cloneDatabaseValue } from "../../db/snapshot_changes";
import crypto from "node:crypto";
import { LUMI_CLIENT_MODE_IDS } from "../../../shared/operation_modes";
import { isPersistableKeyName } from "../../config/keys";
import type { CapabilityLane, CapabilityMode, CapabilityOperation, CapabilityRisk, CapabilitySideEffect, CapabilityVerification, SecurityLevel, ToolPermission } from "../../tools/types";
import type { ExtensionPublisher, LumiExtensionManifest, ExtensionAuthConfig, ExtensionRevision } from './contracts';
import { LUMI_EXTENSION_API_VERSION } from './contracts';
import { normalizeOrigin, normalizeBaseUrl, isLoopbackHost, normalizeEndpointPath } from './network_policy';

export const EXTENSION_ID_RE = /^ext_[a-z0-9][a-z0-9_.-]{2,63}$/;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]{1,40})?$/i;

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,95}$/;

const MODEL_ID_RE = /^[^\s\u0000-\u001f]{1,200}$/u;

const MAX_MANIFEST_BYTES = 256 * 1024;

const ALLOWED_MANIFEST_KEYS = new Set([
  'schemaVersion', 'extensionApiVersion', 'id', 'version', 'name', 'description',
  'publisher', 'signature', 'permissions', 'auth', 'health', 'provider', 'tools',
]);

const ALLOWED_PERMISSION_KEYS = new Set([
  'networkOrigins', 'credentialRefs', 'localNetwork', 'maxRequestBytes',
  'maxResponseBytes', 'timeoutMs', 'maxConcurrency',
]);

const ALLOWED_SIDE_EFFECTS = new Set<CapabilitySideEffect['type']>([
  'network_read', 'external_state_change', 'external_communication',
  'credential_access', 'none',
]);

const ALLOWED_LANES = new Set<CapabilityLane>([
  'client', 'files', 'desktop', 'web', 'cad', 'messaging', 'office', 'media',
  'knowledge', 'memory', 'agents', 'system', 'industry', 'general',
]);

const ALLOWED_OPERATIONS = new Set<CapabilityOperation>(['observe', 'test', 'mutate', 'create', 'communicate']);

const ALLOWED_RISKS = new Set<CapabilityRisk>(['none', 'low', 'medium', 'high', 'critical']);

const ALLOWED_MODES = new Set<CapabilityMode>(LUMI_CLIENT_MODE_IDS);

const ALLOWED_SECURITY = new Set<SecurityLevel>(['safe', 'confirm', 'forbidden']);

const ALLOWED_PERMISSIONS = new Set<ToolPermission>(['user', 'admin']);

const ALLOWED_VERIFICATION_STRATEGIES = new Set<CapabilityVerification['strategy']>([
  'terminal_receipt', 'state_diff', 'artifact', 'provider_ack', 'visual', 'measured',
]);

export function publisherTrustedBy(publisher: ExtensionPublisher, userId: string): boolean {
  return Array.isArray(publisher.trustedBy)
    ? publisher.trustedBy.includes(userId)
    : publisher.trustedBy === userId;
}

export function unsignedManifest(manifest: LumiExtensionManifest): Record<string, unknown> {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

export function extensionManifestSigningPayload(manifest: LumiExtensionManifest): Buffer {
  // Sign the exact normalized representation Lumi will execute. This keeps
  // optional defaults ergonomic for publishers while preventing a textual
  // variation from changing runtime permissions after signature validation.
  const normalized = validateManifest(manifest);
  return Buffer.from(canonicalJson(unsignedManifest(normalized)), 'utf8');
}

export function digest(value: unknown): string {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Every signed extension receives a private credential namespace. An extension
 * may never borrow host-wide model, messaging, source-control, or organization
 * credentials merely by naming their settings key in its signed manifest.
 */
export function extensionCredentialNamespace(extensionId: string): string {
  return `LUMI_EXT_${crypto.createHash('sha256').update(String(extensionId || '')).digest('hex').slice(0, 16).toUpperCase()}_`;
}

export function cleanError(error: unknown): string {
  return String((error as any)?.message || error || 'Extension operation failed')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .slice(0, 1_000);
}

function assertNoEmbeddedCredentials(value: unknown, pathName = 'manifest'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedCredentials(item, `${pathName}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:api.?keys?|access.?tokens?|auth.?tokens?|tokens?|secrets?|passwords?|cookies?|authorization|credentials?)$/i.test(key)
      && key !== 'credentialRef' && key !== 'credentialRefs') {
      throw new Error(`${pathName}.${key} embeds credential material. Use an approved credentialRef instead.`);
    }
    if (/^headers?$/i.test(key)) throw new Error(`${pathName}.${key} is not allowed; extension headers are runtime-controlled.`);
    assertNoEmbeddedCredentials(child, `${pathName}.${key}`);
  }
}

function parsePublicKey(value: string): crypto.KeyObject {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 8_192) throw new Error('A valid publisher public key is required.');
  try {
    if (/-----BEGIN PUBLIC KEY-----/.test(raw)) return crypto.createPublicKey(raw);
    return crypto.createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('Publisher publicKey must be a valid Ed25519 PEM or base64 SPKI key.');
  }
}

function publicKeyFingerprint(key: crypto.KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

export function verifyManifestSignature(manifest: LumiExtensionManifest): { fingerprint: string; publicKey: crypto.KeyObject } {
  if (manifest.signature?.algorithm !== 'ed25519') throw new Error('Only Ed25519 extension signatures are accepted.');
  const publicKey = parsePublicKey(manifest.publisher?.publicKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('The publisher key is not an Ed25519 public key.');
  const signature = Buffer.from(String(manifest.signature?.value || ''), 'base64');
  if (signature.length !== 64 || !crypto.verify(null, extensionManifestSigningPayload(manifest), publicKey, signature)) {
    throw new Error('Extension signature verification failed.');
  }
  return { fingerprint: publicKeyFingerprint(publicKey), publicKey };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function validateSchema(value: unknown, field: string, depth = 0): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be a JSON Schema object.`);
  if (depth > 8) throw new Error(`${field} exceeds the maximum schema depth.`);
  const schema = value as Record<string, unknown>;
  if ('$ref' in schema || '$dynamicRef' in schema) throw new Error(`${field} cannot use external or dynamic schema references.`);
  if (schema.type !== 'object') throw new Error(`${field} must declare type=object.`);
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new Error(`${field}.properties must be an object.`);
  if (Object.keys(properties as Record<string, unknown>).length > 80) throw new Error(`${field} declares too many properties.`);
  const inspect = (node: unknown, nodePath: string, nodeDepth: number) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (nodeDepth > 8) throw new Error(`${nodePath} exceeds the maximum schema depth.`);
    const object = node as Record<string, unknown>;
    if ('$ref' in object || '$dynamicRef' in object) throw new Error(`${nodePath} cannot use schema references.`);
    if (object.properties && typeof object.properties === 'object' && !Array.isArray(object.properties)) {
      for (const [key, child] of Object.entries(object.properties as Record<string, unknown>)) inspect(child, `${nodePath}.${key}`, nodeDepth + 1);
    }
    if (object.items) inspect(object.items, `${nodePath}.items`, nodeDepth + 1);
  };
  for (const [key, child] of Object.entries(properties as Record<string, unknown>)) inspect(child, `${field}.${key}`, depth + 1);
}

function validateVerification(value: CapabilityVerification, field: string): CapabilityVerification {
  if (!value || !ALLOWED_VERIFICATION_STRATEGIES.has(value.strategy) || value.required !== true) {
    throw new Error(`${field} must declare a required supported verification strategy.`);
  }
  if (!Array.isArray(value.requiredFields) || value.requiredFields.length === 0) {
    throw new Error(`${field}.requiredFields must identify terminal receipt fields.`);
  }
  return {
    ...value,
    requiredFields: value.requiredFields.map(item => String(item).slice(0, 120)).slice(0, 20),
    successSignals: Array.isArray(value.successSignals) ? value.successSignals.map(String).slice(0, 20) : [],
    limitations: Array.isArray(value.limitations) ? value.limitations.map(String).slice(0, 20) : [],
  };
}

export function validateManifest(input: unknown): LumiExtensionManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Extension manifest must be an object.');
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Extension manifest exceeds the 256 KiB limit.');
  assertNoEmbeddedCredentials(input);
  const manifest = cloneDatabaseValue(input) as LumiExtensionManifest;
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) throw new Error(`Unsupported extension manifest field: ${key}`);
  }
  if (manifest.schemaVersion !== 1 || manifest.extensionApiVersion !== LUMI_EXTENSION_API_VERSION) {
    throw new Error(`Extension API compatibility failed; this Lumi accepts schemaVersion=1 and extensionApiVersion=${LUMI_EXTENSION_API_VERSION}.`);
  }
  if (!EXTENSION_ID_RE.test(String(manifest.id || ''))) throw new Error('Extension id must use the ext_ namespace and safe lowercase characters.');
  if (!VERSION_RE.test(String(manifest.version || ''))) throw new Error('Extension version must be semantic version syntax.');
  if (!String(manifest.name || '').trim() || String(manifest.name).length > 120) throw new Error('Extension name is required and must be at most 120 characters.');
  if (!/^[a-z0-9][a-z0-9_.-]{1,80}$/i.test(String(manifest.publisher?.id || ''))) throw new Error('Publisher id is invalid.');
  if (!manifest.permissions || typeof manifest.permissions !== 'object') throw new Error('Extension permissions are required.');
  for (const key of Object.keys(manifest.permissions)) {
    if (!ALLOWED_PERMISSION_KEYS.has(key)) throw new Error(`Unsupported extension permission: ${key}`);
  }
  const origins = Array.from(new Set((manifest.permissions.networkOrigins || []).map(normalizeOrigin)));
  if (origins.length === 0 || origins.length > 8) throw new Error('Extension permissions must declare 1 to 8 exact network origins.');
  const credentialRefs = Array.from(new Set((manifest.permissions.credentialRefs || []).map(item => String(item).trim())));
  const credentialNamespace = extensionCredentialNamespace(manifest.id);
  if (
    credentialRefs.length > 8
    || credentialRefs.some(item => !isPersistableKeyName(item) || !item.startsWith(credentialNamespace))
  ) {
    throw new Error(`Extension credentialRefs must use this extension's dedicated ${credentialNamespace}* credential namespace.`);
  }
  manifest.permissions = {
    networkOrigins: origins,
    credentialRefs,
    localNetwork: manifest.permissions.localNetwork === true,
    maxRequestBytes: boundedInteger(manifest.permissions.maxRequestBytes, 256 * 1024, 1_024, 2 * 1024 * 1024, 'permissions.maxRequestBytes'),
    maxResponseBytes: boundedInteger(manifest.permissions.maxResponseBytes, 2 * 1024 * 1024, 1_024, 16 * 1024 * 1024, 'permissions.maxResponseBytes'),
    timeoutMs: boundedInteger(manifest.permissions.timeoutMs, 30_000, 1_000, 120_000, 'permissions.timeoutMs'),
    maxConcurrency: boundedInteger(manifest.permissions.maxConcurrency, 2, 1, 8, 'permissions.maxConcurrency'),
  };
  const validateAuth = (auth: ExtensionAuthConfig | undefined, field: string): ExtensionAuthConfig => {
    const normalized = auth || { type: 'none' as const };
    if (!['none', 'bearer'].includes(normalized.type)) throw new Error(`${field} must be none or bearer.`);
    if (normalized.type === 'bearer') {
      if (!normalized.credentialRef || !credentialRefs.includes(normalized.credentialRef)) {
        throw new Error(`${field} bearer auth requires a credentialRef present in permissions.credentialRefs.`);
      }
      return { type: 'bearer', credentialRef: normalized.credentialRef };
    }
    if (normalized.credentialRef) throw new Error(`${field}.credentialRef is only valid for bearer authentication.`);
    return { type: 'none' };
  };
  manifest.auth = validateAuth(manifest.auth, 'auth');
  if (!manifest.provider && (!Array.isArray(manifest.tools) || manifest.tools.length === 0)) {
    throw new Error('Extension must declare an OpenAI-compatible provider, at least one tool, or both.');
  }
  if (manifest.provider) {
    const provider = manifest.provider;
    if (provider.id !== manifest.id || provider.protocol !== 'openai-compatible') {
      throw new Error('Provider id must equal the extension id and protocol must be openai-compatible.');
    }
    const base = normalizeBaseUrl(provider.baseUrl);
    if (!origins.includes(base.origin)) throw new Error('Provider baseUrl origin is outside the declared networkOrigins sandbox.');
    const loopback = isLoopbackHost(base.hostname);
    if (loopback && manifest.permissions.localNetwork !== true) throw new Error('Loopback providers require the explicit localNetwork permission.');
    if (provider.local === true && !loopback) throw new Error('A provider can be marked local only when its exact baseUrl is loopback.');
    provider.auth = validateAuth(provider.auth, 'provider.auth');
    if (!Array.isArray(provider.models) || provider.models.length === 0 || provider.models.length > 64) {
      throw new Error('Provider must declare 1 to 64 models.');
    }
    const ids = new Set<string>();
    provider.models = provider.models.map((model, index) => {
      if (!MODEL_ID_RE.test(String(model?.id || '')) || ids.has(model.id)) throw new Error(`Provider model ${index} has an invalid or duplicate id.`);
      ids.add(model.id);
      if (model.capabilities?.text !== true) throw new Error(`Provider model ${model.id} must explicitly declare text capability.`);
      return {
        id: model.id,
        capabilities: {
          text: true,
          vision: model.capabilities.vision === true,
          tools: model.capabilities.tools === true,
          json: model.capabilities.json === true,
          streaming: model.capabilities.streaming === true,
        },
        ...(model.contextWindow ? { contextWindow: boundedInteger(model.contextWindow, 0, 1_024, 10_000_000, `provider.models[${index}].contextWindow`) } : {}),
        ...(model.maxOutputTokens ? { maxOutputTokens: boundedInteger(model.maxOutputTokens, 0, 128, 1_000_000, `provider.models[${index}].maxOutputTokens`) } : {}),
      };
    });
    if (!ids.has(provider.defaultModel)) throw new Error('Provider defaultModel must be one of its declared model ids.');
    provider.baseUrl = base.toString().replace(/\/$/, '');
    provider.modelsPath = normalizeEndpointPath(provider.modelsPath || '/models', 'provider.modelsPath');
    provider.local = provider.local === true;
  }
  const toolNames = new Set<string>();
  manifest.tools = (manifest.tools || []).map((tool, index) => {
    const field = `tools[${index}]`;
    if (!TOOL_NAME_RE.test(String(tool?.name || '')) || !tool.name.startsWith(`${manifest.id}_`) || toolNames.has(tool.name)) {
      throw new Error(`${field}.name must be unique and start with ${manifest.id}_.`);
    }
    toolNames.add(tool.name);
    if (!String(tool.description || '').trim() || tool.description.length > 1_500) throw new Error(`${field}.description is required.`);
    validateSchema(tool.parameters, `${field}.parameters`);
    if (!ALLOWED_PERMISSIONS.has(tool.permission)) throw new Error(`${field}.permission is unsupported.`);
    if (!ALLOWED_SECURITY.has(tool.securityLevel)) throw new Error(`${field}.securityLevel is unsupported.`);
    const capability = tool.capability;
    if (!capability || !capability.id || !capability.family || !ALLOWED_LANES.has(capability.lane)
      || !ALLOWED_OPERATIONS.has(capability.operation) || !ALLOWED_RISKS.has(capability.risk)) {
      throw new Error(`${field}.capability must explicitly declare id, family, lane, operation, and risk.`);
    }
    if (!Array.isArray(capability.sideEffects) || capability.sideEffects.length === 0) throw new Error(`${field}.capability.sideEffects is required.`);
    for (const effect of capability.sideEffects) {
      if (!ALLOWED_SIDE_EFFECTS.has(effect.type) || !String(effect.scope || '').trim() || typeof effect.reversible !== 'boolean') {
        throw new Error(`${field}.capability.sideEffects contains an unsupported or incomplete effect.`);
      }
    }
    const externalCommit = capability.sideEffects.some(effect => ['external_state_change', 'external_communication'].includes(effect.type));
    if (externalCommit && tool.securityLevel !== 'confirm') throw new Error(`${field} external commits must use securityLevel=confirm.`);
    if (['observe', 'test'].includes(capability.operation) && externalCommit) throw new Error(`${field} read/test operations cannot declare external commits.`);
    if (capability.operation === 'communicate' && !capability.sideEffects.some(effect => effect.type === 'external_communication')) {
      throw new Error(`${field} communicate operation must declare external_communication.`);
    }
    capability.verification = validateVerification(capability.verification, `${field}.capability.verification`);
    if (capability.modes?.some(mode => !ALLOWED_MODES.has(mode))) throw new Error(`${field}.capability.modes contains an unsupported mode.`);
    return {
      ...tool,
      endpointPath: normalizeEndpointPath(tool.endpointPath, `${field}.endpointPath`),
      ...(tool.reconcilePath ? { reconcilePath: normalizeEndpointPath(tool.reconcilePath, `${field}.reconcilePath`) } : {}),
      routingHints: (tool.routingHints || []).map(String).filter(Boolean).slice(0, 40),
      capability: {
        ...capability,
        sideEffects: capability.sideEffects.map(effect => ({ ...effect })),
        modes: capability.modes?.slice(0, 4),
        domains: capability.domains?.map(String).slice(0, 20),
        tags: capability.tags?.map(String).slice(0, 40),
        intents: capability.intents?.map(String).slice(0, 40),
      },
    };
  });
  if (!manifest.provider) {
    if (!manifest.health?.path) throw new Error('Tool-only extensions must declare a fixed health.path compatibility probe.');
    manifest.health = { path: normalizeEndpointPath(manifest.health.path, 'health.path') };
  } else if (manifest.health?.path) {
    manifest.health = { path: normalizeEndpointPath(manifest.health.path, 'health.path') };
  }
  return manifest;
}

export function manifestKind(manifest: LumiExtensionManifest): ExtensionRevision['kind'] {
  return manifest.provider && manifest.tools?.length ? 'hybrid' : manifest.provider ? 'provider' : 'plugin';
}
