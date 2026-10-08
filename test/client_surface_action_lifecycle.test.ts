// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import * as surfaces from '../shared/client_surfaces';
import * as surfaceTargets from '../shared/client_surface_target';
import * as organizations from '../shared/org_workspace';
import { loadSourceModule } from './source_expression';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); });

function client(overrides: Record<string, unknown> = {}) {
  const commit = vi.fn(async (_target: string) => true);
  const route = vi.fn();
  const runtime = {
    activeTab: 'home', openWindows: [], workDomain: 'personal', orgConnection: null,
    isDesktopWidgetMode: false, operationMode: 'assistant',
    openSurface: vi.fn(), closeSurface: vi.fn(), openCommandCenter: vi.fn(),
    enterDesktopWidgetMode: vi.fn(async () => true), exitDesktopWidgetMode: vi.fn(async () => true),
    endMeetingAndReport: vi.fn(async () => {}), resetMeetingCapture: vi.fn(),
    setMeetingPaused: vi.fn(), setMeetingNotesOpen: vi.fn(), setLegalMeetingCaseTitle: vi.fn(),
    setSettingsSection: vi.fn(), setPersonalizationSection: vi.fn(), setOperationMode: vi.fn(),
    switchDomain: vi.fn(async () => ({ success: true })),
    applyWallpaperMode: vi.fn(async (enabled: boolean) => ({ enabled, presentation: 'workbench', workspace: 'personal' })),
    ...overrides,
  };
  const hook = loadSourceModule<{ useClientSurfaceActions: (runtime: any) => void }>(
    'src/components/desktop/useClientSurfaceActions.ts', {
      react: { useEffect: (effect: () => () => void) => cleanups.push(effect()) },
      '../../lib/legalCaseStore': { getLegalConsultationCaseId: () => '', setLegalConsultationCaseId: vi.fn() },
      '../../../shared/org_workspace': organizations,
      '../../../shared/client_surfaces': surfaces,
      '../../../shared/client_surface_target': surfaceTargets,
      '../../lib/orgWorkspaceNavigation': { queueOrganizationWorkspaceRoute: route },
      '../../lib/clientSurfaceCommit': { isClientSurfaceRendered: () => false, waitForClientSurfaceRendered: commit },
    },
  );
  hook.useClientSurfaceActions(runtime);
  const send = (detail: Record<string, unknown>) => {
    const respond = vi.fn(), reject = vi.fn();
    window.dispatchEvent(new CustomEvent('lumi:client-action', { detail: { ...detail, respond, reject } }));
    return { respond, reject };
  };
  return { runtime, commit, send, route };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it.each(['open_settings', 'open_personality_lab'])('does not report %s success before the shared window commit completes', async action => {
  const c = client(); let resolve!: (value: boolean) => void;
  c.commit.mockImplementationOnce(() => new Promise<boolean>(yes => { resolve = yes; }));
  const reply = c.send({ action, section: 'general' });
  expect(c.runtime.openSurface).toHaveBeenCalledWith(action === 'open_settings' ? 'settings' : 'personality');
  expect(reply.respond).not.toHaveBeenCalled();
  resolve(true); await settle();
  expect(reply.respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  expect(reply.reject).not.toHaveBeenCalled();
});
it.each(['open_settings', 'open_personality_lab', 'open_command_center'])('rejects %s when the target never renders', async action => {
  const c = client(); c.commit.mockResolvedValueOnce(false);
  const reply = c.send({ action }); await settle();
  expect(reply.respond).not.toHaveBeenCalled();
  expect(reply.reject).toHaveBeenCalledWith(expect.stringContaining('did not render'));
});
it('sends client open and close actions through the same navigation callbacks as the view', async () => {
  const c = client(); const opened = c.send({ action: 'open_tools' }); await settle();
  expect(c.runtime.openSurface).toHaveBeenCalledExactlyOnceWith('tools'); expect(c.commit).toHaveBeenCalledExactlyOnceWith('tools');
  expect(opened.respond).toHaveBeenCalledWith(expect.objectContaining({ target: 'tools', rendered: true }));
  c.send({ action: 'close_client_surface', target: 'tools' }); expect(c.runtime.closeSurface).toHaveBeenCalledExactlyOnceWith('tools');
});
it.each([
  { action: 'set_client_mode', mode: 'meeting' },
  { action: 'start_meeting_mode', resetNotes: true },
  { action: 'end_meeting_mode' },
  { action: 'set_wallpaper_mode', enabled: true },
])('keeps confirmation ahead of every mutation for $action', async detail => {
  const c = client(); const reply = c.send(detail); await settle();
  expect(reply.reject).toHaveBeenCalledWith(expect.stringContaining('confirmation'));
  for (const fn of [c.runtime.setOperationMode, c.runtime.resetMeetingCapture, c.runtime.endMeetingAndReport, c.runtime.applyWallpaperMode]) expect(fn).not.toHaveBeenCalled();
});
it('accepts a confirmed meeting action and applies each transition once', async () => {
  const c = client(); const reply = c.send({ action: 'start_meeting_mode', confirmed: true, resetNotes: true }); await settle();
  expect(c.runtime.resetMeetingCapture).toHaveBeenCalledTimes(1); expect(c.runtime.setOperationMode).toHaveBeenCalledExactlyOnceWith('meeting');
  expect(c.runtime.setMeetingPaused).toHaveBeenCalledExactlyOnceWith(false); expect(c.runtime.setMeetingNotesOpen).toHaveBeenCalledExactlyOnceWith(true);
  expect(reply.respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, mode: 'meeting' }));
});
it('denies a restricted organization route before opening or switching the workspace', async () => {
  const c = client({ orgConnection: { connected: true, orgRole: 'member' } });
  const reply = c.send({ action: 'open_organization_workspace', section: 'members' }); await settle();
  expect(reply.respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: 'organization_role_not_allowed' }));
  expect(c.runtime.switchDomain).not.toHaveBeenCalled(); expect(c.runtime.openSurface).not.toHaveBeenCalled(); expect(c.route).not.toHaveBeenCalled();
});
it('keeps personal workspace closed if domain switching fails', async () => {
  const c = client({ workDomain: 'work', switchDomain: vi.fn(async () => ({ success: false, message: 'synthetic switch denied' })) });
  const reply = c.send({ action: 'open_personal_workspace' }); await settle();
  expect(c.runtime.openSurface).not.toHaveBeenCalled();
  expect(reply.respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: 'synthetic switch denied' }));
});
it('expands widget mode through its existing owner and still waits for the requested window', async () => {
  const c = client({ isDesktopWidgetMode: true }); const reply = c.send({ action: 'open_tools' }); await settle();
  expect(c.runtime.exitDesktopWidgetMode).toHaveBeenCalledExactlyOnceWith('tools'); expect(c.runtime.openSurface).not.toHaveBeenCalled();
  expect(c.commit).toHaveBeenCalledExactlyOnceWith('tools'); expect(reply.respond).toHaveBeenCalledWith(expect.objectContaining({ rendered: true }));
});
it('removes its listener on cleanup so a retained hook cannot process another action', () => {
  const c = client(); cleanups.pop()!(); c.send({ action: 'open_tools' }); expect(c.runtime.openSurface).not.toHaveBeenCalled();
});

