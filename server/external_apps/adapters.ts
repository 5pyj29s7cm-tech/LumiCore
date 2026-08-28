import { getAdapterRegistry, AdapterCapability } from '../adapters/registry';

export type ExternalAppAdapterId = 'browser' | 'wechat' | 'cad' | 'ai_apps';

export interface ExternalAppAdapter {
  id: ExternalAppAdapterId;
  label: string;
  status: 'ready' | 'draft_only' | 'requires_setup';
  actions: string[];
  safety: string;
  notes: string;
}

const LEGACY_ADAPTER_IDS: Record<ExternalAppAdapterId, string> = {
  browser: 'web.browser',
  wechat: 'messaging.wechat_feishu',
  cad: 'cad_bim.drafting',
  ai_apps: 'ai.external_agents',
};

const FALLBACK_EXTERNAL_APP_ADAPTERS: ExternalAppAdapter[] = [
  {
    id: 'browser',
    label: 'Browser and web work',
    status: 'ready',
    actions: ['browser_open_task', 'web_search', 'url_fetch', 'web_login_site_presets', 'web_login_profile_save_from_preset', 'web_login_profile_save', 'web_login_learn_site', 'web_login_profile_list', 'web_login_run', 'url_fetch_logged_in', 'external_control_candidates', 'external_control_configure_candidate', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_fill_form', 'mcp_playwright_browser_click'],
    safety: 'Opening a URL, reading pages, and reusing saved/authorized browser login sessions are allowed; first-time login, credential storage, account switching, purchases, payments, legal/business final submissions, and ambiguous submissions still need confirmation.',
    notes: 'Use this adapter for research, opening project pages, continuing work in saved browser sessions, running authorized login profiles, authenticated fetches, and configuring Playwright MCP for structured browser control.',
  },
  {
    id: 'wechat',
    label: 'WeChat and messaging',
    status: 'draft_only',
    actions: ['wechat_intake_analyze', 'wechat_intake_from_clipboard', 'work_takeover_task_from_wechat', 'work_takeover_task_from_clipboard', 'wechat_prepare_reply', 'wechat_copy_reply_draft', 'wechat_desktop_watch_status', 'wechat_desktop_watch_update', 'wechat_desktop_watch_scan', 'wechat_desktop_watch_approve_reply'],
    safety: 'Lumi can prepare and copy a reply draft. Sending messages must stay user-confirmed.',
    notes: 'Lumi can triage WeChat messages into persistent work takeover tasks, watch the native desktop WeChat window for accessible unread indicators, inspect a verified contact only after the user is idle, prepare next actions and drafts, and keep every external send confirmation-gated.',
  },
  {
    id: 'cad',
    label: 'CAD drafting',
    status: 'draft_only',
    actions: ['floorplan_extract_geometry', 'ocr_image_file', 'cad_generate_dxf'],
    safety: 'Lumi generates DXF draft files first. Opening CAD or modifying production drawings needs confirmation.',
    notes: 'Good for image-to-CAD extraction, structured floor-plan drafts, simple outlines, layout sketches, and handoff files. Exact production drawings still need confirmed scale and review.',
  },
  {
    id: 'ai_apps',
    label: 'Other local AI tools',
    status: 'requires_setup',
    actions: ['external_app_list_adapters', 'external_control_candidates', 'desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'capability_research', 'computer_use'],
    safety: 'Use explicit tool or MCP integrations when available. Full UI control needs desktop automation confirmation.',
    notes: 'Lumi can research integration candidates, inspect and operate native app controls through the shared Windows UIA/macOS Accessibility contract, then coordinate other AI tools through browser, files, clipboard, MCP, or confirmed computer-use sessions.',
  },
];

export function getExternalAppAdapters(): ExternalAppAdapter[] {
  const registry = getAdapterRegistry({ includePlanned: false });
  return (Object.entries(LEGACY_ADAPTER_IDS) as Array<[ExternalAppAdapterId, string]>)
    .map(([legacyId, registryId]) => {
      const adapter = registry.adapters.find(item => item.id === registryId);
      if (!adapter) return FALLBACK_EXTERNAL_APP_ADAPTERS.find(item => item.id === legacyId);
      return toExternalAppAdapter(legacyId, adapter);
    })
    .filter(Boolean) as ExternalAppAdapter[];
}

function toExternalAppAdapter(id: ExternalAppAdapterId, adapter: AdapterCapability): ExternalAppAdapter {
  return {
    id,
    label: adapter.label,
    status: toLegacyStatus(adapter),
    actions: adapter.actions,
    safety: adapter.safety || 'Use explicit Lumi tools and ask for confirmation before external side effects.',
    notes: adapter.notes || '',
  };
}

function toLegacyStatus(adapter: AdapterCapability): ExternalAppAdapter['status'] {
  if (adapter.status === 'draft_only') return 'draft_only';
  if (adapter.status === 'requires_setup' || adapter.status === 'blocked' || adapter.status === 'planned') return 'requires_setup';
  return 'ready';
}
