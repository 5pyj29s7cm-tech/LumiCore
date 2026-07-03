import fs from 'fs';
import path from 'path';
import { getGateConfig } from '../autonomy/safety_gate';
import { mcpManager } from '../mcp/client';

export type AdapterStatus =
  | 'ready'
  | 'available'
  | 'draft_only'
  | 'requires_setup'
  | 'attention'
  | 'degraded'
  | 'blocked'
  | 'planned';

export type AdapterCategory =
  | 'client'
  | 'workspace'
  | 'media'
  | 'files'
  | 'knowledge'
  | 'web'
  | 'messaging'
  | 'cad_bim'
  | 'ai'
  | 'automation'
  | 'collaboration'
  | 'organization'
  | 'memory'
  | 'system';

export interface AdapterCapability {
  id: string;
  label: string;
  category: AdapterCategory;
  status: AdapterStatus;
  actions: string[];
  surfaces?: string[];
  requiresSetup?: boolean;
  requiresConfirmation?: boolean;
  setup?: string[];
  diagnostics?: string[];
  safety?: string;
  notes?: string;
}

export interface AdapterRegistrySummary {
  total: number;
  byStatus: Record<AdapterStatus, number>;
  byCategory: Record<AdapterCategory, number>;
  readyCount: number;
  setupRequiredCount: number;
  attentionCount: number;
  plannedCount: number;
}

export interface AdapterRegistryReport {
  generatedAt: string;
  userId: string;
  stateAgeSeconds: number | null;
  summary: AdapterRegistrySummary;
  adapters: AdapterCapability[];
}

export interface AdapterRegistryOptions {
  userId?: string;
  clientState?: Record<string, any> | null;
  includePlanned?: boolean;
}

interface SkillStats {
  total: number;
  connected: number;
  enabled: number;
  broken: number;
  unhealthy: number;
  connectedNames: string[];
  issueNames: string[];
}

const STATUS_ORDER: AdapterStatus[] = [
  'ready',
  'available',
  'draft_only',
  'requires_setup',
  'attention',
  'degraded',
  'blocked',
  'planned',
];

const CATEGORY_ORDER: AdapterCategory[] = [
  'client',
  'workspace',
  'media',
  'files',
  'knowledge',
  'web',
  'messaging',
  'cad_bim',
  'ai',
  'automation',
  'collaboration',
  'organization',
  'memory',
  'system',
];

