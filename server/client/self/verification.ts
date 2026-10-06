import { normalizeOrganizationWorkspaceView } from "../../../shared/org_workspace";
import { getOpenPersonalClientSurfaceIds, getPersonalClientSurfaceByAction, isComputerAdaptationSettingsTarget, normalizeClientSettingsSection } from "../../../shared/client_surfaces";
import type { ClientActionExpectation, ClientStateSnapshot, ClientActionVerification, ClientActionVerificationStatus } from './contracts';
import { normalizeClientActionTarget } from '../../../shared/client_surface_target';
import { getClientStateDigest } from './state';

export function getClientActionExpectation(args: Record<string, any> = {}): ClientActionExpectation {
  const action = String(args.action || '').trim();
  const mode = String(args.mode || '').trim();
  const section = String(args.section || '').trim();
  const enabled = Boolean(args.enabled);
  let target = normalizeClientActionTarget(args.target);
  const requestedOrganizationView = normalizeOrganizationWorkspaceView(section || target);
  const registeredSurface = getPersonalClientSurfaceByAction(action);
  let expectedState: string[] = [];
  let verification = 'Check the latest client state after the action before claiming success.';
  let naturalCompletion = 'Done.';
  let naturalPending = 'The command was sent, but the latest client state has not confirmed the change yet.';

  const setSurface = (surface: string, label?: string) => {
    target = normalizeClientActionTarget(surface);
    expectedState = [`surface:${target}:open`];
    verification = `The ${label || target} surface should be visible or active in client state.`;
    naturalCompletion = `${label || target} is open.`;
    naturalPending = `${label || target} was requested, but I still need a fresh client state to confirm it is open.`;
  };

  switch (action) {
    case 'refresh_client_state':
      expectedState = ['state:fresh'];
      verification = 'A fresh client state report should arrive from the desktop client.';
      naturalCompletion = 'Client state is refreshed.';
      naturalPending = 'I asked the client to refresh state, but no fresh state has arrived yet.';
      break;
    case 'focus_home':
      setSurface('home', 'home');
      break;
    case 'open_personal_workspace':
      setSurface('home', 'personal workspace');
      expectedState.push('domain:personal');
      verification = 'The personal workspace should be active and the organization data overlay should be closed.';
      naturalCompletion = 'Personal workspace is open.';
      naturalPending = 'I asked to return to the personal workspace, but fresh state has not confirmed the domain switch yet.';
      break;
    case 'open_nexus':
      setSurface('nexus', 'Nexus / central world');
      break;
    case 'close_nexus':
      expectedState = ['surface:nexus:closed'];
      verification = 'The Nexus / central world view should no longer be active.';
      naturalCompletion = 'Nexus / central world is closed.';
      naturalPending = 'I asked to close Nexus / central world, but I still need a fresh client state to confirm it.';
      break;
    case 'enter_widget_mode':
    case 'show_desktop_widget':
      expectedState = ['surface:widget:open'];
      verification = 'Desktop widget mode should be active in client state.';
      naturalCompletion = 'Desktop widget mode is active.';
      naturalPending = 'I asked to enter desktop widget mode, but I still need fresh state to confirm it.';
      break;
    case 'exit_widget_mode':
    case 'expand_from_widget':
      expectedState = ['surface:widget:closed'];
      verification = 'Desktop widget mode should be inactive in client state.';
      naturalCompletion = 'Desktop widget mode is closed.';
      naturalPending = 'I asked to leave desktop widget mode, but I still need fresh state to confirm it.';
      break;
    case 'close_client_surface':
      expectedState = target ? [`surface:${target}:closed`] : [];
      verification = target ? `The ${target} surface should no longer be open.` : 'A target surface is required for close_client_surface.';
      naturalCompletion = target ? `${target} is closed.` : 'The close request completed.';
      naturalPending = target ? `${target} was asked to close, but I still need fresh state to confirm it.` : 'The close request was sent.';
      break;
    case 'set_client_mode':
      expectedState = mode ? [`mode:${mode}`] : [];
      verification = mode ? `Client mode should become ${mode}.` : 'A target mode is required.';
      naturalCompletion = mode ? `Mode is now ${mode}.` : 'Mode change requested.';
      naturalPending = mode ? `I asked to switch to ${mode}, but the latest state has not confirmed it yet.` : 'Mode change requested.';
      break;
    case 'start_meeting_mode':
      expectedState = ['mode:meeting', 'surface:meeting:open'];
      verification = 'Client mode should be meeting and meeting capture/notes should be active.';
      naturalCompletion = 'Meeting mode is active.';
      naturalPending = 'I asked to start meeting mode, but the latest state has not confirmed it yet.';
      break;
    case 'end_meeting_mode':
      expectedState = ['mode:not:meeting'];
      verification = 'Client mode should leave meeting mode; report generation may continue afterward.';
      naturalCompletion = 'Meeting mode is ending and report generation may continue.';
      naturalPending = 'I asked to end meeting mode, but the latest state has not confirmed it yet.';
      break;
    case 'open_meeting_notes':
      setSurface('meeting', 'meeting notes');
      break;
    case 'show_knowledge_base':
    case 'open_files':
      setSurface('knowledge', 'knowledge base');
      break;
    case 'open_organization_workspace':
      setSurface('org', 'organization workspace');
      if (requestedOrganizationView) {
        expectedState.push(`org-view:${requestedOrganizationView}`);
        verification = `The organization workspace and its ${requestedOrganizationView} view should be visible in fresh client state.`;
        naturalCompletion = `Organization workspace is open on ${requestedOrganizationView}.`;
        naturalPending = `I asked to open the organization ${requestedOrganizationView} view, but fresh client state has not confirmed that exact view yet.`;
      }
      break;
    case 'open_settings':
      if (isComputerAdaptationSettingsTarget(section)) {
        setSurface('kernel', 'computer adaptation center');
        break;
      }
      setSurface('settings', 'settings');
      {
        const normalizedSettingsSection = normalizeClientSettingsSection(section);
        if (normalizedSettingsSection) {
          expectedState.push(`settings-section:${normalizedSettingsSection}`);
          verification = `Settings should be visible on the ${normalizedSettingsSection} section in fresh client state.`;
          naturalCompletion = `Settings is open on ${normalizedSettingsSection}.`;
          naturalPending = `I asked to open the ${normalizedSettingsSection} settings section, but fresh state has not confirmed that exact section yet.`;
        }
      }
      break;
    case 'open_computer_adaptation':
      setSurface('kernel', 'computer adaptation center');
      break;
    case 'open_personalization':
      setSurface('personalization', 'personalization');
      break;
    case 'open_avatar_studio':
      setSurface('personalization', 'personalization appearance');
      break;
    case 'open_sound_studio':
      setSurface('personalization', 'personalization voice');
      break;
    case 'open_memory_avatar':
      setSurface('memory-avatar', 'Memory Territory');
      break;
    case 'open_skills':
      setSurface('skills', 'skills');
      break;
    case 'open_tools':
      setSurface('tools', 'tools');
      break;
    case 'open_command_center':
    case 'open_chat':
      setSurface('command-center', 'Lumi command center');
      break;
    case 'open_plans':
    case 'open_work_queue':
      setSurface('plans', 'plans');
      break;
    case 'set_wallpaper_mode':
      expectedState = [`surface:wallpaper:${enabled ? 'open' : 'closed'}`];
      verification = `Wallpaper mode should be ${enabled ? 'enabled' : 'disabled'} in client state.`;
      naturalCompletion = `Wallpaper mode is ${enabled ? 'enabled' : 'disabled'}.`;
      naturalPending = `I asked to ${enabled ? 'enable' : 'disable'} wallpaper mode, but state has not confirmed it yet.`;
      break;
    default:
      if (registeredSurface) {
        setSurface(registeredSurface.target, registeredSurface.label);
        const registeredOrganizationView = normalizeOrganizationWorkspaceView(
          registeredSurface.organizationViewByAction?.[action]
          || registeredSurface.organizationView,
        );
        if (registeredOrganizationView) {
          expectedState.push(`org-view:${registeredOrganizationView}`);
          verification = `${registeredSurface.label} should be visible on the ${registeredOrganizationView} organization view.`;
        }
        if (registeredSurface.settingsSection) {
          expectedState.push(`settings-section:${registeredSurface.settingsSection}`);
          verification = `${registeredSurface.label} should be visible in the ${registeredSurface.settingsSection} settings section.`;
        }
      } else {
        expectedState = [];
        verification = 'No built-in state expectation is known for this client action.';
        naturalCompletion = 'The client action completed.';
        naturalPending = 'The client action was sent, but I need its action result or fresh state before claiming success.';
      }
      break;
  }

  return {
    action,
    target: target || undefined,
    mode: mode || undefined,
    expectedState,
    requiresConfirmation: isConfirmationSensitiveClientAction(action, mode),
    verification,
    naturalCompletion,
    naturalPending,
  };
}

