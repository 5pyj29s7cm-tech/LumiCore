import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import OpenAI from 'openai';
import { Agent as UndiciAgent } from 'undici';
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import { LUMI_CLIENT_MODE_IDS } from '../../shared/operation_modes';
import { getKey, isPersistableKeyName } from '../config/keys';
import type { ToolRegistry } from '../tools/registry';
import type {
  CapabilityLane,
  CapabilityMode,
  CapabilityOperation,
  CapabilityRisk,
  CapabilitySideEffect,
  CapabilityVerification,
  SecurityLevel,
  ToolContext,
  ToolDefinition,
  ToolPermission,
} from '../tools/types';

export const LUMI_EXTENSION_API_VERSION = 1;

const EXTENSION_ID_RE = /^ext_[a-z0-9][a-z0-9_.-]{2,63}$/;
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

export interface ExtensionProviderModel {
  id: string;
  capabilities: {
    text: boolean;
    vision?: boolean;
    tools?: boolean;
    json?: boolean;
    streaming?: boolean;
  };
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ExtensionAuthConfig {
  type: 'none' | 'bearer';
  credentialRef?: string;
}

export interface OpenAICompatibleProviderManifest {
  id: string;
  protocol: 'openai-compatible';
  baseUrl: string;
  modelsPath?: string;
  auth: ExtensionAuthConfig;
  defaultModel: string;
  models: ExtensionProviderModel[];
  local?: boolean;
}

export interface ExtensionToolManifest {
  name: string;
  description: string;
  endpointPath: string;
  reconcilePath?: string;
  parameters: Record<string, unknown>;
  permission: ToolPermission;
  securityLevel: SecurityLevel;
  routingHints?: string[];
  capability: {
    id: string;
    family: string;
    lane: CapabilityLane;
    operation: Exclude<CapabilityOperation, 'unknown'>;
    risk: CapabilityRisk;
    sideEffects: CapabilitySideEffect[];
    verification: CapabilityVerification;
    domains?: string[];
    tags?: string[];
    intents?: string[];
    modes?: CapabilityMode[];
  };
}

export interface LumiExtensionManifest {
  schemaVersion: 1;
  extensionApiVersion: number;
  id: string;
  version: string;
  name: string;
  description?: string;
  publisher: {
    id: string;
    publicKey: string;
  };
  signature: {
    algorithm: 'ed25519';
    value: string;
  };
  permissions: {
    networkOrigins: string[];
    credentialRefs?: string[];
    localNetwork?: boolean;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    timeoutMs?: number;
    maxConcurrency?: number;
  };
  auth?: ExtensionAuthConfig;
  health?: { path: string };
  provider?: OpenAICompatibleProviderManifest;
  tools?: ExtensionToolManifest[];
}

export type ExtensionRevisionStatus = 'staged' | 'active' | 'inactive' | 'disabled' | 'failed' | 'boot_failed';

export interface ExtensionRevision {
  id: string;
  extensionId: string;
  userId: string;
  version: string;
  kind: 'provider' | 'plugin' | 'hybrid';
  status: ExtensionRevisionStatus;
  manifestDigest: string;
  signerFingerprint: string;
  manifest: LumiExtensionManifest;
  toolNames: string[];
  compatibility?: ExtensionCompatibilityReceipt;
  error?: string;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  disabledAt?: string;
}

export interface ExtensionCompatibilityReceipt {
  ok: boolean;
  status: 'compatible' | 'incompatible';
  checkedAt: string;
  latencyMs: number;
  providerModels?: string[];
  pluginHealth?: string;
  error?: string;
}

export interface SignedExtensionRuntimeSnapshot {
  extensionId: string;
  revisionId: string;
  name: string;
  version: string;
  kind: ExtensionRevision['kind'];
  revisionStatus: ExtensionRevisionStatus;
  manifestDigest: string;
  signerFingerprint: string;
  registered: boolean;
  usable: boolean;
  runtimeStatus: string;
  registeredToolNames: string[];
  declaredToolCount: number;
  keyReady: boolean;
  providerId: string;
  providerModelIds: string[];
}

interface ExtensionPublisher {
  fingerprint: string;
  publisherId: string;
  publicKey: string;
  status: 'trusted' | 'revoked';
  trustedBy: string | string[];
  createdAt: string;
  updatedAt: string;
}

function publisherTrustedBy(publisher: ExtensionPublisher, userId: string): boolean {
  return Array.isArray(publisher.trustedBy)
    ? publisher.trustedBy.includes(userId)
    : publisher.trustedBy === userId;
}

interface ExtensionActivationReceipt {
  id: string;
  extensionId: string;
  revisionId: string;
  userId: string;
  status: string;
  manifestDigest: string;
  signerFingerprint: string;
  previousRevisionId: string;
  toolNames: string[];
  providerId: string;
  compatibility?: ExtensionCompatibilityReceipt;
  error?: string;
  createdAt: string;
}

interface ExtensionArrays {
  publishers: ExtensionPublisher[];
  revisions: ExtensionRevision[];
  receipts: ExtensionActivationReceipt[];
}

interface ExtensionRuntimeOverrides {
  fetch?: typeof fetch;
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  persist?: () => Promise<void>;
}

const activeRuntime = new Map<string, ExtensionRevision>();
const registeredTools = new Map<string, {
  extensionId: string;
  revisionId: string;
  userId: string;
  registry: ToolRegistry;
}>();
const providerClients = new Map<string, { signature: string; client: OpenAI }>();
const executionCounts = new Map<string, number>();
let runtimeOverrides: ExtensionRuntimeOverrides | null = null;
let activationLock: Promise<void> = Promise.resolve();

function nowIso(): string {
  return new Date().toISOString();
}

function arrays(db = readDB()): ExtensionArrays {
  if (!Array.isArray(db.extensionPublishers)) db.extensionPublishers = [];
  if (!Array.isArray(db.extensionRevisions)) db.extensionRevisions = [];
  if (!Array.isArray(db.extensionActivationReceipts)) db.extensionActivationReceipts = [];
  return {
    publishers: db.extensionPublishers,
    revisions: db.extensionRevisions,
    receipts: db.extensionActivationReceipts,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key]),
  ]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function unsignedManifest(manifest: LumiExtensionManifest): Record<string, unknown> {
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

function digest(value: unknown): string {
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

function cleanError(error: unknown): string {
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

function verifyManifestSignature(manifest: LumiExtensionManifest): { fingerprint: string; publicKey: crypto.KeyObject } {
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

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  const family = net.isIP(lower);
  if (family === 4) return lower.startsWith('127.');
  if (family === 6) return lower === '::1' || lower === '0:0:0:0:0:0:0:1';
  return false;
}

function isPrivateAddress(address: string): boolean {
  const normalized = String(address || '').trim().toLowerCase().split('%', 1)[0];
  let ipv4 = net.isIPv4(normalized) ? normalized : '';
  if (!ipv4 && normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) {
      ipv4 = mapped;
    } else if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(mapped)) {
      const [high, low] = mapped.split(':').map(part => Number.parseInt(part, 16));
      ipv4 = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
    }
  }
  if (ipv4) {
    const octets = ipv4.split('.').map(Number);
    return octets[0] === 0
      || octets[0] === 10
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] === 0)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] === 2)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19)
      || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
      || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
      || octets[0] >= 224;
  }
  if (net.isIPv6(normalized)) {
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab][0-9a-f]:/i.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8:');
  }
  return true;
}

