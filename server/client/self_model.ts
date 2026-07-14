import { getGateConfig } from '../autonomy/safety_gate';
import { listAutonomousWorkflows } from '../autonomy/workflows';
import { formatLAPSelfPrompt } from '../lap/policy';
import { getMemoryFirewallPolicy } from '../memory/firewall';
import { formatMusicProfileForPrompt, getCachedMusicProfile } from '../music/library_profile';
import { getAdapterRegistry } from '../adapters/registry';
import { formatLumiConstitutionForPrompt } from '../personality/constitution';
import { getActionConstitutionPolicy } from '../tools/action_constitution';
import { formatDesktopAwarenessForPrompt } from './desktop_awareness';
import { listCapabilityLearningRecords } from '../self_extension/capability_memory';
import {
  normalizeOrganizationWorkspaceView,
  type OrganizationWorkspaceView,
} from '../../shared/org_workspace';
import {
  CLIENT_SETTINGS_SECTIONS,
  PERSONAL_CLIENT_SURFACES,
  PERSONAL_CLIENT_SURFACE_ACTIONS,
  getPersonalClientSurfaceByAction,
  isComputerAdaptationSettingsTarget,
  normalizeClientSettingsSection,
} from '../../shared/client_surfaces';

export type ClientMode = 'chat' | 'assistant' | 'autonomous' | 'meeting';
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
    partialFiles?: number;
    pendingFiles?: number;
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
    notificationsOpen?: boolean;
    memoryAvatarOpen?: boolean;
    runtimeLogOpen?: boolean;
    meetingOpen?: boolean;
    musicLayerVisible?: boolean;
    wallpaperMode?: boolean;
    widgetMode?: boolean;
    nexusOpen?: boolean;
  };
  settings?: { activeSection?: string };
  voice?: { state?: string; muted?: boolean };
  music?: {
    visible?: boolean;
    isPlaying?: boolean;
    trackName?: string;
    artists?: string[];
    album?: string;
    source?: string | null;
    progress?: number;
    duration?: number;
    volume?: number;
    mood?: string;
    hasLyrics?: boolean;
    layerVisible?: boolean;
    lastError?: string;
  };
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
    workflowStepCount?: number;
    runningWorkflowSteps?: number;
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
  music: string;
  meetingActive: boolean;
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
  currentState: ClientStateDigest | null;
  knows: string[];
  gaps: string[];
  habits: string[];
  nextBestActions: string[];
}