export function verifyClientActionResult(
  args: Record<string, any> = {},
  before: ClientStateSnapshot | null,
  after: ClientStateSnapshot | null,
  relayResult?: any,
): ClientActionVerification {
  const expectation = getClientActionExpectation(args);
  const relayOk = extractRelayOk(relayResult);
  const relayReason = extractRelayReason(relayResult);
  const matched: string[] = [];
  const missing: string[] = [];

  if (relayOk === false) {
    return {
      status: 'failed',
      matched,
      missing: expectation.expectedState,
      expectation,
      before: getClientStateDigest(before),
      after: getClientStateDigest(after),
      relayOk,
      relayReason,
      message: relayReason || 'The client action reported failure.',
    };
  }

  for (const expected of expectation.expectedState) {
    if (clientStateMatchesExpectation(expected, before, after)) matched.push(expected);
    else missing.push(expected);
  }

  const status: ClientActionVerificationStatus = expectation.expectedState.length === 0
    ? (relayOk === true ? 'not_applicable' : 'pending')
    : missing.length === 0
      ? 'verified'
      : 'pending';

  return {
    status,
    matched,
    missing,
    expectation,
    before: getClientStateDigest(before),
    after: getClientStateDigest(after),
    relayOk,
    relayReason,
    message: status === 'verified' || status === 'not_applicable'
      ? expectation.naturalCompletion
      : relayReason || expectation.naturalPending,
  };
}

