import { getToolRuntimeMetrics } from '../../runtime/tool_metrics';
import { getAdapterResilienceSnapshot } from '../../tools/adapter_resilience';
import { getDatabasePersistenceStatus } from '../../../db_layer';
import { runtimeFaults } from '../../runtime/fault_state';
import { scheduler } from '../../scheduler';
import { getUnifiedRuntimeSupervisorStatus } from '../../runtime/unified_supervisor';
import { getLumiModelConfiguration } from '../../llm/model_configuration';
import { createProviderAvailabilityReader } from '../../llm/provider_health';
import { getDurableTaskHealthSnapshot } from '../../cognition/durable_task_diagnostics';
import { mcpManager } from '../../mcp';
import { safeRuntimeError } from "../diagnostic_sanitizer";
import { CLIENT_SETTINGS_SECTIONS, PERSONAL_CLIENT_LAUNCHER_IDS, PERSONAL_CLIENT_SURFACES, PERSONAL_CLIENT_SURFACE_ACTIONS } from "../../../shared/client_surfaces";
import { LUMI_TECHNICAL_ARCHITECTURE } from "../../../shared/technical_architecture";
import type { ClientHealthReport, ClientHealthFinding, ClientHealthLevel, ClientSelfAwarenessReport } from './contracts';
import { getClientStateForScope, getClientStateDigest } from './state';

export function getBackendHealthReport() {
  const fault = runtimeFaults.snapshot();
  const persistence = getDatabasePersistenceStatus();
  const tasks = scheduler.listTasks();
  const schedulerHealth = {
    degraded: tasks.some(task => task.requiresReconciliation || (task.enabled && ['failed', 'timed_out', 'blocked'].includes(task.lastStatus))),
    pausedTasks: tasks.filter(task => task.requiresReconciliation).length,
    queuedTasks: tasks.filter(task => task.queued).length,
    failedTasks: tasks.filter(task => task.enabled && ['failed', 'timed_out', 'blocked'].includes(task.lastStatus)).length,
  };
  return { fault, persistence, scheduler: schedulerHealth,
    status: fault.degraded || persistence.degraded || schedulerHealth.degraded ? 'degraded' as const : 'ok' as const };
}

