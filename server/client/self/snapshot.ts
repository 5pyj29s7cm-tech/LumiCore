import crypto from "node:crypto";
import { getAdapterRegistry } from "../../adapters/registry";
import { toolRegistry } from "../../tools/registry";
import { getLumiModelConfiguration, LUMI_MODEL_ROLES } from "../../llm/model_configuration";
import { DESKTOP_APPLICATION_REGISTRY } from "../../desktop/execution_plan";
import { listRegisteredProviders } from "../../extensions/registry";
import type { SelfModelSnapshot } from './contracts';
import { getClientStateForScope } from './state';
import { getClientSelfAwarenessReport, getClientHealthReport } from './health';

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getSelfModelSnapshot(
  userId: string,
  scope: { domain?: 'personal' | 'work'; orgId?: string; socketId?: string } = {},
): SelfModelSnapshot {
  const domain = scope.domain === 'work' && scope.orgId ? 'work' : 'personal';
  const state = getClientStateForScope(userId, { domain, orgId: domain === 'work' ? scope.orgId : '', socketId: scope.socketId });
  const modelConfiguration = getLumiModelConfiguration(userId) as {
    roles?: Record<string, Record<string, unknown>>;
  };
  const health = getClientHealthReport(userId, { domain, orgId: scope.orgId, socketId: scope.socketId }, modelConfiguration.roles);
  const awareness = getClientSelfAwarenessReport(userId, { domain, orgId: scope.orgId, socketId: scope.socketId }, health);
  const models = LUMI_MODEL_ROLES.map(role => {
    const configuration = modelConfiguration.roles?.[role] || {};
    return {
      role,
      provider: stringValue(configuration.provider),
      model: stringValue(configuration.model),
      configured: configuration.configured === true,
      ...(stringValue(configuration.effectiveProvider)
        ? { effectiveProvider: stringValue(configuration.effectiveProvider) }
        : {}),
      ...(stringValue(configuration.effectiveModel)
        ? { effectiveModel: stringValue(configuration.effectiveModel) }
        : {}),
    };
  });
  const manifest = toolRegistry.getCapabilityManifest(undefined, {
    context: { userId, domain, orgId: domain === 'work' ? scope.orgId : '' },
  });
  const extensionProviders = listRegisteredProviders(userId);
  const adapters = getAdapterRegistry({
    userId,
    clientState: state as Record<string, any> | null,
    capabilityManifest: manifest,
  });
  const knowledge = state?.knowledge || {};
  const totalFiles = Number(knowledge.totalFiles || 0);
  const indexedFiles = Number(knowledge.indexedFiles || 0);
  const verifiedFiles = Number(knowledge.verifiedFiles || 0);
  const indexedUnverifiedFiles = Number(knowledge.indexedUnverifiedFiles || Math.max(0, indexedFiles - verifiedFiles));
  const partialFiles = Number(knowledge.partialFiles || 0);
  const pendingFiles = Number(knowledge.pendingFiles || 0);
  const staleFiles = Number(knowledge.staleFiles || 0);
  const failedFiles = Number(knowledge.failedFiles || 0);
  const unsupportedFiles = Number(knowledge.unsupportedFiles || 0);
  const verification = health.checks.find(check => check.id === 'knowledge.observation')?.level === 'unknown'
    ? 'unknown'
    : failedFiles > 0 || unsupportedFiles > 0
    ? 'failed'
    : staleFiles > 0
      ? 'stale'
      : partialFiles > 0 || pendingFiles > 0 || indexedFiles < totalFiles
      ? 'partial'
      : totalFiles > 0 && verifiedFiles === totalFiles
        ? 'verified'
        : totalFiles > 0
        ? 'indexed_unverified'
        : 'empty';
  const snapshotCore: Omit<SelfModelSnapshot, 'factDigest' | 'generatedAt'> = {
    schemaVersion: 1,
    identity: {
      name: 'Lumi',
      product: 'LumiCore',
      deployment: 'private_user_directed_agent',
      continuity: 'single_identity_across_surfaces',
    },
    scope: { domain, orgId: domain === 'work' ? String(scope.orgId || '') : '' },
    modes: [], // No selectable operation modes; capture status lives in meeting/voice.
    health,
    configuredModels: models,
    connectedCapabilities: {
      tools: manifest.length,
      skills: manifest.filter(entry => entry.source === 'skill' && entry.executable).length,
      mcp: manifest.filter(entry => entry.source === 'mcp' && entry.executable).length,
      extensionProviders: extensionProviders.length,
      adaptersReady: adapters.adapters.filter(adapter => adapter.status === 'ready' || adapter.status === 'available').length,
      adaptersAttention: adapters.adapters.filter(adapter => ['attention', 'degraded', 'blocked', 'requires_setup'].includes(adapter.status)).length,
    },
    desktopCapabilities: DESKTOP_APPLICATION_REGISTRY.map(application => ({
      id: application.id,
      displayName: application.displayName,
      supportTier: application.certification,
      certification: application.id === 'lumi-client' && awareness.level === 'live'
        ? 'client_state_live'
        : 'runtime_preflight_required',
      // A registry entry is a policy, not proof that the installed binary was
      // observed. The exact version is populated only by an action receipt.
      certifiedVersion: null,
      requiredIdentitySignals: [...application.certificationPolicy.requiredSignals],
      controlLayers: [...application.controlLayers],
    })),
    knowledgeCoverage: {
      totalFiles,
      indexedFiles,
      verifiedFiles,
      indexedUnverifiedFiles,
      partialFiles,
      pendingFiles,
      staleFiles,
      failedFiles,
      unsupportedFiles,
      verification,
      verifiedAbsorption: verification === 'verified',
    },
    memoryState: {
      available: manifest.some(entry => entry.lane === 'memory'),
      scope: domain === 'work' ? 'organization' : 'personal',
      absorptionClaim: 'retrieval_and_evidence_required',
    },
    runtime: {
      awareness: awareness.level,
      health: health.level,
      stateAgeSeconds: health.stateAgeSeconds,
      sourceUpdatedAt: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null,
      refreshRequired: awareness.level !== 'live',
      refreshAction: awareness.level === 'live' ? null : 'client_self_repair(refresh_client_state)',
    },
    permissions: {
      externalCommitConfirmation: 'required',
      localActions: 'policy_controlled',
      dataBoundary: 'source_and_scope_isolated',
    },
    limitations: [
      'Desktop certification applies only to registered application identities and tested versions; unknown applications use safe fallback control.',
      'Indexed knowledge is not called absorbed until extraction, embedding, retrieval, citation, and evaluation evidence pass.',
      'Models and tools are selected dynamically only inside privacy, permission, confirmation, budget, and receipt policies.',
      'Third-party extensions are limited to signed declarative OpenAI-compatible providers and sandboxed HTTP tools; Lumi does not load arbitrary extension code.',
      ...(awareness.level === 'live' ? [] : ['Live client state is unavailable or stale, so present-moment desktop claims require refresh.']),
    ],
  };
  // `stateAgeSeconds` is derived from wall-clock time rather than a changed
  // client fact. Excluding that ticking value keeps the same observed client
  // snapshot addressable across adjacent verbal/visible renderings while
  // `sourceUpdatedAt`, awareness, and health still invalidate the digest when
  // the underlying state or its freshness classification actually changes.
  const digestCore = {
    ...snapshotCore,
    health: {
      ...health, observedAt: null, stateAgeSeconds: null,
      checks: health.checks.map(({ observedAt: _at, ...check }) => check),
      findings: health.findings.map(({ observedAt: _at, ...finding }) => finding),
    },
    runtime: {
      ...snapshotCore.runtime,
      stateAgeSeconds: null,
    },
  };
  const factDigest = crypto.createHash('sha256').update(JSON.stringify(digestCore)).digest('hex');
  return { ...snapshotCore, factDigest, generatedAt: new Date().toISOString() };
}