export function isConfirmationSensitiveClientAction(action: string, mode?: string): boolean {
  if (action === 'start_meeting_mode' || action === 'end_meeting_mode' || action === 'set_wallpaper_mode') return true;
  return action === 'set_client_mode' && mode === 'meeting';
}

export function surfaceIsOpen(state: ClientStateSnapshot | null | undefined, surface: string): boolean {
  if (!state) return false;
  const target = normalizeClientActionTarget(surface);
  const registryVisible = new Set(state.surfaces?.openSurfaceIds || getOpenPersonalClientSurfaceIds({
    activeTab: state.activeTab,
    viewMode: state.viewMode,
    workDomain: state.workDomain,
    focusedWindow: state.windows?.focused,
    openWindows: state.windows?.open,
    settingsSection: state.settings?.activeSection,
    appLauncherOpen: state.surfaces?.appLauncherOpen,
    knowledgeOpen: state.surfaces?.knowledgeOpen,
    chatOpen: state.surfaces?.chatOpen,
    commandCenterOpen: state.surfaces?.commandCenterOpen,
    commandCenterView: state.surfaces?.commandCenterView,
    notificationsOpen: state.surfaces?.notificationsOpen,
    memoryAvatarOpen: state.surfaces?.memoryAvatarOpen,
    meetingOpen: state.surfaces?.meetingOpen || state.meeting?.active,
    wallpaperMode: state.surfaces?.wallpaperMode,
    widgetMode: state.surfaces?.widgetMode,
    organizationWorkspaceVisible: state.orgWorkspace?.visible,
    organizationWorkspaceView: state.orgWorkspace?.activeView,
  }));
  if (registryVisible.has(surface) || registryVisible.has(target)) return true;
  const openWindows = state.windows?.open || [];
  if (target === 'home') return state.activeTab === 'home';
  if (target === 'nexus') return state.viewMode === 'world' || Boolean(state.surfaces?.nexusOpen);
  if (target === 'app-launcher') return Boolean(state.surfaces?.appLauncherOpen);
  if (target === 'org') return state.activeTab === 'org' || openWindows.includes('org') || state.windows?.focused === 'org';
  if (target === 'knowledge') return Boolean(state.surfaces?.knowledgeOpen) || openWindows.includes('knowledge');
  if (target === 'command-center') return Boolean(state.surfaces?.commandCenterOpen || state.surfaces?.chatOpen)
    || openWindows.includes('command-center') || openWindows.includes('chat');
  if (target === 'notifications') return Boolean(state.surfaces?.notificationsOpen) || openWindows.includes('notifications');
  if (target === 'memory-avatar') return Boolean(state.surfaces?.memoryAvatarOpen) || openWindows.includes('memory-avatar');
  if (target === 'meeting') return Boolean(state.surfaces?.meetingOpen || state.meeting?.active) || openWindows.includes('meeting');
  if (target === 'wallpaper') return Boolean(state.surfaces?.wallpaperMode);
  if (target === 'widget') return Boolean(state.surfaces?.widgetMode);
  return state.activeTab === target || openWindows.includes(target) || state.windows?.focused === target;
}

