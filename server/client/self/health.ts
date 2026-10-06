import { safeRuntimeError } from "../diagnostic_sanitizer";
import { CLIENT_SETTINGS_SECTIONS, PERSONAL_CLIENT_LAUNCHER_IDS, PERSONAL_CLIENT_SURFACES, PERSONAL_CLIENT_SURFACE_ACTIONS } from "../../../shared/client_surfaces";
import { LUMI_TECHNICAL_ARCHITECTURE } from "../../../shared/technical_architecture";
import type { ClientHealthReport, ClientHealthFinding, ClientHealthLevel, ClientSelfAwarenessReport } from './contracts';
import { getClientStateForScope, getClientStateDigest } from './state';

export function getClientHealthReport(
  userId: string,
  scope: { domain?: string; orgId?: string } = {},
): ClientHealthReport {
  const state = getClientStateForScope(userId, scope);
  const now = Date.now();
  const findings: ClientHealthFinding[] = [];
  const stateAgeSeconds = state?.updatedAt ? Math.round((now - state.updatedAt) / 1000) : null;

  const add = (finding: ClientHealthFinding) => findings.push(finding);

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
  if (failedKnowledgeFiles || unsupportedKnowledgeFiles || partialKnowledgeFiles || pendingKnowledgeFiles) {
    add({
      id: 'knowledge.ingestion_attention',
      level: 'attention',
      area: 'knowledge',
      message: 'Some saved knowledge files are not fully indexed and should not be treated as completely retrievable.',
      evidence: `partial=${partialKnowledgeFiles}, pending=${pendingKnowledgeFiles}, failed=${failedKnowledgeFiles}, unsupported=${unsupportedKnowledgeFiles}`,
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

  for (const err of (state?.errors || []).slice(-5)) {
    add({
      id: `recent_error.${err.source}.${err.code || 'runtime'}`,
      level: 'attention',
      area: err.source || 'client',
      message: safeRuntimeError(err.message) || 'Client reported an error.',
      evidence: safeRuntimeError(err.code),
      safeActions: ['client_health_check'],
    });
  }

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
): ClientSelfAwarenessReport {
  const state = getClientStateForScope(userId, scope);
  const health = getClientHealthReport(userId, scope);
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
  if (health.findings.length) gaps.push(...health.findings.slice(0, 3).map(f => `${f.area}: ${f.message}`));

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
      'Before diagnosing desktop readiness or permissions, refresh with desktop_capability_status; there is no separate Lumi external-app automation switch. Before saying what this machine has installed, where a file is, what is on the desktop, or what is running, refresh with desktop_system_info, desktop_list_apps, desktop_list_files, desktop_path_info, desktop_active_window, desktop_running_processes, or desktop_capture_screen as needed.',
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