export function getClientHealthReport(
  userId: string,
  scope: { domain?: string; orgId?: string } = {},
  models: Record<string, Record<string, unknown>> = (getLumiModelConfiguration(userId) as { roles?: Record<string, Record<string, unknown>> }).roles || {},
): ClientHealthReport {
  const state = getClientStateForScope(userId, scope);
  const now = Date.now();
  const checks: ClientHealthFinding[] = [];
  const stateAgeSeconds = state?.updatedAt ? Math.round((now - state.updatedAt) / 1000) : null;

  const observedAt = new Date(now).toISOString();
  const add = (finding: ClientHealthFinding) => checks.push({ observedAt, ...finding, message: safeRuntimeError(finding.message) || finding.id, evidence: safeRuntimeError(finding.evidence) });
  const backend = getBackendHealthReport();
  add({ id: 'backend.process', area: 'backend', level: backend.fault.degraded ? 'degraded' : 'ok',
    message: backend.fault.degraded ? 'Backend stopped accepting work after a fatal runtime fault.' : 'Backend process is accepting work.',
    evidence: backend.fault.kind, observedAt: backend.fault.occurredAt || observedAt });
  add({ id: 'database.persistence', area: 'database', level: backend.persistence.degraded ? 'degraded' : 'ok',
    message: backend.persistence.degraded ? 'Database persistence has failed or fallen behind.' : 'Database persistence reports no current fault.',
    evidence: safeRuntimeError(backend.persistence.lastError) || `pending=${backend.persistence.pending}; lagMs=${backend.persistence.lagMs}` });
  add({ id: 'scheduler.runtime', area: 'scheduler', level: backend.scheduler.degraded ? 'degraded' : 'ok',
    message: 'Scheduled task runtime snapshot.', evidence: JSON.stringify(backend.scheduler) });
  const supervisor = getUnifiedRuntimeSupervisorStatus();
  add({ id: 'supervisor.runtime', area: 'supervisor', level: supervisor.running ? 'ok' : 'unknown',
    message: supervisor.running ? 'Runtime supervision is running.' : 'No running runtime supervisor is observed.' });
  for (const job of supervisor.jobs.filter(job => ['failed', 'timeout'].includes(job.outcome))) {
    add({ id: `supervisor.${job.id}`, area: 'supervisor', level: 'degraded',
      message: `Runtime supervisor job ${job.id}: ${job.outcome}.`, evidence: safeRuntimeError(job.lastError), observedAt: job.lastCompletedAt });
  }
  const availability = createProviderAvailabilityReader();
  for (const [role, model] of Object.entries(models)) {
    if (model.enabled === false) continue;
    const provider = String(model.effectiveProvider || model.provider || '');
    const modelName = String(model.effectiveModel || model.model || '');
    const result = availability({ provider, model: modelName, configured: model.configured === true });
    add({ id: `model.${role}`, area: 'models',
      level: result.readiness === 'healthy' ? 'ok' : result.readiness === 'unhealthy' ? 'degraded' : 'unknown',
      message: `${role}: ${provider}/${modelName || 'provider-managed'}; ${result.readiness}.`,
      evidence: result.reason, observedAt: result.lastObservation?.observedAt || result.lastProbe?.testedAt });
  }
  const tasks = getDurableTaskHealthSnapshot(userId, scope);
  add({ id: 'tasks.runtime', area: 'tasks', level: !tasks.available ? 'unknown' : tasks.blocked || tasks.failed ? 'attention' : 'ok',
    message: 'Scoped autonomous, chat and creation task ledger snapshot.',
    evidence: `active=${tasks.active}; paused=${tasks.paused}; retryScheduled=${tasks.retryScheduled}; blocked=${tasks.blocked}; failed=${tasks.failed}; sources=${tasks.diagnostics.join(',') || 'available'}` });
  const toolHistory = getToolRuntimeMetrics().totals;
  add({ id: 'tools.execution_history', area: 'tools', level: 'ok', message: 'Process-lifetime tool outcome history; past failures do not prove a current fault.', evidence: JSON.stringify(toolHistory.outcomes) });
  add({ id: 'memory.retrieval_verification', area: 'memory', level: 'unknown', message: 'Memory retrieval correctness requires source evidence; registration and database persistence do not verify recall accuracy.' });
  const skills = getSkillRuntimeFindings();
  add({ id: 'skills.runtime', area: 'skills', level: skills.some(skill => skill.enabled) ? 'attention' : 'ok',
    message: 'Enabled skill and MCP runtime snapshot.', evidence: skills.filter(skill => skill.enabled).map(skill => `${skill.name}=${skill.status}${skill.lastError ? ':' + skill.lastError : ''}`).join('; ') });
  const adapterFamilies = Object.values(getAdapterResilienceSnapshot().families);
  add({ id: 'adapters.runtime', area: 'adapters', level: adapterFamilies.some(family => family.openCircuits || family.halfOpenCircuits) ? 'attention' : 'ok',
    message: 'External adapter circuit state.', evidence: `open=${adapterFamilies.reduce((n, family) => n + family.openCircuits, 0)}; recovering=${adapterFamilies.reduce((n, family) => n + family.halfOpenCircuits, 0)}` });
  const stateObservedAt = state?.updatedAt ? new Date(state.updatedAt).toISOString() : undefined;
  for (const [area, value] of [['client_ui', state?.activeTab], ['native_runtime', state?.runtime], ['voice', state?.voice?.state], ['meeting', state?.meeting], ['knowledge', state?.knowledge]] as const) {
    add({ id: `${area}.observation`, area, level: value == null || (stateAgeSeconds ?? Infinity) > 30 ? 'unknown' : value === 'error' || value === 'failed' ? 'degraded' : 'ok',
      message: value != null ? `${area}: ${typeof value === 'string' ? value : 'state reported'}.` : `${area}: no state reported.`, observedAt: stateObservedAt });
  }

  if (!state) {
    add({
      id: 'client_state.missing',
      level: 'unknown',
      area: 'client_state',
      message: 'No live desktop client state has been reported yet.',
      safeActions: ['client_self_repair(refresh_client_state)'],
      confirmationActions: ['Ask the user to open or restart the desktop client if no state arrives.'],
    });
  } else if (stateAgeSeconds != null && stateAgeSeconds > 30) {
    add({
      id: 'client_state.stale',
      level: stateAgeSeconds > 120 ? 'degraded' : 'attention',
      area: 'client_state',
      message: `Desktop client state is ${stateAgeSeconds}s old.`,
      evidence: `socket=${state.socketId || 'unknown'}`,
      safeActions: ['client_self_repair(refresh_client_state)'],
    });
  }

  if (state?.runtime?.lastError) {
    add({
      id: 'runtime.last_error',
      level: 'degraded',
      area: 'runtime',
      message: safeRuntimeError(state.runtime.lastError) || 'Native runtime reported an error.',
      safeActions: ['client_self_repair(open_recovery_surface:kernel)'],
      confirmationActions: ['Restart Lumi desktop runtime only after user confirmation.'],
    });
  }

  if (state?.runtimeLog?.lastError) {
    add({
      id: 'runtime_log.attention',
      level: 'attention',
      area: 'runtime',
      message: 'Runtime log reports a client/runtime issue.',
      evidence: safeRuntimeError(state.runtimeLog.lastError),
      safeActions: ['client_self_repair(open_recovery_surface:runtime-log)'],
    });
  }

  if (state?.platform === 'desktop') {
    const reported = state.uiManifest;
    if (!reported) {
      add({
        id: 'client_ui.manifest_missing',
        level: 'attention',
        area: 'client_ui',
        message: 'The desktop client has not reported its interface manifest; UI capability claims may be stale.',
        safeActions: ['client_self_repair(refresh_client_state)'],
      });
    } else {
      const missingSurfaces = PERSONAL_CLIENT_SURFACES
        .map(surface => surface.id)
        .filter(id => !(reported.surfaceIds || []).includes(id));
      const missingActions = PERSONAL_CLIENT_SURFACE_ACTIONS
        .filter(action => !(reported.actions || []).includes(action));
      const missingSettings = CLIENT_SETTINGS_SECTIONS
        .map(section => section.id)
        .filter(id => !(reported.settingsSections || []).includes(id));
      const missingLauncherIds = PERSONAL_CLIENT_LAUNCHER_IDS
        .filter(id => !(reported.launcherIds || []).includes(id));
      if (missingSurfaces.length || missingActions.length || missingSettings.length || missingLauncherIds.length) {
        add({
          id: 'client_ui.manifest_mismatch',
          level: 'degraded',
          area: 'client_ui',
          message: 'The running desktop interface does not match the server capability registry.',
          evidence: [
            `surfaces=${missingSurfaces.join(',') || 'ok'}`,
            `actions=${missingActions.join(',') || 'ok'}`,
            `settings=${missingSettings.join(',') || 'ok'}`,
            `launcher=${missingLauncherIds.join(',') || 'ok'}`,
          ].join('; '),
          safeActions: ['client_self_repair(refresh_client_state)'],
          confirmationActions: ['Restart the desktop client after updating it to the same source version as the server.'],
        });
      }
    }
  }

  if (state?.knowledge?.lastError) {
    add({
      id: 'knowledge.refresh_error',
      level: 'attention',
      area: 'knowledge',
      message: 'The current workspace knowledge inventory could not be fully refreshed.',
      evidence: safeRuntimeError(state.knowledge.lastError),
      safeActions: ['client_action(show_knowledge_base)', 'client_self_repair(refresh_client_state)'],
    });
  }
  const failedKnowledgeFiles = Number(state?.knowledge?.failedFiles || 0);
  const unsupportedKnowledgeFiles = Number(state?.knowledge?.unsupportedFiles || 0);
  const partialKnowledgeFiles = Number(state?.knowledge?.partialFiles || 0);
  const pendingKnowledgeFiles = Number(state?.knowledge?.pendingFiles || 0);
  const staleKnowledgeFiles = Number(state?.knowledge?.staleFiles || 0);
  if (failedKnowledgeFiles || unsupportedKnowledgeFiles || partialKnowledgeFiles || pendingKnowledgeFiles || staleKnowledgeFiles) {
    add({
      id: 'knowledge.ingestion_attention',
      level: 'attention',
      area: 'knowledge',
      message: 'Some saved knowledge files are not fully indexed and should not be treated as completely retrievable.',
      evidence: `partial=${partialKnowledgeFiles}, pending=${pendingKnowledgeFiles}, failed=${failedKnowledgeFiles}, unsupported=${unsupportedKnowledgeFiles}, stale=${staleKnowledgeFiles}`,
      safeActions: ['client_action(show_knowledge_base)'],
    });
  }
  if (Number(state?.knowledge?.orgArticles?.missingIndex || 0) || Number(state?.knowledge?.orgArticles?.stale || 0)) {
    add({
      id: 'knowledge.organization_index_attention',
      level: 'attention',
      area: 'knowledge',
      message: 'Some organization articles have a missing or stale semantic index; keyword retrieval may still work.',
      evidence: `missing=${state?.knowledge?.orgArticles?.missingIndex || 0}, stale=${state?.knowledge?.orgArticles?.stale || 0}`,
      safeActions: ['client_action(open_organization_workspace, section=kb)'],
    });
  }

  for (const err of (state?.errors || [])) {
    add({
      id: `recent_error.${err.source}.${err.code || 'runtime'}`,
      level: 'attention',
      area: err.source || 'client',
      message: safeRuntimeError(err.message) || 'Client reported an error.',
      evidence: safeRuntimeError(err.code),
      observedAt: err.at ? new Date(err.at).toISOString() : stateObservedAt,
      safeActions: ['client_health_check'],
    });
  }

  const findings = checks.filter(check => check.level !== 'ok');
  const level: ClientHealthLevel = findings.some(f => f.level === 'degraded')
    ? 'degraded'
    : findings.some(f => f.level === 'attention')
      ? 'attention'
      : findings.some(f => f.level === 'unknown')
        ? 'unknown'
        : 'ok';

  return {
    level,
    stateAgeSeconds,
    observedAt,
    checks,
    findings,
    autonomyBoundary: {
      automatic: [
        'Read client state and health.',
        'Refresh client state.',
        'Research candidate libraries, MCP servers, and skills for a requested capability.',
        'Run a sleep/dream memory consolidation pass when resting or when the user asks.',
        'Open Lumi recovery surfaces such as Runtime Diagnostics, Skills, Settings, Plans, or Computer Adaptation.',
        'Retry non-destructive client actions when the cause is clear.',
      ],
      confirmFirst: [
        'Install or execute untrusted third-party code from GitHub, npm, Python, Revit add-ins, CAD plugins, or MCP servers.',
        'Start meeting capture or wallpaper mode.',
        'Operate generic shell/system commands, first-time login/security verification/credential storage/account switching, ambiguous external submits, high-consequence external commits, or file writes without explicit deliverable intent.',
        'Change settings, model providers, permissions, or runtime startup behavior.',
      ],
      forbidden: [
        'Delete user data or uninstall software without an explicit destructive-safe tool and confirmation.',
        'Purchase/pay/transfer, place or cancel real brokerage orders, change orders/prices/inventory/ad spend, perform first-time login/security verification/credential storage/account switching, file/sign legal commitments, or run ambiguous external submits without confirmation.',
        'Claim a repair or mode switch happened without calling the relevant tool and checking state.',
      ],
    },
  };
}

