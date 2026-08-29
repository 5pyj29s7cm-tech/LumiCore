export interface PersonalClientSurfaceDefinition {
  id: string;
  label: string;
  target: string;
  actions: readonly string[];
  useWhen: string;
  closeAfterUse?: boolean;
  settingsSection?: string;
  launcherIds?: readonly string[];
  /** Spoken or typed names that must resolve to this native client surface. */
  navigationAliases?: readonly string[];
  organizationView?: string;
  organizationViewByAction?: Readonly<Record<string, string>>;
  commandCenterViewByAction?: Readonly<Record<string, 'office' | 'core'>>;
}

export interface ClientSettingsSectionDefinition {
  id: string;
  label: string;
  aliases: readonly string[];
  useWhen: string;
}

export interface PersonalClientSurfaceVisibilityState {
  activeTab?: string;
  viewMode?: string;
  workDomain?: string;
  focusedWindow?: string | null;
  openWindows?: readonly string[];
  settingsSection?: string;
  appLauncherOpen?: boolean;
  knowledgeOpen?: boolean;
  chatOpen?: boolean;
  commandCenterOpen?: boolean;
  commandCenterView?: 'office' | 'core';
  notificationsOpen?: boolean;
  memoryAvatarOpen?: boolean;
  meetingOpen?: boolean;
  wallpaperMode?: boolean;
  widgetMode?: boolean;
  organizationWorkspaceVisible?: boolean;
  organizationWorkspaceView?: string;
}

const DATA_SOURCE_SETTINGS_ALIASES = [
  'data-source', 'data-sources', 'factual-data', 'external-data',
] as const;

const APPLICATION_SETTINGS_ALIASES = [
  'application', 'applications', 'app-connection', 'app-connections',
  'application-connection', 'application-connections', 'integrations', 'integration',
] as const;

export const CLIENT_SETTINGS_SECTIONS: readonly ClientSettingsSectionDefinition[] = [
  {
    id: 'general',
    label: 'General settings',
    aliases: ['general', 'core', 'language', 'appearance'],
    useWhen: 'Change language, appearance, and other general client preferences.',
  },
  {
    id: 'neural',
    label: 'LumiCore and autonomy',
    aliases: ['neural', 'lumicore', 'autonomy', 'autonomous'],
    useWhen: 'Inspect or configure LumiCore, operation modes, and autonomous execution policy.',
  },
  {
    id: 'ai-providers',
    label: 'AI providers',
    aliases: [
      'ai-provider', 'ai-providers', 'provider', 'providers', 'model-provider', 'model-providers',
      'llm', 'llm-provider', 'llm-providers', 'api-provider', 'api-providers',
    ],
    useWhen: 'Configure credentials, endpoints, and local runtimes for every model provider in one place.',
  },
  {
    id: 'reasoning-model',
    label: 'Reasoning model',
    aliases: ['model', 'models', 'model-role', 'model-roles', 'model-routing', 'reasoning', 'reasoning-model'],
    useWhen: 'Choose the configured provider and model used for reasoning and general conversation.',
  },
  {
    id: 'world-model',
    label: 'World model',
    aliases: ['world', 'world-model', 'world-models', 'vision', 'vision-model', 'vision-models', 'computer-vision', 'desktop-action-model', 'document-model', 'document-models'],
    useWhen: 'Choose configured visual perception and desktop action models; document understanding reuses world and reasoning models.',
  },
  {
    id: 'generation-model',
    label: 'Generation model',
    aliases: ['generation', 'generative', 'generation-model', 'generation-models', 'generative-models', 'image-model', 'video-model'],
    useWhen: 'Choose configured image and video generation models.',
  },
  {
    id: 'retrieval-model',
    label: 'Retrieval model',
    aliases: ['retrieval-model', 'retrieval-models', 'embedding-model', 'rerank-model', 'knowledge-retrieval-model'],
    useWhen: 'Choose the configured Embedding semantic-recall model and optional Rerank candidate-ordering model.',
  },
  {
    id: 'voice-model',
    label: 'Voice and sound model',
    aliases: ['voice-model', 'voice-service', 'voice-services', 'speech-model', 'speech-models', 'speech-services', 'audio-services'],
    useWhen: 'Choose configured speech recognition, synthesis, and sound models.',
  },
  {
    id: 'external-connections',
    label: 'External connections',
    aliases: [
      'external-connection', 'external-connections',
      ...DATA_SOURCE_SETTINGS_ALIASES,
      ...APPLICATION_SETTINGS_ALIASES,
    ],
    useWhen: 'Configure external data sources and application connections. Data sources are read-oriented factual services; applications may read, write, or act.',
  },
  {
    id: 'tools',
    label: 'Tool runtimes',
    aliases: [
      'tool', 'tools', 'tool-runtime', 'tool-runtimes', 'tool-connection', 'tool-connections',
      'connections', 'connection', 'connections-tools', 'app-tool', 'app-tools', 'application-tool', 'application-tools',
      'mcp', 'mcp-settings', 'model-context-protocol',
    ],
    useWhen: 'Configure execution-tool credentials, inspect runtimes, and diagnose or add private custom MCP connections.',
  },
  {
    id: 'security',
    label: 'Privacy, security, and biometrics',
    aliases: ['security', 'privacy', 'biometrics', 'face', 'voiceprint', 'safety-model', 'safety-models', 'moderation-model'],
    useWhen: 'Manage local security, policy enforcement, auditing, background runtime security, face enrollment, and voiceprint enrollment.',
  },
  {
    id: 'hardware',
    label: 'Hardware permissions',
    aliases: ['hardware', 'permissions', 'sensors', 'camera', 'microphone'],
    useWhen: 'Inspect and configure camera, microphone, notification, and sensor permissions.',
  },
  {
    id: 'voice',
    label: 'Voice Forge',
    aliases: ['voice', 'voice-forge', 'voice-clone', 'voice-cloning'],
    useWhen: 'Create, clone, preview, and select Lumi voices.',
  },
];