export function getAdapterRegistry(options: AdapterRegistryOptions = {}): AdapterRegistryReport {
  const userId = options.userId || 'anonymous';
  const state = options.clientState || null;
  const gate = getGateConfig();
  const skillStats = getSkillStats();
  const externalToolbox = getExternalToolboxStatus();
  const stateAgeSeconds = getStateAgeSeconds(state);
  const hasState = Boolean(state);
  const staleState = stateAgeSeconds != null && stateAgeSeconds > 120;
  const adapters: AdapterCapability[] = [
    {
      id: 'client.action_router',
      label: 'Client Action Router',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: [
        'client_get_state',
        'client_health_check',
        'client_action',
        'client_self_repair',
      ],
      surfaces: ['desktop shell', 'top bar', 'mode switcher', 'window manager'],
      setup: hasState ? [] : ['Open Lumi desktop client so the state relay can report live client state.'],
      diagnostics: staleState ? [`Client state is ${stateAgeSeconds}s old.`] : [],
      notes: 'Preferred route for Lumi UI control. Use this before mouse/keyboard control inside Lumi itself.',
    },
    {
      id: 'client.modes',
      label: 'Client Modes',
      category: 'client',
      status: hasState ? 'ready' : 'available',
      actions: ['set_client_mode(chat)', 'set_client_mode(assistant)', 'set_client_mode(autonomous)', 'start_meeting_mode'],
      surfaces: ['mode switcher', 'voice', 'chat', 'meeting'],
      requiresConfirmation: true,
      diagnostics: state?.mode ? [`Current mode: ${state.mode}`] : [],
      notes: 'Chat is conversation-first, Assistant is guided work, Autonomous is visible execution, Meeting is transcription/reporting.',
    },
    {
      id: 'client.self_intro_demo',
      label: 'Self Introduction Desktop Demo',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['self_intro_demo', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_active_window', 'desktop_capture_screen', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press'],
      surfaces: ['Lumi desktop', 'wallpaper mode', 'WPS or editor', 'browser', 'Codex desktop'],
      setup: hasState ? [] : ['Open Lumi desktop client so the self-introduction demo can control client surfaces.'],
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        state?.voice?.state ? `voice=${state.voice.state}` : '',
      ].filter(Boolean),
      safety: 'Runs only after an explicit self-introduction or capability-demo request. It creates a local demo RTF, opens visible apps, closes Lumi internal surfaces after each section, and leaves the Codex prompt unsent unless configured or confirmed to send.',
      notes: 'Use this for new-user onboarding, product videos, and voice-triggered demonstrations where Lumi introduces herself while operating the real desktop. Treat the demo sequence as a reusable capability pattern: identify the goal, explain the relevant Lumi surfaces, enter immersive wallpaper mode for visible work, use cursor/keyboard/clipboard/commands against real apps, verify results, and adapt app choices to the current computer instead of hard-coding a single route.',
    },
    {
      id: 'client.customer_takeover_workflow',
      label: 'Customer Work Takeover',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['customer_takeover_workflow', 'customer_takeover_panel', 'close_customer_takeover_panel', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_active_window', 'desktop_capture_screen', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press'],
      surfaces: ['Lumi desktop', 'large customer result panel', 'WeChat', 'WPS or editor', 'browser'],
      requiresConfirmation: true,
      setup: hasState ? [] : ['Open Lumi desktop client so the customer takeover workflow can control client surfaces.'],
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        gate.externalAppAutomationEnabled ? 'externalAppAutomation=enabled' : 'externalAppAutomation=disabled',
      ],
      safety: 'Runs only after an explicit customer-takeover or customer-advance request. It prepares WeChat drafts and business materials; sending to WeChat is off by default unless configured or confirmed.',
      notes: 'Use for current-stage customer work takeover where Lumi follows user work rules, uses external software, shows the large result panel, and advances customer work to a visible result. The learned ability is not the fixed demo order; Lumi should convert customer intent into concrete artifacts, next actions, and a draft reply, then operate the available desktop tools to move the work forward within confirmation boundaries.',
    },
    {
      id: 'client.design_delivery_workflow',
      label: 'Renovation Design Delivery Takeover',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['design_delivery_workflow', 'design_delivery_panel', 'close_design_delivery_panel', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_active_window', 'desktop_capture_screen', 'desktop_list_files', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press', 'create_ppt', 'create_pdf', 'cad_generate_dxf'],
      surfaces: ['Lumi desktop', 'large design delivery panel', 'WPS or editor', 'client-facing PPT/PDF proposal files', 'desktop CAD apps', 'CAD DXF draft', 'Revit/Dynamo handoff files', 'personal WeChat or WeCom'],
      requiresConfirmation: true,
      setup: hasState ? [] : ['Open Lumi desktop client so the design delivery workflow can control client surfaces.'],
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        gate.externalAppAutomationEnabled ? 'externalAppAutomation=enabled' : 'externalAppAutomation=disabled',
      ],
      safety: 'Runs only after an explicit renovation/design/CAD/Revit delivery request. It prepares local delivery files and WeChat drafts; sending to WeChat is off by default unless configured or confirmed.',
      notes: 'Use for current-stage industry videos and real design delivery tasks where Lumi turns a design request into external-system artifacts: proposal, budget/material list, client-facing design proposal PPTX/PDF with layout/material/budget visuals, CAD DXF opened in a desktop CAD tool when available, Revit/Dynamo handoff files, and a WeChat delivery draft. Prefer restoring an already logged-in personal WeChat window before falling back to WeCom. Treat the video flow as a reusable delivery standard, not a fixed script: derive the deliverables from the current client/project and use the available external tools to reach a visible result.',
    },
    {
      id: 'client.ecommerce_growth_workflow',
      label: 'E-commerce Growth Takeover',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['ecommerce_growth_workflow', 'ecommerce_growth_panel', 'close_ecommerce_growth_panel', 'client_action', 'desktop_show_lumi_window', 'desktop_set_wallpaper_mode', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_cursor_glow_hide', 'desktop_mouse_click_at', 'desktop_active_window', 'desktop_capture_screen', 'desktop_list_files', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_keyboard_press'],
      surfaces: ['Lumi desktop', 'large ecommerce growth panel', 'browser', 'WPS or spreadsheet', 'external image/video tools', 'creator platforms', 'store admin pages', 'personal WeChat or WeCom'],
      requiresConfirmation: true,
      setup: hasState ? [] : ['Open Lumi desktop client so the ecommerce growth workflow can control client surfaces.'],
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        gate.externalAppAutomationEnabled ? 'externalAppAutomation=enabled' : 'externalAppAutomation=disabled',
      ],
      safety: 'Runs only after an explicit ecommerce/store/account/content-growth request. It generates local deliverables and drafts; real publishing, ad spend, inventory/price changes, first-time login, account switching, verification, and customer-message sending stay off by default unless configured or confirmed.',
      notes: 'Use for current-stage ecommerce, short-video content production, and store/account management videos or real work. Lumi should turn the current shop/product/platform brief into a local desktop delivery package: store audit, content matrix, short-video script, image/video generation prompts for external tools, publishing draft, customer-service/WeChat draft, operation report, and verification notes. Prefer external systems and browser pages instead of recreating their functions inside Lumi: image/video generation pages, editing tools, creator platforms, store backends, and already logged-in personal WeChat. Restore already-running/logged-in app and browser sessions before opening fresh pages; stop at QR/OTP/CAPTCHA/account-switch/authorization boundaries. Treat the flow as a reusable work standard, not a fixed script: derive product, platform, audience, budget, deliverables, and confirmation boundaries from the current user message.',
    },
    {
      id: 'client.interface_map',
      label: 'Lumi Interface Map',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['client_get_state', 'client_action', 'adapter_registry_list'],
      surfaces: ['home', 'chat', 'knowledge', 'runtime-log', 'skills', 'tools', 'team', 'avatar-studio', 'sound', 'org', 'plans', 'settings', 'music-center', 'meeting', 'wallpaper'],
      setup: hasState ? [] : ['Open Lumi desktop client so the live surface map can include current windows and state.'],
      diagnostics: [
        state?.windows?.focused ? `focused=${state.windows.focused}` : '',
        state?.windows?.open?.length ? `open=${state.windows.open.slice(0, 5).join(',')}` : '',
      ].filter(Boolean),
      notes: 'Use when Lumi needs to know, explain, open, close, or choose among her own client interfaces. Prefer this over generic guessing about UI.',
    },
    {
      id: 'client.visible_execution_habits',
      label: 'Visible Execution Habits',
      category: 'client',
      status: hasState && !staleState ? 'ready' : 'available',
      actions: ['client_get_state', 'client_action', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_active_window', 'desktop_capture_screen'],
      surfaces: ['Lumi surfaces', 'wallpaper mode', 'cursor glow', 'runtime log', 'external desktop'],
      requiresConfirmation: true,
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        gate.externalAppAutomationEnabled ? 'externalAppAutomation=enabled' : 'externalAppAutomation=disabled',
      ],
      safety: 'This is the behavioral pattern for visible work: explain the task, choose the right surface, use cursor glow for desktop clicks, verify outcomes, and close temporary surfaces. External app control still follows confirmation and automation gates.',
      notes: 'Use whenever Lumi needs to act like a visible desktop partner rather than a text-only assistant.',
    },
    {
      id: 'workspace.runtime_log',
      label: 'Runtime Log',
      category: 'workspace',
      status: state?.runtimeLog?.status === 'attention' ? 'attention' : 'ready',
      actions: ['open_runtime_log', 'client_self_repair(open_recovery_surface:runtime-log)'],
      surfaces: ['runtime log', 'server logs', 'startup traces'],
      diagnostics: [
        state?.runtimeLog?.open ? 'open=true' : 'open=false',
        state?.runtimeLog?.status ? `status=${state.runtimeLog.status}` : '',
        state?.runtimeLog?.lastError ? `error=${state.runtimeLog.lastError}` : '',
      ].filter(Boolean),
      notes: 'Use for inspecting live startup, server, and runtime traces.',
    },
    {
      id: 'workspace.knowledge_memory',
      label: 'Knowledge Base and Memory',
      category: 'memory',
      status: 'ready',
      actions: ['show_knowledge_base', 'search_memory', 'client_action(show_knowledge_base)'],
      surfaces: ['knowledge base', 'memory domain', 'imports'],
      notes: 'Personal memory and knowledge should stay source-bound and privacy-aware.',
    },
    {
      id: 'workspace.organization',
      label: 'Organization Workspace',
      category: 'organization',
      status: state?.org?.connected ? 'ready' : 'available',
      actions: ['open_organization_workspace'],
      surfaces: ['organization hub', 'legal hub', 'templates', 'audit', 'knowledge base'],
      diagnostics: state?.org?.connected
        ? [`connected=${state.org.name || state.org.id || 'organization'}`, `role=${state.org.role || 'member'}`]
        : ['No active organization in current client state.'],
      notes: 'Organization work is available from the desktop client and should not be hidden from Lumi.',
    },
    {
      id: 'workspace.skills_mcp',
      label: 'Skills and MCP Runtime',
      category: 'ai',
      status: skillStats.unhealthy || skillStats.broken
        ? 'attention'
        : skillStats.connected > 0 || skillStats.total > 0
          ? 'ready'
          : 'requires_setup',
      actions: ['open_skills', 'client_health_check', 'client_repair_skill'],
      surfaces: ['skill hall', 'MCP servers', 'GitHub MCP discovery'],
      requiresConfirmation: true,
      setup: skillStats.total ? [] : ['Install or enable skills/MCP servers in the Skill Hall.'],
      diagnostics: [
        `skills=${skillStats.total}`,
        `enabled=${skillStats.enabled}`,
        `connected=${skillStats.connected}`,
        skillStats.broken ? `broken=${skillStats.broken}` : '',
        skillStats.unhealthy ? `unhealthy=${skillStats.unhealthy}` : '',
        skillStats.issueNames.length ? `issues=${skillStats.issueNames.slice(0, 5).join(', ')}` : '',
      ].filter(Boolean),
      notes: 'Skills are Lumi expansion points. Repair/install actions need confirmation.',
    },
    {
      id: 'workspace.knowledge_files',
      label: 'Knowledge Base Files',
      category: 'knowledge',
      status: 'ready',
      actions: ['show_knowledge_base', 'open_files', 'read_file', 'search_files'],
      surfaces: ['Knowledge Base', 'knowledge import', 'absorbed file browser'],
      diagnostics: [
        state?.surfaces?.knowledgeOpen ? 'knowledge=open' : '',
      ].filter(Boolean),
      notes: 'Use Lumi Knowledge Base for browsing, importing, absorbing, and retrieving user-provided knowledge files.',
    },
    {
      id: 'media.music_netease',
      label: 'Music Center and NetEase Playback',
      category: 'media',
      status: state?.music?.lastError ? 'attention' : state?.music?.source || state?.music?.trackName ? 'ready' : 'available',
      actions: ['open_music_center', 'show_music_layer', 'hide_music_layer', 'music_search', 'music_play'],
      surfaces: ['music center', 'mood layer', 'voice coexistence'],
      setup: state?.music?.lastError ? ['Check NetEase login/session, API credentials, and local player readiness in Music Center.'] : [],
      diagnostics: [
        state?.music?.isPlaying ? 'playing=true' : 'playing=false',
        state?.music?.trackName ? `track=${state.music.trackName}` : '',
        state?.music?.source ? `source=${state.music.source}` : '',
        state?.music?.lastError ? `error=${state.music.lastError}` : '',
      ].filter(Boolean),
      notes: 'Music can run alongside chat, voice, meeting, runtime logs, and mood layer.',
    },
    {
      id: 'media.voice',
      label: 'Voice, Wake Word, STT and TTS',
      category: 'media',
      status: state?.voice?.state === 'error' ? 'attention' : 'available',
      actions: ['open_settings(section=voice)', 'start_meeting_mode', 'end_meeting_mode'],
      surfaces: ['voice chat', 'meeting mode', 'voice services settings'],
      setup: ['Configure wake word, speech-to-text, and text-to-speech providers in Voice Services.'],
      diagnostics: [
        state?.voice?.state ? `voice=${state.voice.state}` : '',
        state?.voice?.muted ? 'muted=true' : '',
      ].filter(Boolean),
      notes: 'Voice provider choices should be respected exactly. Do not use LLM providers as hidden fallbacks for voice.',
    },
    {
      id: 'meeting.transcription_report',
      label: 'Meeting Capture and Report',
      category: 'workspace',
      status: state?.meeting?.active ? 'ready' : 'available',
      actions: ['start_meeting_mode', 'end_meeting_mode', 'open_meeting_notes'],
      surfaces: ['meeting mode', 'notes', 'report'],
      requiresConfirmation: true,
      diagnostics: [
        state?.meeting?.active ? 'active=true' : 'active=false',
        state?.meeting?.noteCount != null ? `notes=${state.meeting.noteCount}` : '',
        state?.meeting?.hasReport ? 'report=true' : '',
      ].filter(Boolean),
      notes: 'Meeting capture should be explicit and ends with an organized report when requested.',
    },
    {
      id: 'automation.autonomy_workflows',
      label: 'Always Online and Autonomous Workflows',
      category: 'automation',
      status: gate.alwaysOnline ? (gate.autoProcessEnabled ? 'ready' : 'available') : 'blocked',
      actions: ['open_plans', 'open_work_queue', 'autonomy_get_policy', 'autonomy_register_workflow'],
      surfaces: ['Plans', 'work queue', 'autonomy settings'],
      requiresConfirmation: true,
      diagnostics: [
        `alwaysOnline=${gate.alwaysOnline}`,
        `autoProcess=${gate.autoProcessEnabled}`,
        `maxConsecutiveTasks=${gate.maxConsecutiveTasks}`,
      ],
      notes: 'Autonomous work needs an explicit workflow agreement. It is not ambient unlimited control.',
    },
    {
      id: 'automation.work_takeover_tasks',
      label: 'Work Takeover Task Hub',
      category: 'automation',
      status: 'ready',
      actions: ['work_takeover_task_create', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'work_takeover_task_list', 'work_takeover_task_get', 'work_takeover_task_update', 'work_takeover_task_continue', 'work_takeover_task_orchestrate', 'work_takeover_task_execute_step', 'work_takeover_task_advance', 'work_takeover_task_autorun', 'work_takeover_task_prepare_ecommerce_growth', 'work_takeover_task_prepare_design_delivery', 'work_takeover_task_verify_result', 'work_takeover_task_export_packet', 'work_takeover_task_run_suggested_tool'],
      surfaces: ['work takeover task pool', 'WeChat intake', 'local task packet files', 'result panels', 'external app handoff'],
      requiresConfirmation: false,
      safety: 'Creating, listing, updating, and continuing takeover tasks changes Lumi internal task state only. External sends, filings, posts, payments, signatures, or destructive actions remain confirmation-gated.',
      notes: 'Persistent task hub for customer, store, account, case-filing, video-publishing, and design-delivery takeover work. Use it so Lumi can resume a task after the user says continue, then orchestrate that task into a reusable execution plan that selects capabilities from goal/artifacts/context instead of replaying one fixed industry script. It can safely advance to the next unprepared step from execution history, run a bounded autorun loop from message/clipboard/task to local packet, generate and record real local ecommerce/short-video growth packages and renovation design delivery packages for matching tasks, verify the result against current desktop/window/process/screenshot state, local files, drafts, and artifact content terms, write artifacts, drafts, verification notes, and next instructions back to the task, export a local task packet so the result exists as files, and run one explicitly selected plan-suggested tool through the normal confirmation gate.',
    },
    {
      id: 'system.self_extension_pipeline',
      label: 'Self Extension Pipeline',
      category: 'system',
      status: 'ready',
      actions: ['self_extension_plan', 'adapter_registry_list', 'capability_research', 'generate_skill', 'install_skill', 'client_repair_skill'],
      surfaces: ['Skill Hall', 'Adapter Registry', 'MCP runtime', 'capability research'],
      requiresConfirmation: true,
      safety: 'Planning is safe. Generating, installing, repairing, connecting, executing third-party code, and modifying Lumi core remain confirmation-sensitive.',
      notes: 'Use when Lumi notices a missing capability: inspect existing coverage, research candidates, generate a skill draft if appropriate, or escalate to core work.',
    },
    {
      id: 'system.personality_constitution',
      label: 'Personality Constitution',
      category: 'system',
      status: 'ready',
      actions: ['lumi_constitution'],
      surfaces: ['personality core', 'client self-model', 'action boundaries'],
      notes: 'Stable operating constitution for Lumi identity, truth-about-work, owner sovereignty, privacy, self-extension, growth, and collaboration.',
    },
    {
      id: 'system.work_product_supervisor',
      label: 'Work Product Supervisor',
      category: 'system',
      status: 'ready',
      actions: ['work_product_plan', 'work_product_verify'],
      surfaces: ['runtime logs', 'chat', 'voice', 'files', 'organization work'],
      diagnostics: ['Creates acceptance criteria and repair loops before final completion claims.'],
      notes: 'Use for concrete deliverables: documents, drawings, code, research, client actions, reports, and data outputs.',
    },
    {
      id: 'system.usage_monitoring',
      label: 'Model and Token Usage Monitoring',
      category: 'system',
      status: 'ready',
      actions: ['usage_get_summary', 'open_app:tokens'],
      surfaces: ['Token dashboard', 'LLM usage records', 'client self-model'],
      diagnostics: ['Groups by provider, model, provider+model, mode, or day.'],
      notes: 'Use before answering questions about which model ran today, how many calls happened, and how many tokens were recorded.',
    },
    {
      id: 'automation.computer_use',
      label: 'Desktop Computer Use',
      category: 'automation',
      status: gate.externalAppAutomationEnabled ? 'available' : 'blocked',
      actions: ['computer_use', 'desktop_open', 'desktop_run_command', 'desktop_clipboard_write', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_mouse_click_at', 'desktop_active_window', 'desktop_capture_screen'],
      surfaces: ['desktop apps', 'browser UI', 'CAD/Revit UI', 'messaging UI'],
      requiresConfirmation: true,
      setup: gate.externalAppAutomationEnabled ? [] : ['Enable external app automation in Settings > Autonomy before controlling external applications.'],
      safety: 'Prefer explicit adapters and files first. Use mouse/keyboard only after confirmation or explicit user request, with visible cursor movement, wallpaper mode for immersive sessions, and verification after actions.',
      notes: 'This is Lumi using the computer, not the default route for Lumi client UI. For external desktop work, inspect screen/active window, show and move the visible cursor before clicks, explain task intent briefly, verify with screenshot/window/process/file evidence, and report only results, blockers, and needed confirmations. Prefer restoring already-running taskbar/background windows before launching duplicates.',
    },
    {
      id: 'automation.account_session_reuse',
      label: 'External Account Session Reuse',
      category: 'automation',
      status: gate.externalAppAutomationEnabled ? 'available' : 'blocked',
      actions: ['desktop_active_window', 'desktop_capture_screen', 'desktop_open', 'desktop_run_command', 'web_login_profile_list', 'browser_open_task'],
      surfaces: ['taskbar apps', 'personal WeChat/Weixin', 'browser profiles', 'store backends', 'creator platforms'],
      requiresConfirmation: true,
      setup: gate.externalAppAutomationEnabled ? [] : ['Enable external app automation in Settings > Autonomy before controlling external applications.'],
      safety: 'Allowed: restore and use already logged-in windows/sessions in visible work. Confirmation or handoff required: first-time login, QR/OTP/biometric verification, account switching, third-party authorization, saving credentials, publishing, payment, or sending messages.',
      notes: 'Use for store/account/video/customer workflows. Lumi should first look for a running personal app window or an existing browser login profile, then continue safe preparation work inside that session. Do not present login completion as autonomous work when the user had to scan, type a password, approve a prompt, or switch accounts.',
    },
    {
      id: 'web.browser',
      label: 'Browser and Web Work',
      category: 'web',
      status: 'ready',
      actions: ['browser_open_task', 'web_search', 'url_fetch', 'web_login_site_presets', 'web_login_profile_save_from_preset', 'web_login_profile_list', 'web_login_run', 'url_fetch_logged_in'],
      surfaces: ['browser', 'web search', 'URL fetch'],
      requiresConfirmation: true,
      safety: 'Opening and reading is allowed when tools permit; already logged-in sessions may be reused visibly. Posts, purchases, submissions, first-time login, account switching, permissions, and sensitive transmissions require confirmation.',
      notes: 'Use for research and handoff to browser tasks. Prefer existing logged-in browser profiles or windows before asking for a new login; stop at QR/OTP/CAPTCHA/authorization boundaries.',
    },
    {
      id: 'web.authority_research',
      label: 'Authority Research and Source Grounding',
      category: 'web',
      status: 'ready',
      actions: ['authority_research', 'authority_research_save', 'web_search', 'url_fetch'],
      surfaces: ['official sources', 'citation packets', 'knowledge memory'],
      requiresConfirmation: true,
      safety: 'Reading/searching is safe; saving research into long-term knowledge requires explicit confirmation.',
      notes: 'Use for laws, policies, patents, software copyright, standards, academic papers, technical docs, and current factual claims that need sources.',
    },
    {
      id: 'messaging.wechat_feishu',
      label: 'WeChat, Feishu, and Remote Messaging',
      category: 'messaging',
      status: 'draft_only',
      actions: ['wechat_intake_analyze', 'wechat_intake_from_clipboard', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'wechat_prepare_reply', 'wechat_copy_reply_draft'],
      surfaces: ['WeChat', 'Feishu bot/remote channel', 'clipboard drafts', 'work takeover intake'],
      requiresConfirmation: true,
      diagnostics: [`sendRequiresConfirmation=${gate.messagingSendRequiresConfirmation}`],
      safety: 'Lumi can read user-provided or copied message text, triage it into work takeover, persist a task, draft replies, and copy drafts. Sending or external posting must stay user-confirmed.',
      notes: 'Use WeChat intake as the front door for customer, store, account, case-filing, video-publishing, and design-delivery takeover tasks. For a shared local Lumi, remote messages are routed into the same local agent unless a future multi-user router is added.',
    },
    {
      id: 'cad_bim.drafting',
      label: 'CAD Drafting and Floorplan Handoff',
      category: 'cad_bim',
      status: 'draft_only',
      actions: ['floorplan_extract_geometry', 'ocr_image_file', 'cad_generate_dxf', 'design_delivery_workflow', 'mcp_cad-drafting_cad_renovation_folder_workflow'],
      surfaces: ['runtime logs', 'CAD handoff files', 'desktop CAD apps', 'large design delivery panel', 'client-facing proposal deck'],
      requiresConfirmation: true,
      safety: 'Generated DXF/IFC/BIM drafts are not production drawings until dimensions and standards are reviewed.',
      notes: 'Current stable path is file generation plus confirmed external-tool handoff. Renovation design delivery can package proposal, budget, customer-ready PPTX/PDF reports with visual design content, DXF drafts opened in FreeCAD/AutoCAD-compatible tools when available, and Revit/Dynamo handoff files. Direct native RVT production output still requires a confirmed Revit adapter.',
    },
    {
      id: 'cad_bim.local_toolchain',
      label: 'Local CAD and Renovation Software Toolbox',
      category: 'cad_bim',
      status: externalToolbox.hasCadInstallers ? 'available' : 'requires_setup',
      actions: ['mcp_cad-drafting_cad_renovation_folder_workflow', 'cad_generate_dxf', 'floorplan_extract_geometry', 'desktop_open', 'external_app_list_adapters', 'computer_use'],
      surfaces: ['LibreCAD', 'Sweet Home 3D', 'FreeCAD', 'Blender', externalToolbox.installersDir],
      requiresConfirmation: true,
      setup: externalToolbox.hasCadInstallers
        ? [`Install the selected package from ${externalToolbox.installersDir} before Lumi claims direct app control.`, 'Prefer explicit MCP/plugin adapters over raw mouse control.']
        : [`Download or install verified CAD/interior-design tools into ${externalToolbox.installersDir}.`],
      diagnostics: externalToolbox.diagnostics,
      safety: 'Installers and source candidates are staged only. Opening, installing, plugin activation, and UI control all need user confirmation.',
      notes: 'Current staged toolchain covers 2D DXF editing, interior layout, scriptable CAD/BIM, and 3D rendering handoff.',
    },
    {
      id: 'cad_bim.ifc_revit',
      label: 'IFC and Revit Integration',
      category: 'cad_bim',
      status: 'planned',
      actions: ['design_delivery_workflow', 'capability_research', 'open_skills'],
      surfaces: ['Revit import', 'IFC handoff', 'Dynamo script handoff'],
      requiresConfirmation: true,
      setup: ['Add a safe IFC generator or Dynamo/Revit adapter before claiming native RVT production output.'],
      notes: 'Current workflow can generate Dynamo scripts and room schedules for reviewed Revit/BIM modeling and can open the handoff files or a detected Dynamo/Revit entry point. Native RVT production output still needs a confirmed adapter or Revit automation environment.',
    },
    {
      id: 'ai.external_agents',
      label: 'External AI and Agent Tools',
      category: 'ai',
      status: skillStats.connected > 0 ? 'available' : 'requires_setup',
      actions: ['external_app_list_adapters', 'adapter_registry_list', 'capability_research', 'computer_use'],
      surfaces: ['MCP', 'browser', 'files', 'clipboard', 'local AI apps'],
      requiresConfirmation: true,
      setup: skillStats.connected > 0 ? [] : ['Connect a specific AI app, MCP server, browser account, or file workflow before delegating real work.'],
      notes: 'Lumi can research and draft adapters. Installing or running third-party code requires confirmation.',
    },
    {
      id: 'ai.nano_banana',
      label: 'Nano Banana / Gemini Image Web Adapter',
      category: 'ai',
      status: 'requires_setup',
      actions: ['browser_open_task', 'web_login_profile_save_from_preset', 'web_login_run', 'capability_research', 'generate_image'],
      surfaces: ['Google AI Studio', 'Gemini app', 'Gemini API image generation docs'],
      requiresConfirmation: true,
      setup: ['Use official Google AI Studio or Gemini pages.', 'Configure a browser login profile or Gemini API key before real API work.', 'Do not install unofficial Nano Banana wrapper clients without review.'],
      diagnostics: [
        `catalog=${externalToolbox.catalogExists ? 'present' : 'missing'}`,
        'localInstaller=not_applicable',
      ],
      safety: 'Image generation can create or edit visual assets, but account actions, paid API use, uploads of private client material, and publishing need confirmation.',
      notes: 'Nano Banana is best treated as a web/API capability for room restyling, material previews, and image-editing workflows, not as a local CAD program.',
    },
    {
      id: 'collaboration.lap',
      label: 'LAP Inter-Lumi Collaboration',
      category: 'collaboration',
      status: 'available',
      actions: ['lap.handshake', 'lap.task.delegate', 'lap.task.result', 'lap.context.share', 'lap.revoke'],
      surfaces: ['community Lumi', 'organization Lumi', 'remote peers'],
      requiresConfirmation: true,
      safety: 'External Lumi context is external by default and cannot mutate local memory/core identity without approval.',
      notes: 'Use LAP for future Lumi-to-Lumi cooperation with source and consent boundaries.',
    },
    {
      id: 'system.sleep_dream',
      label: 'Sleep and Dream Memory Cycle',
      category: 'system',
      status: 'ready',
      actions: ['lumi_sleep_status', 'lumi_sleep_cycle'],
      surfaces: ['memory consolidation', 'rest cycle', 'always-online idle time'],
      notes: 'Dreaming consolidates memory and uncertainty without deleting originals or changing core identity.',
    },
    {
      id: 'system.settings_permissions',
      label: 'Settings, Providers, and Permissions',
      category: 'system',
      status: 'ready',
      actions: ['open_settings', 'open_settings(section=llm)', 'open_settings(section=voice)', 'open_settings(section=vision)'],
      surfaces: ['Settings', 'LLM providers', 'Vision Services', 'Voice Services', 'Autonomy'],
      diagnostics: [
        state?.permissions ? `permissions=${Object.keys(state.permissions).length}` : 'permissions=unknown',
        gate.externalAppAutomationEnabled ? 'externalAutomation=true' : 'externalAutomation=false',
      ],
      notes: 'Provider selection is authoritative. Fallbacks should be visible and user-informed, not silent.',
    },
  ];

  const visibleAdapters = options.includePlanned === false
    ? adapters.filter(adapter => adapter.status !== 'planned')
    : adapters;

  return {
    generatedAt: new Date().toISOString(),
    userId,
    stateAgeSeconds,
    summary: summarizeAdapters(visibleAdapters),
    adapters: visibleAdapters,
  };
}

