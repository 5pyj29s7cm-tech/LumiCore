import type { ClientStateSnapshot, ClientStateDigest } from './contracts';

export const stateByUser = new Map<string, ClientStateSnapshot>();
const stateBySocket = new Map<string, { userId: string; state: ClientStateSnapshot }>();

export function updateClientState(userId: string, state: ClientStateSnapshot): ClientStateSnapshot {
  const compactList = (values?: string[]) => Array.from(new Set(
    (values || []).map(value => String(value || '').trim()).filter(Boolean),
  )).slice(0, 300);
  const snapshot: ClientStateSnapshot = {
    ...state,
    surfaces: state.surfaces
      ? {
          ...state.surfaces,
          openSurfaceIds: compactList(state.surfaces.openSurfaceIds),
        }
      : state.surfaces,
    uiManifest: state.uiManifest
      ? {
          surfaceIds: compactList(state.uiManifest.surfaceIds),
          actions: compactList(state.uiManifest.actions),
          settingsSections: compactList(state.uiManifest.settingsSections),
          launcherIds: compactList(state.uiManifest.launcherIds),
        }
      : undefined,
    updatedAt: Date.now(),
  };
  const uid = userId || 'anonymous';
  stateByUser.set(uid, snapshot);
  if (snapshot.socketId) {
    const previous = stateBySocket.get(snapshot.socketId);
    if (previous && previous.userId !== uid && stateByUser.get(previous.userId)?.socketId === snapshot.socketId) {
      stateByUser.set(previous.userId, { ...previous.state, connected: false });
    }
    stateBySocket.set(snapshot.socketId, { userId: uid, state: snapshot });
  }
  return snapshot;
}

export function disconnectClientState(userId: string, socketId: string): void {
  const uid = userId || 'anonymous';
  const current = stateBySocket.get(socketId);
  if (current?.userId !== uid) return;
  stateBySocket.delete(socketId);
  if (stateByUser.get(uid)?.socketId === socketId) {
    stateByUser.set(uid, { ...current.state, connected: false });
  }
}

export function getClientState(userId: string): ClientStateSnapshot | null {
  return stateByUser.get(userId || 'anonymous') || null;
}

export function getClientStateForScope(
  userId: string,
  scope: { domain?: string; orgId?: string; socketId?: string } = {},
): ClientStateSnapshot | null {
  const session = scope.socketId ? stateBySocket.get(scope.socketId) : undefined;
  const state = scope.socketId
    ? session?.userId === (userId || 'anonymous') ? session.state : null
    : getClientState(userId);
  if (state?.connected === false) return null;
  if (!state || !scope.domain) return state;
  if (scope.domain === 'work') {
    const knowledgeMatches = !state.knowledge
      || (state.knowledge.domain === 'work' && (!state.knowledge.orgId || state.knowledge.orgId === scope.orgId));
    return scope.orgId && state.workDomain === 'work' && state.org?.id === scope.orgId && knowledgeMatches ? state : null;
  }
  return state.workDomain === 'work' || state.knowledge?.domain === 'work' ? null : state;
}

export function getClientStateDigest(state: ClientStateSnapshot | null | undefined): ClientStateDigest | null {
  if (!state) return null;
  const openWindows = [...(state.windows?.open || [])];
  const openSurfaces: string[] = [...(state.surfaces?.openSurfaceIds || [])];
  if (state.activeTab) openSurfaces.push(`tab:${state.activeTab}`);
  if (state.viewMode) openSurfaces.push(`view:${state.viewMode}`);
  if (state.viewMode === 'world' || state.surfaces?.nexusOpen) openSurfaces.push('nexus');
  if (state.surfaces?.appLauncherOpen) openSurfaces.push('app-launcher');
  if (state.surfaces?.knowledgeOpen) openSurfaces.push('knowledge');
  if (state.surfaces?.commandCenterOpen || state.surfaces?.chatOpen) openSurfaces.push('command-center');
  if (state.surfaces?.notificationsOpen) openSurfaces.push('notifications');
  if (state.surfaces?.memoryAvatarOpen) openSurfaces.push('memory-avatar');
  if (state.surfaces?.runtimeLogOpen || state.runtimeLog?.open) openSurfaces.push('runtime-log');
  if (state.surfaces?.meetingOpen || state.meeting?.active) openSurfaces.push('meeting');
  if (state.surfaces?.wallpaperMode) openSurfaces.push('wallpaper');
  if (state.surfaces?.widgetMode) openSurfaces.push('widget');
  const orgView = state.orgWorkspace?.activeView || 'none';
  if (state.activeTab === 'org' && orgView !== 'none') openSurfaces.push(`org:${orgView}`);
  for (const win of openWindows) {
    if (!openSurfaces.includes(win)) openSurfaces.push(win);
  }
  const stateAgeSeconds = state.updatedAt ? Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000)) : null;
  const knowledge = state.knowledge
    ? `${state.knowledge.domain || state.workDomain || 'personal'}:files=${state.knowledge.totalFiles || 0},indexed=${state.knowledge.indexedFiles || 0},partial=${state.knowledge.partialFiles || 0},pending=${state.knowledge.pendingFiles || 0},failed=${state.knowledge.failedFiles || 0},unsupported=${state.knowledge.unsupportedFiles || 0}${state.knowledge.orgArticles ? `,orgArticles=${state.knowledge.orgArticles.total || 0},orgIndexed=${state.knowledge.orgArticles.indexed || 0},orgMissing=${state.knowledge.orgArticles.missingIndex || 0},orgStale=${state.knowledge.orgArticles.stale || 0}` : ''}`
    : 'unknown';
  return {
    mode: state.mode || 'unknown',
    workDomain: state.workDomain || 'personal',
    activeTab: state.activeTab || 'unknown',
    viewMode: state.viewMode || 'unknown',
    settingsSection: state.settings?.activeSection || 'none',
    focusedWindow: state.windows?.focused || 'none',
    openWindows,
    openSurfaces,
    voice: `${state.voice?.state || 'idle'}${state.voice?.muted ? '/muted' : ''}`,
    meetingActive: Boolean(state.meeting?.active),
    wallpaperMode: Boolean(state.surfaces?.wallpaperMode),
    wallpaperPresentation: state.surfaces?.wallpaperPresentation || 'unknown',
    wallpaperWorkspace: state.surfaces?.wallpaperWorkspace || 'unknown',
    runtimeStatus: state.runtimeLog?.status || (state.runtime?.lastError ? 'attention' : 'ready'),
    orgView,
    knowledge,
    stateAgeSeconds,
    socketId: state.socketId || 'unknown',
  };
}
