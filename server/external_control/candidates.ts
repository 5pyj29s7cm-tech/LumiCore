import type { MCPServerConfig } from '../mcp/client';

export type ExternalControlLayer = 'browser' | 'desktop_ui' | 'desktop_vision' | 'safety';

export interface ExternalControlCandidate {
  id: string;
  label: string;
  layer: ExternalControlLayer;
  status: 'ready' | 'requires_setup' | 'planned';
  actions: string[];
  industries: string[];
  surfaces: string[];
  safety: string;
  notes: string;
  setup: string[];
  mcp?: {
    serverName: string;
    config: MCPServerConfig;
  };
}

const PLAYWRIGHT_MCP: ExternalControlCandidate = {
  id: 'playwright-mcp',
  label: 'Playwright MCP structured browser control',
  layer: 'browser',
  status: 'requires_setup',
  actions: ['external_control_configure_candidate', 'browser_open_task', 'web_login_learn_site', 'web_login_run'],
  industries: ['ecommerce', 'short_video', 'account_management', 'legal', 'design_delivery', 'general_work'],
  surfaces: ['browser DOM', 'logged-in web apps', 'store backends', 'creator centers', 'web forms'],
  safety: 'Use for visible browser automation and authenticated sessions. Publishing, purchases, payments, account switching, and final submissions still require confirmation.',
  notes: 'Best first upgrade for Lumi browser work because it can expose structured page state instead of relying only on screenshots and coordinates.',
  setup: ['Configure the MCP server, then restart it from the MCP settings or with client_repair_skill.'],
  mcp: {
    serverName: 'playwright',
    config: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      enabled: false,
      source: 'external',
      transport: 'stdio',
      description: 'Playwright MCP structured browser automation for real websites and authenticated browser tasks.',
    },
  },
};

const WINDOWS_UIA: ExternalControlCandidate = {
  id: 'windows-uia-snapshot',
  label: 'Windows UI Automation snapshot',
  layer: 'desktop_ui',
  status: process.platform === 'win32' ? 'ready' : 'requires_setup',
  actions: ['desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'desktop_active_window', 'desktop_capture_screen', 'desktop_mouse_click_at', 'desktop_keyboard_type'],
  industries: ['ecommerce', 'short_video', 'account_management', 'legal', 'design_delivery', 'general_work'],
  surfaces: ['native Windows apps', 'WPS/Office', 'WeChat', 'CAD/Revit launchers', 'installers', 'dialogs'],
  safety: 'Read-only UI tree inspection is safe. Clicking, typing, sending, publishing, submitting, payment, and destructive app actions remain confirmation-gated.',
  notes: 'Gives Lumi a structured control tree and direct UIA action path for the active window so she can identify, focus, invoke, click, and type into real buttons, fields, menus, and dialogs before falling back to raw mouse/keyboard.',
  setup: process.platform === 'win32'
    ? []
    : ['Windows UI Automation is only available on Windows desktop hosts.'],
};

const DESKTOP_VISION_LOOP: ExternalControlCandidate = {
  id: 'vision-computer-use-loop',
  label: 'Vision computer-use loop',
  layer: 'desktop_vision',
  status: 'ready',
  actions: ['computer_use', 'desktop_capture_screen', 'desktop_cursor_glow_show', 'desktop_mouse_click_at', 'desktop_keyboard_type'],
  industries: ['ecommerce', 'short_video', 'account_management', 'legal', 'design_delivery', 'general_work'],
  surfaces: ['screen pixels', 'desktop cursor', 'apps without accessibility metadata'],
  safety: 'Use only after confirmation for visible desktop work. Verify after each step and prefer UIA or browser DOM when available.',
  notes: 'Fallback route for apps with weak accessibility trees or graphics-heavy surfaces. It remains less stable than UIA or Playwright MCP.',
  setup: ['Configure a vision-capable model before claiming reliable computer-use execution.'],
};

const THIRD_PARTY_MCP_SAFETY: ExternalControlCandidate = {
  id: 'third-party-mcp-safety-gate',
  label: 'Third-party MCP safety gate',
  layer: 'safety',
  status: 'planned',
  actions: ['external_control_candidates', 'adapter_health_check', 'capability_research'],
  industries: ['all'],
  surfaces: ['MCP config', 'third-party tool servers', 'external credentials'],
  safety: 'Review source, command, permissions, network/file access, and credential requirements before enabling third-party MCP servers.',
  notes: 'This is the policy layer that prevents Lumi from turning random GitHub repos into trusted account/file/desktop tools.',
  setup: ['Add scanners and allowlists before enabling broad third-party MCP installation.'],
};

export const EXTERNAL_CONTROL_CANDIDATES: ExternalControlCandidate[] = [
  PLAYWRIGHT_MCP,
  WINDOWS_UIA,
  DESKTOP_VISION_LOOP,
  THIRD_PARTY_MCP_SAFETY,
];

export function listExternalControlCandidates(filters: { layer?: string; industry?: string } = {}): ExternalControlCandidate[] {
  const layer = String(filters.layer || '').trim();
  const industry = String(filters.industry || '').trim().toLowerCase();
  return EXTERNAL_CONTROL_CANDIDATES.filter(candidate => (
    (!layer || candidate.layer === layer) &&
    (!industry || candidate.industries.includes('all') || candidate.industries.some(item => item.toLowerCase() === industry))
  ));
}

export function getExternalControlCandidate(id: string): ExternalControlCandidate | undefined {
  const normalized = String(id || '').trim().toLowerCase();
  return EXTERNAL_CONTROL_CANDIDATES.find(candidate => candidate.id === normalized);
}