export function getClientSelfAwarenessReport(
  userId: string,
  scope: { domain?: string; orgId?: string } = {},
  health = getClientHealthReport(userId, scope),
): ClientSelfAwarenessReport {
  const state = getClientStateForScope(userId, scope);
  const digest = getClientStateDigest(state);
  const stale = health.stateAgeSeconds != null && health.stateAgeSeconds > 30;
  const level: ClientSelfAwarenessReport['level'] = !state ? 'missing' : stale ? 'stale' : 'live';
  const gaps: string[] = [];
  if (!state) gaps.push('No live client state has arrived yet.');
  if (stale) gaps.push(`Client state is ${health.stateAgeSeconds}s old; refresh before acting.`);
  if (state?.knowledge?.lastError) gaps.push(`Knowledge inventory: ${safeRuntimeError(state.knowledge.lastError)}`);
  if (Number(state?.knowledge?.failedFiles || 0) || Number(state?.knowledge?.unsupportedFiles || 0)) {
    gaps.push(`Knowledge ingestion needs attention: failed=${state?.knowledge?.failedFiles || 0}, unsupported=${state?.knowledge?.unsupportedFiles || 0}.`);
  }
  if (health.findings.length) gaps.push(...health.findings.map(f => `${f.area}: ${f.message}`));

  const bodySummary = digest
    ? `mode=${digest.mode}; domain=${digest.workDomain}; active=${digest.activeTab}; view=${digest.viewMode}; settings=${digest.settingsSection}; orgView=${digest.orgView}; focused=${digest.focusedWindow}; surfaces=${digest.openSurfaces.join(', ') || 'none'}; knowledge=${digest.knowledge}; health=${health.level}; age=${digest.stateAgeSeconds ?? 'unknown'}s`
    : `no live client body; health=${health.level}`;

  return {
    level,
    bodySummary,
    architecture: LUMI_TECHNICAL_ARCHITECTURE,
    currentState: digest,
    knows: [
      'the complete registered personal-client surface map and each native client_action route',
      'the exact active settings section when settings are visible',
      'the exact current organization workspace view and the views allowed by the authenticated member role',
      'the current-domain knowledge inventory and the difference between saved, indexed, partial, pending, failed, unsupported, missing-index, and stale content',
      'one continuous Lumi identity with personal and organization workspace overlays; organization access never grants another member personal memory access',
      'current mode, active tab, windows, focused window, voice/meeting/runtime state when the desktop reports it',
      'local machine identity, installed/launchable apps, files, folders, startup entries, services, and running processes when refreshed through desktop relay tools',
      'visible desktop state: foreground window, screen pixels, accessible UI controls, clipboard, cursor/input focus, and existing taskbar/background app sessions',
      'background runtime state: launch-at-login, close-to-background, backend health, runtime log, autonomy policy, idle/activity signals, and confirmed workflows',
      'which client actions need confirmation and which external/irreversible actions must stop for the user',
      'how to recover safely by refreshing state or opening the right recovery surface',
    ],
    gaps: gaps.length ? gaps : ['No current self-awareness gaps reported by client health.'],
    habits: [
      'Before changing a Lumi client surface or mode, read client_get_state unless the current tool result already contains fresh state.',
      'Before diagnosing desktop readiness or permissions, refresh with desktop_capability_status; Internal/External is a saved execution preference independent of wallpaper. External prefers visual and actual desktop operation for requested work; Internal asks once through the existing exact action confirmation before switching to External. Changing the preference does not start an action or grant desktop, background, or sensitive-operation permission. Wallpaper is only the temporary presentation used by an actual desktop workflow. Before saying what this machine has installed, where a file is, what is on the desktop, or what is running, refresh with desktop_system_info, desktop_list_apps, desktop_list_files, desktop_path_info, desktop_active_window, desktop_running_processes, or desktop_capture_screen as needed.',
      'Before saying Lumi can keep working in the background, read client_get_state or client_health_check and distinguish resident runtime from autonomous workflow execution.',
      'After client_action, trust verified state or explicit failure, not intention alone.',
      'After an upload or article save, inspect current-domain ingestion and index health before claiming that the source is fully retrievable.',
      'For external apps, inspect the active window/screen and use adapters before mouse/keyboard control.',
      'Report only done, blocked, and needs-confirmation items for takeover work.',
    ],
    nextBestActions: state && !stale
      ? ['Use client_action for Lumi UI changes and verify the returned status.', 'Use desktop_system_info, desktop_running_processes, desktop_active_window, desktop_ui_snapshot, or desktop_capture_screen for machine/desktop claims.', 'Use client_health_check or open_computer_adaptation before background/runtime claims.']
      : ['Call client_self_repair(refresh_client_state).', 'Ask the user to open/reconnect the Lumi desktop client if no state arrives.'],
  };
}

