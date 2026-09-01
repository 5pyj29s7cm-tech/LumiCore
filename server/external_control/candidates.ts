import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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

const PLAYWRIGHT_MCP_VERSION = '0.0.79';
const PLAYWRIGHT_MCP_CLI_SHA256 = '70dab09ab9a5bc1943fb78e2655f00af7349f9931073833919f19c5d7d786ad6';

function resolvePinnedPlaywrightMcpRuntime(): { cliPath: string; packageDirectory: string } | null {
  try {
    const localRequire = createRequire(import.meta.url);
    const packageJsonPath = localRequire.resolve('@playwright/mcp/package.json');
    const packageDirectory = fs.realpathSync(path.dirname(packageJsonPath));
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (packageJson.version !== PLAYWRIGHT_MCP_VERSION || packageJson.bin?.['playwright-mcp'] !== 'cli.js') return null;
    const cliPath = fs.realpathSync(path.join(packageDirectory, 'cli.js'));
    const relativeCli = path.relative(packageDirectory, cliPath);
    if (!relativeCli || relativeCli.startsWith('..') || path.isAbsolute(relativeCli)) return null;
    const cliDigest = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
    if (cliDigest !== PLAYWRIGHT_MCP_CLI_SHA256) return null;
    return { cliPath, packageDirectory };
  } catch {
    return null;
  }
}

const PINNED_PLAYWRIGHT_MCP = resolvePinnedPlaywrightMcpRuntime();

const PLAYWRIGHT_MCP: ExternalControlCandidate = {
  id: 'playwright-mcp',
  label: 'Playwright MCP structured browser control',
  layer: 'browser',
  status: PINNED_PLAYWRIGHT_MCP ? 'requires_setup' : 'planned',
  actions: ['external_control_configure_candidate', 'browser_open_task', 'web_login_learn_site', 'web_login_run'],
  industries: ['ecommerce', 'short_video', 'account_management', 'legal', 'design_delivery', 'general_work'],
  surfaces: ['browser DOM', 'logged-in web apps', 'store backends', 'creator centers', 'web forms'],
  safety: 'Use for visible browser automation and authenticated sessions. Publishing, purchases, payments, account switching, and final submissions still require confirmation.',
  notes: 'Best first upgrade for Lumi browser work because it can expose structured page state instead of relying only on screenshots and coordinates.',
  setup: PINNED_PLAYWRIGHT_MCP
    ? ['Configure the pinned local MCP server, then restart it from MCP settings or with client_repair_skill. Browser binaries may require a separate reviewed setup.']
    : ['The pinned bundled @playwright/mcp runtime is missing or failed integrity verification. Reinstall LumiCore dependencies before enabling it.'],
  ...(PINNED_PLAYWRIGHT_MCP ? { mcp: {
    serverName: 'playwright',
    config: {
      command: process.execPath,
      args: [PINNED_PLAYWRIGHT_MCP.cliPath],
      cwd: PINNED_PLAYWRIGHT_MCP.packageDirectory,
      enabled: false,
      source: 'external',
      transport: 'stdio',
      description: `Pinned @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} structured browser automation for real websites and authenticated browser tasks.`,
    },
  } } : {}),
};

const NATIVE_ACCESSIBILITY: ExternalControlCandidate = {
  id: 'native-accessibility',
  label: 'Native semantic accessibility control',
  layer: 'desktop_ui',
  status: process.platform === 'win32' || process.platform === 'darwin' ? 'ready' : 'requires_setup',
  actions: ['desktop_ui_snapshot', 'desktop_ui_focus', 'desktop_ui_click', 'desktop_ui_invoke', 'desktop_ui_type', 'desktop_active_window', 'desktop_capture_screen', 'desktop_mouse_click_at', 'desktop_keyboard_type'],
  industries: ['ecommerce', 'short_video', 'account_management', 'legal', 'design_delivery', 'general_work'],
  surfaces: ['native Windows/macOS apps', 'office suites', 'messaging apps', 'CAD/BIM launchers', 'installers', 'dialogs'],
  safety: 'Read-only UI tree inspection is safe. Clicking, typing, sending, publishing, submitting, payment, and destructive app actions remain confirmation-gated.',
  notes: 'Gives Lumi one structured native-control contract backed by Windows UIA or macOS Accessibility, so it can identify, focus, invoke, click, and type before falling back to raw mouse/keyboard.',
  setup: process.platform === 'win32'
    ? []
    : process.platform === 'darwin'
      ? ['Grant LumiCore Accessibility permission in System Settings > Privacy & Security > Accessibility.']
      : ['Native semantic accessibility control is available on Windows and macOS desktop hosts.'],
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
  NATIVE_ACCESSIBILITY,
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