it.each(['enter_widget_mode', 'exit_widget_mode'])('awaits native completion and then rendered content for %s', async action => {
  let finish!: (ok: boolean) => void;
  const transition = vi.fn(() => new Promise<boolean>(resolve => finish = resolve));
  const c = client({ enterDesktopWidgetMode: transition, exitDesktopWidgetMode: transition });
  const reply = c.send({ action }); await settle();
  expect(reply.respond).not.toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled();
  finish(true); await settle();
  expect(c.commit).toHaveBeenCalledWith(action === 'enter_widget_mode' ? 'widget' : 'home');
  expect(reply.respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, rendered: true }));
});
it.each(['enter_widget_mode', 'exit_widget_mode'])('rejects %s if the mode transition fails', async action => {
  const c = client({ enterDesktopWidgetMode: vi.fn(async () => false), exitDesktopWidgetMode: vi.fn(async () => false) });
  const reply = c.send({ action }); await settle();
  expect(reply.respond).not.toHaveBeenCalled(); expect(reply.reject).toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled();
});
it.each(['home', 'nexus', 'app-launcher', 'org', 'knowledge', 'notifications', 'memory-avatar'])('requires a real commit for %s', async target => {
  const c = client(); c.commit.mockResolvedValueOnce(false);
  const action = surfaces.PERSONAL_CLIENT_SURFACES.find(surface => surface.target === target)!.actions[0];
  const reply = c.send({ action, target }); await settle();
  expect(c.commit).toHaveBeenCalledWith(target); expect(reply.respond).not.toHaveBeenCalled(); expect(reply.reject).toHaveBeenCalled();
});