export const PERSONAL_CLIENT_SURFACES: readonly PersonalClientSurfaceDefinition[] = [
  {
    id: 'home',
    label: 'Home / desktop shell',
    target: 'home',
    actions: ['focus_home'],
    useWhen: 'Return to the main Lumi desktop and clear temporary client windows.',
    launcherIds: [],
  },
  {
    id: 'personal-workspace',
    label: 'Personal workspace',
    target: 'home',
    actions: ['open_personal_workspace'],
    useWhen: 'Return the same Lumi to the private personal workspace without carrying organization data across the boundary.',
    launcherIds: [],
  },
  {
    id: 'nexus',
    label: 'Nexus / central world',
    target: 'nexus',
    actions: ['open_nexus'],
    useWhen: 'Open the full central-world view of the Lumi client.',
    closeAfterUse: false,
    launcherIds: [],
  },
  {
    id: 'app-launcher',
    label: 'App launcher and search',
    target: 'app-launcher',
    actions: ['open_app_launcher'],
    useWhen: 'Search and inspect all installed Lumi client interfaces from one launcher.',
    launcherIds: [],
  },
  {
    id: 'command-center',
    label: 'Lumi command center',
    target: 'command-center',
    navigationAliases: ['指挥中心', 'Lumi 指挥中心', 'Lumi指挥中心'],
    actions: ['open_command_center', 'open_chat'],
    commandCenterViewByAction: {
      open_command_center: 'office',
      open_chat: 'office',
    },
    useWhen: 'Converse with Lumi, inspect persistent tasks and receipts, and enter the LumiCore workspace.',
    // The command center is a permanent top-level navigation destination,
    // not a duplicated desktop/app-launcher icon.
    launcherIds: [],
  },
  {
    id: 'knowledge',
    label: 'Knowledge base and memory',
    target: 'knowledge',
    actions: ['show_knowledge_base', 'open_files'],
    useWhen: 'Browse, import, absorb, search, and inspect indexing health for current-workspace knowledge.',
    launcherIds: ['knowledge', 'memory'],
  },
  {
    id: 'memory-avatar',
    label: 'Memory Avatar sanctuary',
    target: 'memory-avatar',
    navigationAliases: ['memory avatar', 'memory avatars', '记忆化身', '记忆头像', '记忆空间'],
    actions: ['open_memory_avatar'],
    useWhen: 'Open a private, frozen, tool-free Memory Avatar distilled from user-provided conversation records.',
    // Memory Avatar is entered from the Command Center switcher. It is still
    // a registered surface/action, but it is intentionally not a desktop
    // launcher icon anymore.
    launcherIds: [],
  },
  {
    id: 'personality',
    label: 'Personality Lab',
    target: 'personality',
    actions: ['open_personality_lab'],
    useWhen: 'Inspect Lumi personality traits, expression style, evolution, and personality records.',
    launcherIds: ['personality'],
  },
  {
    id: 'computer-adaptation',
    label: 'Kernel monitor and computer adaptation',
    target: 'kernel',
    actions: ['open_computer_adaptation'],
    useWhen: 'Inspect this computer, detected applications, runtime health, and adaptation recommendations.',
    launcherIds: ['kernel'],
  },
  {
    id: 'devices',
    label: 'Device sync center',
    target: 'devices',
    actions: ['open_devices'],
    useWhen: 'Inspect device pairing, synchronization, and connected-device state.',
    launcherIds: ['devices', 'sync'],
  },
  {
    id: 'settings',
    label: 'Settings',
    target: 'settings',
    actions: ['open_settings'],
    useWhen: 'Open product, provider, permission, voice, security, and runtime settings.',
    launcherIds: ['settings'],
  },
  {
    id: 'voice-forge',
    label: 'Voice Forge',
    target: 'settings',
    actions: ['open_voice_forge'],
    settingsSection: 'voice',
    useWhen: 'Create, clone, preview, or select a Lumi voice.',
    launcherIds: ['voice'],
  },
  {
    id: 'mcp-settings',
    label: 'MCP settings',
    target: 'settings',
    actions: ['open_mcp_settings'],
    settingsSection: 'tools',
    useWhen: 'Inspect MCP runtime health, restart a connection, or add a private custom server from Tool Runtimes. Use Skill Hall for discovery, install, enablement, repair, and removal.',
    launcherIds: ['mcp'],
  },
  {
    id: 'skills',
    label: 'Skill Hall',
    target: 'skills',
    actions: ['open_skills'],
    useWhen: 'Discover, install, enable, repair, and remove skills or MCP extensions, and inspect their health.',
    launcherIds: ['skills'],
  },
  {
    id: 'skill-generator',
    label: 'Skill generator',
    target: 'generate',
    actions: ['open_skill_generator'],
    useWhen: 'Open the client-native skill generation and extension workspace.',
    launcherIds: [],
  },
  {
    id: 'tools',
    label: 'Tools catalog',
    target: 'tools',
    actions: ['open_tools'],
    useWhen: 'Inspect executable tools, categories, status, and invocation surfaces.',
    launcherIds: ['tools'],
  },
  {
    id: 'personalization',
    label: 'Personalization',
    target: 'personalization',
    actions: ['open_personalization', 'open_avatar_studio', 'open_sound_studio'],
    useWhen: 'Design Lumi appearance and configure voice, sound, speech, and audio presentation in one place.',
    launcherIds: ['personalization'],
  },
  {
    id: 'notifications',
    label: 'Notification Center',
    target: 'notifications',
    actions: ['open_notifications'],
    useWhen: 'Inspect proactive updates, completed work, blockers, and client notifications.',
    launcherIds: ['notifications'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    target: 'terminal',
    actions: ['open_terminal'],
    useWhen: 'Open the client terminal surface for visible local command work.',
    launcherIds: ['terminal'],
  },
  {
    id: 'reminders',
    label: 'Reminders',
    target: 'reminders',
    actions: ['open_reminders'],
    useWhen: 'Inspect and manage reminders and scheduled prompts.',
    launcherIds: ['reminders'],
  },
  {
    id: 'plans',
    label: 'Plans and work queue',
    target: 'plans',
    actions: ['open_plans', 'open_work_queue'],
    useWhen: 'Inspect queued work, recurring workflows, checkpoints, and autonomous execution plans.',
    launcherIds: ['plans'],
  },
  {
    id: 'tokens',
    label: 'Model and token usage',
    target: 'tokens',
    actions: ['open_token_dashboard'],
    useWhen: 'Inspect provider, model, call, and token-usage summaries.',
    launcherIds: ['tokens'],
  },
  {
    id: 'profile',
    label: 'Personal profile',
    target: 'profile',
    actions: ['open_profile'],
    useWhen: 'Inspect the current local user profile and account-facing preferences.',
    launcherIds: ['profile'],
  },
  {
    id: 'github-mcp',
    label: 'GitHub MCP browser',
    target: 'github-mcp',
    actions: ['open_github_mcp'],
    useWhen: 'Browse GitHub MCP integrations and repository-backed extension options.',
    launcherIds: [],
  },
  {
    id: 'docs',
    label: 'Documentation',
    target: 'docs',
    actions: ['open_docs'],
    useWhen: 'Open built-in Lumi product and usage documentation.',
    launcherIds: [],
  },
  {
    id: 'founders',
    label: 'Founder workspace',
    target: 'founders',
    actions: ['open_founders_sanctuary'],
    useWhen: 'Open the founder-facing private workspace when it is available to the current user.',
    launcherIds: [],
  },
  {
    id: 'org',
    label: 'Organization workspace',
    target: 'org',
    actions: ['open_organization_workspace'],
    organizationView: 'dashboard',
    useWhen: 'Enter the role-scoped organization overlay for the same Lumi identity.',
    launcherIds: [],
  },
  {
    id: 'org-dashboard',
    label: 'Organization dashboard',
    target: 'org',
    actions: ['open_organization_dashboard'],
    organizationView: 'dashboard',
    useWhen: 'Show organization status, shared work, and the main organization destinations.',
    launcherIds: [],
  },
  {
    id: 'org-knowledge',
    label: 'Organization knowledge base',
    target: 'org',
    actions: ['open_organization_knowledge'],
    organizationView: 'kb',
    useWhen: 'Browse role-authorized organization articles, uploaded sources, and indexing health.',
    launcherIds: [],
  },
  {
    id: 'org-lumi',
    label: 'Lumi in the organization workspace',
    target: 'org',
    actions: ['open_organization_chat'],
    organizationView: 'chat',
    useWhen: 'Chat with the same Lumi under the active organization scope.',
    launcherIds: [],
  },
  {
    id: 'org-messaging',
    label: 'Organization messaging',
    target: 'org',
    actions: ['open_organization_messaging'],
    organizationView: 'messaging',
    useWhen: 'Manage role-authorized organization message connections and routed messages.',
    launcherIds: [],
  },
  {
    id: 'org-governance',
    label: 'Members, permissions, and audit',
    target: 'org',
    actions: ['open_organization_members', 'open_organization_audit'],
    organizationView: 'members',
    organizationViewByAction: { open_organization_audit: 'audit' },
    useWhen: 'Administer members, permissions, and audit records when the active role allows it.',
    launcherIds: [],
  },
  {
    id: 'org-settings',
    label: 'Organization settings and branch connection',
    target: 'org',
    actions: ['open_organization_settings', 'open_organization_branch'],
    organizationView: 'settings',
    organizationViewByAction: { open_organization_branch: 'branch' },
    useWhen: 'Open organization settings or branch connection.',
    launcherIds: [],
  },
  {
    id: 'org-legal',
    label: 'Law firm workspace',
    target: 'org',
    actions: ['open_organization_legal'],
    organizationView: 'legal',
    useWhen: 'Open organization-scoped cases, evidence, legal research, and delivery gates.',
    launcherIds: [],
  },
  {
    id: 'org-spatial-design',
    label: 'Spatial and architecture workspace',
    target: 'org',
    actions: ['open_organization_spatial_design'],
    organizationView: 'spatial-design',
    useWhen: 'Open spatial, architecture, CAD, and design-delivery work.',
    launcherIds: [],
  },
  {
    id: 'org-brand-design',
    label: 'Brand and creative workspace',
    target: 'org',
    actions: ['open_organization_brand_design'],
    organizationView: 'brand-design',
    useWhen: 'Open organization brand, campaign, visual, and creative-delivery work.',
    launcherIds: [],
  },
  {
    id: 'meeting',
    label: 'Meeting mode and notes',
    target: 'meeting',
    actions: ['start_meeting_mode', 'end_meeting_mode', 'open_meeting_notes'],
    useWhen: 'Capture meeting transcription, notes, and reports after explicit user intent.',
    closeAfterUse: false,
    launcherIds: [],
  },
  {
    id: 'wallpaper',
    label: 'Wallpaper mode',
    target: 'wallpaper',
    actions: ['set_wallpaper_mode'],
    useWhen: 'Make visible external-application work immersive while keeping state explicit.',
    launcherIds: [],
  },
  {
    id: 'widget',
    label: 'Desktop widget mode',
    target: 'widget',
    actions: ['enter_widget_mode', 'show_desktop_widget', 'exit_widget_mode', 'expand_from_widget'],
    useWhen: 'Collapse Lumi into or expand Lumi out of the desktop widget shell.',
    closeAfterUse: false,
    launcherIds: [],
  },
];

const settingsSectionByAlias = new Map<string, string>();
for (const section of CLIENT_SETTINGS_SECTIONS) {
  settingsSectionByAlias.set(section.id, section.id);
  for (const alias of section.aliases) settingsSectionByAlias.set(alias, section.id);
}

const settingsConnectionTabByAlias = new Map<string, string>();
for (const alias of DATA_SOURCE_SETTINGS_ALIASES) settingsConnectionTabByAlias.set(alias, 'data-sources');
for (const alias of APPLICATION_SETTINGS_ALIASES) settingsConnectionTabByAlias.set(alias, 'applications');

const surfaceByAction = new Map<string, PersonalClientSurfaceDefinition>();
const surfaceByTarget = new Map<string, PersonalClientSurfaceDefinition>();
for (const surface of PERSONAL_CLIENT_SURFACES) {
  for (const action of surface.actions) surfaceByAction.set(action, surface);
  if (!surfaceByTarget.has(surface.target)) surfaceByTarget.set(surface.target, surface);
  for (const launcherId of surface.launcherIds || []) {
    if (!surfaceByTarget.has(launcherId)) surfaceByTarget.set(launcherId, surface);
  }
}

export const PERSONAL_CLIENT_SURFACE_ACTIONS = Array.from(surfaceByAction.keys());
export const PERSONAL_CLIENT_LAUNCHER_IDS = Array.from(new Set(
  PERSONAL_CLIENT_SURFACES.flatMap(surface => [...(surface.launcherIds || [])]),
));

export function getPersonalClientSurfaceByAction(action?: string): PersonalClientSurfaceDefinition | undefined {
  return surfaceByAction.get(String(action || '').trim());
}

export function getPersonalClientSurfaceByTarget(target?: string): PersonalClientSurfaceDefinition | undefined {
  return surfaceByTarget.get(String(target || '').trim().toLowerCase());
}

/**
 * Data-migration helper for persisted workflows created before the explicit
 * surface registry. Runtime client_action does not accept these legacy names.
 */
export function migratePersistedClientActionName(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === 'open_runtime_log') return 'open_computer_adaptation';
  if (raw === 'set_mode') return 'set_client_mode';
  if (raw === 'close_app') return 'close_client_surface';
  const legacyOpen = raw.match(/^open_app(?::(.+))?$/);
  if (!legacyOpen) return raw;
  const legacyTarget = String(legacyOpen[1] || '').toLowerCase();
  const explicitLegacyTargets: Record<string, string> = {
    'runtime-log': 'open_computer_adaptation',
    kernel: 'open_computer_adaptation',
    sound: 'open_sound_studio',
    'avatar-studio': 'open_avatar_studio',
  };
  if (explicitLegacyTargets[legacyTarget]) return explicitLegacyTargets[legacyTarget];
  const surface = getPersonalClientSurfaceByTarget(legacyTarget);
  return surface?.actions[0] || null;
}