function normalizeOrigin(value: unknown): string {
  const raw = String(value || '').trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Invalid extension network origin: ${raw}`); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Extension network origin must contain only scheme, host, and optional port: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported extension network protocol: ${url.protocol}`);
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Non-local extension network origins must use HTTPS.');
  }
  return url.origin;
}

function normalizeBaseUrl(value: unknown): URL {
  const raw = String(value || '').trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Provider baseUrl must be a valid absolute URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider baseUrl cannot contain credentials, query parameters, or fragments.');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider baseUrl must use HTTP or HTTPS.');
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) throw new Error('Non-local providers must use HTTPS.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function normalizeEndpointPath(value: unknown, field: string): string {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('..') || raw.includes('?') || raw.includes('#') || raw.length > 300) {
    throw new Error(`${field} must be a fixed absolute path without traversal, query, or fragment.`);
  }
  return raw;
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

function validateManifest(input: unknown): LumiExtensionManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Extension manifest must be an object.');
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Extension manifest exceeds the 256 KiB limit.');
  assertNoEmbeddedCredentials(input);
  const manifest = structuredClone(input) as LumiExtensionManifest;
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

function manifestKind(manifest: LumiExtensionManifest): ExtensionRevision['kind'] {
  return manifest.provider && manifest.tools?.length ? 'hybrid' : manifest.provider ? 'provider' : 'plugin';
}

