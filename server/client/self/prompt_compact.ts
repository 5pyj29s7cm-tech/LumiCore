import { PERSONAL_CLIENT_SURFACES } from '../../../shared/client_surfaces';
import { formatComputerCapabilityProfileForPrompt } from "../desktop_awareness";
import { sanitizeDiagnosticValue } from "../diagnostic_sanitizer";
import { getClientStateForScope } from './state';
import { getSelfModelSnapshot } from './snapshot';
import { formatWallpaperState, formatActiveWallpaperBoundary, formatClientProductState } from './prompt_context';

/**
 * Voice turns need the live client facts, not the complete diagnostic manual.
 * The full prompt below contains every surface, adapter and governance rule and
 * can add tens of thousands of tokens when it is repeated in a tool loop.
 * Keep this compact view factual and sufficient for routing/verification while
 * leaving the full diagnostic prompt available to explicit self-audit flows.
 */
export function formatCompactClientSelfPrompt(
  userId: string,
  scope: { domain?: 'personal' | 'work'; orgId?: string; socketId?: string } = { domain: 'personal', orgId: '' },
): string {
  const isWork = scope.domain === 'work' && Boolean(scope.orgId);
  const scoped = { domain: isWork ? 'work' as const : 'personal' as const, orgId: isWork ? scope.orgId : '', socketId: scope.socketId };
  const state = sanitizeDiagnosticValue(getClientStateForScope(userId, scoped));
  const snapshot = sanitizeDiagnosticValue(getSelfModelSnapshot(userId, scoped));
  const configuredModels = snapshot.configuredModels
    .filter(model => model.configured)
    .map(model => `${model.role}=${model.effectiveProvider || model.provider}/${model.effectiveModel || model.model}`)
    .slice(0, 8);

  return [
    '## Current Lumi Client Facts (compact)',
    formatClientProductState(state),
    `- Scope: ${snapshot.scope.domain}${snapshot.scope.orgId ? `/${snapshot.scope.orgId}` : ''}`,
    `- Fact digest: ${snapshot.factDigest}`,
    `- Runtime awareness: ${snapshot.runtime.awareness}; health=${snapshot.runtime.health}; stateAgeSeconds=${snapshot.runtime.stateAgeSeconds ?? 'unknown'}`,
    state
      ? `- UI: mode=${state.mode || 'unknown'}; activeTab=${state.activeTab || 'unknown'}; viewMode=${state.viewMode || 'personal'}; workDomain=${state.workDomain || 'personal'}; settings=${state.settings?.activeSection || 'none'}`
      : '- UI: no live desktop state is currently available.',
    '- Lumi is a single personal core with no selectable operation modes. Meeting is a temporary capture surface.',
    `- Command Center interface definition (not a live visibility claim). When the user identifies a screenshot as Lumi Command Center, use these registered destinations and purposes; a vision caption's guesses about unlabeled icon shapes do not rename them. The small castle icon can resemble a calendar: ${PERSONAL_CLIENT_SURFACES.find(surface => surface.id === 'command-center')?.useWhen}`,
    state
      ? `- Surfaces: wallpaper=${formatWallpaperState(state)}; widget=${Boolean(state.surfaces?.widgetMode)}; meeting=${Boolean(state.surfaces?.meetingOpen || state.meeting?.active)}; nexus=${Boolean(state.surfaces?.nexusOpen || state.viewMode === 'world')}; focused=${state.windows?.focused || 'none'}`
      : '',
    formatActiveWallpaperBoundary(state, isWork),
    `- Self-health observations: ${snapshot.health.checks.map(check => `${check.id}=${check.level}`).join('; ')}` ,
    `- Self-health findings: ${snapshot.health.findings.filter(finding => finding.level !== 'unknown').map(finding => `${finding.id}: ${finding.message}${finding.evidence ? ` (${finding.evidence})` : ''}`).join('; ') || 'none reported'}` ,
    '- Use client_health_check for the full current report and source times. Unknown or stale observations are not healthy evidence; retained task failures are historical unless still blocked. Do not infer global health from configured models or registered tool counts.',
    `- Connected capabilities: tools=${snapshot.connectedCapabilities.tools}; skills=${snapshot.connectedCapabilities.skills}; mcp=${snapshot.connectedCapabilities.mcp}; adaptersReady=${snapshot.connectedCapabilities.adaptersReady}; adaptersAttention=${snapshot.connectedCapabilities.adaptersAttention}`,
    configuredModels.length ? `- Configured models: ${configuredModels.join('; ')}` : '- Configured models: none reported.',
    snapshot.knowledgeCoverage.verification === 'unknown'
      ? '- Knowledge: no fresh inventory observation; counts and retrieval coverage are unknown.'
      : `- Knowledge: total=${snapshot.knowledgeCoverage.totalFiles}; indexed=${snapshot.knowledgeCoverage.indexedFiles}; verified=${snapshot.knowledgeCoverage.verifiedFiles}; status=${snapshot.knowledgeCoverage.verification}`,
    isWork
      ? '- Personalized host-computer exploration is not organization context.'
      : formatComputerCapabilityProfileForPrompt(userId),
    snapshot.runtime.refreshRequired && snapshot.runtime.refreshAction
      ? `- Refresh required before present-tense client claims: ${snapshot.runtime.refreshAction}.`
      : '- Current client facts may be used for this turn; refresh after an action before claiming the new state.',
    '- For a Lumi UI change, use client_get_state when needed, call client_action, and trust only its verification status. Preserve failures and retries in the receipt chain.',
    '- A routed turn manifest is not the global capability inventory. Use client_capability_manifest for an explicit inventory request.',
  ].filter(Boolean).join('\n');
}
