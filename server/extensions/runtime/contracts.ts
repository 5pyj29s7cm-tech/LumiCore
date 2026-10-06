import type { CapabilityLane, CapabilityMode, CapabilityOperation, CapabilityRisk, CapabilitySideEffect, CapabilityVerification, SecurityLevel, ToolPermission } from "../../tools/types";

export const LUMI_EXTENSION_API_VERSION = 1;

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

export interface ExtensionPublisher {
  fingerprint: string;
  publisherId: string;
  publicKey: string;
  status: 'trusted' | 'revoked';
  trustedBy: string | string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionActivationReceipt {
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

export interface ExtensionArrays {
  publishers: ExtensionPublisher[];
  revisions: ExtensionRevision[];
  receipts: ExtensionActivationReceipt[];
}

export interface ExtensionRuntimeOverrides {
  fetch?: typeof fetch;
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  persist?: () => Promise<void>;
}