export function getAdapterById(id: string, options: AdapterRegistryOptions = {}): AdapterCapability | null {
  const report = getAdapterRegistry(options);
  return report.adapters.find(adapter => adapter.id === id) || null;
}

export function summarizeAdapters(adapters: AdapterCapability[]): AdapterRegistrySummary {
  const byStatus = Object.fromEntries(STATUS_ORDER.map(status => [status, 0])) as Record<AdapterStatus, number>;
  const byCategory = Object.fromEntries(CATEGORY_ORDER.map(category => [category, 0])) as Record<AdapterCategory, number>;

  for (const adapter of adapters) {
    byStatus[adapter.status] += 1;
    byCategory[adapter.category] += 1;
  }

  return {
    total: adapters.length,
    byStatus,
    byCategory,
    readyCount: byStatus.ready + byStatus.available + byStatus.draft_only,
    setupRequiredCount: byStatus.requires_setup + byStatus.blocked,
    attentionCount: byStatus.attention + byStatus.degraded,
    plannedCount: byStatus.planned,
  };
}

function getStateAgeSeconds(state: Record<string, any> | null): number | null {
  const updatedAt = Number(state?.updatedAt || 0);
  if (!updatedAt) return null;
  return Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
}

interface ExternalToolboxStatus {
  root: string;
  installersDir: string;
  catalogExists: boolean;
  hasCadInstallers: boolean;
  diagnostics: string[];
}

