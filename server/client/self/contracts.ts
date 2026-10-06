import type { OrganizationWorkspaceView } from "../../../shared/org_workspace";
import type { LumiTechnicalArchitecture } from "../../../shared/technical_architecture";
import type { LumiClientMode } from "../../../shared/operation_modes";

export type ClientMode = LumiClientMode;

export type WallpaperPresentation = 'workbench' | 'desktop-control';

export type WallpaperWorkspace = 'personal' | 'command-center' | 'organization';

export type ClientCapabilityKind =
  | 'mode'
  | 'window'
  | 'workspace'
  | 'tool_surface'
  | 'media'
  | 'meeting'
  | 'organization'
  | 'knowledge'
  | 'runtime'
  | 'settings'
  | 'permission'
  | 'system'
  | 'external_app'
  | 'collaboration';

export interface ClientCapability {
  id: string;
  label: string;
  kind: ClientCapabilityKind;
  actions: string[];
  notes: string;
  requiresConfirmation?: boolean;
  stateKeys?: string[];
}

export interface ClientInterfaceSurface {
  id: string;
  label: string;
  actions: string[];
  useWhen: string;
  closeAfterUse?: boolean;
}

export interface VisibleExecutionHabit {
  id: string;
  rule: string;
}

export interface ClientStateSnapshot {
  platform?: string;
  mode?: ClientMode;
  activeTab?: string;
  viewMode?: 'personal' | 'world' | string;
  workDomain?: 'personal' | 'work';
  org?: { connected?: boolean; id?: string; name?: string; role?: string };
  orgWorkspace?: {
    activeView?: OrganizationWorkspaceView | string;
    availableViews?: string[];
    visible?: boolean;
  };
  knowledge?: {
    domain?: 'personal' | 'work';
    orgId?: string;
    totalFiles?: number;
    indexedFiles?: number;
    verifiedFiles?: number;
    indexedUnverifiedFiles?: number;
    partialFiles?: number;
    pendingFiles?: number;
    staleFiles?: number;
    failedFiles?: number;
    unsupportedFiles?: number;
    orgArticles?: {
      total?: number;
      published?: number;
      indexed?: number;
      missingIndex?: number;
      stale?: number;
    };
    refreshedAt?: number;
    lastError?: string;
  };
  windows?: { open?: string[]; focused?: string | null; minimized?: string[] };
  surfaces?: {
    appLauncherOpen?: boolean;
    knowledgeOpen?: boolean;
    chatOpen?: boolean;
    commandCenterOpen?: boolean;
    commandCenterView?: 'office' | 'core';
    notificationsOpen?: boolean;
    memoryAvatarOpen?: boolean;
    runtimeLogOpen?: boolean;
    meetingOpen?: boolean;
    wallpaperMode?: boolean;
    wallpaperPresentation?: WallpaperPresentation;
    wallpaperWorkspace?: WallpaperWorkspace;
    widgetMode?: boolean;
    nexusOpen?: boolean;
    /** Surface ids derived from the authoritative shared client registry. */
    openSurfaceIds?: string[];
  };
  uiManifest?: {
    surfaceIds?: string[];
    actions?: string[];
    settingsSections?: string[];
    launcherIds?: string[];
  };
  settings?: { activeSection?: string };
  voice?: { state?: string; muted?: boolean };
  meeting?: {
    active?: boolean;
    noteCount?: number;
    hasReport?: boolean;
    startedAt?: number | null;
    reportGenerating?: boolean;
  };
  runtimeLog?: {
    open?: boolean;
    status?: string;
    lastError?: string;
  };
  permissions?: Record<string, string | boolean | number | null | undefined>;
  tools?: {
    agentStatus?: string;
    mcpActivityCount?: number;
  };
  runtime?: {
    autostartSupported?: boolean;
    autostartEnabled?: boolean;
    closeToBackground?: boolean;
    startedInBackground?: boolean;
    backendNodeRunning?: boolean;
    backendPythonRunning?: boolean;
    nodeRestarts?: number;
    pythonRestarts?: number;
    globalShortcut?: string;
    lastError?: string;
  };
  autonomy?: {
    autonomyLevel?: 'reactive' | 'semi' | 'full';
    alwaysOnline?: boolean;
    autoProcessEnabled?: boolean;
    messagingSendRequiresConfirmation?: boolean;
    maxConsecutiveTasks?: number;
  };
  errors?: Array<{ source: string; message: string; code?: string; at?: number }>;
  updatedAt?: number;
  socketId?: string;
}

