export interface PersonalClientSurfaceDefinition {
  id: string;
  label: string;
  target: string;
  actions: readonly string[];
  useWhen: string;
  closeAfterUse?: boolean;
  settingsSection?: string;
  launcherIds?: readonly string[];
}

export interface ClientSettingsSectionDefinition {
  id: string;
  label: string;
  aliases: readonly string[];
  useWhen: string;
}

export const CLIENT_SETTINGS_SECTIONS: readonly ClientSettingsSectionDefinition[] = [
  {
    id: 'general',
    label: 'General settings',
    aliases: ['general', 'core', 'language', 'appearance'],
    useWhen: 'Change language, appearance, and other general client preferences.',
  },
  {
    id: 'neural',
    label: 'Agent framework and autonomy',
    aliases: ['neural', 'agent', 'agent-framework', 'autonomy', 'autonomous'],
    useWhen: 'Inspect or configure the agent framework, operation modes, and autonomous execution policy.',
  },
  {
    id: 'llm-providers',
    label: 'LLM providers',
    aliases: ['llm', 'llm-provider', 'llm-providers', 'provider', 'providers', 'models'],
    useWhen: 'Configure cloud or local language-model providers and inspect their runtime status.',
  },
  {
    id: 'vision-models',
    label: 'Vision models',
    aliases: ['vision', 'vision-model', 'vision-models', 'computer-vision'],
    useWhen: 'Configure the vision model used for screenshots and desktop understanding.',
  },
  {
    id: 'voice-services',
    label: 'Voice services',
    aliases: ['voice-service', 'voice-services', 'speech-services', 'audio-services'],
    useWhen: 'Configure speech recognition, synthesis, and voice-service providers.',
  },
  {
    id: 'security',
    label: 'Privacy, security, and biometrics',
    aliases: ['security', 'privacy', 'biometrics', 'face', 'voiceprint'],
    useWhen: 'Manage local security, background runtime security, face enrollment, and voiceprint enrollment.',
  },
  {
    id: 'hardware',
    label: 'Hardware permissions',
    aliases: ['hardware', 'permissions', 'sensors', 'camera', 'microphone'],
    useWhen: 'Inspect and configure camera, microphone, notification, and sensor permissions.',
  },
  {
    id: 'mcp',
    label: 'MCP settings',
    aliases: ['mcp', 'mcp-settings', 'model-context-protocol'],
    useWhen: 'Inspect, configure, enable, and diagnose MCP servers.',
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
    id: 'chat',
    label: 'Side chat',
    target: 'chat',
    actions: ['open_chat'],
    useWhen: 'Hold a conversation beside other work without leaving the desktop shell.',
    launcherIds: ['chat'],
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
    settingsSection: 'mcp',
    useWhen: 'Configure and diagnose MCP servers from the main settings window.',
    launcherIds: ['mcp'],
  },
  {
    id: 'runtime-log',
    label: 'Runtime log',
    target: 'runtime-log',
    actions: ['open_runtime_log'],
    useWhen: 'Inspect live execution, startup traces, tool progress, and runtime errors.',
    launcherIds: ['runtime-log'],
  },
  {
    id: 'skills',
    label: 'Skill Hall',
    target: 'skills',
    actions: ['open_skills'],
    useWhen: 'Browse installed skills, discover extensions, and inspect skill health.',
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
    id: 'team',
    label: 'Agent team',
    target: 'team',
    actions: ['open_team'],
    useWhen: 'Inspect sub-agents, delegation, orchestration, and multi-agent work.',
    launcherIds: ['team'],
  },
  {
    id: 'memory-avatar',
    label: 'Memory avatar',
    target: 'memory-avatar',
    actions: ['open_memory_avatar'],
    useWhen: 'Open the memory-avatar laboratory and embodied memory surface.',
    launcherIds: ['memory-avatar'],
  },
  {
    id: 'avatar-studio',
    label: 'Avatar Studio',
    target: 'avatar-studio',
    actions: ['open_avatar_studio'],
    useWhen: 'Design and configure Lumi appearance and avatar presentation.',
    launcherIds: ['avatar-studio'],
  },
  {
    id: 'sound',
    label: 'Sound Studio',
    target: 'sound',
    actions: ['open_sound_studio'],
    useWhen: 'Inspect voice, sound, speech, and audio presentation controls.',
    launcherIds: ['sound'],
  },
  {
    id: 'music-center',
    label: 'Music Center',
    target: 'music-center',
    actions: ['open_music_center'],
    useWhen: 'Search, play, control, and inspect music and mood-layer state.',
    closeAfterUse: false,
    launcherIds: ['music-center'],
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
    id: 'subscription',
    label: 'Subscription, activation, and billing',
    target: 'subscription',
    actions: ['open_subscription', 'open_activation', 'open_billing'],
    useWhen: 'Inspect subscription, local activation, plan, or billing information.',
    launcherIds: [],
  },
  {
    id: 'agent-ecosystem',
    label: 'Agent ecosystem',
    target: 'ecosystem',
    actions: ['open_agent_ecosystem'],
    useWhen: 'Browse Lumi agents, collaboration options, and the client ecosystem.',
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
];

const settingsSectionByAlias = new Map<string, string>();
for (const section of CLIENT_SETTINGS_SECTIONS) {
  settingsSectionByAlias.set(section.id, section.id);
  for (const alias of section.aliases) settingsSectionByAlias.set(alias, section.id);
}

const surfaceByAction = new Map<string, PersonalClientSurfaceDefinition>();
for (const surface of PERSONAL_CLIENT_SURFACES) {
  for (const action of surface.actions) surfaceByAction.set(action, surface);
}

export const PERSONAL_CLIENT_SURFACE_ACTIONS = Array.from(surfaceByAction.keys());
export const PERSONAL_CLIENT_LAUNCHER_IDS = Array.from(new Set(
  PERSONAL_CLIENT_SURFACES.flatMap(surface => [...(surface.launcherIds || [])]),
));

export function getPersonalClientSurfaceByAction(action?: string): PersonalClientSurfaceDefinition | undefined {
  return surfaceByAction.get(String(action || '').trim());
}

export function normalizeClientSettingsSection(value?: string): string | null {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!normalized) return 'general';
  return settingsSectionByAlias.get(normalized) || null;
}

export function isComputerAdaptationSettingsTarget(value?: string): boolean {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return ['computer', 'kernel', 'computer-adaptation', 'adaptation'].includes(normalized);
}
