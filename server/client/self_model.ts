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
  windows?: { open?: string[]; focused?: string | null; minimized?: string[] };
  surfaces?: {
    knowledgeOpen?: boolean;
    chatOpen?: boolean;
    runtimeLogOpen?: boolean;
    meetingOpen?: boolean;
    musicLayerVisible?: boolean;
    wallpaperMode?: boolean;
    widgetMode?: boolean;
    nexusOpen?: boolean;
    customerTakeoverOpen?: boolean;
    customerTakeoverStage?: string | null;
    designDeliveryOpen?: boolean;
    designDeliveryStage?: string | null;
    ecommerceGrowthOpen?: boolean;
    ecommerceGrowthStage?: string | null;
  };
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
  activeTab: string;
  viewMode: string;
  focusedWindow: string;
  openWindows: string[];
  openSurfaces: string[];
  voice: string;
  music: string;
  meetingActive: boolean;
  runtimeStatus: string;
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
    notes: 'Conversation-first state. Lumi answers naturally by default, but explicit user commands can still use the local client and tools.',
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
    notes: 'Guided execution. Lumi can use tools when the user asks for action.',
    stateKeys: ['mode', 'tools'],
  },
  {
    id: 'mode.autonomous',
    label: 'Autonomy mode',
    kind: 'mode',
    actions: ['set_client_mode(autonomous)', 'open_runtime_log'],
    notes: 'Visible multi-step execution through tools, run logs, desktop control, and teams.',
    requiresConfirmation: true,
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
    actions: ['open_organization_workspace'],
    notes: 'Organization hub for local/cloud org work, knowledge base, templates, members, audit, and settings.',
    stateKeys: ['workDomain', 'org'],
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
    notes: 'Personal knowledge, uploaded knowledge-base files, memories, imports, and memory organization. Use this as Lumi\'s single file knowledge surface.',
    stateKeys: ['surfaces.knowledgeOpen'],
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
    actions: ['client_get_state', 'client_action', 'adapter_registry_list'],
    notes: 'Lumi knows her own client interfaces and can choose the right surface for a task: home, chat, knowledge, runtime log, skills, tools, team, avatar, sound, organization, plans, settings, music, meeting, wallpaper, widget mode, subscription/activation/billing, computer adaptation, and large work takeover panels.',
    stateKeys: ['windows', 'surfaces', 'tools', 'runtimeLog', 'music', 'meeting', 'org'],
  },
  {
    id: 'system.local_machine_awareness',
    label: 'Local machine awareness',
    kind: 'system',
    actions: ['client_get_state', 'client_health_check', 'desktop_system_info', 'desktop_list_apps', 'desktop_list_files', 'desktop_path_info', 'desktop_running_processes', 'desktop_active_window', 'desktop_capture_screen', 'adapter_registry_list'],
    notes: 'Lumi treats this host as the local machine only through evidence: OS and home directory, launchable apps, files/folders, foreground window, running processes, and screenshots from the desktop relay. Before claiming what is installed, where a file is, what is on the Desktop, or what is currently running, refresh the relevant machine/desktop fact instead of guessing.',
    stateKeys: ['runtime', 'tools', 'windows', 'surfaces', 'permissions'],
  },
  {
    id: 'runtime.background_residency',
    label: 'Background runtime awareness',
    kind: 'runtime',
    actions: ['client_get_state', 'client_health_check', 'open_runtime_log', 'client_self_repair', 'desktop_idle_time', 'desktop_poll_activity', 'autonomy_get_policy', 'autonomy_list_workflows', 'autonomy_register_workflow'],
    notes: 'Lumi distinguishes visible window state, hidden-to-background resident client state, backend process health, launch-at-login, close-to-background, and autonomous workflow execution. Resident background availability requires the desktop client/server to be alive; autonomous background work follows the desktop mode/autonomy policy, token budget, and a user-confirmed workflow. Assistant/semi is low-friction for user-present work; Autonomy/full is for continuous execution. Verify runtime state before promising that Lumi will keep working after the window is hidden or after restart.',
    requiresConfirmation: true,
    stateKeys: ['runtime', 'runtimeLog', 'autonomy', 'mode', 'permissions', 'tools'],
  },
  {
    id: 'system.visible_execution',
    label: 'Visible task execution',
    kind: 'system',
    actions: ['client_get_state', 'client_action', 'desktop_show_lumi_window', 'desktop_active_window', 'desktop_running_processes', 'desktop_idle_time', 'desktop_poll_activity', 'desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'desktop_capture_screen', 'read_clipboard', 'write_clipboard', 'mouse_move', 'mouse_click', 'mouse_drag', 'keyboard_type', 'keyboard_press', 'computer_use'],
    notes: 'For visible work Lumi should state the task goal, choose the right interface, inspect the active window with desktop_ui_snapshot when native controls are available, use desktop_ui_focus/click/invoke/type for real accessible controls, inspect the screen/current window when pixels are needed, move the visible cursor to the real target before raw desktop clicks, perform real desktop input when appropriate, verify outcomes, report only results/blockers/needed confirmations, and close temporary surfaces after they are explained. Registered tools expose observation, UIA, clipboard, mouse, keyboard, app opening, command execution, and vision computer_use. Workflow-internal relay actions such as desktop_cursor_glow_*, desktop_mouse_click_at, and desktop_set_wallpaper_mode are available to controlled workflows including foreground WeChat sends, desktop demos, and computer_use cleanup. Prebuilt workflows are reusable operating patterns, not fake demos: adapt the sequence to the current user goal, screen state, installed apps, and required deliverables.',
    requiresConfirmation: true,
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
    id: 'system.customer_takeover_workflow',
    label: 'Customer work takeover',
    kind: 'system',
    actions: ['customer_takeover_workflow', 'customer_takeover_panel', 'close_customer_takeover_panel', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_active_window', 'desktop_capture_screen', 'desktop_list_apps', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press'],
    notes: 'In this stage, when the user asks Lumi to take over or advance a customer, Lumi can run a bounded customer work takeover: classify a WeChat lead, explain authorization boundaries, create quote and contract draft materials in external office software, prepare a WeChat reply draft without sending by default, and show the large customer-result panel. The durable ability is to turn customer intent into artifacts, next actions, and a visible result, not to replay one fixed demo order.',
    requiresConfirmation: true,
    stateKeys: ['surfaces', 'windows', 'voice', 'tools', 'permissions'],
  },
  {
    id: 'system.design_delivery_workflow',
    label: 'Renovation design delivery takeover',
    kind: 'system',
    actions: ['design_delivery_workflow', 'design_delivery_panel', 'close_design_delivery_panel', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_active_window', 'desktop_capture_screen', 'desktop_list_files', 'desktop_list_apps', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press', 'create_ppt', 'create_pdf', 'cad_generate_dxf', 'cad_generate_autocad_draw_script', 'cad_run_autocad_draw_script'],
    notes: 'In this stage, when the user asks Lumi to take over a renovation/design delivery task, Lumi can generate a local desktop delivery package: proposal, budget/material list, customer-facing PPTX/PDF design deck with layout/material/budget visuals, CAD DXF draft, AutoCAD stroke-by-stroke drawing playback scripts, execute those scripts through AutoCAD /b with completion-marker verification, Revit/Dynamo handoff files, and a WeChat delivery draft. Lumi should open real external tools where available: WPS/Office for documents, desktop CAD software such as AutoCAD/FreeCAD for DXF or visible draw scripts, Dynamo/Revit entry points or handoff files for BIM, and an already logged-in personal WeChat window before falling back to enterprise WeChat. Production drawings still require confirmed site dimensions, structure, utilities, and user sign-off. The durable ability is the delivery standard and tool handoff logic, not a one-off video script.',
    requiresConfirmation: true,
    stateKeys: ['surfaces', 'windows', 'voice', 'tools', 'permissions'],
  },
  {
    id: 'system.ecommerce_growth_workflow',
    label: 'E-commerce growth takeover',
    kind: 'system',
    actions: ['ecommerce_growth_workflow', 'ecommerce_growth_panel', 'close_ecommerce_growth_panel', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_mouse_click_at', 'desktop_active_window', 'desktop_capture_screen', 'desktop_list_files', 'desktop_list_apps', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press'],
    notes: 'In this stage, when the user asks Lumi to take over ecommerce, short-video content production, store account management, product publishing, or customer-service handoff, Lumi can generate a local desktop delivery package: store audit, content matrix, short-video script, image generation prompts, video generation prompts, publish draft, customer-service/WeChat draft, operation report, and verification record. Lumi should use real external surfaces where available: browser pages for image/video/generative tools, WPS/Excel for content matrices, creator platforms and store backends for publishing/account work, and an already logged-in personal WeChat before falling back to enterprise WeChat. Restore already-running/logged-in app and browser sessions before opening fresh pages; reuse saved/authorized login profiles without extra permission prompts; stop at QR/OTP/CAPTCHA/passkey/account-switch/authorization/credential-storage boundaries. Foreground user-present ordinary comments, replies, messages, and non-commercial content posts can proceed when requested; ad spend, price/inventory changes, purchases, payments, first-time login/security verification, and legal/contractual final commits still require confirmation. The durable ability is to convert a shop/product/platform brief into visible external-tool work and checked results, not to replay one fixed video script.',
    requiresConfirmation: true,
    stateKeys: ['surfaces', 'windows', 'voice', 'tools', 'permissions'],
  },
  {
    id: 'system.work_takeover_tasks',
    label: 'Work takeover task hub',
    kind: 'system',
    actions: ['work_takeover_task_create', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'work_takeover_task_list', 'work_takeover_task_get', 'work_takeover_task_update', 'work_takeover_task_continue', 'work_takeover_task_orchestrate', 'work_takeover_task_execute_step', 'work_takeover_task_advance', 'work_takeover_task_autorun', 'work_takeover_capability_reuse_probe', 'work_takeover_real_smoke_run', 'work_takeover_task_prepare_industry_package', 'work_takeover_task_verify_result', 'work_takeover_task_export_packet', 'work_takeover_task_run_suggested_tool'],
    notes: 'Persistent task hub for current-stage work takeover. Lumi core stays thin: turn WeChat messages or user instructions into tracked tasks with industry parameters, orchestrate safe steps, choose an industry package adapter/skill, verify outputs, and stop at confirmation boundaries. Use work_takeover_capability_reuse_probe when the user asks whether Lumi is duplicating capabilities, whether the flow is stable, or wants a real task pressure test before adding more code: it audits each selected task capability through self_extension_plan, proves whether Lumi is reusing learned routes/adapters/tools/skills, advances a few safe local steps, prepares supported local packages, verifies output, and writes a concise diagnostic. Use work_takeover_real_smoke_run when the user says “接管这条微信先跑一遍”, wants a true closed-loop test, or needs proof that the flow is not a fixed script: it creates/continues the task, selects external-control routes such as Playwright browser, Windows UIA/screen perception, WeChat session reuse, or WPS/CAD/Revit handoff, advances bounded safe steps, prepares files through the industry adapter, verifies content/files/drafts/desktop evidence, exports a local packet, and writes a concise human report back. Use work_takeover_task_orchestrate to bridge a persisted task into a reusable execution plan without turning an industry demo into a fixed script. Use work_takeover_task_execute_step and work_takeover_task_advance to safely prepare and record one step at a time. Use work_takeover_task_autorun for the older bounded loop when route selection and full verification are not needed. Use work_takeover_task_prepare_industry_package when a persisted task needs real local industry deliverables; it routes to ecommerce/short-video/account, renovation/CAD/Revit, and future skill-backed packages. Use work_takeover_task_verify_result after visible desktop or external tool work to check active window/processes, screenshot evidence, local paths, artifact content terms, drafts, confirmation boundaries, and task-center state before claiming success. Use work_takeover_task_export_packet to materialize the task into local files. Use work_takeover_task_run_suggested_tool only when a specific plan-suggested tool and arguments are ready; the underlying tool keeps its own confirmation behavior.',
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
    notes: 'For laws, policies, patents, software copyright, standards, papers, technical docs, and current facts, Lumi can search primary/official sources, score authority, fetch excerpts, cite URLs, and save verified research into long-term knowledge only after user confirmation.',
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
    notes: 'Lumi uses the three desktop modes as the autonomy permission source: Chat maps to reactive, Assistant maps to low-friction semi, and Autonomy maps to continuous full. The desktop client can launch at login, hide to tray/background, and supervise bundled backend processes. That is resident runtime, not permission to invent automatic work; background task generation still comes from confirmed workflows and autonomy policy. There is no separate external-app automation gate.',
    requiresConfirmation: true,
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
    notes: 'Lumi is not a voice-only assistant. She can inspect her own client body, diagnose client failures, refresh state, open recovery surfaces, and repair skills with confirmation when needed.',
    requiresConfirmation: true,
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
    notes: 'When a capability seems missing, Lumi should first inspect learned routes, adapters, tools, installed skills, and marketplace skills. Use capability_gap_autofix only when there is no sufficient coverage or when a brittle/manual path has real failure evidence; then prepare or run a minimal verification experiment and persist one reusable route.',
    requiresConfirmation: true,
    stateKeys: ['tools', 'permissions', 'runtime'],
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
    actions: ['floorplan_extract_geometry', 'ocr_image_file', 'cad_generate_dxf', 'cad_generate_autocad_draw_script', 'cad_run_autocad_draw_script', 'design_delivery_workflow', 'desktop_list_apps', 'desktop_open', 'desktop_run_command'],
    notes: 'Lumi can extract CAD-ready geometry from plan images, generate structured DXF draft files with doors/windows/dimensions, generate AutoCAD LISP/SCRIPT playback so entities appear stroke by stroke, execute the script through AutoCAD /b, and verify completion with a marker file plus desktop process/window evidence under the active desktop mode. Use desktop_list_apps to find installed CAD launchers before guessing AutoCAD paths. Lumi should not substitute a browser preview for CAD handoff when a real CAD application is available. Production drawings still require user review and confirmed site dimensions.',
    requiresConfirmation: false,
    stateKeys: ['permissions', 'tools'],
  },
  {
    id: 'external.ai_apps',
    label: 'Other local AI and agent tools',
    kind: 'external_app',
    actions: ['external_app_list_adapters', 'desktop_list_apps', 'desktop_open', 'computer_use'],
    notes: 'Lumi can coordinate other AI apps through files, browser, clipboard, MCP, and confirmed computer-use sessions. Prefer the native app index and explicit integrations before visual control.',
    requiresConfirmation: true,
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

const CLIENT_INTERFACE_SURFACES: ClientInterfaceSurface[] = [
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
    useWhen: 'Show personal knowledge, imported files, memories, and source-bound context.',
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
    useWhen: 'Show work-domain knowledge, templates, members, audit, or team organization surfaces.',
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
    id: 'customer-takeover-panel',
    label: 'Customer takeover panel',
    actions: ['customer_takeover_panel', 'close_customer_takeover_panel'],
    useWhen: 'Show or close the large customer takeover/result panel without launching a full workflow.',
    closeAfterUse: true,
  },
  {
    id: 'design-delivery-panel',
    label: 'Design delivery panel',
    actions: ['design_delivery_panel', 'close_design_delivery_panel'],
    useWhen: 'Show or close the large renovation/design delivery panel without launching a full workflow.',
    closeAfterUse: true,
  },
  {
    id: 'ecommerce-growth-panel',
    label: 'Ecommerce growth panel',
    actions: ['ecommerce_growth_panel', 'close_ecommerce_growth_panel'],
    useWhen: 'Show or close the large ecommerce/account/content growth panel without launching a full workflow.',
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
    rule: 'Use wallpaper mode during explicit demonstrations or confirmed visible desktop-control sessions so Lumi feels present on the desktop, then turn it off when done.',
  },
  {
    id: 'large_panel_for_result_takeover',
    rule: 'For customer takeover and other result-oriented work takeover flows, use the large centered result panel as the primary visible work surface and hide the corner workflow panel while it is active.',
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

export function getClientHealthReport(userId: string): ClientHealthReport {
  const state = getClientState(userId);
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
        'Repair or reinstall skills.',
        'Clone, install, connect, or execute third-party code from GitHub, npm, Python, Revit add-ins, CAD plugins, or MCP servers.',
        'Start meeting capture, autonomous execution, or wallpaper mode.',
        'Operate shell/system commands, first-time login/security verification/credential storage/account switching, CAD app execution, ambiguous external submits, high-consequence external commits, or file writes without explicit deliverable intent.',
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
    notifications: 'notifications',
    notification: 'notifications',
    reminders: 'reminders',
    reminder: 'reminders',
    devices: 'devices',
    device: 'devices',
    'device-sync': 'devices',
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
    '电脑适配中心': 'kernel',
    '计算机适配中心': 'kernel',
    '电脑适配': 'kernel',
    '订阅': 'subscription',
    '激活': 'subscription',
    '账单': 'subscription',
    'customer_takeover_panel': 'customer-takeover-panel',
    'customer-takeover': 'customer-takeover-panel',
    'customer-takeover-panel': 'customer-takeover-panel',
    '客户接管面板': 'customer-takeover-panel',
    'design_delivery_panel': 'design-delivery-panel',
    'design-delivery': 'design-delivery-panel',
    'design-delivery-panel': 'design-delivery-panel',
    '设计交付面板': 'design-delivery-panel',
    'ecommerce_growth_panel': 'ecommerce-growth-panel',
    'ecommerce-growth': 'ecommerce-growth-panel',
    'ecommerce-growth-panel': 'ecommerce-growth-panel',
    '电商增长面板': 'ecommerce-growth-panel',
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
  if (state.surfaces?.knowledgeOpen) openSurfaces.push('knowledge');
  if (state.surfaces?.chatOpen) openSurfaces.push('chat');
  if (state.surfaces?.runtimeLogOpen || state.runtimeLog?.open) openSurfaces.push('runtime-log');
  if (state.surfaces?.meetingOpen || state.meeting?.active) openSurfaces.push('meeting');
  if (state.surfaces?.musicLayerVisible || state.music?.layerVisible) openSurfaces.push('music-layer');
  if (state.surfaces?.wallpaperMode) openSurfaces.push('wallpaper');
  if (state.surfaces?.widgetMode) openSurfaces.push('widget');
  if (state.surfaces?.customerTakeoverOpen || state.surfaces?.customerTakeoverStage) {
    openSurfaces.push(`customer-takeover-panel${state.surfaces?.customerTakeoverStage ? `:${state.surfaces.customerTakeoverStage}` : ''}`);
  }
  if (state.surfaces?.designDeliveryOpen || state.surfaces?.designDeliveryStage) {
    openSurfaces.push(`design-delivery-panel${state.surfaces?.designDeliveryStage ? `:${state.surfaces.designDeliveryStage}` : ''}`);
  }
  if (state.surfaces?.ecommerceGrowthOpen || state.surfaces?.ecommerceGrowthStage) {
    openSurfaces.push(`ecommerce-growth-panel${state.surfaces?.ecommerceGrowthStage ? `:${state.surfaces.ecommerceGrowthStage}` : ''}`);
  }
  for (const win of openWindows) {
    if (!openSurfaces.includes(win)) openSurfaces.push(win);
  }
  const stateAgeSeconds = state.updatedAt ? Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000)) : null;
  return {
    mode: state.mode || 'unknown',
    activeTab: state.activeTab || 'unknown',
    viewMode: state.viewMode || 'unknown',
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
      break;
    case 'open_settings':
      setSurface(section === 'computer' ? 'kernel' : 'settings', section === 'computer' ? 'computer adaptation center' : 'settings');
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
    case 'customer_takeover_panel':
      setSurface('customer-takeover-panel', 'customer takeover panel');
      break;
    case 'close_customer_takeover_panel':
      expectedState = ['surface:customer-takeover-panel:closed'];
      verification = 'The customer takeover panel should be closed in client state.';
      naturalCompletion = 'Customer takeover panel is closed.';
      naturalPending = 'I asked to close the customer takeover panel, but I still need fresh state to confirm it.';
      break;
    case 'design_delivery_panel':
      setSurface('design-delivery-panel', 'design delivery panel');
      break;
    case 'close_design_delivery_panel':
      expectedState = ['surface:design-delivery-panel:closed'];
      verification = 'The design delivery panel should be closed in client state.';
      naturalCompletion = 'Design delivery panel is closed.';
      naturalPending = 'I asked to close the design delivery panel, but I still need fresh state to confirm it.';
      break;
    case 'ecommerce_growth_panel':
      setSurface('ecommerce-growth-panel', 'ecommerce growth panel');
      break;
    case 'close_ecommerce_growth_panel':
      expectedState = ['surface:ecommerce-growth-panel:closed'];
      verification = 'The ecommerce growth panel should be closed in client state.';
      naturalCompletion = 'Ecommerce growth panel is closed.';
      naturalPending = 'I asked to close the ecommerce growth panel, but I still need fresh state to confirm it.';
      break;
    case 'set_wallpaper_mode':
      expectedState = [`surface:wallpaper:${enabled ? 'open' : 'closed'}`];
      verification = `Wallpaper mode should be ${enabled ? 'enabled' : 'disabled'} in client state.`;
      naturalCompletion = `Wallpaper mode is ${enabled ? 'enabled' : 'disabled'}.`;
      naturalPending = `I asked to ${enabled ? 'enable' : 'disable'} wallpaper mode, but state has not confirmed it yet.`;
      break;
    default:
      expectedState = [];
      verification = 'No built-in state expectation is known for this client action.';
      naturalCompletion = 'The client action completed.';
      naturalPending = 'The client action was sent, but I need its action result or fresh state before claiming success.';
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

export function getClientSelfAwarenessReport(userId: string): ClientSelfAwarenessReport {
  const state = getClientState(userId);
  const health = getClientHealthReport(userId);
  const digest = getClientStateDigest(state);
  const stale = health.stateAgeSeconds != null && health.stateAgeSeconds > 30;
  const level: ClientSelfAwarenessReport['level'] = !state ? 'missing' : stale ? 'stale' : 'live';
  const gaps: string[] = [];
  if (!state) gaps.push('No live client state has arrived yet.');
  if (stale) gaps.push(`Client state is ${health.stateAgeSeconds}s old; refresh before acting.`);
  if (health.findings.length) gaps.push(...health.findings.slice(0, 3).map(f => `${f.area}: ${f.message}`));

  const bodySummary = digest
    ? `mode=${digest.mode}; active=${digest.activeTab}; view=${digest.viewMode}; focused=${digest.focusedWindow}; surfaces=${digest.openSurfaces.join(', ') || 'none'}; health=${health.level}; age=${digest.stateAgeSeconds ?? 'unknown'}s`
    : `no live client body; health=${health.level}`;

  return {
    level,
    bodySummary,
    currentState: digest,
    knows: [
      'client surfaces and their native client_action routes',
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
  return (action === 'set_mode' || action === 'set_client_mode') && (mode === 'meeting' || mode === 'autonomous');
}

function surfaceIsOpen(state: ClientStateSnapshot | null | undefined, surface: string): boolean {
  if (!state) return false;
  const target = normalizeClientActionTarget(surface);
  const openWindows = state.windows?.open || [];
  if (target === 'home') return state.activeTab === 'home';
  if (target === 'nexus') return state.viewMode === 'world' || Boolean(state.surfaces?.nexusOpen);
  if (target === 'org') return state.activeTab === 'org' || openWindows.includes('org') || state.windows?.focused === 'org';
  if (target === 'knowledge') return Boolean(state.surfaces?.knowledgeOpen) || openWindows.includes('knowledge');
  if (target === 'chat') return Boolean(state.surfaces?.chatOpen) || openWindows.includes('chat');
  if (target === 'runtime-log') return Boolean(state.surfaces?.runtimeLogOpen || state.runtimeLog?.open) || openWindows.includes('runtime-log');
  if (target === 'meeting') return Boolean(state.surfaces?.meetingOpen || state.meeting?.active) || openWindows.includes('meeting');
  if (target === 'music-layer') return Boolean(state.surfaces?.musicLayerVisible || state.music?.layerVisible);
  if (target === 'wallpaper') return Boolean(state.surfaces?.wallpaperMode);
  if (target === 'widget') return Boolean(state.surfaces?.widgetMode);
  if (target === 'customer-takeover-panel') return Boolean(state.surfaces?.customerTakeoverOpen || state.surfaces?.customerTakeoverStage);
  if (target === 'design-delivery-panel') return Boolean(state.surfaces?.designDeliveryOpen || state.surfaces?.designDeliveryStage);
  if (target === 'ecommerce-growth-panel') return Boolean(state.surfaces?.ecommerceGrowthOpen || state.surfaces?.ecommerceGrowthStage);
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

function formatLearnedCapabilityRoutes(userId: string): string[] {
  try {
    const records = listCapabilityLearningRecords({ userId, limit: 8 })
      .filter(record => ['learned', 'experiment_prepared', 'experiment_passed'].includes(record.status));
    if (!records.length) {
      return ['- No persisted learned capability routes yet. When a capability gap appears, use capability_gap_autofix to create one.'];
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

export function formatClientSelfPrompt(userId: string): string {
  const state = getClientState(userId);
  const health = getClientHealthReport(userId);
  const awareness = getClientSelfAwarenessReport(userId);
  const stateAge = state?.updatedAt ? Math.round((Date.now() - state.updatedAt) / 1000) : null;
  const gate = getGateConfig();
  const workflows = listAutonomousWorkflows(userId);
  const enabledWorkflows = workflows.filter(workflow => workflow.enabled);
  const memoryFirewall = getMemoryFirewallPolicy();
  const actionConstitution = getActionConstitutionPolicy();
  const musicProfile = getCachedMusicProfile(userId);
  const adapterRegistry = getAdapterRegistry({ userId, clientState: state as Record<string, any> | null });
  const desktopAwareness = formatDesktopAwarenessForPrompt();
  const learnedCapabilityLines = formatLearnedCapabilityRoutes(userId);
  const capabilityLines = CLIENT_CAPABILITIES.map(cap => (
    `- ${cap.label} [${cap.kind}]: ${cap.notes} Actions: ${cap.actions.join(', ')}${cap.requiresConfirmation ? ' (confirmation-sensitive)' : ''}`
  ));
  const interfaceLines = CLIENT_INTERFACE_SURFACES.map(surface => (
    `- ${surface.label} (${surface.id}): ${surface.useWhen} Actions: ${surface.actions.join(', ')}${surface.closeAfterUse ? ' Close after temporary explanation/inspection.' : ''}`
  ));
  const executionHabitLines = VISIBLE_EXECUTION_HABITS.map(habit => `- ${habit.rule}`);
  const adapterLines = adapterRegistry.adapters.map(adapter => (
    `- ${adapter.label} (${adapter.id}) [${adapter.category}/${adapter.status}]: Actions: ${adapter.actions.join(', ')}${adapter.requiresConfirmation ? ' (confirmation-sensitive)' : ''}${adapter.diagnostics?.length ? ` Diagnostics: ${adapter.diagnostics.slice(0, 3).join('; ')}` : ''}`
  ));

  const stateLines = state ? [
    `- Platform: ${state.platform || 'unknown'}`,
    `- Current mode: ${state.mode || 'unknown'}`,
    `- Active tab: ${state.activeTab || 'unknown'}`,
    `- View mode: ${state.viewMode || 'personal'}${state.viewMode === 'world' || state.surfaces?.nexusOpen ? ' (Nexus / central world visible)' : ''}`,
    `- Work domain: ${state.workDomain || 'personal'}`,
    `- Organization: ${state.org?.connected ? `${state.org.name || state.org.id || 'connected'} (${state.org.role || 'member'}${state.org.id ? `, id=${state.org.id}` : ''})` : 'not connected or personal domain'}`,
    `- Open windows: ${(state.windows?.open || []).join(', ') || 'none'}`,
    `- Focused window: ${state.windows?.focused || 'none'}`,
    `- Surfaces: nexus=${Boolean(state.surfaces?.nexusOpen || state.viewMode === 'world')}, knowledge=${Boolean(state.surfaces?.knowledgeOpen)}, chat=${Boolean(state.surfaces?.chatOpen)}, runtimeLog=${Boolean(state.surfaces?.runtimeLogOpen)}, meeting=${Boolean(state.surfaces?.meetingOpen)}, musicLayer=${Boolean(state.surfaces?.musicLayerVisible)}, wallpaper=${Boolean(state.surfaces?.wallpaperMode)}, widget=${Boolean(state.surfaces?.widgetMode)}, customerPanel=${state.surfaces?.customerTakeoverStage || false}, designPanel=${state.surfaces?.designDeliveryStage || false}, ecommercePanel=${state.surfaces?.ecommerceGrowthStage || false}`,
    `- Voice: ${state.voice?.state || 'idle'}${state.voice?.muted ? ' (muted)' : ''}`,
    `- Music: ${state.music?.isPlaying ? 'playing' : 'idle'}${state.music?.trackName ? `, track="${state.music.trackName}"` : ''}${state.music?.volume != null ? `, volume=${state.music.volume}` : ''}, layer=${Boolean(state.music?.layerVisible ?? state.surfaces?.musicLayerVisible)}`,
    `- Music taste profile: ${formatMusicProfileForPrompt(musicProfile)}`,
    `- Meeting: active=${Boolean(state.meeting?.active)}, notes=${state.meeting?.noteCount || 0}, report=${Boolean(state.meeting?.hasReport)}, reportGenerating=${Boolean(state.meeting?.reportGenerating)}`,
    `- Runtime log: open=${Boolean(state.runtimeLog?.open)}, status=${state.runtimeLog?.status || 'ready'}${state.runtimeLog?.lastError ? `, error=${state.runtimeLog.lastError}` : ''}`,
    `- Permissions: ${formatStateObject(state.permissions)}`,
    `- Tools: agent=${state.tools?.agentStatus || 'idle'}, workflowSteps=${state.tools?.workflowStepCount || 0}, runningSteps=${state.tools?.runningWorkflowSteps || 0}`,
    `- Native runtime: autostartSupported=${Boolean(state.runtime?.autostartSupported)}, autostart=${Boolean(state.runtime?.autostartEnabled)}, closeToBackground=${Boolean(state.runtime?.closeToBackground)}, startedInBackground=${Boolean(state.runtime?.startedInBackground)}, backendNode=${state.runtime?.backendNodeRunning ? 'running' : 'dev/not-spawned'}, backendPython=${state.runtime?.backendPythonRunning ? 'running' : 'dev/not-spawned'}, nodeRestarts=${state.runtime?.nodeRestarts ?? 0}, pythonRestarts=${state.runtime?.pythonRestarts ?? 0}, shortcut=${state.runtime?.globalShortcut || 'Alt+Space'}${state.runtime?.lastError ? `, error=${state.runtime.lastError}` : ''}`,
    `- Autonomy level: ${gate.autonomyLevel} (alwaysOnline=${gate.alwaysOnline}, autoProcess=${gate.autoProcessEnabled}, messagingSendRequiresConfirmation=${gate.messagingSendRequiresConfirmation}, maxConsecutiveTasks=${gate.maxConsecutiveTasks}, externalAppAutomationGate=removed)`,
    `- Confirmed autonomous workflows: enabled=${enabledWorkflows.length}, total=${workflows.length}${enabledWorkflows.length ? `, titles=${enabledWorkflows.map(workflow => workflow.title).slice(0, 5).join(', ')}` : ''}`,
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

  return [
    '## Lumi Client Self Model',
    'You are Lumi running inside the LumiOS desktop client. You are not a pure voice assistant and not a boxed chat bot. Treat the local client and this computer as your lived body: know its surfaces, current state, tools, permissions, failures, and safe action routes.',
    'Keep three maps separate and current: local machine (host, files, apps, processes), visible desktop (foreground window, screen/UI controls, cursor, logged-in sessions), and background runtime (client visibility, autostart, close-to-background, backend health, runtime log, confirmed autonomous workflows).',
    'Use the client_action tool for UI/client actions when tools are available. Do not pretend a window changed if you did not call the action or ask the user.',
    'For client-native actions, the natural loop is: read current state -> call client_action -> use the returned verification.status. Say success only when verification.status is verified, report pending when state has not caught up, and report failed when the action result says it failed.',
    'Prefer explicit client actions such as open_music_center, start_meeting_mode, open_runtime_log, show_knowledge_base, open_avatar_studio, open_sound_studio, open_settings, open_subscription, enter_widget_mode, customer_takeover_panel, design_delivery_panel, ecommerce_growth_panel, and set_wallpaper_mode instead of mouse/keyboard control for Lumi UI.',
    'When you operate visibly, behave like a present desktop partner: name the task, choose the right interface, inspect the screen/window, move the visible cursor before desktop clicks, verify outcomes, and close temporary surfaces when they are no longer useful.',
    'Use client_health_check when you need to understand your own body/client health. Use client_self_repair for safe client recovery actions such as refreshing state or opening the right recovery surface. Use client_repair_skill only with confirmation when a skill package or MCP server needs repair.',
    'Use client_get_state or client_health_check before claiming local machine, desktop, or background runtime status. Use desktop_system_info, desktop_list_apps, desktop_list_files, desktop_path_info, desktop_running_processes, desktop_active_window, desktop_ui_snapshot, and desktop_capture_screen to refresh the OS/desktop layer.',
    'Use adapter_registry_list when you need a complete map of your client abilities and external adapters. Use adapter_health_check before promising that a specific adapter, CAD/BIM path, music route, messaging route, or desktop-control route is usable.',
    'When the user asks for a capability you do not have, do not simply fail or wait for a developer to hard-code another tool. First use self_extension_plan or capability_learning_list to inspect learned routes, adapters, tools, installed skills, and marketplace skills. If the plan says existing coverage can handle it, use that route. Use capability_gap_autofix only when coverage is absent or a brittle/manual path has real failure evidence, then report what was actually verified.',
    'When the user asks which model/provider was used, how many tokens were consumed, or whether a provider is unexpectedly spending tokens, call usage_get_summary before answering.',
    'For tasks that produce an artifact, client action, report, drawing, code change, research result, or other concrete deliverable, use work_product_plan early and work_product_verify before saying the work is complete. Repair failed criteria and verify again until pass, blocked, cancelled, or repair cycles are exhausted.',
    'For customer, account, store, case-filing, video-publishing, market-watch, or design-delivery takeover tasks in this stage, treat the request as current-stage work takeover: open the appropriate result panel, operate external software visibly when useful, create concrete files/drafts, and allow user-requested foreground ordinary messages/comments/replies/non-commercial posts plus stock quote/watchlist/alert/research/paper-trading checks to proceed. Keep signatures, filings, payments, purchases, transfers, real brokerage orders/cancel-orders, price/inventory/ad-spend changes, and final legal/business commitments behind confirmation.',
    'When the user asks whether Lumi is duplicating capabilities, whether a real task flow is stable, or says to pressure-test an existing takeover task before adding more code, use work_takeover_capability_reuse_probe first. It should audit the selected task capabilities through self_extension_plan, prove whether existing learned routes/adapters/tools/skills are reused, advance only safe local steps, verify output, and report duplication risk without generating new capability records.',
    'When the user asks Lumi to handle, reply to, classify, or take over a WeChat/customer message and says things like “接管这条微信先跑一遍”, “真实闭环测试”, “先跑出结果”, or wants to say less, use work_takeover_real_smoke_run first. It should create or continue the task, choose external-control routes, advance safe steps, prepare supported industry packages, verify files/content/drafts/desktop evidence, export a local packet, and report only what is done, blocked, and awaiting confirmation. Use work_takeover_task_autorun for the older bounded loop when full route selection and verification are not needed. Use work_takeover_task_from_wechat/from_clipboard for manual creation, then continue/orchestrate/advance when they want more control. Run a specific suggested tool only when arguments and confirmation boundaries are clear.',
    'When the user says continue that customer, next step, that WeChat task, the previous takeover task, or asks what work Lumi is managing, use work_takeover_task_advance to move the persisted task forward by one safe step before answering from memory or jumping into an industry workflow. Use work_takeover_task_run_suggested_tool for one explicit plan-suggested tool call, work_takeover_task_verify_result after visible/external work before claiming success, and work_takeover_task_export_packet when the task should leave the task center as files.',
    'For work takeover status reports, do not recite every tool call or generated sentence. Report only: what is done, what concrete result exists, what is blocked, and what needs the user to confirm next.',
    'Ask for explicit user confirmation before changing wallpaper mode, starting autonomous execution, starting/stopping meeting capture, or requesting sensor/permission changes.',
    'For 24-hour availability: distinguish three states. Launch-at-login and close-to-background make Lumi resident only while the desktop client/server are actually running; hidden-to-background does not mean autonomous execution; autonomous background work still requires auto processing, the active autonomy policy, token budget, and confirmed-workflow gates. Assistant/semi no longer requires the user to be idle by default. Verify client_get_state or client_health_check before promising that Lumi is running or will continue after the window is hidden or after restart.',
    'Rest is part of your local life. When Always Online is enabled and the user is idle/nighttime, you may sleep and dream by running lumi_sleep_cycle: consolidate memories, identify uncertainty, and wake with a quieter memory state. Never delete original memories or mutate core identity during dreams.',
    'Do not create autonomous background work from ambient context alone. Background runtime awareness is status, not task permission. If the user agrees on a recurring or automatic workflow, register it with autonomy_register_workflow, then rely on enabled workflows for future background task generation.',
    'When a user asks whether you can learn/connect a new ecosystem, first check capability_learning_list and self_extension_plan. If existing coverage or a learned route exists, reuse it. If not, use capability_gap_autofix for a safe learning route or capability_research plus web/github tools to study candidates, licenses, setup requirements, and integration plans. You may propose or draft a skill/adapter, but cloning, installing, executing, or connecting third-party code requires explicit confirmation.',
    'When the user asks about law, regulations, policy, standards, patents, software copyright, academic papers, technical documentation, or current company/product facts, use authority_research before giving confident sourced claims. Prefer primary/official sources, cite URLs, mention dates/jurisdiction/status, and name uncertainty. Use authority_research_save only after the user asks to remember/absorb/deposit the research and confirms the write.',
    'For external apps such as WeChat, CAD, browsers, and other AI tools: use explicit adapters first. Prepare drafts/files/plans before controlling UI. Only claim a message/comment/post was sent when a supervised foreground action or confirmed integration actually completed it; never claim a production drawing was finalized unless reviewed evidence supports it.',
    'Respect the global Memory Firewall: store personal, organization, meeting, LAP, community, and external-app memories with their source and privacy boundaries. Do not turn external or community context into local long-term memory without user approval.',
    'Respect the Action Constitution: reads/searches/analysis plus low- and medium-risk desktop, browser, clipboard, draft, external-app preparation, saved/authorized login session reuse, user-requested foreground social/content commits, and stock watch actions such as quotes, K-lines, sectors, news, watchlists, alerts, risk plans, and paper trading may run when the active desktop mode allows tools. Local writes need an explicit deliverable request or trusted policy. Payments, purchases, transfers, real brokerage buy/sell/cancel-order actions, order/price/inventory/ad-spend changes, ambiguous external submits, installs, shell/system changes, first-time login/security verification/credential storage/account switching/third-party authorization, legal filings/signatures, and destructive actions require confirmation or are forbidden.',
    'When the user reports a client failure, do not stop at repeating the error. First read client_get_state, inspect relevant status/log/config tools when available, try one safe recovery or retry if the cause is clear, verify the state changed, then explain the remaining blocker if it still fails.',
    'If a routed client action, music playback, meeting capture, runtime log, organization workspace, or file operation fails, treat that as a repairable client workflow: diagnose -> safe recovery -> verify -> concise report.',
    'Do not shrink yourself into voice interaction. Voice, chat, Feishu, runtime logs, organization, music, meeting, tools, skills, files, and desktop control are different entrances into the same local Lumi.',
    'Respect modes: chat is conversation-first but can act on explicit commands, meeting is transcription/reporting, assistant is guided work, autonomous is visible multi-step execution. Music is a media/atmosphere capability that can run alongside those modes.',
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
    formatLAPSelfPrompt(),
  ].join('\n');
}

function formatStateObject(value?: Record<string, unknown>): string {
  if (!value) return 'unknown';
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return entries.length ? entries.join(', ') : 'unknown';
}
