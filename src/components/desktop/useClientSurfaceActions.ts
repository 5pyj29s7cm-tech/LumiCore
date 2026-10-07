import { useEffect } from 'react';
import type { useApp, OperationMode } from '../../contexts/AppContext';
import type { CommandCenterView } from '../commandCenterTypes';
import type { WallpaperPresentation, WallpaperWorkspace } from '../../services/systemService';
import { getLegalConsultationCaseId, setLegalConsultationCaseId } from '../../lib/legalCaseStore';
import { canAccessOrganizationWorkspaceView, normalizeOrganizationWorkspaceView, type OrganizationWorkspaceView } from '../../../shared/org_workspace';
import { getPersonalClientSurfaceByAction, isComputerAdaptationSettingsTarget, normalizeClientSettingsSection } from '../../../shared/client_surfaces';
import { queueOrganizationWorkspaceRoute } from '../../lib/orgWorkspaceNavigation';
import { isClientSurfaceRendered, waitForClientSurfaceRendered } from '../../lib/clientSurfaceCommit';

type ClientActionRuntime = Pick<ReturnType<typeof useApp>, 'orgConnection' | 'workDomain' | 'switchDomain' | 'operationMode' | 'setOperationMode'> & {
  activeTab: string;
  openWindows: string[];
  isDesktopWidgetMode: boolean;
  openSurface: (target: string) => void;
  closeSurface: (target: string) => void;
  openCommandCenter: (view: CommandCenterView) => void;
  enterDesktopWidgetMode: () => Promise<void>;
  exitDesktopWidgetMode: (target?: string) => Promise<void>;
  endMeetingAndReport: () => Promise<void>;
  resetMeetingCapture: () => void;
  setMeetingPaused: (paused: boolean) => void;
  setMeetingNotesOpen: (open: boolean) => void;
  setLegalMeetingCaseTitle: (title: string) => void;
  setSettingsSection: (section: string) => void;
  setPersonalizationSection: (section: 'appearance' | 'voice') => void;
  applyWallpaperMode: (enabled: boolean, options: { presentation: WallpaperPresentation }) => Promise<{
    enabled: boolean; presentation: WallpaperPresentation; workspace: WallpaperWorkspace;
  }>;
};

import { normalizeClientActionTarget as normalizeDesktopSurfaceTarget } from '../../../shared/client_surface_target';
export { normalizeDesktopSurfaceTarget };

async function waitForSurfaceCommit(target: string): Promise<true | undefined> {
  if (['home', 'nexus', 'app-launcher', 'org', 'knowledge', 'notifications', 'memory-avatar'].includes(target)) return;
  if (!await waitForClientSurfaceRendered(target)) {
    throw new Error(target === 'command-center'
      ? 'Lumi command center state changed, but the visible surface did not render.'
      : 'Lumi client state changed, but ' + target + ' did not render visibly.');
  }
  window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
  return true;
}