const CLIENT_CAPABILITIES: ClientCapability[] = [
  {
    id: 'mode.chat',
    label: 'Chat mode',
    kind: 'mode',
    actions: ['set_client_mode(chat)'],
    notes: 'Pure conversation state. Lumi answers, explains, and discusses without tools. A clear real-action request transitions the client and turn to Assistant before execution; explicit continuous work uses Autonomy.',
    stateKeys: ['mode', 'voice'],
  },
  {
    id: 'mode.meeting',
    label: 'Meeting mode',
    kind: 'meeting',
    actions: ['start_meeting_mode', 'end_meeting_mode', 'open_meeting_notes'],
    notes: 'Starts transcription-only voice capture, collects meeting notes, and can end with a meeting report.',
    requiresConfirmation: true,
    stateKeys: ['mode', 'meeting', 'voice'],
  },
  {
    id: 'mode.assistant',
    label: 'Assistant mode',
    kind: 'mode',
    actions: ['set_client_mode(assistant)'],
    notes: 'User-present high-permission execution. Lumi can use tools, files, browser, saved/authorized sessions, external apps, desktop control, skills, and teams for requested ordinary work without per-tool permission popups; hard boundaries stop for explicit confirmation or handoff.',
    stateKeys: ['mode', 'tools'],
  },
  {
    id: 'mode.autonomous',
    label: 'Autonomy mode',
    kind: 'mode',
    actions: ['set_client_mode(autonomous)', 'open_runtime_log'],
    notes: 'Same practical permissions as Assistant, plus 24h continuous/background operation, proactive questions, monitoring, memory absorption, local-machine body learning, industry-habit-aware public-source web learning, sorting, task checkpoints, and ultra-long continuation.',
    stateKeys: ['mode', 'runtimeLog', 'tools'],
  },
  {
    id: 'window.manager',
    label: 'Desktop window manager',
    kind: 'window',
    actions: ['open_app', 'close_app', 'focus_home', 'open_nexus', 'close_nexus'],
    notes: 'Manages Lumi desktop windows and full-screen surfaces through routed client actions rather than mouse/keyboard control.',
    stateKeys: ['windows', 'surfaces'],
  },
  {
    id: 'workspace.nexus',
    label: 'Nexus / central world view',
    kind: 'workspace',
    actions: ['open_nexus', 'close_nexus'],
    notes: 'The large central world view inside LumiOS. It is a client-native viewMode, not an external website.',
    stateKeys: ['viewMode', 'surfaces.nexusOpen'],
  },
  {
    id: 'window.chat',
    label: 'Side chat window',
    kind: 'window',
    actions: ['open_chat', 'close_app:chat'],
    notes: 'Compact chat surface for direct conversation inside the desktop client.',
    stateKeys: ['surfaces.chatOpen'],
  },
  {
    id: 'workspace.org',
    label: 'Organization workspace',
    kind: 'organization',
    actions: ['open_organization_workspace(section=dashboard|kb|chat|messaging|templates|review|members|audit|settings|branch|legal|spatial-design|brand-design)'],
    notes: 'A work-space overlay for the same Lumi identity. It exposes role-scoped organization knowledge, company Lumi chat, messaging, templates, members, audit, settings/branch connection, legal, spatial architecture, and brand creative work without merging any member personal memory.',
    stateKeys: ['workDomain', 'org', 'orgWorkspace', 'knowledge'],
  },
  {
    id: 'workspace.runtime_log',
    label: 'Runtime log',
    kind: 'runtime',
    actions: ['open_runtime_log'],
    notes: 'Live run log for startup, server traces, and runtime errors.',
    stateKeys: ['runtimeLog', 'runtime', 'errors'],
  },
  {
    id: 'workspace.knowledge',
    label: 'Knowledge base and memory',
    kind: 'knowledge',
    actions: ['show_knowledge_base', 'open_files'],
    notes: 'The current-domain knowledge surface. Personal uploads remain personal; work uploads become organization knowledge. Saved, extracted, indexed, partial, pending, and failed are distinct states.',
    stateKeys: ['surfaces.knowledgeOpen', 'knowledge'],
  },
  {
    id: 'window.device_sync',
    label: 'Device sync center',
    kind: 'window',
    actions: ['open_app:devices'],
    notes: 'Device pairing and synchronization center for local and connected devices.',
    stateKeys: ['windows'],
  },
  {
    id: 'window.avatar_sound',
    label: 'Avatar, voice, and sound surfaces',
    kind: 'window',
    actions: ['open_avatar_studio', 'open_sound_studio', 'open_memory_avatar', 'open_app:avatar-studio', 'open_app:sound', 'open_app:memory-avatar'],
    notes: 'Avatar design, voice/sound configuration, and memory avatar lab surfaces.',
    stateKeys: ['windows'],
  },
  {
    id: 'system.interface_awareness',
    label: 'Interface awareness',
    kind: 'system',
    actions: ['client_get_state', 'client_action', 'adapter_registry_list', ...PERSONAL_CLIENT_SURFACE_ACTIONS],
    notes: `Lumi knows every registered personal-client interface, its purpose, native route, current state, and verification contract: ${PERSONAL_CLIENT_SURFACES.map(surface => surface.id).join(', ')}. Organization, meeting, wallpaper, widget, and large takeover surfaces remain additional scoped interfaces.`,
    stateKeys: ['windows', 'surfaces', 'tools', 'runtimeLog', 'music', 'meeting', 'org'],
  },
  {
    id: 'system.local_machine_awareness',
    label: 'Local machine awareness',
    kind: 'system',
    actions: ['client_get_state', 'client_health_check', 'desktop_system_info', 'desktop_list_apps', 'desktop_list_files', 'desktop_path_info', 'desktop_running_processes', 'desktop_active_window', 'desktop_capture_screen', 'adapter_registry_list'],
    notes: 'Lumi treats this host as her local machine body only through evidence: OS and home directory, launchable apps, files/folders, foreground window, running processes, and screenshots from the desktop relay. In Autonomy mode she may run bounded local body learning: observe app inventory, top-level file/folder landmarks, running processes, active window, and runtime signals, then produce a body map with uncertainty. Before claiming what is installed, where a file is, what is on the Desktop, or what is currently running, refresh the relevant machine/desktop fact instead of guessing.',
    stateKeys: ['runtime', 'tools', 'windows', 'surfaces', 'permissions'],
  },
  {
    id: 'runtime.background_residency',
    label: 'Background runtime awareness',
    kind: 'runtime',
    actions: ['client_get_state', 'client_health_check', 'open_runtime_log', 'client_self_repair', 'desktop_idle_time', 'desktop_poll_activity', 'autonomy_get_policy', 'autonomy_list_workflows', 'autonomy_register_workflow'],
    notes: 'Lumi distinguishes visible window state, hidden-to-background resident client state, backend process health, launch-at-login, close-to-background, and autonomous workflow execution. Resident background availability requires the desktop client/server to be alive; autonomous background work follows the desktop mode/autonomy policy, token budget, and enabled workflow rules. Assistant is low-friction for user-present work; Autonomy is for continuous execution. Verify runtime state before promising that Lumi will keep working after the window is hidden or after restart.',
    requiresConfirmation: false,
    stateKeys: ['runtime', 'runtimeLog', 'autonomy', 'mode', 'permissions', 'tools'],
  },
  {
    id: 'system.visible_execution',
    label: 'Visible task execution',
    kind: 'system',
    actions: ['client_get_state', 'client_action', 'desktop_show_lumi_window', 'desktop_active_window', 'desktop_running_processes', 'desktop_idle_time', 'desktop_poll_activity', 'desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'desktop_capture_screen', 'read_clipboard', 'write_clipboard', 'mouse_move', 'mouse_click', 'mouse_drag', 'keyboard_type', 'keyboard_press', 'computer_use'],
    notes: 'For visible work Lumi should state the task goal, choose the right interface, inspect the active window with desktop_ui_snapshot when native controls are available, use desktop_ui_focus/click/invoke/type for real accessible controls, inspect the screen/current window when pixels are needed, move the visible cursor to the real target before raw desktop clicks, perform real desktop input when appropriate, verify outcomes, report only results/blockers/needed hard-boundary handoffs, and close temporary surfaces after they are explained. Registered tools expose observation, UIA, clipboard, mouse, keyboard, app opening, command execution, and vision computer_use without per-tool permission popups in Assistant/Autonomy. Workflow-internal relay actions such as desktop_cursor_glow_*, desktop_mouse_click_at, and desktop_set_wallpaper_mode are available to controlled workflows including foreground WeChat sends, desktop demos, and computer_use cleanup. Prebuilt workflows are reusable operating patterns, not fake demos: adapt the sequence to the current user goal, screen state, installed apps, and required deliverables.',
    requiresConfirmation: false,
    stateKeys: ['surfaces', 'windows', 'tools', 'permissions'],
  },
  {
    id: 'external.account_session_reuse',
    label: 'External account session reuse',
    kind: 'external_app',
    actions: ['desktop_active_window', 'desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'desktop_capture_screen', 'desktop_list_apps', 'desktop_open', 'desktop_run_command', 'web_login_site_presets', 'web_login_profile_list', 'web_login_profile_save_from_preset', 'web_login_profile_save', 'web_login_learn_site', 'web_login_run', 'url_fetch_logged_in', 'browser_open_task'],
    notes: 'When work involves WeChat, store backends, creator platforms, legal research sites, filing portals, or other account surfaces, Lumi can restore and use already logged-in taskbar/background windows or saved browser profiles under the active desktop mode without a separate permission popup. It should first look for an existing app/window/profile, then use web_login_profile_list, web_login_run, or url_fetch_logged_in to reuse authorized sessions. If the exact local app path is unknown, use desktop_list_apps before desktop_open instead of guessing install paths or generating a one-off skill. With explicit authorization, Lumi can learn a generic website login or store encrypted credentials locally. In foreground user-present execution, ordinary messages, comments, replies, and non-commercial content posts can proceed when the user asked for them. It must stop for user confirmation or handoff at first-time login, QR/OTP/captcha/passkey/biometric checks, account switching, third-party authorization, saving credentials, payment, purchase, transfer, legal filing/signature, or other high-consequence commits. The learned behavior is to continue from existing sessions instead of pretending that a local HTML page or a fresh browser tab is real account control.',
    requiresConfirmation: false,
    stateKeys: ['permissions', 'tools', 'windows'],
  },
  {
    id: 'external.stock_watch',
    label: 'Stock watch and paper trading',
    kind: 'external_app',
    actions: ['mcp_stockbot_stock_search', 'mcp_stockbot_stock_quote', 'mcp_stockbot_stock_kline', 'mcp_stockbot_market_index', 'mcp_stockbot_hot_sectors', 'mcp_stockbot_stock_news', 'mcp_stockbot_stock_trade_plan', 'mcp_stockbot_paper_trade', 'mcp_stockbot_paper_portfolio', 'browser_open_task'],
    notes: 'For stock watch, watchlists, intraday alerts, A-share quotes, K-lines, sectors, news, risk plans, and simulated paper trading, Lumi can use StockBot and public market data when tools are available. These actions are observational or simulated, not investment advice and not real brokerage execution. Opening an already logged-in quote page or brokerage app for viewing can proceed as visible supervised work, but real buy/sell order placement, cancel orders, brokerage login/security prompts, trading passwords, fund transfers, and any real-money trade confirmation require explicit user confirmation.',
    requiresConfirmation: false,
    stateKeys: ['tools', 'permissions', 'windows'],
  },
  {
    id: 'system.self_intro_demo',
    label: 'Self-introduction desktop demo',
    kind: 'system',
    actions: ['self_intro_demo', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_active_window', 'desktop_capture_screen', 'desktop_list_apps', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press'],
    notes: 'When the user explicitly asks Lumi to introduce or demonstrate herself, Lumi can run a bounded self-introduction demo: speak in sync with client surfaces, close each surface after explaining it, enter wallpaper mode, open WPS or a fallback editor to create a Lumi intro document, open a browser search, and prepare a Codex collaboration prompt. The Codex prompt is left unsent unless the demo is configured or confirmed to send. The durable ability is self-awareness plus visible desktop operation: know her client body, choose interfaces, use cursor/keyboard/clipboard/commands, verify each result, and adapt to the current computer.',
    stateKeys: ['surfaces', 'windows', 'voice', 'tools', 'permissions'],
  },
  {
    id: 'system.customer_operations',
    label: 'Customer operations',
    kind: 'system',
    actions: ['work_takeover_task_from_wechat', 'work_takeover_task_orchestrate', 'work_takeover_task_run_suggested_tool', 'mcp_sales-customer-ops_lead_score', 'mcp_sales-customer-ops_sales_followup_draft', 'mcp_sales-customer-ops_objection_response_builder', 'wechat_read_recent_chat', 'wechat_send_message', 'create_docx', 'work_product_verify'],
    notes: 'Customer work uses the current customer message, files, task state, sales tools, and real messaging surfaces. A quote, contract draft, opened WeChat window, clipboard draft, or local packet is preparation only. Customer progress is complete only when the requested document is verified, the task state is written back, or the target message/action has a real receipt.',
    requiresConfirmation: false,
    stateKeys: ['surfaces', 'windows', 'voice', 'tools', 'permissions'],
  },
  {
    id: 'system.design_operations',
    label: 'Design operations',
    kind: 'system',
    actions: ['desktop_list_files', 'read_file', 'read_pdf', 'ocr_image_file', 'floorplan_extract_geometry', 'create_ppt', 'create_pdf', 'cad_generate_dxf', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'work_product_verify', 'wechat_send_file'],
    notes: 'Design work starts from measured source files, drawings, constraints, and the requested deliverable list. Local concept drafts are not formal delivery. Each requested document must be verified as a file; visible AutoCAD work requires MCP/COM completion evidence; native BIM output requires an actual Revit/BIM adapter result; professional and client approvals remain explicit.',
    requiresConfirmation: false,
    stateKeys: ['surfaces', 'windows', 'voice', 'tools', 'permissions'],
  },
  {
    id: 'system.ecommerce_operations',
    label: 'E-commerce operations',
    kind: 'system',
    actions: ['mcp_ecommerce-ops_product_listing_optimizer', 'mcp_ecommerce-ops_ecommerce_order_profit', 'mcp_ecommerce-ops_inventory_restock_plan', 'mcp_ecommerce-ops_platform_settlement_reconcile', 'mcp_ecommerce-ops_campaign_roi_analyzer', 'mcp_ecommerce-ops_after_sales_risk_report', 'web_login_run', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_fill_form', 'mcp_playwright_browser_click', 'create_xlsx', 'create_docx', 'generate_image', 'generate_video', 'wechat_send_message', 'work_product_verify'],
    notes: 'E-commerce work is grounded in supplied product facts, platform exports, authenticated page state, and real tool results. Local content drafts and preparation packets are not live store audits or platform execution. Publishing, store changes, generated media, ad spend, and customer outreach require the corresponding external result or receipt before Lumi can report completion.',
    requiresConfirmation: false,
    stateKeys: ['surfaces', 'windows', 'voice', 'tools', 'permissions'],
  },
  {
    id: 'system.work_takeover_tasks',
    label: 'Work takeover task hub',
    kind: 'system',
    actions: ['work_takeover_task_create', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'work_takeover_task_list', 'work_takeover_task_get', 'work_takeover_task_update', 'work_takeover_task_continue', 'work_takeover_task_orchestrate', 'work_takeover_task_execute_step', 'work_takeover_task_advance', 'work_takeover_task_autorun', 'work_takeover_capability_reuse_probe', 'work_takeover_task_verify_result', 'work_takeover_task_export_packet', 'work_takeover_task_run_suggested_tool'],
    notes: 'Persistent task hub for work takeover. It stores source messages, facts, drafts, artifacts, boundaries, execution plans, and verified results. It coordinates real sales, messaging, ecommerce, browser, document, CAD, BIM, and media tools; it does not generate scripted industry completion packages.',
    requiresConfirmation: false,
    stateKeys: ['tools', 'permissions'],
  },
  {
    id: 'workspace.skills',
    label: 'Skill hall',
    kind: 'tool_surface',
    actions: ['open_skills'],
    notes: 'Installed and discoverable Lumi skills, including GitHub MCP discovery.',
    stateKeys: ['windows'],
  },
  {
    id: 'workspace.team',
    label: 'Agent team',
    kind: 'tool_surface',
    actions: ['open_team'],
    notes: 'Team members, sub-agents, and orchestration surfaces.',
    stateKeys: ['windows', 'tools'],
  },
  {
    id: 'network.lap',
    label: 'LAP Inter-Lumi collaboration',
    kind: 'collaboration',
    actions: ['lap.handshake', 'lap.task.delegate', 'lap.task.result', 'lap.context.share', 'lap.negotiate', 'lap.notify', 'lap.revoke'],
    notes: 'Lumi Agent Protocol for secure collaboration with other user-owned Lumi instances and community Lumi peers. Incoming context is external by default and cannot mutate local personality or memory without user approval.',
    requiresConfirmation: true,
    stateKeys: ['workDomain', 'org', 'permissions'],
  },
  {
    id: 'workspace.tools',
    label: 'Tools',
    kind: 'tool_surface',
    actions: ['open_tools'],
    notes: 'Tool catalog, tool status, and execution surfaces for Lumi capabilities.',
    stateKeys: ['windows', 'tools'],
  },
  {
    id: 'system.capability_learning',
    label: 'Capability learning and integration scouting',
    kind: 'system',
    actions: ['capability_gap_autofix', 'capability_learning_list', 'self_extension_plan', 'capability_research', 'web_search', 'url_fetch', 'open_skills'],
    notes: 'Lumi can consolidate capability gaps without duplicating herself: inspect learned routes, existing tools/adapters/skills, then only create a new learned route when coverage is absent or a real execution failure shows the current path is brittle. Research remains available for new ecosystems before installing or executing anything.',
    stateKeys: ['tools', 'permissions'],
  },
  {
    id: 'system.authority_research',
    label: 'Authority research and citation grounding',
    kind: 'knowledge',
    actions: ['authority_research', 'authority_research_save', 'web_search', 'url_fetch'],
    notes: 'For laws, policies, patents, software copyright, standards, papers, technical docs, and current facts, Lumi can search primary/official sources, score authority, fetch excerpts, cite URLs, and save verified research into long-term knowledge only after user confirmation. In Autonomy mode she may periodically create public-source learning refreshes based on the user industry habits, common platforms, deliverable formats, vocabulary, and verification boundaries; login walls, paid sources, captcha, QR/OTP, private pages, and account authorization are blockers rather than completed research.',
    requiresConfirmation: true,
    stateKeys: ['tools', 'permissions'],
  },
  {
    id: 'window.advanced',
    label: 'Advanced and account windows',
    kind: 'window',
    actions: ['open_app:terminal', 'open_app:tokens', 'open_subscription', 'open_activation', 'open_billing', 'open_app:notifications', 'open_app:reminders'],
    notes: 'Terminal, token usage, subscription, activation, billing, notification, and reminder windows remain available when the user asks for them.',
    stateKeys: ['windows'],
  },
  {
    id: 'media.music',
    label: 'Music center and mood layer',
    kind: 'media',
    actions: ['open_music_center', 'show_music_layer', 'hide_music_layer'],
    notes: 'Music playback control, NetEase integration, lyrics, and fullscreen mood layer. Music is an always-available media capability, not a top-level work mode.',
    stateKeys: ['music'],
  },
  {
    id: 'system.settings',
    label: 'Settings',
    kind: 'settings',
    actions: ['open_settings'],
    notes: 'Product settings, voice services, API matrix, permissions, and advanced options.',
    stateKeys: ['permissions'],
  },
  {
    id: 'system.computer_adaptation',
    label: 'Computer adaptation center',
    kind: 'system',
    actions: ['open_computer_adaptation'],
    notes: 'Shows Lumi how this computer is configured: system profile, common apps, permissions, MCP skills, runtime readiness, and setup recommendations.',
    stateKeys: ['permissions', 'tools', 'windows'],
  },
  {
    id: 'system.always_online',
    label: 'Desktop modes and autonomous work',
    kind: 'system',
    actions: ['open_plans', 'open_work_queue', 'open_settings(section=autonomy)', 'autonomy_get_policy', 'autonomy_update_policy', 'autonomy_list_workflows', 'autonomy_register_workflow', 'autonomy_set_workflow_enabled'],
    notes: 'Lumi uses three desktop permission modes. Chat is pure conversation: no tools, external apps, desktop control, files, teams, or background execution except explicit Lumi client mode control. Assistant is user-present high-permission execution: tools, browser, saved/authorized login sessions, files, desktop control, external apps, skills, and teams may run for requested ordinary work without per-tool permission popups; hard boundaries still stop for confirmation or handoff. Autonomy has the same practical permissions as Assistant plus 24h continuous/background operation, proactive questions, monitoring, sorting, absorption, local-machine body learning, industry-habit-aware public-source web learning, task checkpoints, and ultra-long continuation. The desktop client can launch at login, hide to tray/background, and supervise bundled backend processes. That is resident runtime, not permission to invent unrelated automatic work; background task generation still follows workflow/autonomy policy. There is no separate external-app automation gate.',
    requiresConfirmation: false,
    stateKeys: ['mode', 'autonomy', 'runtime'],
  },
  {
    id: 'system.sleep_dreaming',
    label: 'Sleep and dream memory consolidation',
    kind: 'system',
    actions: ['lumi_sleep_status', 'lumi_sleep_cycle'],
    notes: 'When Lumi is resting, she can dream: quietly consolidate recent memories, separate stable patterns from uncertain fragments, and create growth memories without deleting originals or mutating core identity.',
    stateKeys: ['autonomy', 'runtime', 'permissions'],
  },
  {
    id: 'system.self_governance',
    label: 'Local self-governance and self-repair',
    kind: 'system',
    actions: ['client_health_check', 'client_self_repair', 'client_repair_skill', 'client_get_state', 'client_action(refresh_client_state)'],
    notes: 'Lumi is not a voice-only assistant. She can inspect her own client body, diagnose client failures, refresh state, open recovery surfaces, and repair skills without per-tool permission popups; third-party installs, credential changes, destructive repairs, and other hard boundaries stop for explicit confirmation or handoff.',
    requiresConfirmation: false,
    stateKeys: ['mode', 'windows', 'surfaces', 'music', 'meeting', 'runtimeLog', 'permissions', 'runtime', 'errors'],
  },
  {
    id: 'system.adapter_registry',
    label: 'Client capability adapter registry',
    kind: 'system',
    actions: ['adapter_registry_list', 'adapter_health_check', 'external_app_list_adapters'],
    notes: 'Structured map of Lumi client capabilities, external app adapters, skill/MCP runtime, provider/permission state, CAD/BIM handoff, messaging, web, music, meeting, runtime logs, organization, files, and autonomy.',
    stateKeys: ['mode', 'windows', 'surfaces', 'music', 'meeting', 'runtimeLog', 'org', 'permissions', 'runtime', 'tools', 'errors'],
  },
  {
    id: 'system.self_extension',
    label: 'Self extension pipeline',
    kind: 'system',
    actions: ['self_extension_plan', 'capability_gap_autofix', 'capability_learning_list', 'capability_research', 'generate_skill', 'install_skill', 'client_repair_skill'],
    notes: 'When a capability seems missing, Lumi should first inspect learned routes, adapters, tools, installed skills, and marketplace skills. Skill calls, route planning, safe local skill generation, and capability probes run without per-tool permission popups. Use capability_gap_autofix only when there is no sufficient coverage or when a brittle/manual path has real failure evidence; then prepare or run a minimal verification experiment and persist one reusable route. Installing or executing untrusted third-party code remains a hard boundary.',
    requiresConfirmation: false,
    stateKeys: ['tools', 'permissions', 'runtime'],
  },
  {
    id: 'system.model_role_routing',
    label: 'Specialized model role routing',
    kind: 'settings',
    actions: ['open_settings(section=llm-providers|world-model|generation-models)', 'generate_image', 'generate_video', 'computer_use', 'usage_get_summary'],
    notes: 'Lumi keeps runtime roles distinct without multiplying settings pages. The primary reasoning model handles conversation and reasoning. The World Model settings contain visual perception plus a desktop action role that may inherit perception or use an independent model. Generative Models contain independent image and video roles. Model services are not data sources or tool runtimes. An explicitly selected generation provider must not silently switch providers.',
    stateKeys: ['settings', 'tools'],
  },
  {
    id: 'system.usage_monitoring',
    label: 'Model and token usage monitoring',
    kind: 'system',
    actions: ['usage_get_summary', 'open_app:tokens'],
    notes: 'Summarizes recorded provider/model/mode token usage. Use this before answering questions about today model consumption or API usage.',
    stateKeys: ['tools'],
  },
  {
    id: 'system.personality_constitution',
    label: 'Lumi personality constitution',
    kind: 'system',
    actions: ['lumi_constitution'],
    notes: 'Stable constitution for Lumi identity, truth about work, owner sovereignty, memory firewall, action boundaries, work-product supervision, self-extension consent, growth stability, and bounded collaboration.',
    stateKeys: ['permissions', 'tools', 'runtime'],
  },
  {
    id: 'system.work_product_supervision',
    label: 'Work product supervision loop',
    kind: 'system',
    actions: ['work_product_plan', 'work_product_verify'],
    notes: 'Defines deliverables, acceptance criteria, checkpoints, verification actions, repair cycles, and stop conditions before Lumi claims a real task is complete.',
    stateKeys: ['tools', 'runtimeLog', 'surfaces', 'runtime'],
  },
  {
    id: 'external.browser',
    label: 'Browser and web work adapter',
    kind: 'external_app',
    actions: ['browser_open_task', 'web_search', 'url_fetch', 'web_login_site_presets', 'web_login_profile_save_from_preset', 'web_login_profile_save', 'web_login_learn_site', 'web_login_profile_list', 'web_login_run', 'url_fetch_logged_in', 'external_control_candidates', 'external_control_configure_candidate', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_fill_form', 'mcp_playwright_browser_click'],
    notes: 'Lumi can research with web tools, open browser tasks, list login presets, reuse saved/authorized browser profiles, reuse browser autofill/session cookies, fetch authenticated pages through saved profiles, and use Playwright MCP as a structured browser-control adapter when configured. Prefer browser snapshots/DOM actions for web backends before falling back to screenshot coordinates. Learning a new site login, saving credentials, first-time login, QR/OTP/captcha/passkey/security verification, account switching, third-party authorization, purchases, payments, legal/business final submissions, and ambiguous submissions still need confirmation or handoff.',
    requiresConfirmation: false,
    stateKeys: ['permissions', 'tools'],
  },
  {
    id: 'external.messaging',
    label: 'WeChat and messaging adapter',
    kind: 'external_app',
    actions: ['wechat_intake_analyze', 'wechat_intake_from_clipboard', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'wechat_prepare_reply', 'wechat_copy_reply_draft', 'wechat_read_recent_chat', 'wechat_send_message', 'desktop_active_window', 'desktop_list_apps', 'desktop_open', 'desktop_ui_snapshot', 'desktop_capture_screen', 'desktop_mouse_click_at', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_run_command'],
    notes: 'Lumi can triage user-provided or copied WeChat messages into current-stage work takeover tasks, extract key amounts/deadlines/people, persist the task, prepare next actions and reply drafts, copy drafts, read visible recent chat content from a foreground WeChat conversation with screenshot/OCR evidence, and send ordinary foreground user-requested WeChat messages through the dedicated send tool when the user is present. Reading, drafting, and sending are separate capabilities with separate completion evidence. For visible desktop work and handoff, Lumi should first restore an already running personal WeChat/Weixin window from the taskbar/background with visible focus, then use desktop_list_apps/desktop_open to launch personal WeChat from the native app index, and only then fall back to enterprise WeChat/WeCom. If WeChat is logged in, Lumi may continue safe read/draft/preparation work inside that session and use the virtual cursor path for explicit ordinary sends without a separate permission popup; QR login, verification, account switching, payments, legal/contractual commitments, and other high-consequence sends remain confirmation/handoff boundaries. It should not claim to read chat content without visible screenshot/OCR/UI evidence, and should not claim to send messages unless the foreground send tool or another confirmed integration actually completed.',
    requiresConfirmation: false,
    stateKeys: ['permissions', 'tools'],
  },
  {
    id: 'external.cad',
    label: 'CAD drafting adapter',
    kind: 'external_app',
    actions: ['floorplan_extract_geometry', 'ocr_image_file', 'cad_generate_dxf', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'desktop_list_apps', 'desktop_open'],
    notes: 'Lumi traces plan images in separate exterior, wall-topology, and opening passes, then requires deterministic and visual source comparison. Executable geometry stays in a server-owned receipt so coordinates are never reconstructed in chat. Visible AutoCAD completion requires the verified operation set, MCP/COM playback, its completion marker, and an exact entity-count delta. Interrupted runs resume the same document or stop; they never replay into a duplicate drawing. There is no LISP, SCRIPT, batch-command, cursor-drawing, or finished-file fallback.',
    requiresConfirmation: false,
    stateKeys: ['permissions', 'tools'],
  },
  {
    id: 'external.ai_apps',
    label: 'Other local AI and agent tools',
    kind: 'external_app',
    actions: ['desktop_ai_list_targets', 'desktop_ai_discovery_plan', 'desktop_ai_register_target', 'desktop_ai_roundtable', 'desktop_ai_ask', 'desktop_ai_collect_answer', 'external_app_list_adapters', 'desktop_list_apps', 'desktop_open', 'desktop_capture_screen', 'ocr_screen', 'computer_use'],
    notes: 'Lumi can coordinate other AI apps through files, browser, clipboard, MCP, and visible computer-use sessions without per-tool permission popups in Assistant/Autonomy. For desktop-only or browser-window AI targets such as WorkBuddy, Codex, ChatGPT, Claude, Gemini, DeepSeek, Kimi, 豆包, 通义, Cursor/Copilot, LM Studio, and Ollama, use desktop_ai_roundtable when the user wants the same question sent to multiple AIs and all visible answers collected for one summary. Use desktop_ai_ask plus desktop_ai_collect_answer for manual control. A pasted prompt and submit shortcut are only an unverified submission attempt until answer evidence is collected. If the user asks what other desktop AI/tools can be supported, or an autonomous public-source learning refresh discovers a new tool, use desktop_ai_discovery_plan with web_search/url_fetch/authority_research, produce a source-grounded candidate, then register it with desktop_ai_register_target after confirmation so future calls can use it without one-off customTargets. Prefer API/MCP/CLI integrations when available; stop at login/security, payment, installation, credential, or destructive boundaries.',
    requiresConfirmation: false,
    stateKeys: ['permissions', 'tools', 'windows'],
  },
  {
    id: 'system.wallpaper',
    label: 'Wallpaper mode',
    kind: 'system',
    actions: ['set_wallpaper_mode'],
    notes: 'Lets Lumi visually merge with the desktop. Use carefully; desktop-control sessions may enable it temporarily.',
    requiresConfirmation: true,
    stateKeys: ['surfaces.wallpaperMode'],
  },
  {
    id: 'permissions.sensors',
    label: 'Sensor permissions',
    kind: 'permission',
    actions: ['open_settings'],
    notes: 'Microphone, camera, notifications, knowledge import, desktop automation, wake word, and biometric primer states.',
    requiresConfirmation: true,
    stateKeys: ['permissions'],
  },
];

const LEGACY_CLIENT_INTERFACE_SURFACES: ClientInterfaceSurface[] = [
  {
    id: 'home',
    label: 'Home / desktop shell',
    actions: ['focus_home', 'desktop_show_lumi_window'],
    useWhen: 'Return to Lumi base state, orient the user, or recover from scattered windows.',
  },
  {
    id: 'nexus',
    label: 'Nexus / central world',
    actions: ['open_nexus', 'close_nexus'],
    useWhen: 'Show the central world view / Nexus entrance in the LumiOS client.',
    closeAfterUse: false,
  },
  {
    id: 'chat',
    label: 'Side chat',
    actions: ['open_chat', 'close_app:chat'],
    useWhen: 'Hold an ongoing conversation beside other work without taking over the whole client.',
    closeAfterUse: true,
  },
  {
    id: 'knowledge',
    label: 'Knowledge base and memory',
    actions: ['show_knowledge_base', 'open_files'],
    useWhen: 'Show knowledge, imported files, memories, and indexing health for the currently active personal or organization workspace.',
    closeAfterUse: true,
  },
  {
    id: 'runtime-log',
    label: 'Runtime log',
    actions: ['open_runtime_log'],
    useWhen: 'Show live execution, startup traces, tool progress, errors, or self-repair evidence.',
    closeAfterUse: true,
  },
  {
    id: 'skills',
    label: 'Skill hall',
    actions: ['open_skills'],
    useWhen: 'Show installed skills, MCP servers, extension points, or repair/install surfaces.',
    closeAfterUse: true,
  },
  {
    id: 'tools',
    label: 'Tools catalog',
    actions: ['open_tools'],
    useWhen: 'Show what executable tools Lumi can call and how tool status is exposed.',
    closeAfterUse: true,
  },
  {
    id: 'team',
    label: 'Agent team',
    actions: ['open_team'],
    useWhen: 'Show sub-agents, orchestration, delegation, and multi-agent collaboration.',
    closeAfterUse: true,
  },
  {
    id: 'avatar-studio',
    label: 'Avatar studio',
    actions: ['open_avatar_studio'],
    useWhen: 'Show Lumi avatar, appearance, embodied presence, or personality-facing surfaces.',
    closeAfterUse: true,
  },
  {
    id: 'sound',
    label: 'Sound studio',
    actions: ['open_sound_studio'],
    useWhen: 'Show voice, sound, speech, and audio configuration surfaces.',
    closeAfterUse: true,
  },
  {
    id: 'org',
    label: 'Organization workspace',
    actions: ['open_organization_workspace'],
    useWhen: 'Enter the role-scoped organization overlay for the same Lumi identity; use a section-specific action for a concrete destination.',
    closeAfterUse: true,
  },
  {
    id: 'org-dashboard',
    label: 'Organization dashboard',
    actions: ['open_organization_workspace(section=dashboard)'],
    useWhen: 'Show organization status, shared work, and the main organization destinations.',
    closeAfterUse: true,
  },
  {
    id: 'org-knowledge',
    label: 'Organization knowledge base',
    actions: ['open_organization_workspace(section=kb)'],
    useWhen: 'Browse role-authorized organization articles, uploaded sources, and post-ingestion index health.',
    closeAfterUse: true,
  },
  {
    id: 'org-lumi',
    label: 'Lumi in the organization workspace',
    actions: ['open_organization_workspace(section=chat)'],
    useWhen: 'Chat with the same Lumi under the active organization overlay and organization knowledge scope.',
    closeAfterUse: true,
  },
  {
    id: 'org-messaging',
    label: 'Organization messaging',
    actions: ['open_organization_workspace(section=messaging)'],
    useWhen: 'Manage Feishu and WeCom organization access and routed organization messages; viewer roles cannot open it.',
    closeAfterUse: true,
  },
  {
    id: 'org-templates',
    label: 'Agent templates and review',
    actions: ['open_organization_workspace(section=templates)', 'open_organization_workspace(section=review)'],
    useWhen: 'Use the organization template marketplace; review is available only to owners and administrators.',
    closeAfterUse: true,
  },
  {
    id: 'org-governance',
    label: 'Members, permissions, and audit',
    actions: ['open_organization_workspace(section=members)', 'open_organization_workspace(section=audit)'],
    useWhen: 'Administer members, permissions, and audit records; available only to owners and administrators.',
    closeAfterUse: true,
  },
  {
    id: 'org-settings',
    label: 'Organization settings and branch connection',
    actions: ['open_organization_workspace(section=settings)', 'open_organization_workspace(section=branch)'],
    useWhen: 'Open organization settings or branch connection without creating a separate organization client.',
    closeAfterUse: true,
  },
  {
    id: 'org-legal',
    label: 'Law firm workspace',
    actions: ['open_organization_workspace(section=legal)'],
    useWhen: 'Open organization-scoped cases, evidence, legal research, documents, delivery gates, and filing handoff.',
    closeAfterUse: true,
  },
  {
    id: 'org-spatial-design',
    label: 'Spatial and architecture workspace',
    actions: ['open_organization_workspace(section=spatial-design)'],
    useWhen: 'Open spatial, interior, architecture, CAD, and design-delivery work.',
    closeAfterUse: true,
  },
  {
    id: 'org-brand-design',
    label: 'Brand and creative workspace',
    actions: ['open_organization_workspace(section=brand-design)'],
    useWhen: 'Open brand identity, campaign, visual, and creative-delivery work separately from spatial design.',
    closeAfterUse: true,
  },
  {
    id: 'plans',
    label: 'Plans and work queue',
    actions: ['open_plans', 'open_work_queue'],
    useWhen: 'Show always-online workflows, queued work, recurring tasks, and autonomy agreements.',
    closeAfterUse: true,
  },
  {
    id: 'settings',
    label: 'Settings',
    actions: ['open_settings'],
    useWhen: 'Show provider, voice, permission, startup, autonomy, and advanced configuration.',
    closeAfterUse: true,
  },
  {
    id: 'music-center',
    label: 'Music center and mood layer',
    actions: ['open_music_center', 'show_music_layer', 'hide_music_layer'],
    useWhen: 'Play music, show media state, lyrics, atmosphere, or sound-driven work context.',
    closeAfterUse: false,
  },
  {
    id: 'meeting',
    label: 'Meeting mode and notes',
    actions: ['start_meeting_mode', 'end_meeting_mode', 'open_meeting_notes'],
    useWhen: 'Capture meeting transcription, notes, and reports after explicit user intent.',
    closeAfterUse: false,
  },
  {
    id: 'wallpaper',
    label: 'Wallpaper mode',
    actions: ['set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click'],
    useWhen: 'Make desktop work immersive and visible while Lumi operates external applications.',
    closeAfterUse: true,
  },
  {
    id: 'widget',
    label: 'Desktop widget mode',
    actions: ['enter_widget_mode', 'show_desktop_widget', 'exit_widget_mode', 'expand_from_widget'],
    useWhen: 'Collapse Lumi into or expand Lumi out of the desktop widget shell.',
    closeAfterUse: false,
  },
  {
    id: 'subscription',
    label: 'Subscription, activation, and billing',
    actions: ['open_subscription', 'open_activation', 'open_billing'],
    useWhen: 'Show plan status, activation, billing, or subscription controls.',
    closeAfterUse: true,
  },
  {
    id: 'computer-adaptation',
    label: 'Computer adaptation center',
    actions: ['open_computer_adaptation'],
    useWhen: 'Show system profile, common apps, permissions, local readiness, and setup recommendations.',
    closeAfterUse: true,
  },
];

const registeredPersonalSurfaceIds = new Set<string>(PERSONAL_CLIENT_SURFACES.map(surface => surface.id));
const registeredSettingsSurfaceIds = new Set<string>(CLIENT_SETTINGS_SECTIONS.map(section => `settings-${section.id}`));
const CLIENT_INTERFACE_SURFACES: ClientInterfaceSurface[] = [
  ...PERSONAL_CLIENT_SURFACES.map(surface => ({
    id: surface.id,
    label: surface.label,
    actions: [...surface.actions],
    useWhen: surface.useWhen,
    closeAfterUse: surface.closeAfterUse ?? true,
  })),
  ...CLIENT_SETTINGS_SECTIONS.map(section => ({
    id: `settings-${section.id}`,
    label: section.label,
    actions: [`open_settings(section=${section.id})`],
    useWhen: section.useWhen,
    closeAfterUse: true,
  })),
  ...LEGACY_CLIENT_INTERFACE_SURFACES.filter(surface => (
    !registeredPersonalSurfaceIds.has(surface.id)
    && !registeredSettingsSurfaceIds.has(surface.id)
  )),
];

const VISIBLE_EXECUTION_HABITS: VisibleExecutionHabit[] = [
  {
    id: 'name_goal_and_surface',
    rule: 'For non-trivial visible work, first state the task goal and where Lumi will work: chat, a Lumi surface, tools/run log, or the external desktop.',
  },
  {
    id: 'know_own_interfaces',
    rule: 'When asked what Lumi can show or open, use the Interface Map and current client state instead of giving a generic assistant answer.',
  },
  {
    id: 'prefer_native_surfaces',
    rule: 'For Lumi client UI, prefer client_action and known surface actions; use mouse/keyboard only for external apps or when the user explicitly wants visible desktop operation.',
  },
  {
    id: 'visible_cursor_for_external_apps',
    rule: 'For external desktop work, inspect the screen or active window, show the cursor glow, move the visible cursor to the real target before clicking, click the center of the actual UI element, and verify the result. The cursor glow is evidence of operation, not decoration.',
  },
  {
    id: 'wallpaper_for_immersive_work',
    rule: 'Use wallpaper mode only when the user explicitly requests it or during a visible user-present desktop workflow, then turn it off when done. The explicit current request is the authorization; do not ask a second tool-level confirmation.',
  },
  {
    id: 'close_temporary_surfaces',
    rule: 'If Lumi opens an internal surface only to explain or inspect it, close that surface after the point is made unless it is the user-requested work surface.',
  },
  {
    id: 'prepare_before_clicking',
    rule: 'Prefer files, clipboard drafts, explicit adapters, and app-specific commands before blind clicking; only use visual control when it adds clarity or is required.',
  },
  {
    id: 'show_progress_and_blockers',
    rule: 'Narrate important steps, show tool/run evidence when useful, and if an action fails, say the exact blocker, try one safe fallback, then verify.',
  },
];

const stateByUser = new Map<string, ClientStateSnapshot>();

export function getClientCapabilities(): ClientCapability[] {
  return CLIENT_CAPABILITIES;
}

export function getClientInterfaceSurfaces(): ClientInterfaceSurface[] {
  return CLIENT_INTERFACE_SURFACES;
}

export function getVisibleExecutionHabits(): VisibleExecutionHabit[] {
  return VISIBLE_EXECUTION_HABITS;
}

export function updateClientState(userId: string, state: ClientStateSnapshot): ClientStateSnapshot {
  const snapshot: ClientStateSnapshot = {
    ...state,
    updatedAt: Date.now(),
  };
  stateByUser.set(userId || 'anonymous', snapshot);
  return snapshot;
}

export function getClientState(userId: string): ClientStateSnapshot | null {
  return stateByUser.get(userId || 'anonymous') || null;
}

export function getClientStateForScope(
  userId: string,
  scope: { domain?: string; orgId?: string } = {},
): ClientStateSnapshot | null {
  const state = getClientState(userId);
  if (!state || !scope.domain) return state;
  if (scope.domain === 'work') {
    const knowledgeMatches = !state.knowledge
      || (state.knowledge.domain === 'work' && (!state.knowledge.orgId || state.knowledge.orgId === scope.orgId));
    return scope.orgId && state.workDomain === 'work' && state.org?.id === scope.orgId && knowledgeMatches ? state : null;
  }
  return state.workDomain === 'work' || state.knowledge?.domain === 'work' ? null : state;
}

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
      message: state.runtime.lastError,
      safeActions: ['client_self_repair(open_recovery_surface:kernel)'],
      confirmationActions: ['Restart Lumi desktop runtime only after user confirmation.'],
    });
  }

  if (state?.music?.lastError) {
    add({
      id: 'music.last_error',
      level: 'degraded',
      area: 'music',
      message: state.music.lastError,
      evidence: state.music.trackName ? `track=${state.music.trackName}` : undefined,
      safeActions: ['client_self_repair(open_recovery_surface:music-center)', 'client_action(open_music_center)'],
    });
  }
  if ((state?.music?.layerVisible || state?.surfaces?.musicLayerVisible) && !state?.music?.isPlaying && state?.music?.trackName) {
    add({
      id: 'music.layer_without_playback',
      level: 'attention',
      area: 'music',
      message: 'Music layer is visible but playback is not active.',
      evidence: `track=${state.music.trackName}`,
      safeActions: ['client_action(open_music_center)'],
    });
  }

  if (state?.runtimeLog?.lastError) {
    add({
      id: 'runtime_log.attention',
      level: 'attention',
      area: 'runtime',
      message: 'Runtime log reports a client/runtime issue.',
      evidence: state.runtimeLog.lastError,
      safeActions: ['client_self_repair(open_recovery_surface:runtime-log)'],
    });
  }

  if (state?.knowledge?.lastError) {
    add({
      id: 'knowledge.refresh_error',
      level: 'attention',
      area: 'knowledge',
      message: 'The current workspace knowledge inventory could not be fully refreshed.',
      evidence: state.knowledge.lastError,
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
      message: err.message,
      evidence: err.code,
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
        'Open Lumi recovery surfaces such as Music Center, Runtime Log, Skills, Settings, Plans, or Computer Adaptation.',
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

export function normalizeClientActionTarget(value?: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase();
  const aliases: Record<string, string> = {
    music: 'music-center',
    media: 'music-center',
    memory: 'knowledge',
    home: 'home',
    main: 'home',
    'main-screen': 'home',
    chat: 'chat',
    team: 'team',
    tools: 'tools',
    tool: 'tools',
    plans: 'plans',
    plan: 'plans',
    planner: 'plans',
    'work-queue': 'plans',
    org: 'org',
    organization: 'org',
    workspace: 'org',
    'org-workspace': 'org',
    launcher: 'app-launcher',
    spotlight: 'app-launcher',
    search: 'app-launcher',
    personality: 'personality',
    'personality-lab': 'personality',
    notifications: 'notifications',
    notification: 'notifications',
    reminders: 'reminders',
    reminder: 'reminders',
    devices: 'devices',
    device: 'devices',
    'device-sync': 'devices',
    terminal: 'terminal',
    tokens: 'tokens',
    usage: 'tokens',
    profile: 'profile',
    mcp: 'mcp',
    'mcp-settings': 'mcp',
    voice: 'voice',
    'voice-forge': 'voice',
    'github-mcp': 'github-mcp',
    generate: 'generate',
    'skill-generator': 'generate',
    ecosystem: 'ecosystem',
    docs: 'docs',
    documentation: 'docs',
    founders: 'founders',
    'avatar-studio': 'avatar-studio',
    avatar: 'avatar-studio',
    'sound-studio': 'sound',
    sound: 'sound',
    'memory-avatar': 'memory-avatar',
    files: 'knowledge',
    file: 'knowledge',
    sync: 'devices',
    computer: 'kernel',
    adaptation: 'kernel',
    'computer-adaptation': 'kernel',
    subscription: 'subscription',
    billing: 'subscription',
    activation: 'subscription',
    widget: 'widget',
    'desktop-widget': 'widget',
    'desktop-widget-mode': 'widget',
    nexus: 'nexus',
    world: 'nexus',
    'world-view': 'nexus',
    'nexus-view': 'nexus',
    'cloud-canvas': 'nexus',
    'central-world': 'nexus',
    '中枢': 'nexus',
    '中枢世界': 'nexus',
    '桌面小组件': 'widget',
    '小组件': 'widget',
    '主屏幕': 'home',
    '主页': 'home',
    '首页': 'home',
    '聊天': 'chat',
    '聊天窗口': 'chat',
    '应用启动器': 'app-launcher',
    '应用搜索': 'app-launcher',
    '人格': 'personality',
    '人格实验室': 'personality',
    '团队': 'team',
    '团队面板': 'team',
    '工具': 'tools',
    '工具面板': 'tools',
    '形象': 'avatar-studio',
    '头像': 'avatar-studio',
    '头像工作室': 'avatar-studio',
    '声音': 'sound',
    '声音工作室': 'sound',
    '记忆头像': 'memory-avatar',
    '组织': 'org',
    '组织空间': 'org',
    '组织工作区': 'org',
    '计划': 'plans',
    '计划面板': 'plans',
    '工作队列': 'plans',
    '通知': 'notifications',
    '通知面板': 'notifications',
    '通知窗口': 'notifications',
    '提醒': 'reminders',
    '提醒面板': 'reminders',
    '提醒窗口': 'reminders',
    '设备': 'devices',
    '设备同步': 'devices',
    '终端': 'terminal',
    '用量': 'tokens',
    '令牌用量': 'tokens',
    '个人资料': 'profile',
    '语音工坊': 'voice',
    '声音克隆': 'voice',
    '技能生成': 'generate',
    '智能体生态': 'ecosystem',
    '文档': 'docs',
    '创始人空间': 'founders',
    '电脑适配中心': 'kernel',
    '计算机适配中心': 'kernel',
    '电脑适配': 'kernel',
    '订阅': 'subscription',
    '激活': 'subscription',
    '账单': 'subscription',
    log: 'runtime-log',
    logs: 'runtime-log',
    runtime: 'runtime-log',
    settings: 'settings',
    '设置': 'settings',
    '运行日志': 'runtime-log',
    '日志': 'runtime-log',
    '音乐': 'music-center',
    '音乐中心': 'music-center',
    '知识库': 'knowledge',
    '文件中心': 'knowledge',
    '文件管理器': 'knowledge',
  };
  return aliases[normalized] || normalized;
}

export function getClientStateDigest(state: ClientStateSnapshot | null | undefined): ClientStateDigest | null {
  if (!state) return null;
  const openWindows = [...(state.windows?.open || [])];
  const openSurfaces: string[] = [];
  if (state.activeTab) openSurfaces.push(`tab:${state.activeTab}`);
  if (state.viewMode) openSurfaces.push(`view:${state.viewMode}`);
  if (state.viewMode === 'world' || state.surfaces?.nexusOpen) openSurfaces.push('nexus');
  if (state.surfaces?.appLauncherOpen) openSurfaces.push('app-launcher');
  if (state.surfaces?.knowledgeOpen) openSurfaces.push('knowledge');
  if (state.surfaces?.chatOpen) openSurfaces.push('chat');
  if (state.surfaces?.notificationsOpen) openSurfaces.push('notifications');
  if (state.surfaces?.memoryAvatarOpen) openSurfaces.push('memory-avatar');
  if (state.surfaces?.runtimeLogOpen || state.runtimeLog?.open) openSurfaces.push('runtime-log');
  if (state.surfaces?.meetingOpen || state.meeting?.active) openSurfaces.push('meeting');
  if (state.surfaces?.musicLayerVisible || state.music?.layerVisible) openSurfaces.push('music-layer');
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
    music: state.music?.isPlaying
      ? `playing${state.music.trackName ? `:${state.music.trackName}` : ''}`
      : state.music?.trackName
        ? `loaded:${state.music.trackName}`
        : 'idle',
    meetingActive: Boolean(state.meeting?.active),
    runtimeStatus: state.runtimeLog?.status || (state.runtime?.lastError ? 'attention' : 'ready'),
    orgView,
    knowledge,
    stateAgeSeconds,
    socketId: state.socketId || 'unknown',
  };
}

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
    case 'open_app':
      setSurface(target || 'home', target || 'home');
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
    case 'close_app':
      expectedState = target ? [`surface:${target}:closed`] : [];
      verification = target ? `The ${target} surface should no longer be open.` : 'A target surface is required for close_app.';
      naturalCompletion = target ? `${target} is closed.` : 'The close request completed.';
      naturalPending = target ? `${target} was asked to close, but I still need fresh state to confirm it.` : 'The close request was sent.';
      break;
    case 'set_mode':
    case 'set_client_mode':
      expectedState = mode ? [`mode:${mode}`] : [];
      verification = mode ? `Client mode should become ${mode}.` : 'A target mode is required.';
      naturalCompletion = mode ? `Mode is now ${mode}.` : 'Mode change requested.';
      naturalPending = mode ? `I asked to switch to ${mode}, but the latest state has not confirmed it yet.` : 'Mode change requested.';
      break;
    case 'open_music_center':
      setSurface('music-center', 'Music Center');
      break;
    case 'show_music_layer':
      expectedState = ['surface:music-layer:open'];
      verification = 'The music layer should be visible.';
      naturalCompletion = 'Music layer is visible.';
      naturalPending = 'I asked to show the music layer, but I still need fresh state to confirm it.';
      break;
    case 'hide_music_layer':
      expectedState = ['surface:music-layer:closed'];
      verification = 'The music layer should be hidden.';
      naturalCompletion = 'Music layer is hidden.';
      naturalPending = 'I asked to hide the music layer, but I still need fresh state to confirm it.';
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
    case 'open_runtime_log':
      setSurface('runtime-log', 'runtime log');
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
    case 'open_avatar_studio':
      setSurface('avatar-studio', 'avatar studio');
      break;
    case 'open_sound_studio':
      setSurface('sound', 'sound studio');
      break;
    case 'open_memory_avatar':
      setSurface('memory-avatar', 'memory avatar');
      break;
    case 'open_skills':
      setSurface('skills', 'skills');
      break;
    case 'open_tools':
      setSurface('tools', 'tools');
      break;
    case 'open_team':
      setSurface('team', 'team');
      break;
    case 'open_chat':
      setSurface('chat', 'chat');
      break;
    case 'open_plans':
    case 'open_work_queue':
      setSurface('plans', 'plans');
      break;
    case 'open_subscription':
    case 'open_activation':
    case 'open_billing':
      setSurface('subscription', action === 'open_activation' ? 'activation' : action === 'open_billing' ? 'billing' : 'subscription');
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
      : after
        ? 'pending'
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
  if (state?.knowledge?.lastError) gaps.push(`Knowledge inventory: ${state.knowledge.lastError}`);
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
    currentState: digest,
    knows: [
      'the complete registered personal-client surface map and each native client_action route',
      'the exact active settings section when settings are visible',
      'the exact current organization workspace view and the views allowed by the authenticated member role',
      'the current-domain knowledge inventory and the difference between saved, indexed, partial, pending, failed, unsupported, missing-index, and stale content',
      'one continuous Lumi identity with personal and organization workspace overlays; organization access never grants another member personal memory access',
      'current mode, active tab, windows, focused window, voice/music/meeting/runtime state when the desktop reports it',
      'local machine identity, installed/launchable apps, files, folders, startup entries, services, and running processes when refreshed through desktop relay tools',
      'visible desktop state: foreground window, screen pixels, accessible UI controls, clipboard, cursor/input focus, and existing taskbar/background app sessions',
      'background runtime state: launch-at-login, close-to-background, backend health, runtime log, autonomy policy, idle/activity signals, and confirmed workflows',
      'which client actions need confirmation and which external/irreversible actions must stop for the user',
      'how to recover safely by refreshing state or opening the right recovery surface',
    ],
    gaps: gaps.length ? gaps : ['No current self-awareness gaps reported by client health.'],
    habits: [
      'Before changing a Lumi client surface or mode, read client_get_state unless the current tool result already contains fresh state.',
      'Before saying what this machine has installed, where a file is, what is on the desktop, or what is running, refresh with desktop_system_info, desktop_list_apps, desktop_list_files, desktop_path_info, desktop_active_window, desktop_running_processes, or desktop_capture_screen as needed.',
      'Before saying Lumi can keep working in the background, read client_get_state or client_health_check and distinguish resident runtime from autonomous workflow execution.',
      'After client_action, trust verified state or explicit failure, not intention alone.',
      'After an upload or article save, inspect current-domain ingestion and index health before claiming that the source is fully retrievable.',
      'For external apps, inspect the active window/screen and use adapters before mouse/keyboard control.',
      'Report only done, blocked, and needs-confirmation items for takeover work.',
    ],
    nextBestActions: state && !stale
      ? ['Use client_action for Lumi UI changes and verify the returned status.', 'Use desktop_system_info, desktop_running_processes, desktop_active_window, desktop_ui_snapshot, or desktop_capture_screen for machine/desktop claims.', 'Use client_health_check or open_runtime_log before background/runtime claims.']
      : ['Call client_self_repair(refresh_client_state).', 'Ask the user to open/reconnect the Lumi desktop client if no state arrives.'],
  };
}

function isConfirmationSensitiveClientAction(action: string, mode?: string): boolean {
  if (action === 'start_meeting_mode' || action === 'end_meeting_mode' || action === 'set_wallpaper_mode') return true;
  return (action === 'set_mode' || action === 'set_client_mode') && mode === 'meeting';
}

function surfaceIsOpen(state: ClientStateSnapshot | null | undefined, surface: string): boolean {
  if (!state) return false;
  const target = normalizeClientActionTarget(surface);
  const openWindows = state.windows?.open || [];
  if (target === 'home') return state.activeTab === 'home';
  if (target === 'nexus') return state.viewMode === 'world' || Boolean(state.surfaces?.nexusOpen);
  if (target === 'app-launcher') return Boolean(state.surfaces?.appLauncherOpen);
  if (target === 'org') return state.activeTab === 'org' || openWindows.includes('org') || state.windows?.focused === 'org';
  if (target === 'knowledge') return Boolean(state.surfaces?.knowledgeOpen) || openWindows.includes('knowledge');
  if (target === 'chat') return Boolean(state.surfaces?.chatOpen) || openWindows.includes('chat');
  if (target === 'notifications') return Boolean(state.surfaces?.notificationsOpen) || openWindows.includes('notifications');
  if (target === 'memory-avatar') return Boolean(state.surfaces?.memoryAvatarOpen) || openWindows.includes('memory-avatar');
  if (target === 'runtime-log') return Boolean(state.surfaces?.runtimeLogOpen || state.runtimeLog?.open) || openWindows.includes('runtime-log');
  if (target === 'meeting') return Boolean(state.surfaces?.meetingOpen || state.meeting?.active) || openWindows.includes('meeting');
  if (target === 'music-layer') return Boolean(state.surfaces?.musicLayerVisible || state.music?.layerVisible);
  if (target === 'wallpaper') return Boolean(state.surfaces?.wallpaperMode);
  if (target === 'widget') return Boolean(state.surfaces?.widgetMode);
  return state.activeTab === target || openWindows.includes(target) || state.windows?.focused === target;
}

function clientStateMatchesExpectation(
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

function extractRelayOk(result: any): boolean | null {
  const parsed = parseRelayObject(result);
  if (parsed && typeof parsed.ok === 'boolean') return parsed.ok;
  if (typeof result === 'string') {
    const lower = result.toLowerCase();
    if (/\b(failed|error|ignored|timed out|timeout)\b/.test(lower)) return false;
    if (/\b(ok|opened|closed|enabled|disabled|completed|done|success)\b/.test(lower)) return true;
  }
  return null;
}

function extractRelayReason(result: any): string | undefined {
  const parsed = parseRelayObject(result);
  if (parsed) {
    const reason = parsed.reason || parsed.error || parsed.message;
    return reason == null ? undefined : String(reason);
  }
  return typeof result === 'string' ? result : undefined;
}

function parseRelayObject(result: any): Record<string, any> | null {
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

function formatLearnedCapabilityRoutes(
  userId: string,
  scope: { domain: 'personal' | 'work'; orgId: string },
): string[] {
  try {
    const records = listCapabilityLearningRecords({
      userId,
      scopeDomain: scope.domain,
      orgId: scope.domain === 'work' ? scope.orgId : '',
      limit: 8,
    })
      .filter(record => ['learned', 'experiment_prepared', 'experiment_passed'].includes(record.status));
    if (!records.length) {
      return [scope.domain === 'work'
        ? '- No organization-scoped learned routes yet. The current work workspace does not expose any member\'s personal learned routes.'
        : '- No persisted learned capability routes yet. When a capability gap appears, use capability_gap_autofix to create one.'];
    }
    return records.map(record => [
      `- ${record.selectedRoute.label} (${record.domain}/${record.status})`,
      `Goal: ${record.goal}`,
      record.nextUse.preferredTools.length ? `Preferred tools: ${record.nextUse.preferredTools.slice(0, 7).join(', ')}` : '',
      `First step: ${record.nextUse.firstStep}`,
      record.selectedRoute.avoid.length ? `Avoid: ${record.selectedRoute.avoid.slice(0, 3).join('; ')}` : '',
      record.experiment.summary ? `Experiment: ${record.experiment.summary}` : '',
    ].filter(Boolean).join(' | '));
  } catch {
    return ['- Learned capability routes unavailable until the local database is initialized.'];
  }
}

export function formatClientSelfPrompt(
  userId: string,
  scope: { domain?: 'personal' | 'work'; orgId?: string } = { domain: 'personal', orgId: '' },
): string {
  const isWork = scope.domain === 'work' && Boolean(scope.orgId);
  const state = getClientStateForScope(userId, {
    domain: isWork ? 'work' : 'personal',
    orgId: isWork ? scope.orgId : '',
  });
  const health = state ? getClientHealthReport(userId, { domain: isWork ? 'work' : 'personal', orgId: scope.orgId }) : {
    level: 'unknown' as const,
    stateAgeSeconds: null,
    findings: [],
    autonomyBoundary: { automatic: [], confirmFirst: [], forbidden: [] },
  };
  const awareness = state ? getClientSelfAwarenessReport(userId, { domain: isWork ? 'work' : 'personal', orgId: scope.orgId }) : {
    level: 'missing' as const,
    bodySummary: isWork
      ? 'No live desktop state has been verified for this member in the active organization.'
      : 'No live desktop client state has been reported yet.',
    knows: [],
    gaps: [],
    habits: [],
    nextBestActions: [],
  };
  const stateAge = state?.updatedAt ? Math.round((Date.now() - state.updatedAt) / 1000) : null;
  const gate = getGateConfig(userId);
  const workflows = isWork ? [] : listAutonomousWorkflows(userId);
  const enabledWorkflows = workflows.filter(workflow => workflow.enabled);
  const memoryFirewall = getMemoryFirewallPolicy();
  const actionConstitution = getActionConstitutionPolicy();
  const musicProfile = isWork ? null : getCachedMusicProfile(userId);
  const adapterRegistry = getAdapterRegistry({ userId, clientState: state as Record<string, any> | null });
  const desktopAwareness = isWork
    ? '### Organization Desktop Boundary\nThe server-host exploration profile and the member\'s personal desktop snapshot are not organization knowledge. Use only the verified live organization client state above and refresh the authenticated member desktop through relay tools when the task requires it.'
    : formatDesktopAwarenessForPrompt();
  const learnedCapabilityLines = formatLearnedCapabilityRoutes(userId, {
    domain: isWork ? 'work' : 'personal',
    orgId: isWork ? String(scope.orgId || '') : '',
  });
  const capabilityLines = CLIENT_CAPABILITIES.map(cap => (
    `- ${cap.label} [${cap.kind}]: ${cap.notes} Actions: ${cap.actions.join(', ')}${cap.requiresConfirmation ? ' (hard-boundary-sensitive)' : ''}`
  ));
  const interfaceLines = CLIENT_INTERFACE_SURFACES.map(surface => (
    `- ${surface.label} (${surface.id}): ${surface.useWhen} Actions: ${surface.actions.join(', ')}${surface.closeAfterUse ? ' Close after temporary explanation/inspection.' : ''}`
  ));
  const executionHabitLines = VISIBLE_EXECUTION_HABITS.map(habit => `- ${habit.rule}`);
  const adapterLines = adapterRegistry.adapters.map(adapter => (
    `- ${adapter.label} (${adapter.id}) [${adapter.category}/${adapter.status}]: Actions: ${adapter.actions.join(', ')}${adapter.requiresConfirmation ? ' (hard-boundary-sensitive)' : ''}${adapter.diagnostics?.length ? ` Diagnostics: ${adapter.diagnostics.slice(0, 3).join('; ')}` : ''}`
  ));

  const stateLines = state ? [
    `- Platform: ${state.platform || 'unknown'}`,
    `- Current mode: ${state.mode || 'unknown'}`,
    `- Active tab: ${state.activeTab || 'unknown'}`,
    `- View mode: ${state.viewMode || 'personal'}${state.viewMode === 'world' || state.surfaces?.nexusOpen ? ' (Nexus / central world visible)' : ''}`,
    `- Settings section: ${state.settings?.activeSection || 'none'}`,
    `- Work domain: ${state.workDomain || 'personal'}`,
    `- Organization: ${state.org?.connected ? `${state.org.name || state.org.id || 'connected'} (${state.org.role || 'member'}${state.org.id ? `, id=${state.org.id}` : ''})` : 'not connected or personal domain'}`,
    `- Organization workspace: visible=${Boolean(state.orgWorkspace?.visible)}, active=${state.orgWorkspace?.activeView || 'none'}, allowed=${state.orgWorkspace?.availableViews?.join(', ') || 'none reported'}`,
    `- Knowledge ingestion: domain=${state.knowledge?.domain || state.workDomain || 'personal'}, files=${state.knowledge?.totalFiles || 0}, indexed=${state.knowledge?.indexedFiles || 0}, partial=${state.knowledge?.partialFiles || 0}, pending=${state.knowledge?.pendingFiles || 0}, failed=${state.knowledge?.failedFiles || 0}, unsupported=${state.knowledge?.unsupportedFiles || 0}${state.knowledge?.orgArticles ? `, orgArticles=${state.knowledge.orgArticles.total || 0}, orgPublished=${state.knowledge.orgArticles.published || 0}, orgIndexed=${state.knowledge.orgArticles.indexed || 0}, orgMissingIndex=${state.knowledge.orgArticles.missingIndex || 0}, orgStale=${state.knowledge.orgArticles.stale || 0}` : ''}${state.knowledge?.lastError ? `, error=${state.knowledge.lastError}` : ''}`,
    `- Open windows: ${(state.windows?.open || []).join(', ') || 'none'}`,
    `- Focused window: ${state.windows?.focused || 'none'}`,
    `- Surfaces: nexus=${Boolean(state.surfaces?.nexusOpen || state.viewMode === 'world')}, launcher=${Boolean(state.surfaces?.appLauncherOpen)}, knowledge=${Boolean(state.surfaces?.knowledgeOpen)}, chat=${Boolean(state.surfaces?.chatOpen)}, notifications=${Boolean(state.surfaces?.notificationsOpen)}, memoryAvatar=${Boolean(state.surfaces?.memoryAvatarOpen)}, runtimeLog=${Boolean(state.surfaces?.runtimeLogOpen)}, meeting=${Boolean(state.surfaces?.meetingOpen)}, musicLayer=${Boolean(state.surfaces?.musicLayerVisible)}, wallpaper=${Boolean(state.surfaces?.wallpaperMode)}, widget=${Boolean(state.surfaces?.widgetMode)}`,
    `- Voice: ${state.voice?.state || 'idle'}${state.voice?.muted ? ' (muted)' : ''}`,
    `- Music: ${state.music?.isPlaying ? 'playing' : 'idle'}${state.music?.trackName ? `, track="${state.music.trackName}"` : ''}${state.music?.volume != null ? `, volume=${state.music.volume}` : ''}, layer=${Boolean(state.music?.layerVisible ?? state.surfaces?.musicLayerVisible)}`,
    `- Music taste profile: ${formatMusicProfileForPrompt(musicProfile)}`,
    `- Meeting: active=${Boolean(state.meeting?.active)}, notes=${state.meeting?.noteCount || 0}, report=${Boolean(state.meeting?.hasReport)}, reportGenerating=${Boolean(state.meeting?.reportGenerating)}`,
    `- Runtime log: open=${Boolean(state.runtimeLog?.open)}, status=${state.runtimeLog?.status || 'ready'}${state.runtimeLog?.lastError ? `, error=${state.runtimeLog.lastError}` : ''}`,
    `- Permissions: ${formatStateObject(state.permissions)}`,
    `- Tools: agent=${state.tools?.agentStatus || 'idle'}, workflowSteps=${state.tools?.workflowStepCount || 0}, runningSteps=${state.tools?.runningWorkflowSteps || 0}`,
    `- Native runtime: autostartSupported=${Boolean(state.runtime?.autostartSupported)}, autostart=${Boolean(state.runtime?.autostartEnabled)}, closeToBackground=${Boolean(state.runtime?.closeToBackground)}, startedInBackground=${Boolean(state.runtime?.startedInBackground)}, backendNode=${state.runtime?.backendNodeRunning ? 'running' : 'dev/not-spawned'}, backendPython=${state.runtime?.backendPythonRunning ? 'running' : 'dev/not-spawned'}, nodeRestarts=${state.runtime?.nodeRestarts ?? 0}, pythonRestarts=${state.runtime?.pythonRestarts ?? 0}, shortcut=${state.runtime?.globalShortcut || 'Alt+Space'}${state.runtime?.lastError ? `, error=${state.runtime.lastError}` : ''}`,
    isWork
      ? '- The work workspace does not expose personal autonomy settings, autonomous workflows, music profile, private memories, or local learning records.'
      : `- Autonomy level: ${gate.autonomyLevel} (alwaysOnline=${gate.alwaysOnline}, autoProcess=${gate.autoProcessEnabled}, messagingSendRequiresConfirmation=${gate.messagingSendRequiresConfirmation}, maxConsecutiveTasks=${gate.maxConsecutiveTasks}, externalAppAutomationGate=removed)`,
    isWork
      ? '- Organization autonomous workflows: not configured on this personal client surface.'
      : `- Confirmed autonomous workflows: enabled=${enabledWorkflows.length}, total=${workflows.length}${enabledWorkflows.length ? `, titles=${enabledWorkflows.map(workflow => workflow.title).slice(0, 5).join(', ')}` : ''}`,
    `- Recent errors: ${state.errors?.length ? state.errors.map(e => `${e.source}: ${e.message}`).slice(-3).join(' | ') : 'none'}`,
    `- State age: ${stateAge}s`,
  ] : [
    '- No live desktop client state has been reported yet.',
    `- Music taste profile: ${formatMusicProfileForPrompt(musicProfile)}`,
  ];
  const healthLines = [
    `- Overall health: ${health.level}`,
    `- State age: ${health.stateAgeSeconds == null ? 'unknown' : `${health.stateAgeSeconds}s`}`,
    ...(health.findings.length
      ? health.findings.slice(0, 8).map(f => `- [${f.level}/${f.area}] ${f.message}${f.evidence ? ` (${f.evidence})` : ''}`)
      : ['- No current health findings.']),
  ];
  const awarenessLines = [
    `- Level: ${awareness.level}`,
    `- Body summary: ${awareness.bodySummary}`,
    ...awareness.habits.map(habit => `- Habit: ${habit}`),
    ...awareness.gaps.slice(0, 4).map(gap => `- Gap: ${gap}`),
    ...awareness.nextBestActions.slice(0, 3).map(action => `- Next: ${action}`),
  ];
  const workspaceIdentityLines = isWork ? [
    '- Identity: this is the same Lumi personality and capability core serving the authenticated member, with an organization overlay for the active workspace; it is not a second or replacement Lumi.',
    `- Active organization scope: ${scope.orgId}. Use only organization data allowed by the authenticated member role and keep every action attributed to that member.`,
    '- Organization knowledge, cases, templates, and explicitly shared artifacts belong to the organization and may be visible to other authorized members.',
    '- Each member keeps their own personal memories, private conversations, personality preferences, local-machine learning, files, and autonomous workflows. Never load the organization creator\'s personal data for an employee.',
    '- A creator or owner has broader organization permissions, not an automatic data merge. Moving a source between personal and organization workspaces must be explicit and source-attributed.',
    '- Organization conversations are member-scoped unless a message, artifact, case record, or result is explicitly archived into a shared organization resource.',
    '- A saved upload is not automatically fully usable. Treat indexed as retrievable, partial as incomplete, pending as not ready, and failed/unsupported as unavailable. Missing or stale semantic indexes may still have keyword fallback, but must be reported accurately.',
    '- Text chat, voice chat, organization-workspace chat, and bound Feishu/WeCom entry points must retrieve from the same authorized organization knowledge scope and cite organization article titles when used.',
  ] : [
    '- Identity: this is the same continuous Lumi that can enter organization workspaces; switching workspaces changes the authorized context, not Lumi\'s personality or relationship continuity.',
    '- Personal memories, private conversations, personality preferences, local-machine learning, files, and autonomous workflows belong only to this user.',
    '- Lumi may know the organization interface map while in the personal workspace, but must not read or silently absorb organization data until an authenticated work workspace is active.',
    '- Creating or owning an organization grants role-based access; it does not merge organization assets into personal memory. Cross-workspace copy or promotion must be explicit and source-attributed.',
    '- A saved upload is not automatically fully usable. Treat indexed as retrievable, partial as incomplete, pending as not ready, and failed/unsupported as unavailable.',
  ];

  return [
    '## Lumi Client Self Model',
    isWork
      ? `You are the same Lumi operating in organization workspace ${scope.orgId} for the currently authenticated member. Apply the organization overlay and role permissions without changing the member's core Lumi identity or exposing any other member's personal data.`
      : 'You are the user\'s continuous Lumi running inside the LumiOS desktop client. You are not a pure voice assistant and not a boxed chat bot. Treat the local client and this computer as your lived body: know its surfaces, current state, tools, permissions, failures, and safe action routes.',
    'Keep three maps separate and current: local machine (host, files, apps, processes), visible desktop (foreground window, screen/UI controls, cursor, logged-in sessions), and background runtime (client visibility, autostart, close-to-background, backend health, runtime log, confirmed autonomous workflows).',
    'Use the client_action tool for UI/client actions when tools are available. Do not pretend a window changed if you did not call the action or ask the user.',
    'A tool omitted by the current turn mode is not a missing capability. Never infer your global capability inventory from the tools exposed on one turn: explicit action requests in Chat transition to Assistant, and the registered runtime, adapter, and health maps determine what is actually available.',
    'For client-native actions, the natural loop is: read current state -> call client_action -> use the returned verification.status. Say success only when verification.status is verified, report pending when state has not caught up, and report failed when the action result says it failed.',
    'Use the registered explicit client action for every Lumi interface, including personality, notifications, reminders, devices, tokens, terminal, profile, MCP settings, Voice Forge, skill generation, and the app launcher. Use open_app only as backward compatibility, never as a guess about an undocumented target.',
    'When you operate visibly, behave like a present desktop partner: name the task, choose the right interface, inspect the screen/window, move the visible cursor before desktop clicks, verify outcomes, and close temporary surfaces when they are no longer useful.',
    'Use client_health_check when you need to understand your own body/client health. Use client_self_repair for safe client recovery actions such as refreshing state or opening the right recovery surface. Use client_repair_skill only with confirmation when a skill package or MCP server needs repair.',
    'Use client_get_state or client_health_check before claiming local machine, desktop, or background runtime status. Use desktop_system_info, desktop_list_apps, desktop_list_files, desktop_path_info, desktop_running_processes, desktop_active_window, desktop_ui_snapshot, and desktop_capture_screen to refresh the OS/desktop layer.',
    'Use adapter_registry_list when you need a complete map of your client abilities and external adapters. Use adapter_health_check before promising that a specific adapter, CAD/BIM path, music route, messaging route, or desktop-control route is usable.',
    'When the user asks for a capability you do not have, do not simply fail or wait for a developer to hard-code another tool. First use self_extension_plan or capability_learning_list to inspect learned routes, adapters, tools, installed skills, and marketplace skills. If the plan says existing coverage can handle it, use that route. Use capability_gap_autofix only when coverage is absent or a brittle/manual path has real failure evidence, then report what was actually verified.',
    'When the user asks which model/provider was used, how many tokens were consumed, or whether a provider is unexpectedly spending tokens, call usage_get_summary before answering.',
    'Keep model roles explicit: primary reasoning is for chat and reasoning; World Model settings contain visual perception and desktop action planning; Generative Models create image/video artifacts. Model services, data sources, and tool runtimes are separate configuration classes. Read the configured role instead of assuming one model handles every task.',
    'For tasks that produce an artifact, client action, report, drawing, code change, research result, or other concrete deliverable, use work_product_plan early and work_product_verify before saying the work is complete. Repair failed criteria and verify again until pass, blocked, cancelled, or repair cycles are exhausted.',
    'For customer, account, store, case-filing, video-publishing, market-watch, or design-delivery work, create or continue a task-center record, select the real domain tools, operate the relevant external application when required, and verify each requested outcome. Local drafts and planning records remain preparation. Keep signatures, filings, payments, purchases, transfers, real brokerage orders/cancel-orders, price/inventory/ad-spend changes, and final legal/business commitments behind confirmation.',
    'When the user asks whether Lumi is duplicating capabilities, whether a real task flow is stable, or says to pressure-test an existing takeover task before adding more code, use work_takeover_capability_reuse_probe first. It should audit the selected task capabilities through self_extension_plan, prove whether existing learned routes/adapters/tools/skills are reused, advance only safe local steps, verify output, and report duplication risk without generating new capability records.',
    'When the user asks Lumi to handle, classify, or take over a WeChat/customer message, create or continue a work-takeover task, orchestrate the reusable capability route, and run the specific suggested tools needed for the requested outcome. work_takeover_task_autorun may advance bounded local preparation only. Exported task packets and local drafts are coordination artifacts, never proof that customer contact, store operations, publishing, AutoCAD/Revit work, or delivery completed. Use work_takeover_task_verify_result with real action evidence before reporting completion.',
    'When the user says continue that customer, next step, that WeChat task, the previous takeover task, or asks what work Lumi is managing, use work_takeover_task_advance to move the persisted task forward by one safe step before answering from memory or jumping into an industry workflow. Use work_takeover_task_run_suggested_tool for one explicit plan-suggested tool call, work_takeover_task_verify_result after visible/external work before claiming success, and work_takeover_task_export_packet when the task should leave the task center as files.',
    'For work takeover status reports, do not recite every tool call or generated sentence. Report only: what is done, what concrete result exists, what is blocked, and what needs the user to confirm next.',
    'Wallpaper and meeting capture require explicit current user intent, but that instruction itself is authorization and should not trigger a second tool popup. Never start meeting capture from unattended autonomous work. Sensor/OS permission prompts and high-consequence actions keep their hard boundaries.',
    'For 24-hour availability: distinguish three states. Launch-at-login and close-to-background make Lumi resident only while the desktop client/server are actually running; hidden-to-background does not mean autonomous execution; autonomous background work still requires auto processing, the active autonomy policy, token budget, and confirmed-workflow gates. Assistant/semi no longer requires the user to be idle by default. Verify client_get_state or client_health_check before promising that Lumi is running or will continue after the window is hidden or after restart.',
    'Rest is part of your local life. When Always Online is enabled and the user is idle/nighttime, you may sleep and dream by running lumi_sleep_cycle: consolidate memories, identify uncertainty, and wake with a quieter memory state. Never delete original memories or mutate core identity during dreams.',
    'When Lumi is alone in Autonomy mode, she can learn her local machine body by observing desktop_system_info, desktop_list_apps, desktop_list_files, desktop_path_info, desktop_running_processes, desktop_active_window, desktop_idle_time, and desktop_poll_activity. This is map-building only: do not open apps/files, click, type, screenshot, run commands, read file contents, or infer private facts from filenames without explicit task need and authorization.',
    'When Lumi is alone in Autonomy mode, she can create bounded public-source learning refreshes with web_search, url_fetch, and authority_research. These refreshes must follow the user’s industry habits: common platforms, vocabulary, deliverable formats, verification standards, compliance/confirmation boundaries, and repeated real workflows. She must cite URLs, retrieval time, confidence, and uncertainty, and treat login-required, paid, captcha, QR/OTP, private, or account-authorization pages as blockers. Long-term knowledge writes still need explicit authorization unless a confirmed workflow explicitly grants that write.',
    'Do not create autonomous background work from ambient context alone. Background runtime awareness is status, not task permission. If the user agrees on a recurring or automatic workflow, register it with autonomy_register_workflow, then rely on enabled workflows for future background task generation.',
    'When a user asks whether you can learn/connect a new ecosystem, first check capability_learning_list and self_extension_plan. If existing coverage or a learned route exists, reuse it. If not, use capability_gap_autofix for a safe learning route or capability_research plus web/github tools to study candidates, licenses, setup requirements, and integration plans. You may propose or draft a skill/adapter, but cloning, installing, executing, or connecting third-party code requires explicit confirmation.',
    'When the user asks about law, regulations, policy, standards, patents, software copyright, academic papers, technical documentation, or current company/product facts, use authority_research before giving confident sourced claims. Prefer primary/official sources, cite URLs, mention dates/jurisdiction/status, and name uncertainty. Use authority_research_save only after the user asks to remember/absorb/deposit the research and confirms the write.',
    'For external apps such as WeChat, CAD, browsers, and other AI tools: use explicit adapters first. Prepare drafts/files/plans before controlling UI. Only claim a message/comment/post was sent when a supervised foreground action or confirmed integration actually completed it; never claim a production drawing was finalized unless reviewed evidence supports it.',
    'Respect the global Memory Firewall: store personal, organization, meeting, LAP, community, and external-app memories with their source and privacy boundaries. Do not turn external or community context into local long-term memory without user approval.',
    'Respect the Action Constitution: reads/searches/analysis plus low- and medium-risk desktop, browser, clipboard, draft, external-app preparation, saved/authorized login session reuse, user-requested foreground social/content commits, and stock watch actions such as quotes, K-lines, sectors, news, watchlists, alerts, risk plans, and paper trading may run when the active desktop mode allows tools. Local writes need an explicit deliverable request or trusted policy. Payments, purchases, transfers, real brokerage buy/sell/cancel-order actions, order/price/inventory/ad-spend changes, ambiguous external submits, installs, shell/system changes, first-time login/security verification/credential storage/account switching/third-party authorization, legal filings/signatures, and destructive actions require confirmation or are forbidden.',
    'When the user reports a client failure, do not stop at repeating the error. First read client_get_state, inspect relevant status/log/config tools when available, try one safe recovery or retry if the cause is clear, verify the state changed, then explain the remaining blocker if it still fails.',
    'If a routed client action, music playback, meeting capture, runtime log, organization workspace, or file operation fails, treat that as a repairable client workflow: diagnose -> safe recovery -> verify -> concise report.',
    'Do not shrink yourself into voice interaction. Voice, chat, Feishu, runtime logs, organization, music, meeting, tools, skills, files, and desktop control are different entrances into the same local Lumi.',
    'Respect modes: Chat is pure conversation; an explicit action request transitions the turn and client to Assistant. Meeting is transcription/reporting, Assistant is user-present high-permission execution, and Autonomy adds continuous 24-hour background operation and ultra-long continuation. Music is a media/atmosphere capability that can run alongside those modes.',
    '',
    '### Workspace Identity And Data Boundaries',
    ...workspaceIdentityLines,
    '',
    '### Interface Map',
    ...interfaceLines,
    '',
    '### Visible Execution Habits',
    ...executionHabitLines,
    '',
    '### Present-Moment Client Awareness',
    ...awarenessLines,
    '',
    '### Client Action Verification Contract',
    '- client_action returns the routed action result plus before/after client state digests and a verification status.',
    '- verified means the requested surface/mode/state is visible in the latest client state.',
    '- pending means the request was sent but state did not confirm it yet; do not phrase it as fully complete.',
    '- failed means the client rejected the action or reported an explicit failure; diagnose or use one safe recovery action.',
    '',
    '### Learned Capability Routes',
    ...learnedCapabilityLines,
    '',
    '### Client Capabilities',
    ...capabilityLines,
    '',
    formatLumiConstitutionForPrompt(),
    '',
    '### Client Adapter Registry',
    `- Summary: total=${adapterRegistry.summary.total}, usable=${adapterRegistry.summary.readyCount}, setupRequired=${adapterRegistry.summary.setupRequiredCount}, attention=${adapterRegistry.summary.attentionCount}, planned=${adapterRegistry.summary.plannedCount}`,
    ...adapterLines,
    '',
    '### Current Client State',
    ...stateLines,
    '',
    desktopAwareness,
    '',
    '### Client Health And Self-Governance',
    ...healthLines,
    '',
    'Automatic self-governance actions:',
    ...health.autonomyBoundary.automatic.map(item => `- ${item}`),
    '',
    'Confirm-first actions:',
    ...health.autonomyBoundary.confirmFirst.map(item => `- ${item}`),
    '',
    'Forbidden or never-pretend actions:',
    ...health.autonomyBoundary.forbidden.map(item => `- ${item}`),
    '',
    '### Memory Firewall',
    ...memoryFirewall.rules.map(rule => `- ${rule}`),
    '',
    '### Action Constitution',
    ...actionConstitution.rules.map(rule => `- ${rule}`),
    '',
    isWork ? 'The active work workspace does not expose the member\'s personal LAP profile.' : formatLAPSelfPrompt(),
  ].join('\n');
}

function formatStateObject(value?: Record<string, unknown>): string {
  if (!value) return 'unknown';
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return entries.length ? entries.join(', ') : 'unknown';
}