export function normalizeClientSettingsSection(value?: string): string | null {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!normalized) return 'general';
  const connectionTab = settingsConnectionTabByAlias.get(normalized);
  if (connectionTab) return connectionTab;
  return settingsSectionByAlias.get(normalized) || null;
}

export function isComputerAdaptationSettingsTarget(value?: string): boolean {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return ['computer', 'kernel', 'computer-adaptation', 'adaptation'].includes(normalized);
}

/**
 * Resolve visible personal-client surfaces from the same registry used by the
 * action router. This prevents hand-maintained state flags from drifting away
 * from renamed or merged UI destinations.
 */
export function getOpenPersonalClientSurfaceIds(
  state: PersonalClientSurfaceVisibilityState,
): string[] {
  const openWindows = new Set(state.openWindows || []);
  const targetVisible = (target: string): boolean => (
    state.activeTab === target
    || state.focusedWindow === target
    || openWindows.has(target)
  );

  return PERSONAL_CLIENT_SURFACES
    .filter(surface => {
      if (surface.id === 'personal-workspace') {
        return state.workDomain === 'personal' && state.activeTab === 'home';
      }
      if (surface.id === 'nexus') return state.viewMode === 'world';
      if (surface.id === 'app-launcher') return Boolean(state.appLauncherOpen);
      if (surface.id === 'knowledge') return Boolean(state.knowledgeOpen);
      if (surface.id === 'command-center') return Boolean(state.commandCenterOpen || state.chatOpen);
      if (surface.id === 'notifications') return Boolean(state.notificationsOpen);
      if (surface.id === 'memory-avatar') return Boolean(state.memoryAvatarOpen);
      if (surface.id === 'meeting') return Boolean(state.meetingOpen);
      if (surface.id === 'wallpaper') return Boolean(state.wallpaperMode);
      if (surface.id === 'widget') return Boolean(state.widgetMode);
      if (surface.organizationView) {
        if (!state.organizationWorkspaceVisible) return false;
        if (surface.id === 'org') return true;
        return state.organizationWorkspaceView === surface.organizationView;
      }
      if (surface.settingsSection) {
        return targetVisible(surface.target) && state.settingsSection === surface.settingsSection;
      }
      return targetVisible(surface.target);
    })
    .map(surface => surface.id);
}