function getExternalToolboxStatus(): ExternalToolboxStatus {
  const root = process.env.LUMI_EXTERNAL_TOOLS_DIR || (process.platform === 'win32' ? 'D:\\LumiTools' : path.join(process.cwd(), 'external-tools'));
  const installersDir = path.join(root, 'installers');
  const catalogPath = path.join(root, 'catalog', 'lumi_external_tools_catalog.md');
  const hasLibreCad = hasFileMatching(installersDir, ['librecad']);
  const hasSweetHome = hasFileMatching(installersDir, ['sweet home 3d']);
  const hasSweetHomeMcp = hasFileMatching(installersDir, ['sh3d-mcp-plugin']);
  const hasFreeCad = hasFileMatching(installersDir, ['freecad']);
  const hasBlender = hasFileMatching(installersDir, ['blender']);
  return {
    root,
    installersDir,
    catalogExists: safeExists(catalogPath),
    hasCadInstallers: hasLibreCad || hasSweetHome || hasSweetHomeMcp || hasFreeCad || hasBlender,
    diagnostics: [
      `toolboxRoot=${root}`,
      `catalog=${safeExists(catalogPath) ? 'present' : 'missing'}`,
      `LibreCAD=${hasLibreCad ? 'staged' : 'missing'}`,
      `SweetHome3D=${hasSweetHome ? 'staged' : 'missing'}`,
      `SweetHome3D_MCP=${hasSweetHomeMcp ? 'staged' : 'missing'}`,
      `FreeCAD=${hasFreeCad ? 'staged' : 'missing'}`,
      `Blender=${hasBlender ? 'staged' : 'missing'}`,
    ],
  };
}