export function getSkillRuntimeFindings() {
  const health = mcpManager.getServerHealth();
  const connected = new Set(mcpManager.getConnectedServers());
  const config = mcpManager.getConfig();
  const local = mcpManager.listLocalSkills();
  return Object.entries(config)
    .map(([name, serverConfig]) => {
      const localSkill = local.find(skill => skill.name === name);
      const serverHealth = health[name];
      const enabled = Boolean(serverConfig.enabled);
      const isConnected = connected.has(name);
      const broken = Boolean(localSkill?.broken);
      const status = serverHealth?.status || (isConnected ? 'connected' : 'unknown');
      const hasIssue = broken || ['crashed', 'failed', 'restarting'].includes(status) || (enabled && !isConnected && status !== 'idle');
      if (!hasIssue) return null;
      return {
        name,
        enabled,
        connected: isConnected,
        broken,
        status,
        consecutiveCrashes: Number(serverHealth?.consecutiveCrashes || 0),
        lastError: safeRuntimeError(serverHealth?.lastError),
        lastCrashTime: serverHealth?.lastCrashTime || undefined,
        lastSuccessfulConnect: serverHealth?.lastSuccessfulConnect || undefined,
        source: serverConfig.source || localSkill?.source || 'unknown',
        description: serverConfig.description || localSkill?.description || name,
        repairTool: `client_repair_skill(skillName="${name}")`,
      };
    })
    .filter(Boolean);
}