/** Re-derive every executable identity field from signed bytes, never DB labels. */
function verifyPersistedRevision(
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

function sourceBaseUrl(manifest: LumiExtensionManifest): URL {
  if (manifest.provider) return new URL(manifest.provider.baseUrl);
  return new URL(manifest.permissions.networkOrigins[0]);
}

function endpointUrl(manifest: LumiExtensionManifest, endpointPath: string): URL {
  const base = sourceBaseUrl(manifest);
  const basePath = base.pathname.replace(/\/$/, '');
  const url = new URL(base.origin);
  url.pathname = `${basePath}${endpointPath}`.replace(/\/{2,}/g, '/');
  if (!manifest.permissions.networkOrigins.includes(url.origin)) throw new Error('Extension endpoint escaped its declared network origin.');
  return url;
}

async function assertResolvedDestinationAllowed(url: URL, manifest: LumiExtensionManifest): Promise<void> {
  if (!manifest.permissions.networkOrigins.includes(url.origin)) throw new Error(`Network sandbox denied origin ${url.origin}.`);
  if (isLoopbackHost(url.hostname)) {
    if (manifest.permissions.localNetwork !== true) throw new Error('Network sandbox denied loopback access.');
    return;
  }
  await resolveAllowedExtensionAddresses(url.hostname, manifest);
}

async function resolveAllowedExtensionAddresses(
  hostname: string,
  manifest: LumiExtensionManifest,
): Promise<Array<{ address: string; family: number }>> {
  const lookup = runtimeOverrides?.dnsLookup || (async (target: string) => dns.lookup(target, { all: true }));
  const addresses = await lookup(hostname);
  if (!addresses.length) throw new Error('Extension destination did not resolve.');
  if (addresses.some(item => isPrivateAddress(item.address)) && manifest.permissions.localNetwork !== true) {
    throw new Error('Network sandbox denied a destination resolving to a private or link-local address.');
  }
  return addresses.map(item => ({ address: item.address, family: Number(item.family) }));
}

function createExtensionNetworkDispatcher(manifest: LumiExtensionManifest): UndiciAgent {
  return new UndiciAgent({
    connect: {
      lookup: ((hostname: string, options: any, callback: (...args: any[]) => void) => {
        resolveAllowedExtensionAddresses(hostname, manifest)
          .then(addresses => {
            const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0);
            const matching = requestedFamily
              ? addresses.filter(item => item.family === requestedFamily)
              : addresses;
            if (!matching.length) {
              callback(new Error(`Extension destination has no allowed IPv${requestedFamily || ''} address.`));
              return;
            }
            if (options?.all === true) callback(null, matching);
            else callback(null, matching[0].address, matching[0].family);
          })
          .catch(error => callback(error));
      }) as any,
    },
  });
}

async function extensionNetworkFetch(
  manifest: LumiExtensionManifest,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<{ response: Response; close: () => Promise<void> }> {
  if (runtimeOverrides?.fetch) {
    return { response: await runtimeOverrides.fetch(input, init), close: async () => undefined };
  }
  const dispatcher = createExtensionNetworkDispatcher(manifest);
  try {
    const response = await fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: UndiciAgent });
    return {
      response,
      close: async () => { await dispatcher.close(); },
    };
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
}

function authHeaders(manifest: LumiExtensionManifest, channel: 'tool' | 'provider' = 'tool'): Record<string, string> {
  const auth = channel === 'provider' ? manifest.provider?.auth : manifest.auth;
  if (!auth || auth.type === 'none') return {};
  const credential = credentialValue(auth.credentialRef!);
  if (!credential) throw new Error(`Required credentialRef ${auth.credentialRef} is not configured.`);
  return { Authorization: `Bearer ${credential}` };
}

function credentialValue(name: string): string | undefined {
  return process.env[name] || getKey(name);
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallback);
}

async function waitForAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  fallback: string,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal, fallback);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal, fallback));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  abort: (reason: Error) => void,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await waitForAbortable(
        reader.read(),
        signal,
        'Extension response read was aborted.',
      );
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new Error('Extension response exceeded its declared response-byte budget.');
        abort(error);
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), totalBytes).toString('utf8');
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function boundedFetch(
  manifest: LumiExtensionManifest,
  url: URL,
  init: RequestInit,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    new Error('Extension request exceeded its total timeout.'),
  ), manifest.permissions.timeoutMs!);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let closeNetwork = async () => undefined;
  try {
    await waitForAbortable(
      assertResolvedDestinationAllowed(url, manifest),
      signal,
      'Extension destination resolution was aborted.',
    );
    const bodyBytes = typeof init.body === 'string' ? Buffer.byteLength(init.body, 'utf8') : 0;
    if (bodyBytes > manifest.permissions.maxRequestBytes!) throw new Error('Extension request exceeds its declared request-byte budget.');
    const pendingNetwork = extensionNetworkFetch(manifest, url, { ...init, signal, redirect: 'error' });
    let secured: Awaited<ReturnType<typeof extensionNetworkFetch>>;
    try {
      secured = await waitForAbortable(
        pendingNetwork,
        signal,
        'Extension connection was aborted.',
      );
    } catch (error) {
      void pendingNetwork.then(result => result.close()).catch(() => undefined);
      throw error;
    }
    closeNetwork = secured.close;
    const response = secured.response;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > manifest.permissions.maxResponseBytes!) throw new Error('Extension response exceeds its declared response-byte budget.');
    const text = await readBoundedResponseText(
      response,
      manifest.permissions.maxResponseBytes!,
      signal,
      reason => controller.abort(reason),
    );
    return { response, text };
  } finally {
    const pendingClose = closeNetwork().catch(() => undefined);
    if (signal.aborted) void pendingClose;
    else await waitForAbortable(pendingClose, signal, 'Extension connection cleanup was aborted.')
      .catch(() => undefined);
    clearTimeout(timer);
  }
}

