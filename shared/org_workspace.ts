export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';

export type OrganizationWorkspaceView =
  | 'dashboard'
  | 'kb'
  | 'kb-edit'
  | 'chat'
  | 'messaging'
  | 'members'
  | 'audit'
  | 'settings'
  | 'branch'
  | 'legal'
  | 'spatial-design'
  | 'brand-design';

export const ORGANIZATION_WORKSPACE_VIEWS: readonly OrganizationWorkspaceView[] = [
  'dashboard',
  'kb',
  'kb-edit',
  'chat',
  'messaging',
  'members',
  'audit',
  'settings',
  'branch',
  'legal',
  'spatial-design',
  'brand-design',
] as const;

export const ORGANIZATION_WORKSPACE_PUBLIC_VIEWS: readonly OrganizationWorkspaceView[] = [
  'dashboard',
  'kb',
  'chat',
  'messaging',
  'members',
  'audit',
  'settings',
  'branch',
  'legal',
  'spatial-design',
  'brand-design',
] as const;

const VIEW_ALIASES: Record<string, OrganizationWorkspaceView> = {
  home: 'dashboard',
  organization: 'dashboard',
  org: 'dashboard',
  'org-home': 'dashboard',
  'org-dashboard': 'dashboard',
  knowledge: 'kb',
  'knowledge-base': 'kb',
  'org-kb': 'kb',
  'organization-knowledge': 'kb',
  'company-knowledge': 'kb',
  'company-lumi': 'chat',
  'organization-lumi': 'chat',
  'org-lumi': 'chat',
  messages: 'messaging',
  'message-access': 'messaging',
  feishu: 'messaging',
  wecom: 'messaging',
  permissions: 'members',
  'members-and-permissions': 'members',
  logs: 'audit',
  'audit-log': 'audit',
  'org-settings': 'settings',
  'organization-settings': 'settings',
  'branch-connection': 'branch',
  'law-firm': 'legal',
  lawyer: 'legal',
  spatial: 'spatial-design',
  architecture: 'spatial-design',
  design: 'spatial-design',
  brand: 'brand-design',
  creative: 'brand-design',
};

const ADMIN_ONLY_VIEWS = new Set<OrganizationWorkspaceView>(['members', 'audit']);
const NON_VIEWER_VIEWS = new Set<OrganizationWorkspaceView>(['kb-edit', 'messaging']);

export function normalizeOrganizationWorkspaceView(value: unknown): OrganizationWorkspaceView | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return null;
  if ((ORGANIZATION_WORKSPACE_VIEWS as readonly string[]).includes(normalized)) {
    return normalized as OrganizationWorkspaceView;
  }
  return VIEW_ALIASES[normalized] || null;
}

export function canAccessOrganizationWorkspaceView(
  role: string | null | undefined,
  view: OrganizationWorkspaceView,
): boolean {
  const candidate = String(role || '').toLowerCase();
  const normalizedRole: OrganizationRole = ['owner', 'admin', 'member', 'viewer'].includes(candidate)
    ? candidate as OrganizationRole
    : 'viewer';
  if (ADMIN_ONLY_VIEWS.has(view)) return normalizedRole === 'owner' || normalizedRole === 'admin';
  if (NON_VIEWER_VIEWS.has(view)) return normalizedRole !== 'viewer';
  return true;
}

export function listOrganizationWorkspaceViewsForRole(
  role: string | null | undefined,
  options: { includeInternal?: boolean } = {},
): OrganizationWorkspaceView[] {
  const source = options.includeInternal
    ? ORGANIZATION_WORKSPACE_VIEWS
    : ORGANIZATION_WORKSPACE_PUBLIC_VIEWS;
  return source.filter(view => canAccessOrganizationWorkspaceView(role, view));
}
