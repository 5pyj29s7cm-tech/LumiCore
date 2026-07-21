import fs from 'fs';
import path from 'path';
import { getGateConfig } from '../autonomy/safety_gate';
import { mcpManager } from '../mcp/client';
import {
  PERSONAL_CLIENT_SURFACES,
  PERSONAL_CLIENT_SURFACE_ACTIONS,
} from '../../shared/client_surfaces';
import { sanitizeDiagnosticValue } from '../client/diagnostic_sanitizer';

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
  | 'finance'
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
  unavailableEnabled: number;
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
  'finance',
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
  const state = sanitizeDiagnosticValue(options.clientState || null);
  const gate = getGateConfig(userId);
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
      requiresConfirmation: false,
      diagnostics: state?.mode ? [`Current mode: ${state.mode}`] : [],
      notes: 'Chat is pure conversation. Assistant is user-present high-permission work. Autonomous has the same practical permissions plus continuous/background work. Switching between Chat, Assistant, and Autonomous does not need tool permission popups; Meeting capture remains explicit.',
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
      id: 'client.customer_operations',
      label: 'Customer Operations',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['work_takeover_task_from_wechat', 'work_takeover_task_orchestrate', 'work_takeover_task_run_suggested_tool', 'mcp_sales-customer-ops_lead_score', 'mcp_sales-customer-ops_sales_followup_draft', 'mcp_sales-customer-ops_objection_response_builder', 'wechat_read_recent_chat', 'wechat_send_message', 'create_docx', 'work_product_verify'],
      surfaces: ['Lumi desktop', 'work takeover task record', 'WeChat', 'WPS or editor', 'browser'],
      requiresConfirmation: false,
      setup: hasState ? [] : ['Open Lumi desktop client so customer operations can use messaging and visible desktop surfaces.'],
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        'externalAppAutomationGate=removed',
      ],
      safety: 'Runs only after an explicit customer-takeover or customer-advance request. It prepares WeChat drafts and business materials without per-tool permission popups; ordinary supervised sends may proceed when requested. Payments, legal commitments, credential changes, and destructive actions remain hard boundaries.',
      notes: 'Use current customer messages, files, sales tools, task state, and messaging receipts. Local quotes, contracts, drafts, opened windows, and clipboard text are preparation only; report customer progress only from verified documents, task writeback, or a real target-action receipt.',
    },
    {
      id: 'client.design_operations',
      label: 'Design Operations',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['desktop_list_files', 'read_file', 'read_pdf', 'ocr_image_file', 'floorplan_extract_geometry', 'create_ppt', 'create_pdf', 'cad_generate_dxf', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'work_product_verify', 'wechat_send_file'],
      surfaces: ['Lumi desktop', 'work takeover task record', 'WPS or editor', 'client-facing PPT/PDF proposal files', 'desktop CAD apps', 'CAD DXF draft', 'AutoCAD MCP/COM stroke-by-stroke playback', 'Revit/BIM application results', 'personal WeChat or WeCom'],
      requiresConfirmation: false,
      setup: hasState ? [] : ['Open Lumi desktop client and provide the measured source drawings or project files required by the design task.'],
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        'externalAppAutomationGate=removed',
      ],
      safety: 'Runs only after an explicit renovation/design/CAD/Revit delivery request. It prepares local delivery files, opens/uses available CAD or office tools, and handles WeChat drafts without per-tool permission popups. Production drawings, legal commitments, payments, installs, and account/security prompts remain hard boundaries.',
      notes: 'Use measured source files and real project constraints. Local concept packets are drafts only. Verify requested documents as files, AutoCAD work through the MCP/COM completion marker, native BIM through an actual adapter result, and client delivery through a file/message receipt.',
    },
    {
      id: 'client.ecommerce_operations',
      label: 'E-commerce Operations',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['mcp_ecommerce-ops_product_listing_optimizer', 'mcp_ecommerce-ops_ecommerce_order_profit', 'mcp_ecommerce-ops_inventory_restock_plan', 'mcp_ecommerce-ops_platform_settlement_reconcile', 'mcp_ecommerce-ops_campaign_roi_analyzer', 'mcp_ecommerce-ops_after_sales_risk_report', 'web_login_run', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_fill_form', 'mcp_playwright_browser_click', 'create_xlsx', 'create_docx', 'generate_image', 'generate_video', 'wechat_send_message', 'work_product_verify'],
      surfaces: ['Lumi desktop', 'work takeover task record', 'browser', 'WPS or spreadsheet', 'external image/video tools', 'creator platforms', 'store admin pages', 'personal WeChat or WeCom'],
      requiresConfirmation: false,
      setup: hasState ? [] : ['Provide store exports or an authorized platform session so ecommerce work can be grounded in live data.'],
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        'externalAppAutomationGate=removed',
      ],
      safety: 'Runs only after an explicit ecommerce/store/account/content-growth request. It generates local deliverables and drafts without per-tool permission popups; foreground user-requested ordinary messages, comments, replies, and non-commercial content posts can proceed. Ad spend, inventory/price changes, first-time login, account switching, verification, payment, purchase, and legal/contractual final commits stay hard-boundary gated.',
      notes: 'Use supplied product facts, platform exports, authenticated page state, and real tool results. Local content drafts are not store analysis or execution. Publishing, media generation, store changes, ad spend, and customer outreach require an external result or receipt before completion is reported.',
    },
    {
      id: 'client.interface_map',
      label: 'Lumi Interface Map',
      category: 'client',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['client_get_state', 'client_action', 'adapter_registry_list', ...PERSONAL_CLIENT_SURFACE_ACTIONS],
      surfaces: [...PERSONAL_CLIENT_SURFACES.map(surface => surface.id), 'org', 'meeting', 'wallpaper', 'widget'],
      setup: hasState ? [] : ['Open Lumi desktop client so the live surface map can include current windows and state.'],
      diagnostics: [
        state?.windows?.focused ? `focused=${state.windows.focused}` : '',
        state?.windows?.open?.length ? `open=${state.windows.open.slice(0, 5).join(',')}` : '',
      ].filter(Boolean),
      notes: 'Use when Lumi needs to know, explain, open, close, or choose among her own client interfaces. This registry is shared with the desktop action router; prefer its explicit actions over generic target guessing.',
    },
    {
      id: 'system.local_machine_awareness',
      label: 'Local Machine Awareness',
      category: 'system',
      status: 'available',
      actions: ['client_get_state', 'client_health_check', 'desktop_capability_status', 'desktop_system_info', 'desktop_list_apps', 'desktop_list_files', 'desktop_path_info', 'desktop_running_processes', 'desktop_active_window', 'desktop_capture_screen', 'adapter_registry_list'],
      surfaces: ['native desktop client', 'host OS', 'home directory', 'Desktop/Documents/Downloads', 'installed apps', 'running processes', 'foreground window'],
      requiresConfirmation: false,
      diagnostics: [
        state?.platform ? `platform=${state.platform}` : '',
        state?.runtime?.backendNodeRunning ? 'backendNode=running' : '',
        staleState ? `clientStateAge=${stateAgeSeconds}s` : '',
      ].filter(Boolean),
      safety: 'Observation only: system info, app/file listings, path checks, active-window/process checks, and screenshots are perception. Autonomous local body learning is stricter: map top-level landmarks and app/process state only, without opening files/apps, screenshots, shell commands, desktop input, or file-content reads. File/app/settings changes, shell commands, and desktop input follow the normal mode and confirmation gates.',
      notes: 'Use when Lumi needs to know this computer as her local body: what host it is running on, what apps are launchable, what files/folders exist, what window is foregrounded, and what processes are running. Autonomous mode may periodically refresh this body map so future work starts from evidence rather than guesses.',
    },
    {
      id: 'system.background_runtime_awareness',
      label: 'Background Runtime Awareness',
      category: 'system',
      status: !hasState ? 'requires_setup' : staleState ? 'attention' : 'ready',
      actions: ['client_get_state', 'client_health_check', 'open_runtime_log', 'client_self_repair', 'desktop_idle_time', 'desktop_poll_activity', 'autonomy_get_policy', 'autonomy_list_workflows', 'autonomy_register_workflow'],
      surfaces: ['runtime log', 'background tray state', 'autostart', 'close-to-background', 'backend processes', 'autonomy policy', 'confirmed workflows'],
      requiresConfirmation: false,
      setup: hasState ? [] : ['Open Lumi desktop client so runtime state can report whether the client/server are alive.'],
      diagnostics: [
        `autostart=${Boolean(state?.runtime?.autostartEnabled)}`,
        `closeToBackground=${Boolean(state?.runtime?.closeToBackground)}`,
        state?.runtime?.startedInBackground ? 'startedInBackground=true' : '',
        `backendNode=${state?.runtime?.backendNodeRunning ? 'running' : 'unknown'}`,
        `desktopModeAutonomy=${gate.autonomyLevel}`,
        `alwaysOnline=${gate.alwaysOnline}`,
        `autoProcess=${gate.autoProcessEnabled}`,
      ].filter(Boolean),
      safety: 'Reading runtime status is safe. Assistant and Autonomous execution do not need per-tool permission popups. Changing startup/runtime settings, enabling recurring workflows, or crossing high-consequence boundaries still requires explicit confirmation or handoff. Hidden-to-background, live backend health, and autonomous execution are distinct states.',
      notes: 'Use before promising 24-hour availability, background continuity, restart survival, or unattended task execution. Resident runtime depends on the desktop client/server actually running; autonomous work additionally depends on desktop mode, autonomy policy, token budget, and enabled workflow limits. Assistant is low-friction by default instead of waiting for idle time.',
    },
    {
      id: 'client.visible_execution_habits',
      label: 'Visible Execution Habits',
      category: 'client',
      status: hasState && !staleState ? 'ready' : 'available',
      actions: ['client_get_state', 'client_action', 'desktop_cursor_glow_show', 'desktop_cursor_glow_update', 'desktop_cursor_glow_click', 'desktop_active_window', 'desktop_capture_screen'],
      surfaces: ['Lumi surfaces', 'wallpaper mode', 'cursor glow', 'runtime log', 'external desktop'],
      requiresConfirmation: false,
      diagnostics: [
        state?.surfaces?.wallpaperMode ? 'wallpaper=on' : 'wallpaper=off',
        'externalAppAutomationGate=removed',
      ],
      safety: 'This is the behavioral pattern for visible work: explain the task, choose the right surface, use cursor glow for desktop clicks, verify outcomes, and close temporary surfaces. External app control follows mode, workflow, and hard-boundary gates without ordinary tool permission popups.',
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
      status: state?.knowledge?.lastError || state?.knowledge?.failedFiles || state?.knowledge?.unsupportedFiles ? 'attention' : 'ready',
      actions: ['show_knowledge_base', 'search_memory', 'client_action(show_knowledge_base)'],
      surfaces: ['current-domain knowledge base', 'memory domain', 'imports', 'ingestion and index health'],
      diagnostics: state?.knowledge ? [
        `domain=${state.knowledge.domain || state.workDomain || 'personal'}`,
        `files=${state.knowledge.totalFiles || 0}, indexed=${state.knowledge.indexedFiles || 0}, partial=${state.knowledge.partialFiles || 0}, pending=${state.knowledge.pendingFiles || 0}`,
        `failed=${state.knowledge.failedFiles || 0}, unsupported=${state.knowledge.unsupportedFiles || 0}`,
      ] : ['Knowledge inventory has not been reported by the client yet.'],
      notes: 'The same Lumi uses the active workspace knowledge scope. Personal and organization data remain source-bound and isolated.',
    },
    {
      id: 'workspace.organization',
      label: 'Organization Workspace',
      category: 'organization',
      status: state?.org?.connected ? 'ready' : 'available',
      actions: [
        'open_organization_workspace(section=dashboard|kb|chat|messaging|templates|review|members|audit|settings|branch|legal|spatial-design|brand-design)',
      ],
      surfaces: [
        'organization dashboard',
        'organization knowledge base',
        'company Lumi',
        'Feishu/WeCom messaging access',
        'agent templates and review',
        'members and permissions',
        'audit',
        'organization settings and branch connection',
        'law firm workspace',
        'spatial and architecture workspace',
        'brand and creative workspace',
      ],
      diagnostics: state?.org?.connected
        ? [
            `connected=${state.org.name || state.org.id || 'organization'}`,
            `role=${state.org.role || 'member'}`,
            `activeView=${state.orgWorkspace?.activeView || 'none'}`,
            `allowedViews=${state.orgWorkspace?.availableViews?.join(',') || 'not-reported'}`,
          ]
        : ['No active organization in current client state.'],
      notes: 'Organization work is a role-scoped overlay for the same Lumi identity, not a separate personal assistant and not a path into another member\'s personal data.',
    },
    {
      id: 'workspace.skills_mcp',
      label: 'Skills and MCP Runtime',
      category: 'ai',
      status: skillStats.unhealthy || skillStats.broken || skillStats.unavailableEnabled
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
        skillStats.unavailableEnabled ? `unavailableEnabled=${skillStats.unavailableEnabled}` : '',
        skillStats.issueNames.length ? `issues=${skillStats.issueNames.slice(0, 5).join(', ')}` : '',
      ].filter(Boolean),
      notes: 'Skills are Lumi expansion points. Calling connected skills and inspecting health are read-only. Package repair can reinstall dependencies, update MCP configuration, or restart a process, so client_repair_skill requires explicit confirmation.',
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
      label: 'Desktop Modes and Autonomous Workflows',
      category: 'automation',
      status: gate.alwaysOnline ? (gate.autonomyLevel === 'reactive' ? 'available' : 'ready') : 'blocked',
      actions: ['open_plans', 'open_work_queue', 'autonomy_get_policy', 'autonomy_register_workflow'],
      surfaces: ['Plans', 'work queue', 'autonomy settings'],
      requiresConfirmation: false,
      diagnostics: [
        `desktopModeAutonomy=${gate.autonomyLevel}`,
        `alwaysOnline=${gate.alwaysOnline}`,
        `autoProcess=${gate.autoProcessEnabled}`,
        `maxConsecutiveTasks=${gate.maxConsecutiveTasks}`,
      ],
      notes: 'The desktop has three permission modes: Chat is pure conversation, Assistant is user-present high-permission execution without ordinary tool prompts, and Autonomy has the same practical permissions plus continuous 24h/background operation. Launch-at-login and close-to-background only make Lumi resident when the client/server are alive; workflows then run according to autonomy policy, token budgets, enabled workflow limits, and high-consequence hard boundaries.',
    },
    {
      id: 'automation.work_takeover_tasks',
      label: 'Work Takeover Task Hub',
      category: 'automation',
      status: 'ready',
      actions: ['work_takeover_task_create', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'work_takeover_task_list', 'work_takeover_task_get', 'work_takeover_task_update', 'work_takeover_task_continue', 'work_takeover_task_orchestrate', 'work_takeover_task_execute_step', 'work_takeover_task_advance', 'work_takeover_task_autorun', 'work_takeover_capability_reuse_probe', 'work_takeover_task_verify_result', 'work_takeover_task_export_packet', 'work_takeover_task_run_suggested_tool'],
      surfaces: ['work takeover task pool', 'WeChat intake', 'local task packet files', 'verified tool results', 'external app handoff'],
      requiresConfirmation: false,
      safety: 'Creating, listing, updating, and continuing takeover tasks changes Lumi internal task state only. External sends, filings, posts, payments, signatures, or destructive actions remain confirmation-gated.',
      notes: 'Persistent task hub for customer, ecommerce, legal, and design work. It stores sources, facts, drafts, artifacts, boundaries, plans, and verified results. Real external outcomes come from selected domain tools and must pass result verification before the task is described as delivered.',
    },
    {
      id: 'system.self_extension_pipeline',
      label: 'Self Extension Pipeline',
      category: 'system',
      status: 'ready',
      actions: ['self_extension_plan', 'capability_gap_autofix', 'capability_learning_list', 'adapter_registry_list', 'capability_research', 'generate_skill', 'install_skill', 'client_repair_skill'],
      surfaces: ['Skill Hall', 'Adapter Registry', 'MCP runtime', 'capability research', 'capability learning memory'],
      requiresConfirmation: true,
      safety: 'Planning and listing learned routes are safe. Capability autofix is only for absent or failed/brittle coverage. Package installation or repair, untrusted third-party execution, and Lumi core changes remain explicit confirmation boundaries.',
      notes: 'Use when Lumi notices a missing capability or brittle raw mouse/script fallback: first inspect learned routes, adapters, tools, installed skills, and marketplace skills through self_extension_plan. Reuse existing coverage when it exists. Run capability_gap_autofix only when the unified plan says a new route is needed or real failure evidence exists, then prepare or run one minimal verification experiment and persist one reusable route instead of creating parallel wrappers.',
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
      status: 'available',
      actions: ['computer_use', 'desktop_show_lumi_window', 'desktop_open', 'desktop_run_command', 'read_clipboard', 'write_clipboard', 'mouse_move', 'mouse_click', 'mouse_drag', 'keyboard_type', 'keyboard_press', 'desktop_active_window', 'desktop_window_control', 'desktop_running_processes', 'desktop_idle_time', 'desktop_poll_activity', 'desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'desktop_capture_screen'],
      surfaces: ['desktop apps', 'browser UI', 'CAD/Revit UI', 'messaging UI'],
      requiresConfirmation: false,
      setup: [],
      diagnostics: ['externalAutomationGate=removed'],
      safety: 'Prefer explicit adapters and files first. Low- and medium-risk computer_use, UIA, clipboard, raw input, saved/authorized login session reuse, and foreground user-requested social/content commits follow the active desktop mode without per-step prompts; payments, purchases, transfers, first-time login, QR/OTP/captcha/passkey/security verification, account switching, credential storage, third-party authorization, legal filings/signatures, ambiguous submits, installs, shell commands, destructive actions, and other high-risk boundaries still require confirmation.',
      notes: 'This is Lumi using the computer, not the default route for Lumi client UI. Registered tools expose observation, UIA, clipboard, mouse, keyboard, app opening, commands, and vision computer_use. Workflow-internal relay actions such as desktop_cursor_glow_*, desktop_mouse_click_at, and desktop_set_wallpaper_mode are available to controlled workflows including foreground WeChat sends, desktop demos, and computer_use cleanup. For external desktop work, inspect active window controls with desktop_ui_snapshot when possible, use desktop_ui_focus/click/invoke/type for accessible controls, inspect screen pixels when needed, show and move the visible cursor before raw clicks, explain task intent briefly, verify with screenshot/window/process/file evidence, and report only results, blockers, and needed confirmations. Prefer restoring already-running taskbar/background windows before launching duplicates.',
    },
    {
      id: 'automation.desktop_uia',
      label: 'Windows UI Automation Snapshot',
      category: 'automation',
      status: process.platform === 'win32' ? 'ready' : 'requires_setup',
      actions: ['desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'desktop_active_window', 'desktop_capture_screen', 'mouse_move', 'mouse_click', 'keyboard_type'],
      surfaces: ['native Windows apps', 'WPS/Office', 'WeChat', 'CAD/Revit launchers', 'installers', 'dialogs'],
      requiresConfirmation: false,
      setup: process.platform === 'win32' ? [] : ['Run Lumi on Windows to use UI Automation snapshots.'],
      safety: 'Snapshot inspection plus low- and medium-risk focus/click/invoke/type can run under the active desktop mode. Foreground user-requested ordinary messages/comments/replies/posts and saved/authorized session reuse can proceed; payments, purchases, first-time login, security verification, credential storage, account switching, legal filings/signatures, ambiguous submits, and destructive actions remain confirmation-gated.',
      notes: 'Use this before raw coordinate control so Lumi can identify and operate real controls, labels, input fields, enabled state, and bounding rectangles.',
    },
    {
      id: 'automation.account_session_reuse',
      label: 'External Account Session Reuse',
      category: 'automation',
      status: 'available',
      actions: ['desktop_active_window', 'desktop_capture_screen', 'desktop_open', 'desktop_run_command', 'web_login_site_presets', 'web_login_profile_list', 'web_login_profile_save_from_preset', 'web_login_profile_save', 'web_login_learn_site', 'web_login_run', 'url_fetch_logged_in', 'browser_open_task'],
      surfaces: ['taskbar apps', 'personal WeChat/Weixin', 'browser profiles', 'store backends', 'creator platforms'],
      requiresConfirmation: false,
      setup: [],
      diagnostics: ['externalAutomationGate=removed'],
      safety: 'Restore and use already logged-in windows/sessions and saved/authorized browser profiles without a separate prompt under the active desktop mode. Learning a new site login or storing encrypted credentials requires confirmation. Foreground user-requested ordinary messages/comments/replies/posts can proceed. Confirmation or handoff required: first-time login, QR/OTP/captcha/passkey/biometric verification, account switching, third-party authorization, saving credentials, payment, purchase, legal filing/signature, or other high-consequence commit.',
      notes: 'Use for store/account/video/customer/legal workflows. Lumi should first look for a running personal app window or an existing browser login profile, then continue safe preparation work inside that session with web_login_run or url_fetch_logged_in when appropriate. If no profile exists, use web_login_learn_site to create a generic authorized profile for the site after confirmation. Do not present login completion as autonomous work when the user had to scan, type a password, approve a prompt, or switch accounts.',
    },
    {
      id: 'web.browser',
      label: 'Browser and Web Work',
      category: 'web',
      status: 'ready',
      actions: ['browser_open_task', 'web_search', 'url_fetch', 'web_login_site_presets', 'web_login_profile_save_from_preset', 'web_login_profile_save', 'web_login_learn_site', 'web_login_profile_list', 'web_login_run', 'url_fetch_logged_in', 'external_control_candidates', 'external_control_configure_candidate', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_fill_form', 'mcp_playwright_browser_click'],
      surfaces: ['browser', 'web search', 'URL fetch'],
      requiresConfirmation: false,
      safety: 'Opening, reading, saved/authorized login profile reuse, and authenticated fetches through saved sessions are allowed when tools permit. Foreground user-requested ordinary comments/replies/content posts can proceed. Purchases, payments, ambiguous submissions, first-time login, QR/OTP/captcha/passkey/security verification, account switching, third-party authorization, credential storage, and sensitive transmissions require confirmation or handoff.',
      notes: 'Use for research, authenticated pages, and handoff to browser tasks. Prefer existing logged-in browser profiles or windows before asking for a new login; for new authorized sites use web_login_learn_site or web_login_profile_save after confirmation. Configure Playwright MCP when structured DOM/browser control is needed. Stop at QR/OTP/CAPTCHA/passkey/authorization boundaries.',
    },
    {
      id: 'web.playwright_mcp',
      label: 'Playwright MCP Browser Control',
      category: 'web',
      status: skillStats.connectedNames.includes('playwright') ? 'ready' : 'requires_setup',
      actions: ['external_control_candidates', 'external_control_configure_candidate', 'client_repair_skill', 'browser_open_task', 'web_login_run', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_click', 'mcp_playwright_browser_fill_form', 'mcp_playwright_browser_type', 'mcp_playwright_browser_take_screenshot'],
      surfaces: ['browser DOM', 'logged-in web apps', 'store backends', 'creator centers', 'web forms'],
      requiresConfirmation: false,
      setup: skillStats.connectedNames.includes('playwright')
        ? []
        : ['Run external_control_configure_candidate with candidateId=playwright-mcp, review the MCP config, then enable/restart the playwright server.'],
      safety: 'Use for structured browser automation without per-tool permission popups. Foreground user-requested ordinary comments/replies/content posts can proceed. Account switching, payments, purchases, uploads of sensitive material, legal/business final submissions, and ambiguous submits require explicit confirmation or handoff.',
      notes: 'This is the preferred upgrade path for browser-heavy work because Lumi can rely on page structure instead of only screenshot coordinates.',
    },
    {
      id: 'web.authority_research',
      label: 'Authority Research and Source Grounding',
      category: 'web',
      status: 'ready',
      actions: ['authority_research', 'authority_research_save', 'web_search', 'url_fetch'],
      surfaces: ['official sources', 'citation packets', 'knowledge memory'],
      requiresConfirmation: true,
      safety: 'Reading/searching public sources is safe; login-required, paid, captcha, QR/OTP, private, or account-authorization pages are blockers. Saving research into long-term knowledge requires explicit confirmation unless a confirmed workflow explicitly grants that write.',
      notes: 'Use for laws, policies, patents, software copyright, standards, academic papers, technical docs, current factual claims, and autonomous public-source learning refreshes that need sources. Autonomous learning should follow the user industry habits: common platforms, deliverable formats, vocabulary, verification standards, and confirmation boundaries.',
    },
    {
      id: 'finance.stock_watch',
      label: 'Stock Watch and Paper Trading',
      category: 'finance',
      status: skillStats.connectedNames.includes('stockbot') ? 'ready' : 'available',
      actions: ['mcp_stockbot_stock_search', 'mcp_stockbot_stock_quote', 'mcp_stockbot_stock_kline', 'mcp_stockbot_market_index', 'mcp_stockbot_hot_sectors', 'mcp_stockbot_stock_news', 'mcp_stockbot_stock_trade_plan', 'mcp_stockbot_paper_trade', 'mcp_stockbot_paper_portfolio', 'browser_open_task'],
      surfaces: ['StockBot MCP', 'public market data', 'watchlists', 'browser quote pages', 'paper portfolio'],
      requiresConfirmation: false,
      setup: skillStats.connectedNames.includes('stockbot') ? [] : ['Enable/connect the bundled StockBot skill for live quote, K-line, sector, news, trade-plan, and paper-trading tools.'],
      diagnostics: [`stockbot=${skillStats.connectedNames.includes('stockbot') ? 'connected' : 'not_connected'}`],
      safety: 'Quotes, watchlists, intraday alerts, sectors, news, risk plans, and paper trades are observational or simulated and can run when tools permit. This does not provide investment advice and never places real brokerage orders. Real buy/sell/cancel-order actions, trading passwords, brokerage login/security prompts, and fund transfers require confirmation.',
      notes: 'Use for A-share market watch, stock pools, price alerts, sector heat, K-line/news checks, position-review planning, and simulated paper portfolios. Prefer StockBot public data and paper-trading records before opening external brokerage surfaces. If a user asks for real-money trading, treat it as a high-consequence external action and stop for confirmation.',
    },
    {
      id: 'messaging.wechat_feishu',
      label: 'WeChat, Feishu, and Remote Messaging',
      category: 'messaging',
      status: gate.messagingSendRequiresConfirmation ? 'draft_only' : 'ready',
      actions: ['wechat_intake_analyze', 'wechat_intake_from_clipboard', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'wechat_prepare_reply', 'wechat_copy_reply_draft', 'wechat_read_recent_chat', 'wechat_send_message', 'wechat_send_file', 'wechat_desktop_watch_status', 'wechat_desktop_watch_update', 'wechat_desktop_watch_scan', 'wechat_desktop_watch_approve_reply', 'messaging_list_file_targets', 'feishu_send_file'],
      surfaces: ['native desktop WeChat duty mode', 'WeChat', 'Feishu bot/remote channel', 'cross-workspace file transfer', 'court-notice link intake', 'clipboard drafts', 'work takeover intake'],
      requiresConfirmation: false,
      diagnostics: [`sendRequiresConfirmation=${gate.messagingSendRequiresConfirmation}`],
      safety: 'Lumi can watch accessible unread indicators without foregrounding WeChat, but it only restores and reads a reliably identified conversation after the user is idle. It may triage and draft in the background; every representational reply still requires action-time user confirmation. Payments, login/security verification, account switching, legal/contractual commitments, and other high-consequence actions remain confirmation or handoff boundaries.',
      notes: 'Use native desktop WeChat duty mode for persistent unread detection, deduplication, conservative risk classification, and confirmation-queued drafts. Treat detection, reading, drafting, and sending as separate actions with separate evidence; an unread badge is not message-content evidence, and a prepared draft is not a send. Personal WeChat may enter an organization only through the bound member identity: uniquely matched court notices can be archived directly, ambiguous cases ask once, and cross-workspace file sends are target-bound and audit-logged. Feishu and WeCom group members are routed independently by member, chat, and thread.',
    },
    {
      id: 'cad_bim.drafting',
      label: 'CAD Drafting and Floorplan Handoff',
      category: 'cad_bim',
      status: 'ready',
      actions: ['floorplan_extract_geometry', 'ocr_image_file', 'cad_generate_dxf', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'mcp_cad-drafting_cad_renovation_folder_workflow'],
      surfaces: ['source project folders', 'runtime logs', 'CAD handoff files', 'desktop CAD apps', 'AutoCAD MCP/COM stroke-by-stroke playback', 'verified client-facing documents'],
      requiresConfirmation: false,
      safety: 'Image-grounded CAD can execute only from a source-bound geometry receipt that passed deterministic checks and visual comparison. It is not a production drawing until source dimensions, standards, structure, and MEP constraints are professionally reviewed.',
      notes: 'The stable path uses staged source tracing and a server-owned geometry receipt. Visible AutoCAD work requires MCP/COM playback, an operation-set match, and exact entity-count verification; interrupted runs resume or block without replaying duplicates. No generated file or handoff note can substitute for a failed external-app run.',
    },
    {
      id: 'cad_bim.local_toolchain',
      label: 'Local CAD and Renovation Software Toolbox',
      category: 'cad_bim',
      status: externalToolbox.hasCadInstallers ? 'available' : 'requires_setup',
      actions: ['mcp_cad-drafting_cad_renovation_folder_workflow', 'cad_generate_dxf', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'floorplan_extract_geometry', 'desktop_open', 'external_app_list_adapters', 'computer_use'],
      surfaces: ['LibreCAD', 'Sweet Home 3D', 'FreeCAD', 'Blender', externalToolbox.installersDir],
      requiresConfirmation: false,
      setup: externalToolbox.hasCadInstallers
        ? [`Install the selected package from ${externalToolbox.installersDir} before Lumi claims direct app control.`, 'Prefer explicit MCP/plugin adapters over raw mouse control.']
        : [`Download or install verified CAD/interior-design tools into ${externalToolbox.installersDir}.`],
      diagnostics: externalToolbox.diagnostics,
      safety: 'Installers and source candidates are staged only. Opening installed CAD/interior tools and visible UI control can run under Assistant/Autonomy without per-tool permission popups. Installing software, plugin activation, credential prompts, and destructive system changes remain hard boundaries.',
      notes: 'Current staged toolchain covers 2D DXF editing, AutoCAD MCP/COM entity playback, interior layout, scriptable CAD/BIM, and 3D rendering handoff. Generated drawing files are explicit deliverables only, never a fallback for failed visible AutoCAD playback.',
    },
    {
      id: 'cad_bim.ifc_revit',
      label: 'IFC and Revit Integration',
      category: 'cad_bim',
      status: 'planned',
      actions: ['capability_research', 'open_skills'],
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
      actions: ['desktop_ai_list_targets', 'desktop_ai_discovery_plan', 'desktop_ai_register_target', 'desktop_ai_roundtable', 'desktop_ai_ask', 'desktop_ai_collect_answer', 'external_app_list_adapters', 'adapter_registry_list', 'capability_research', 'computer_use'],
      surfaces: ['MCP', 'browser', 'files', 'clipboard', 'local AI apps', 'WorkBuddy', 'Codex desktop', 'ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Kimi', 'Cursor/Copilot', 'local AI runtimes'],
      requiresConfirmation: false,
      setup: skillStats.connected > 0 ? [] : ['Connect a specific AI app, MCP server, browser account, or file workflow before delegating real work.'],
      notes: 'Lumi can research, draft adapters, ask desktop AI apps and browser AI surfaces such as WorkBuddy, Codex, ChatGPT, Claude, Gemini, DeepSeek, Kimi, Cursor/Copilot, and local AI runtimes through real windows, collect visible answers with screenshot/vision evidence, and coordinate connected AI apps without per-tool permission popups. desktop_ai_roundtable sends one question to multiple targets, collects each verified visible answer, and returns a synthesis input; pressing submit alone remains unverified. Missing targets should be handled as public-source discovery candidates with desktop_ai_discovery_plan, then registered after confirmation with desktop_ai_register_target so they become reusable catalog entries instead of one-off scripts. API/MCP/CLI integrations are preferred when available; installing or running untrusted third-party code remains a hard boundary.',
    },
    {
      id: 'ai.nano_banana',
      label: 'Nano Banana / Gemini Image Web Adapter',
      category: 'ai',
      status: 'requires_setup',
      actions: ['browser_open_task', 'web_login_profile_save_from_preset', 'web_login_profile_save', 'web_login_learn_site', 'web_login_run', 'capability_research', 'generate_image'],
      surfaces: ['Google AI Studio', 'Gemini app', 'Gemini API image generation docs'],
      requiresConfirmation: false,
      setup: ['Use official Google AI Studio or Gemini pages.', 'Configure a browser login profile or Gemini API key before real API work.', 'Do not install unofficial Nano Banana wrapper clients without review.'],
      diagnostics: [
        `catalog=${externalToolbox.catalogExists ? 'present' : 'missing'}`,
        'localInstaller=not_applicable',
      ],
      safety: 'Image generation can create or edit visual assets without per-tool permission popups, but account actions, paid API use, uploads of private client material, and publishing need explicit confirmation or handoff.',
      notes: 'Nano Banana is best treated as a web/API capability for room restyling, material previews, and image-editing workflows, not as a local CAD program.',
    },
    {
      id: 'collaboration.lap',
      label: 'LAP Inter-Lumi Collaboration',
      category: 'collaboration',
      status: 'available',
      actions: ['lap.handshake', 'lap.task.delegate', 'lap.task.result', 'lap.context.share', 'lap.revoke'],
      surfaces: ['community Lumi', 'organization workspaces', 'remote peers'],
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
        'externalAutomationGate=removed',
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
    const availableSet = new Set(mcpManager.getAvailableServers());
    const health = mcpManager.getServerHealth();
    const enabled = Object.values(config).filter((item: any) => item?.enabled).length;
    const brokenSkills = local.filter((skill: any) => skill?.broken);
    const unhealthyNames = Object.entries(health)
      .filter(([, item]) => ['crashed', 'failed', 'restarting'].includes(item.status))
      .map(([name]) => name);
    const unavailableEnabledNames = Object.entries(config)
      .filter(([name, item]: [string, any]) => item?.enabled && !availableSet.has(name))
      .map(([name]) => name);
    const issueNames = Array.from(new Set([
      ...brokenSkills.map((skill: any) => String(skill.name || 'unknown')),
      ...unhealthyNames,
      ...unavailableEnabledNames,
    ])).filter(Boolean);

    return {
      total: local.length,
      connected: connected.length,
      enabled,
      broken: brokenSkills.length,
      unhealthy: unhealthyNames.length,
      unavailableEnabled: unavailableEnabledNames.length,
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
      unavailableEnabled: 0,
      connectedNames: [],
      issueNames: [String(error?.message || error || 'mcp inspection failed')],
    };
  }
}