function parseJsonObject(text: string, label: string): Record<string, any> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || '{}'); } catch { throw new Error(`${label} returned invalid JSON.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must return a JSON object.`);
  return parsed as Record<string, any>;
}

async function runWithConcurrency<T>(revision: ExtensionRevision, operation: () => Promise<T>): Promise<T> {
  const release = acquireConcurrency(revision);
  try { return await operation(); } finally { release(); }
}

function acquireConcurrency(revision: ExtensionRevision): () => void {
  const key = revision.id;
  const current = executionCounts.get(key) || 0;
  const limit = revision.manifest.permissions.maxConcurrency!;
  if (current >= limit) throw new Error(`Extension ${revision.extensionId} concurrency budget is exhausted.`);
  executionCounts.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (executionCounts.get(key) || 1) - 1);
    if (remaining) executionCounts.set(key, remaining);
    else executionCounts.delete(key);
  };
}

function invalidateRevisionRuntime(revision: ExtensionRevision): void {
  activeRuntime.delete(revision.extensionId);
  providerClients.delete(revision.extensionId);
  const registries = new Set<ToolRegistry>();
  for (const owner of registeredTools.values()) {
    if (owner.extensionId === revision.extensionId && owner.revisionId === revision.id) {
      registries.add(owner.registry);
    }
  }
  for (const registry of registries) unregisterExtensionTools(registry, revision.extensionId);
}

function assertCurrentExecutableRevision(revision: ExtensionRevision): void {
  try {
    verifyPersistedRevision(revision);
    if (
      revision.status !== 'active'
      || activeRuntime.get(revision.extensionId)?.id !== revision.id
    ) {
      throw new Error('Signed extension revision is not the current active runtime.');
    }
  } catch (error) {
    invalidateRevisionRuntime(revision);
    throw error;
  }
}