export function clientStateMatchesExpectation(
  expected: string,
  before: ClientStateSnapshot | null,
  after: ClientStateSnapshot | null,
): boolean {
  if (expected === 'state:fresh') {
    if (!after?.updatedAt) return false;
    return !before?.updatedAt || after.updatedAt > before.updatedAt;
  }
  if (expected.startsWith('mode:not:')) return after?.mode !== expected.slice('mode:not:'.length);
  if (expected.startsWith('mode:')) return after?.mode === expected.slice('mode:'.length);
  if (expected.startsWith('domain:')) return after?.workDomain === expected.slice('domain:'.length);
  if (expected.startsWith('settings-section:')) {
    const requestedSection = normalizeClientSettingsSection(expected.slice('settings-section:'.length));
    const activeSection = after?.settings?.activeSection
      ? normalizeClientSettingsSection(after.settings.activeSection)
      : null;
    return Boolean(requestedSection && activeSection === requestedSection && surfaceIsOpen(after, 'settings'));
  }
  if (expected.startsWith('org-view:')) {
    const requestedView = normalizeOrganizationWorkspaceView(expected.slice('org-view:'.length));
    const activeView = normalizeOrganizationWorkspaceView(after?.orgWorkspace?.activeView);
    return Boolean(requestedView && activeView === requestedView && after?.activeTab === 'org');
  }
  const surfaceMatch = expected.match(/^surface:(.+):(open|closed)$/);
  if (surfaceMatch) {
    const [, surface, desired] = surfaceMatch;
    const isOpen = surfaceIsOpen(after, surface);
    return desired === 'open' ? isOpen : !isOpen;
  }
  return false;
}

export function extractRelayOk(result: any): boolean | null {
  const parsed = parseRelayObject(result);
  if (parsed && typeof parsed.ok === 'boolean') return parsed.ok;
  if (typeof result === 'string') {
    const lower = result.toLowerCase();
    if (/\b(failed|error|ignored|timed out|timeout)\b/.test(lower)) return false;
    if (/\b(ok|opened|closed|enabled|disabled|completed|done|success)\b/.test(lower)) return true;
  }
  return null;
}

export function extractRelayReason(result: any): string | undefined {
  const parsed = parseRelayObject(result);
  if (parsed) {
    const reason = parsed.reason || parsed.error || parsed.message;
    return reason == null ? undefined : String(reason);
  }
  return typeof result === 'string' ? result : undefined;
}

export function parseRelayObject(result: any): Record<string, any> | null {
  if (!result) return null;
  if (typeof result === 'object') return result as Record<string, any>;
  if (typeof result !== 'string') return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