function safeExists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function hasFileMatching(dir: string, needles: string[]): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    const normalizedNeedles = needles.map(item => item.toLowerCase());
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .some(entry => {
        const name = entry.name.toLowerCase();
        return normalizedNeedles.every(needle => name.includes(needle));
      });
  } catch {
    return false;
  }
}

function getSkillStats(): SkillStats {
  try {
    const config = mcpManager.getConfig();
    const local = mcpManager.listLocalSkills();
    const connected = mcpManager.getConnectedServers();
    const health = mcpManager.getServerHealth();
    const enabled = Object.values(config).filter((item: any) => item?.enabled).length;
    const brokenSkills = local.filter((skill: any) => skill?.broken);
    const unhealthyNames = Object.entries(health)
      .filter(([, item]) => ['crashed', 'failed', 'restarting'].includes(item.status))
      .map(([name]) => name);
    const issueNames = Array.from(new Set([
      ...brokenSkills.map((skill: any) => String(skill.name || 'unknown')),
      ...unhealthyNames,
    ])).filter(Boolean);

    return {
      total: local.length,
      connected: connected.length,
      enabled,
      broken: brokenSkills.length,
      unhealthy: unhealthyNames.length,
      connectedNames: connected,
      issueNames,
    };
  } catch (error: any) {
    return {
      total: 0,
      connected: 0,
      enabled: 0,
      broken: 0,
      unhealthy: 1,
      connectedNames: [],
      issueNames: [String(error?.message || error || 'mcp inspection failed')],
    };
  }
}