async function invokeExtensionTool(
  revision: ExtensionRevision,
  tool: ExtensionToolManifest,
  args: Record<string, any>,
  context?: ToolContext,
): Promise<string> {
  if ((context?.userId || 'anonymous') !== revision.userId) throw new Error('Extension tool is not authorized for this user.');
  assertCurrentExecutableRevision(revision);
  return runWithConcurrency(revision, async () => {
    const url = endpointUrl(revision.manifest, tool.endpointPath);
    const request = {
      extensionId: revision.extensionId,
      revisionId: revision.id,
      tool: tool.name,
      arguments: args,
      context: {
        taskId: context?.taskId || '',
        requestId: context?.requestId || '',
        idempotencyKey: context?.idempotencyKey || '',
        domain: context?.domain || 'personal',
        orgId: context?.orgId || '',
      },
    };
    const { response, text } = await boundedFetch(revision.manifest, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(revision.manifest) },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Extension tool ${tool.name} failed with HTTP ${response.status}.`);
    const upstream = parseJsonObject(text, `Extension tool ${tool.name}`);
    const providerClaimedVerified = upstream.verified === true && upstream.verificationStatus === 'verified';
    return JSON.stringify({
      ...upstream,
      ok: upstream.ok === true,
      verified: false,
      verificationStatus: 'unverified',
      providerClaimedVerified,
      status: upstream.status || (upstream.ok === true ? 'provider_reported' : 'unknown'),
      extensionId: revision.extensionId,
      extensionVersion: revision.version,
      revisionId: revision.id,
      manifestDigest: revision.manifestDigest,
      signerFingerprint: revision.signerFingerprint,
      endpointOrigin: url.origin,
    });
  });
}

async function reconcileExtensionTool(
  revision: ExtensionRevision,
  tool: ExtensionToolManifest,
  args: Record<string, any>,
  context: ToolContext | undefined,
  idempotencyKey: string,
): Promise<string | null> {
  if (!tool.reconcilePath || (context?.userId || 'anonymous') !== revision.userId) return null;
  assertCurrentExecutableRevision(revision);
  return runWithConcurrency(revision, async () => {
    const url = endpointUrl(revision.manifest, tool.reconcilePath!);
    const { response, text } = await boundedFetch(revision.manifest, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(revision.manifest) },
      body: JSON.stringify({ idempotencyKey, inputDigest: digest(args), extensionId: revision.extensionId, tool: tool.name }),
    });
    if (!response.ok) return null;
    const upstream = parseJsonObject(text, `Extension reconciliation ${tool.name}`);
    if (upstream.verified !== true || upstream.verificationStatus !== 'verified') return null;
    return JSON.stringify({
      ...upstream,
      ok: upstream.ok === true,
      verified: false,
      verificationStatus: 'unverified',
      providerClaimedVerified: true,
      reconciled: true,
      extensionId: revision.extensionId,
      revisionId: revision.id,
      manifestDigest: revision.manifestDigest,
    });
  });
}

function buildToolDefinition(revision: ExtensionRevision, tool: ExtensionToolManifest): ToolDefinition {
  const hostSideEffects = tool.capability.sideEffects.some(effect => (
    effect.type === 'external_communication' || effect.type === 'external_state_change'
  ))
    ? tool.capability.sideEffects
    : [
      ...tool.capability.sideEffects,
      {
        type: 'external_communication' as const,
        scope: `user-reviewed signed extension ${revision.extensionId}`,
        reversible: false,
      },
    ];
  return {
    name: tool.name,
    description: `${tool.description} Signed extension ${revision.extensionId}@${revision.version}; execution is restricted to its exact origin, credential references, timeout, byte, and concurrency budgets.`,
    parameters: tool.parameters,
    permission: tool.permission,
    // A third-party signature authenticates bytes and publisher identity; it
    // cannot prove that a POST endpoint declared as "observe" is read-only.
    // Host policy therefore imposes a confirmation/external-commit floor. A
    // manifest may tighten this to forbidden, but can never relax it to safe.
    securityLevel: tool.securityLevel === 'forbidden' ? 'forbidden' : 'confirm',
    routingHints: tool.routingHints,
    capability: {
      ...tool.capability,
      risk: tool.capability.risk === 'critical' ? 'critical' : 'high',
      sideEffects: hostSideEffects,
      source: 'adapter',
      provider: revision.extensionId,
      provenance: { kind: 'adapter', provider: revision.extensionId, trust: 'user-reviewed' },
      prerequisites: [
        `active signed revision ${revision.id}`,
        `manifest digest ${revision.manifestDigest}`,
      ],
    },
    evidence: {
      capability: tool.capability.id,
      operation: tool.capability.operation,
      assurance: 'declared',
      limitations: [
        `Evidence is bound to signed extension revision ${revision.id}.`,
        'The extension provider cannot independently verify its own business outcome; host-owned corroboration is required.',
        ...(tool.capability.verification.limitations || []),
      ],
    },
    handler: (args, context) => invokeExtensionTool(revision, tool, args, context),
    ...(tool.reconcilePath ? {
      reconcileExternalCommit: (args: Record<string, any>, context: ToolContext | undefined, idempotencyKey: string) => (
        reconcileExtensionTool(revision, tool, args, context, idempotencyKey)
      ),
    } : {}),
  };
}

function buildDefinitions(revision: ExtensionRevision): ToolDefinition[] {
  return (revision.manifest.tools || []).map(tool => buildToolDefinition(revision, tool));
}

function extensionRuntimeState(
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

function runtimeRevision(extensionId: string): ExtensionRevision | null {
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

function assertRevisionOwner(revision: ExtensionRevision, userId?: string): void {
  if (revision.userId !== (userId || 'anonymous')) throw new Error('Extension is not available in this user scope.');
}

export function isExtensionProviderId(value: unknown): value is string {
  return typeof value === 'string' && EXTENSION_ID_RE.test(value);
}

export function isRegisteredOpenAICompatibleProvider(providerId: unknown, userId?: string): boolean {
  if (!isExtensionProviderId(providerId)) return false;
  const revision = runtimeRevision(providerId);
  return Boolean(revision?.manifest.provider && (!userId || revision.userId === userId));
}

export function getRegisteredProviderDefaultModel(providerId: string, userId?: string): string {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider || (userId && revision.userId !== userId)) return '';
  return revision.manifest.provider.defaultModel;
}

export function getRegisteredProviderManifest(providerId: string, userId?: string): OpenAICompatibleProviderManifest | null {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider || (userId && revision.userId !== userId)) return null;
  return structuredClone(revision.manifest.provider);
}

export function isRegisteredProviderLocal(providerId: string, userId?: string): boolean {
  return getRegisteredProviderManifest(providerId, userId)?.local === true;
}

export function assertRegisteredProviderModel(
  providerId: string,
  modelId: string,
  options: { userId?: string; needsVision?: boolean; needsTools?: boolean; needsJson?: boolean; needsStreaming?: boolean } = {},
): ExtensionProviderModel {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider) throw new Error(`Extension provider ${providerId} is not active.`);
  assertRevisionOwner(revision, options.userId);
  const model = revision.manifest.provider.models.find(item => item.id === modelId);
  if (!model) throw new Error(`Model ${modelId} is not declared by signed provider ${providerId}.`);
  if (options.needsVision && model.capabilities.vision !== true) throw new Error(`Model ${modelId} does not declare vision capability.`);
  if (options.needsTools && model.capabilities.tools !== true) throw new Error(`Model ${modelId} does not declare tool-calling capability.`);
  if (options.needsJson && model.capabilities.json !== true) throw new Error(`Model ${modelId} does not declare JSON response capability.`);
  if (options.needsStreaming && model.capabilities.streaming !== true) throw new Error(`Model ${modelId} does not declare streaming capability.`);
  return structuredClone(model);
}

function providerClientFetch(revision: ExtensionRevision): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const release = acquireConcurrency(revision);
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), revision.manifest.permissions.timeoutMs!);
    let finished = false;
    let closeNetwork = async () => undefined;
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      release();
      await closeNetwork().catch(() => undefined);
    };
    const callerSignal = init?.signal || request?.signal;
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    try {
      await assertResolvedDestinationAllowed(url, revision.manifest);
      const body = init?.body;
      let bodyBytes = 0;
      if (typeof body === 'string') bodyBytes = Buffer.byteLength(body, 'utf8');
      else if (body instanceof URLSearchParams) bodyBytes = Buffer.byteLength(body.toString(), 'utf8');
      else if (body instanceof ArrayBuffer) bodyBytes = body.byteLength;
      else if (ArrayBuffer.isView(body)) bodyBytes = body.byteLength;
      else if (request?.body && !['GET', 'HEAD'].includes(request.method.toUpperCase())) {
        const declaredLength = Number(request.headers.get('content-length') || 0);
        if (!declaredLength) throw new Error('Provider streaming request bodies are not allowed by the extension sandbox.');
        bodyBytes = declaredLength;
      }
      if (bodyBytes > revision.manifest.permissions.maxRequestBytes!) {
        throw new Error('Provider request exceeds its signed request-byte budget.');
      }
      const secured = await extensionNetworkFetch(
        revision.manifest,
        input,
        { ...init, signal, redirect: 'error' },
      );
      closeNetwork = secured.close;
      const response = secured.response;
      const length = Number(response.headers.get('content-length') || 0);
      if (length > revision.manifest.permissions.maxResponseBytes!) throw new Error('Provider response exceeds its signed response-byte budget.');
      if (!response.body) {
        await finish();
        return response;
      }
      const reader = response.body.getReader();
      let responseBytes = 0;
      const bodyStream = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              await finish();
              streamController.close();
              return;
            }
            responseBytes += chunk.value.byteLength;
            if (responseBytes > revision.manifest.permissions.maxResponseBytes!) {
              controller.abort();
              await reader.cancel('response byte budget exceeded');
              await finish();
              streamController.error(new Error('Provider response exceeded its signed response-byte budget.'));
              return;
            }
            streamController.enqueue(chunk.value);
          } catch (error) {
            await finish();
            streamController.error(error);
          }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); } finally { await finish(); }
        },
      });
      return new Response(bodyStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      await finish();
      throw error;
    }
  }) as typeof fetch;
}

export function getRegisteredOpenAIClient(providerId: string, userId?: string): OpenAI | null {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider) return null;
  assertRevisionOwner(revision, userId);
  const provider = revision.manifest.provider;
  const credential = provider.auth.type === 'bearer' ? credentialValue(provider.auth.credentialRef!) : 'no-auth';
  if (provider.auth.type === 'bearer' && !credential) throw new Error(`Required credentialRef ${provider.auth.credentialRef} is not configured.`);
  const signature = digest([revision.id, provider.baseUrl, provider.auth.credentialRef || '', credential || '']);
  const cached = providerClients.get(providerId);
  if (cached?.signature === signature) return cached.client;
  const client = new OpenAI({
    apiKey: credential || 'no-auth',
    baseURL: provider.baseUrl,
    timeout: revision.manifest.permissions.timeoutMs,
    maxRetries: 0,
    fetch: providerClientFetch(revision),
  });
  providerClients.set(providerId, { signature, client });
  return client;
}

export function listRegisteredProviders(userId?: string): Array<Record<string, unknown>> {
  try {
    const store = arrays();
    return store.revisions
      .filter(item => item.status === 'active' && item.manifest.provider && (!userId || item.userId === userId))
      .filter(item => {
        try {
          verifyPersistedRevision(item, store);
          return true;
        } catch {
          invalidateRevisionRuntime(item);
          return false;
        }
      })
      .map(item => ({
        id: item.extensionId,
        version: item.version,
        userId: item.userId,
        local: item.manifest.provider!.local === true,
        defaultModel: item.manifest.provider!.defaultModel,
        models: item.manifest.provider!.models.map(model => ({ ...model })),
        configured: item.manifest.provider!.auth.type === 'none' || Boolean(credentialValue(item.manifest.provider!.auth.credentialRef!)),
        manifestDigest: item.manifestDigest,
        signerFingerprint: item.signerFingerprint,
        compatibility: item.compatibility,
      }));
  } catch {
    return [];
  }
}

async function compatibilityProbe(manifest: LumiExtensionManifest): Promise<ExtensionCompatibilityReceipt> {
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

function ensurePublisherTrust(
  manifest: LumiExtensionManifest,
  fingerprint: string,
  userId: string,
  trustPublisher: boolean,
): void {
  const store = arrays();
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

function receipt(
  revision: ExtensionRevision,
  status: string,
  previousRevisionId: string,
  error?: string,
): ExtensionActivationReceipt {
  return {
    id: `extension_receipt_${crypto.randomUUID()}`,
    extensionId: revision.extensionId,
    revisionId: revision.id,
    userId: revision.userId,
    status,
    manifestDigest: revision.manifestDigest,
    signerFingerprint: revision.signerFingerprint,
    previousRevisionId,
    toolNames: [...revision.toolNames],
    providerId: revision.manifest.provider?.id || '',
    compatibility: revision.compatibility,
    ...(error ? { error } : {}),
    createdAt: nowIso(),
  };
}

function pushReceipt(store: ExtensionArrays, value: ExtensionActivationReceipt): void {
  store.receipts.push(value);
  if (store.receipts.length > 1_000) store.receipts.splice(0, store.receipts.length - 1_000);
}

async function persistStrict(): Promise<void> {
  if (runtimeOverrides?.persist) return runtimeOverrides.persist();
  return flushDBOrThrow();
}

function registerRevisionTools(registry: ToolRegistry, revision: ExtensionRevision): void {
  verifyPersistedRevision(revision);
  const definitions = buildDefinitions(revision);
  const registered: string[] = [];
  try {
    for (const definition of definitions) {
      const owner = registeredTools.get(definition.name);
      if (registry.get(definition.name) && owner?.extensionId !== revision.extensionId) {
        throw new Error(`Tool name collision: ${definition.name} is already owned by another capability.`);
      }
      if (registry.get(definition.name)) registry.unregister(definition.name);
      if (!registry.register(definition)) throw new Error(`Tool registration failed for ${definition.name}.`);
      registered.push(definition.name);
      registeredTools.set(definition.name, {
        extensionId: revision.extensionId,
        revisionId: revision.id,
        userId: revision.userId,
        registry,
      });
    }
  } catch (error) {
    for (const name of registered) {
      registry.unregister(name);
      registeredTools.delete(name);
    }
    throw error;
  }
}

function unregisterExtensionTools(registry: ToolRegistry, extensionId: string): string[] {
  const removed: string[] = [];
  for (const [name, owner] of [...registeredTools.entries()]) {
    if (owner.extensionId !== extensionId || owner.registry !== registry) continue;
    registry.unregister(name);
    registeredTools.delete(name);
    removed.push(name);
  }
  return removed;
}

async function withActivationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = activationLock;
  let release!: () => void;
  activationLock = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

function publicRevision(revision: ExtensionRevision, registry?: ToolRegistry): Record<string, unknown> {
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
    const db = readDB();
    const store = arrays(db);
    const ownerConflict = store.revisions.find(item => item.extensionId === manifest.id && item.userId !== userId);
    if (ownerConflict) throw new Error('Extension id is already owned by a different local user.');
    const signerConflict = store.revisions.find(item => item.extensionId === manifest.id && item.signerFingerprint !== fingerprint);
    if (signerConflict) throw new Error('Extension signer does not match the immutable publisher key bound to this extension id.');
    const sameVersion = store.revisions.find(item => item.extensionId === manifest.id && item.version === manifest.version);
    if (sameVersion && sameVersion.manifestDigest !== manifestDigest) {
      throw new Error('Extension version is immutable and already exists with a different manifest digest.');
    }
    ensurePublisherTrust(manifest, fingerprint, userId, input.trustPublisher === true);
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
    writeDB(db);

    const compatibility = await compatibilityProbe(manifest);
    revision.compatibility = compatibility;
    if (!compatibility.ok) {
      revision.status = 'failed';
      revision.error = compatibility.error;
      revision.updatedAt = nowIso();
      const failedReceipt = receipt(revision, 'compatibility_failed', '', compatibility.error);
      pushReceipt(store, failedReceipt);
      writeDB(db);
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
    const oldDefinitions = oldActive ? buildDefinitions(oldActive) : [];
    const oldRuntime = activeRuntime.get(manifest.id);
    const arraySnapshot = {
      publishers: structuredClone(store.publishers),
      revisions: structuredClone(store.revisions),
      receipts: structuredClone(store.receipts),
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
      writeDB(db);
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
      for (const definition of oldDefinitions) {
        if (targetRegistry.register(definition)) registeredTools.set(definition.name, {
          extensionId: manifest.id,
          revisionId: oldActive!.id,
          userId: oldActive!.userId,
          registry: targetRegistry,
        });
      }
      db.extensionPublishers = arraySnapshot.publishers;
      db.extensionRevisions = arraySnapshot.revisions;
      db.extensionActivationReceipts = arraySnapshot.receipts;
      if (oldRuntime) activeRuntime.set(manifest.id, oldRuntime);
      else activeRuntime.delete(manifest.id);
      providerClients.delete(manifest.id);
      const restored = arrays(db);
      const failed = restored.revisions.find(item => item.id === revision.id) || revision;
      failed.status = 'failed';
      failed.error = cleanError(error);
      failed.updatedAt = nowIso();
      const rollbackReceipt = receipt(failed, 'rolled_back', oldActive?.id || '', failed.error);
      pushReceipt(restored, rollbackReceipt);
      writeDB(db);
      try { await persistStrict(); } catch {}
      return JSON.stringify({
        ok: false,
        verified: true,
        verificationStatus: 'verified',
        status: 'rolled_back',
        rollback: oldActive ? 'previous_revision_restored' : 'new_revision_removed_from_runtime',
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
    const db = readDB();
    const store = arrays(db);
    const candidates = store.revisions.filter(item => item.extensionId === input.extensionId && item.userId === userId && item.status !== 'active');
    const target = input.version
      ? candidates.find(item => item.version === input.version)
      : [...candidates].sort((a, b) => Date.parse(b.activatedAt || b.createdAt) - Date.parse(a.activatedAt || a.createdAt))[0];
    if (!target) throw new Error('No prior extension revision is available for rollback.');
    verifyPersistedRevision(target, store);
    const compatibility = await compatibilityProbe(target.manifest);
    target.compatibility = compatibility;
    if (!compatibility.ok) {
      const failedReceipt = receipt(target, 'rollback_compatibility_failed', '', compatibility.error);
      pushReceipt(store, failedReceipt);
      writeDB(db);
      await persistStrict();
      return JSON.stringify({ ok: false, verified: true, status: 'rollback_compatibility_failed', receipt: failedReceipt }, null, 2);
    }
    const current = store.revisions.find(item => item.extensionId === input.extensionId && item.status === 'active');
    if (current) verifyPersistedRevision(current, store);
    const currentDefinitions = current ? buildDefinitions(current) : [];
    const currentSnapshot = current ? structuredClone(current) : null;
    const targetSnapshot = structuredClone(target);
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
      writeDB(db);
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
      writeDB(db);
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
    const db = readDB();
    const store = arrays(db);
    const revision = store.revisions.find(item => item.extensionId === extensionId && item.status === 'active' && item.userId === (context?.userId || 'anonymous'));
    if (!revision) throw new Error('Active extension was not found in this user scope.');
    verifyPersistedRevision(revision, store);
    const revisionSnapshot = structuredClone(revision);
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
      writeDB(db);
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
      writeDB(db);
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

export async function hydrateActiveExtensions(registry: ToolRegistry): Promise<{ activated: number; failed: number; errors: string[] }> {
  const store = arrays();
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
    writeDB(readDB());
    await persistStrict().catch(() => undefined);
  }
  return { activated, failed, errors };
}

export function configureExtensionRuntimeForTests(overrides: ExtensionRuntimeOverrides | null): void {
  runtimeOverrides = overrides;
  providerClients.clear();
}

export function resetExtensionRegistryForTests(options: { clearPersisted?: boolean } = {}): void {
  for (const [name, owner] of [...registeredTools.entries()]) {
    owner.registry.unregister(name);
    registeredTools.delete(name);
  }
  activeRuntime.clear();
  providerClients.clear();
  executionCounts.clear();
  activationLock = Promise.resolve();
  runtimeOverrides = null;
  if (options.clearPersisted) {
    const db = readDB();
    db.extensionPublishers = [];
    db.extensionRevisions = [];
    db.extensionActivationReceipts = [];
    writeDB(db);
  }
}
