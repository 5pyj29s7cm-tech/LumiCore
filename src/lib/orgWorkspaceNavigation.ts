import {
  normalizeOrganizationWorkspaceView,
  type OrganizationWorkspaceView,
} from '../../shared/org_workspace';

const PENDING_ROUTE_KEY = 'lumi_pending_organization_workspace_route';

export interface PendingOrganizationWorkspaceRoute {
  view: OrganizationWorkspaceView;
  articleId?: string;
}

export function queueOrganizationWorkspaceRoute(value: unknown, articleId?: unknown): PendingOrganizationWorkspaceRoute | null {
  const view = normalizeOrganizationWorkspaceView(value);
  if (!view) return null;
  const route: PendingOrganizationWorkspaceRoute = {
    view,
    ...(articleId ? { articleId: String(articleId) } : {}),
  };
  try {
    window.sessionStorage.setItem(PENDING_ROUTE_KEY, JSON.stringify(route));
  } catch {}
  return route;
}

export function takePendingOrganizationWorkspaceRoute(): PendingOrganizationWorkspaceRoute | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_ROUTE_KEY);
    window.sessionStorage.removeItem(PENDING_ROUTE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const view = normalizeOrganizationWorkspaceView(parsed?.view);
    if (!view) return null;
    return {
      view,
      ...(parsed?.articleId ? { articleId: String(parsed.articleId) } : {}),
    };
  } catch {
    return null;
  }
}

export function clearPendingOrganizationWorkspaceRoute(): void {
  try {
    window.sessionStorage.removeItem(PENDING_ROUTE_KEY);
  } catch {}
}