export type ClientHealthLevel = 'ok' | 'attention' | 'degraded' | 'unknown';

export interface ClientHealthFinding {
  id: string;
  level: ClientHealthLevel;
  area: string;
  message: string;
  evidence?: string;
  safeActions?: string[];
  confirmationActions?: string[];
}

export interface ClientHealthReport {
  level: ClientHealthLevel;
  stateAgeSeconds: number | null;
  findings: ClientHealthFinding[];
  autonomyBoundary: {
    automatic: string[];
    confirmFirst: string[];
    forbidden: string[];
  };
}

export type ClientActionVerificationStatus = 'verified' | 'pending' | 'failed' | 'not_applicable';

export interface ClientStateDigest {
  mode: string;
  workDomain: string;
  activeTab: string;
  viewMode: string;
  settingsSection: string;
  focusedWindow: string;
  openWindows: string[];
  openSurfaces: string[];
  voice: string;
  meetingActive: boolean;
  wallpaperMode: boolean;
  wallpaperPresentation: WallpaperPresentation | 'unknown';
  wallpaperWorkspace: WallpaperWorkspace | 'unknown';
  runtimeStatus: string;
  orgView: string;
  knowledge: string;
  stateAgeSeconds: number | null;
  socketId: string;
}

export interface ClientActionExpectation {
  action: string;
  target?: string;
  mode?: string;
  expectedState: string[];
  requiresConfirmation: boolean;
  verification: string;
  naturalCompletion: string;
  naturalPending: string;
}

export interface ClientActionVerification {
  status: ClientActionVerificationStatus;
  matched: string[];
  missing: string[];
  expectation: ClientActionExpectation;
  before: ClientStateDigest | null;
  after: ClientStateDigest | null;
  relayOk: boolean | null;
  relayReason?: string;
  message: string;
}

export interface ClientSelfAwarenessReport {
  level: 'live' | 'stale' | 'missing';
  bodySummary: string;
  architecture: LumiTechnicalArchitecture;
  currentState: ClientStateDigest | null;
  knows: string[];
  gaps: string[];
  habits: string[];
  nextBestActions: string[];
}

export interface SelfModelSnapshot {
  schemaVersion: 1;
  factDigest: string;
  identity: {
    name: 'Lumi';
    product: 'LumiCore';
    deployment: 'private_user_directed_agent';
    continuity: 'single_identity_across_surfaces';
  };
  scope: { domain: 'personal' | 'work'; orgId: string };
  modes: Array<{ id: string; available: boolean; active: boolean }>;
  configuredModels: Array<{
    role: string;
    provider: string;
    model: string;
    configured: boolean;
    effectiveProvider?: string;
    effectiveModel?: string;
  }>;
  connectedCapabilities: {
    tools: number;
    skills: number;
    mcp: number;
    extensionProviders: number;
    adaptersReady: number;
    adaptersAttention: number;
  };
  desktopCapabilities: Array<{
    id: string;
    displayName: string;
    supportTier: string;
    certification: 'client_state_live' | 'runtime_preflight_required';
    certifiedVersion: string | null;
    requiredIdentitySignals: string[];
    controlLayers: string[];
  }>;
  knowledgeCoverage: {
    totalFiles: number;
    indexedFiles: number;
    verifiedFiles: number;
    indexedUnverifiedFiles: number;
    partialFiles: number;
    pendingFiles: number;
    staleFiles: number;
    failedFiles: number;
    unsupportedFiles: number;
    verification: 'empty' | 'verified' | 'indexed_unverified' | 'partial' | 'stale' | 'failed';
    verifiedAbsorption: boolean;
  };
  memoryState: {
    available: boolean;
    scope: 'personal' | 'organization';
    absorptionClaim: 'retrieval_and_evidence_required';
  };
  runtime: {
    awareness: 'live' | 'stale' | 'missing';
    health: ClientHealthLevel;
    stateAgeSeconds: number | null;
    sourceUpdatedAt: string | null;
    refreshRequired: boolean;
    refreshAction: 'client_self_repair(refresh_client_state)' | null;
  };
  permissions: {
    externalCommitConfirmation: 'required';
    localActions: 'policy_controlled';
    dataBoundary: 'source_and_scope_isolated';
  };
  limitations: string[];
  generatedAt: string;
}