export function useClientSurfaceActions({
  activeTab, applyWallpaperMode, closeSurface, endMeetingAndReport, enterDesktopWidgetMode, exitDesktopWidgetMode, isDesktopWidgetMode, openCommandCenter, openSurface, openWindows, operationMode, orgConnection, resetMeetingCapture, setOperationMode, switchDomain, workDomain, setMeetingPaused, setMeetingNotesOpen, setLegalMeetingCaseTitle, setSettingsSection, setPersonalizationSection
}: ClientActionRuntime) {
  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {};
      const action = String(detail.action || '');
      const target = String(detail.target || '');
      const mode = String(detail.mode || '');
      const section = String(detail.section || '');
      const confirmed = Boolean(detail.confirmed);
      const respond = typeof detail.respond === 'function' ? detail.respond : () => {};
      const reject = typeof detail.reject === 'function' ? detail.reject : () => {};

      const openClientSurface = async (value: string) => {
        if (isDesktopWidgetMode) void exitDesktopWidgetMode(normalizeDesktopSurfaceTarget(value));
        else openSurface(value);
        return waitForSurfaceCommit(normalizeDesktopSurfaceTarget(value));
      };

      const getDemoTargetPoint = (value: string): { x: number; y: number } => {
        const windowId = normalizeDesktopSurfaceTarget(value);
        const targetEl = Array.from(document.querySelectorAll<HTMLElement>('[data-lumi-target]'))
          .find(el => el.dataset.lumiTarget === windowId);
        if (targetEl) {
          const rect = targetEl.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        const fallback: Record<string, { x: number; y: number }> = {
          home: { x: 82, y: 24 },
          org: { x: window.innerWidth / 2, y: 24 },
          plans: { x: window.innerWidth * 0.72, y: window.innerHeight * 0.42 },
        };
        return fallback[windowId] || { x: window.innerWidth / 2, y: window.innerHeight * 0.82 };
      };

      const animateDemoCursor = async (value: string) => {
        const point = getDemoTargetPoint(value);
        window.dispatchEvent(new CustomEvent('cursor-glow:show'));
        window.dispatchEvent(new CustomEvent('cursor-glow:update', { detail: point }));
        await new Promise(resolve => window.setTimeout(resolve, 540));
        window.dispatchEvent(new CustomEvent('cursor-glow:click', { detail: point }));
        await new Promise(resolve => window.setTimeout(resolve, 220));
      };

      const setClientMode = (value: string) => {
        const allowed = ['chat', 'meeting', 'assistant', 'autonomous'];
        if (!allowed.includes(value)) throw new Error(`Unsupported mode: ${value}`);
        if (value === 'meeting' && !confirmed) {
          throw new Error(`${value} mode requires explicit user confirmation`);
        }
        setOperationMode(value as OperationMode);
        if (value === 'meeting') {
          setMeetingPaused(false);
          setMeetingNotesOpen(true);
        }
      };

      const openOrganizationSurface = async (
        requestedView: OrganizationWorkspaceView,
        requestedAction: string,
      ) => {
        if (orgConnection?.connected && !canAccessOrganizationWorkspaceView(orgConnection?.orgRole, requestedView)) {
          respond({
            ok: false,
            action: requestedAction,
            target: 'org',
            section: requestedView,
            reason: 'organization_role_not_allowed',
          });
          return;
        }
        queueOrganizationWorkspaceRoute(requestedView);
        if (orgConnection?.connected && workDomain !== 'work') {
          const switched = await switchDomain('work');
          if (!switched.success) {
            await openClientSurface('org');
            respond({
              ok: false,
              action: requestedAction,
              target: 'org',
              section: requestedView,
              reason: switched.message || 'organization_domain_switch_failed',
            });
            return;
          }
        }
        await openClientSurface('org');
        window.dispatchEvent(new CustomEvent('lumi:navigate', {
          detail: { tab: 'org', sub: requestedView },
        }));
        respond({
          ok: true,
          action: requestedAction,
          target: 'org',
          section: requestedView,
          domain: orgConnection?.connected ? 'work' : workDomain,
        });
      };

      try {
        if (action === 'refresh_model_configuration') {
          const roles = Array.isArray(detail.payload?.roles) ? detail.payload.roles : [];
          window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed', {
            detail: { roles },
          }));
          respond({ ok: true, action, roles });
          return;
        }
        if (action === 'refresh_client_state') {
          window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
          respond({
            ok: true,
            action,
            mode: operationMode,
            activeTab,
            openWindows,
            widgetMode: isDesktopWidgetMode,
            renderedSurfaces: [
              isClientSurfaceRendered('command-center') ? 'command-center' : null,
              isClientSurfaceRendered('chat') ? 'chat' : null,
            ].filter(Boolean),
          });
          return;
        }
        if (action === 'enter_widget_mode' || action === 'show_desktop_widget') {
          void enterDesktopWidgetMode();
          respond({ ok: true, action, widgetMode: true });
          return;
        }
        if (action === 'exit_widget_mode' || action === 'expand_from_widget') {
          void exitDesktopWidgetMode(target || undefined);
          respond({ ok: true, action, widgetMode: false, target: target || undefined });
          return;
        }
        if (action === 'demo_open_surface') {
          const surface = normalizeDesktopSurfaceTarget(target || detail.surface || '');
          if (!surface) throw new Error('demo_open_surface requires target');
          void (async () => {
            try {
              await animateDemoCursor(surface);
              await openClientSurface(surface);
              respond({ ok: true, action, target: surface });
            } catch (err: any) {
              reject(err?.message || String(err));
            }
          })();
          return;
        }
        if (action === 'close_client_surface') {
          closeSurface(target);
          respond({ ok: true, action, target });
          return;
        }
        if (action === 'set_client_mode') {
          setClientMode(mode);
          respond({ ok: true, action, mode });
          return;
        }
        if (action === 'open_personal_workspace') {
          if (workDomain !== 'personal') {
            const switched = await switchDomain('personal');
            if (!switched.success) {
              respond({
                ok: false,
                action,
                target: 'home',
                domain: workDomain,
                reason: switched.message || 'personal_domain_switch_failed',
              });
              return;
            }
          }
          await openClientSurface('home');
          respond({ ok: true, action, target: 'home', domain: 'personal' });
          return;
        }
        if (action === 'open_settings') {
          if (isComputerAdaptationSettingsTarget(section)) {
            await openClientSurface('kernel');
            respond({ ok: true, action, target: 'kernel', section: 'computer' });
            return;
          }
          const requestedSection = normalizeClientSettingsSection(section);
          if (!requestedSection) throw new Error(`Unknown settings section: ${section}`);
          setSettingsSection(requestedSection);
          await openClientSurface('settings');
          respond({ ok: true, action, target: 'settings', section: requestedSection });
          return;
        }
        if (action === 'close_nexus') {
          closeSurface('nexus');
          respond({ ok: true, action, target: 'nexus', viewMode: 'personal' });
          return;
        }
        if (action === 'start_meeting_mode') {
          if (!confirmed) throw new Error('start_meeting_mode requires explicit user confirmation');
          if (detail.resetNotes) resetMeetingCapture();
          if (detail.legalCaseId) setLegalConsultationCaseId(String(detail.legalCaseId));
          if (detail.legalCaseTitle) setLegalMeetingCaseTitle(String(detail.legalCaseTitle));
          else if (!getLegalConsultationCaseId()) setLegalMeetingCaseTitle('');
          setClientMode('meeting');
          respond({ ok: true, action, mode: 'meeting' });
          return;
        }
        if (action === 'end_meeting_mode') {
          if (!confirmed) throw new Error('end_meeting_mode requires explicit user confirmation');
          void endMeetingAndReport();
          respond({ ok: true, action, status: 'ending_and_generating_report' });
          return;
        }
        if (action === 'open_meeting_notes') {
          setMeetingNotesOpen(true);
          respond({ ok: true, action });
          return;
        }
        if (action === 'open_organization_workspace') {
          const requestedView = normalizeOrganizationWorkspaceView(section || (target !== 'org' ? target : '') || 'dashboard');
          if (!requestedView) throw new Error(`Unknown organization workspace section: ${section || target}`);
          await openOrganizationSurface(requestedView, action);
          return;
        }
        if (action === 'set_wallpaper_mode') {
          const enabled = Boolean(detail.enabled);
          if (enabled && !confirmed) throw new Error('set_wallpaper_mode requires explicit user confirmation');
          const state = await applyWallpaperMode(enabled, { presentation: 'workbench' });
          respond({
            ok: true,
            action,
            enabled: state.enabled,
            presentation: state.presentation,
            workspace: state.workspace,
          });
          return;
        }
        const registeredSurface = getPersonalClientSurfaceByAction(action);
        if (registeredSurface?.organizationView) {
          const requestedView = normalizeOrganizationWorkspaceView(
            registeredSurface.organizationViewByAction?.[action]
            || registeredSurface.organizationView,
          );
          if (!requestedView) throw new Error(`Unknown organization workspace section for action: ${action}`);
          await openOrganizationSurface(requestedView, action);
          return;
        }
        if (registeredSurface) {
          if (registeredSurface.settingsSection) setSettingsSection(registeredSurface.settingsSection);
          const requestedCommandView = registeredSurface.commandCenterViewByAction?.[action];
          if (requestedCommandView) {
            openCommandCenter(requestedCommandView);
            await waitForSurfaceCommit('command-center');
            respond({
              ok: true,
              action,
              target: registeredSurface.target,
              surface: registeredSurface.id,
              view: requestedCommandView,
              rendered: true,
            });
            return;
          }
          if (action === 'open_avatar_studio') setPersonalizationSection('appearance');
          if (action === 'open_sound_studio') setPersonalizationSection('voice');
          const rendered = await openClientSurface(registeredSurface.target);
          respond({
            ok: true,
            action,
            target: registeredSurface.target,
            surface: registeredSurface.id,
            section: registeredSurface.settingsSection || '',
            rendered,
          });
          return;
        }
        throw new Error(`Unsupported client action: ${action}`);
      } catch (err: any) {
        reject(err?.message || String(err));
      }
    };

    window.addEventListener('lumi:client-action', handler);
    return () => window.removeEventListener('lumi:client-action', handler);
  }, [activeTab, applyWallpaperMode, closeSurface, endMeetingAndReport, enterDesktopWidgetMode, exitDesktopWidgetMode, isDesktopWidgetMode, openCommandCenter, openSurface, openWindows, operationMode, orgConnection?.connected, orgConnection?.orgRole, resetMeetingCapture, setOperationMode, switchDomain, workDomain, setMeetingPaused, setMeetingNotesOpen, setLegalMeetingCaseTitle, setSettingsSection, setPersonalizationSection]);

}
