import { getGateConfig, isMessagingSendConfirmationRequired } from '../autonomy/safety_gate';
import type { SecurityLevel, ToolContext } from './types';

export type ActionDomain = 'observe' | 'draft' | 'local_write' | 'desktop_control' | 'external_app' | 'messaging' | 'system' | 'network' | 'destructive';
export type ActionRisk = 'low' | 'medium' | 'high';

export interface ActionConstitutionDecision {
  level: SecurityLevel;
  domain: ActionDomain;
  reason: string;
  requiresUserConfirmation: boolean;
}

export interface ActionConstitutionPolicy {
  rules: string[];
  destructivePatterns: string[];
  confirmationDomains: ActionDomain[];
}

const DESTRUCTIVE_ARG_PATTERN = /\b(rm\s+-rf|del\s+\/[sqf]|format\b|shutdown\b|reboot\b|reg\s+delete|erase\b|remove-item\b.*-recurse|drop\s+table|delete\s+from|mkfs\b|diskpart\b|cipher\s+\/w|docker\s+system\s+prune)\b/i;
const EXTERNAL_COMMIT_PATTERN = /(send|post|submit|publish|purchase|buy|transfer|pay|checkout)|付款|支付|转账|购买|下单|提交|发布|发送/i;
const PACKAGE_INSTALL_PATTERN = /\b(npm|pnpm|yarn|bun|pip|pip3|uv|cargo|go|gem|winget|choco|scoop|brew)\s+(?:i|install|add|update|upgrade|remove|uninstall|audit\s+fix)\b/i;
const GIT_MUTATION_PATTERN = /\bgit\s+(?:commit|push|tag|merge|rebase|reset|checkout|clean|branch\s+-d|branch\s+-D)\b/i;
const SHELL_DOWNLOAD_EXEC_PATTERN = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[\s\S]*(?:\||;|&&)\s*(?:sh|bash|powershell|pwsh|iex|invoke-expression)\b/i;
const EXTERNAL_SEND_TARGET_PATTERN = /\b(?:wechat|weixin|wecom|feishu|lark|slack|telegram|whatsapp|mail|email|gmail|outlook|browser|chrome|edge|alipay|paypal|stripe|bank|trading|broker|stock|payment|checkout|订单|付款|支付|转账|微信|企业微信|飞书|浏览器|股票|证券|交易)\b/i;
const TRUSTED_EXPLICIT_LOCAL_WRITE_TOOL_RE =
  /^(write_file|create_(?:docx|pdf|ppt|pptx|xlsx|txt|markdown|md)|transcribe_audio_to_text_file|cad_generate_dxf|document_|export_|save_)/i;

export function getActionConstitutionPolicy(): ActionConstitutionPolicy {
  return {
    destructivePatterns: ['rm -rf', 'format', 'shutdown', 'reg delete', 'drop table', 'delete from'],
    confirmationDomains: ['local_write', 'desktop_control', 'external_app', 'messaging', 'system', 'destructive'],
    rules: [
      'Observation, reading, search, and analysis tools may run automatically when tool policy allows them.',
      'Low- and medium-risk desktop control, browser/external app preparation, and clipboard handoff may run under the active chat/assistant/autonomy tool policy without a per-step prompt.',
      'Local writes and file generation may run automatically only when the current turn explicitly requests a local deliverable or a narrower trusted policy exists.',
      'System commands, installs, package changes, git mutations, and high-risk external actions require confirmation.',
      'Messaging send/post/submit/purchase/payment actions require confirmation.',
      'Destructive commands are forbidden unless implemented as an explicitly confirmed safe tool.',
      'Autonomous background work must run under semi or full autonomy and still obey messaging, destructive-action, and tool risk boundaries.',
      'Lumi should prefer explicit client actions and adapters over raw mouse/keyboard control.',
    ],
  };
}

export function evaluateActionConstitution(
  toolName: string,
  args: Record<string, any>,
  currentLevel: SecurityLevel,
  context?: ToolContext,
): ActionConstitutionDecision {
  const domain = classifyAction(toolName, args);
  const argText = JSON.stringify(args || {});
  const actionText = `${toolName} ${argText}`;
  const risk = classifyActionRisk(toolName, args);

  const sensitiveClientAction = getSensitiveClientAction(args);
  if (toolName === 'client_action' && sensitiveClientAction) {
    return confirm('desktop_control', `Sensitive client action "${sensitiveClientAction}" requires user confirmation`);
  }

  if (domain === 'destructive' || DESTRUCTIVE_ARG_PATTERN.test(argText)) {
    return {
      level: 'forbidden',
      domain: 'destructive',
      reason: 'Action Constitution forbids destructive system/file/database operations through generic tools',
      requiresUserConfirmation: true,
    };
  }

  if (context?.autonomous === true) {
    const gate = getGateConfig();
    if (gate.autonomyLevel === 'reactive' || !gate.autoProcessEnabled) {
      return {
        level: 'forbidden',
        domain,
        reason: 'Autonomous work is disabled in reactive mode',
        requiresUserConfirmation: true,
      };
    }
  }

  if (domain === 'messaging' && isMessagingSendConfirmationRequired() && EXTERNAL_COMMIT_PATTERN.test(actionText)) {
    return confirm(domain, 'Messaging actions require user confirmation');
  }

  if (risk === 'high') {
    return confirm(domain, `High-risk ${domain} action requires explicit user confirmation`);
  }

  if (
    domain === 'local_write' &&
    context?.allowLocalFileWrites === true &&
    TRUSTED_EXPLICIT_LOCAL_WRITE_TOOL_RE.test(toolName)
  ) {
    return {
      level: 'safe',
      domain,
      reason: context.localWriteIntentReason || 'Current user turn explicitly requested local file output',
      requiresUserConfirmation: false,
    };
  }

  if (currentLevel === 'safe') {
    if (domain === 'system') {
      return confirm(domain, 'System actions require confirmation by Action Constitution');
    }
    if (domain === 'local_write') {
      return confirm(domain, 'Local write actions require confirmation unless the current turn explicitly requested a local deliverable');
    }
  }

  return {
    level: currentLevel,
    domain,
    reason: 'Action Constitution allows current tool security level',
    requiresUserConfirmation: currentLevel === 'confirm',
  };
}

export function classifyActionRisk(toolName: string, args: Record<string, any> = {}): ActionRisk {
  const domain = classifyAction(toolName, args);
  const name = toolName.toLowerCase();
  const argText = JSON.stringify(args || {}).toLowerCase();
  const actionText = `${name} ${argText}`;

  if (domain === 'destructive' || DESTRUCTIVE_ARG_PATTERN.test(argText)) return 'high';
  if (name.includes('install') || name.includes('uninstall') || name.includes('delete') || name.includes('remove')) return 'high';
  if (GIT_MUTATION_PATTERN.test(argText) || PACKAGE_INSTALL_PATTERN.test(argText) || SHELL_DOWNLOAD_EXEC_PATTERN.test(argText)) return 'high';
  if ((domain === 'messaging' || domain === 'external_app' || domain === 'desktop_control') && EXTERNAL_COMMIT_PATTERN.test(actionText)) return 'high';
  if ((domain === 'external_app' || domain === 'desktop_control') && EXTERNAL_SEND_TARGET_PATTERN.test(argText) && EXTERNAL_COMMIT_PATTERN.test(actionText)) return 'high';
  if (domain === 'system') return 'high';
  if (domain === 'desktop_control' || domain === 'external_app' || domain === 'messaging' || domain === 'local_write') return 'medium';
  return 'low';
}

export function canAutoApproveAction(toolName: string, args: Record<string, any> = {}): boolean {
  const domain = classifyAction(toolName, args);
  const risk = classifyActionRisk(toolName, args);
  if (risk === 'high') return false;
  return !['system', 'destructive'].includes(domain);
}

export function classifyAction(toolName: string, args: Record<string, any> = {}): ActionDomain {
  const name = toolName.toLowerCase();
  const argText = JSON.stringify(args || {}).toLowerCase();

  if (name === 'client_action') return getSensitiveClientAction(args) ? 'desktop_control' : 'observe';
  if (DESTRUCTIVE_ARG_PATTERN.test(argText) || /\b(delete|remove|wipe|format|kill|shutdown|reboot)\b/.test(name)) return 'destructive';
  if (name === 'desktop_system_info' || name === 'desktop_list_files' || name === 'desktop_list_apps' || name === 'desktop_path_info' || name === 'desktop_show_lumi_window' || name === 'desktop_idle_time' || name === 'desktop_poll_activity' || name === 'desktop_active_window' || name === 'get_active_window_info' || name === 'desktop_running_processes' || name === 'desktop_ui_snapshot' || name === 'desktop_capture_screen' || name === 'desktop_clipboard_read') return 'observe';
  if (name.includes('run_command') || name.includes('terminal') || name.includes('shell') || name.includes('code_execution')) return 'system';
  if (name.includes('wechat') || name.includes('feishu') || name.includes('wecom') || name.includes('message')) return 'messaging';
  if (name === 'computer_use' || name.startsWith('desktop_') || name.includes('mouse') || name.includes('keyboard') || name.includes('screenshot')) return 'desktop_control';
  if (name === 'cad_generate_dxf') return 'local_write';
  if (name === 'cad_generate_autocad_draw_script') return args.launchAutoCAD === true ? 'system' : 'local_write';
  if (name === 'cad_run_autocad_draw_script') return 'system';
  if (name.includes('external_app') || name.includes('web_login') || name.includes('logged_in') || name.includes('cad_') || name.includes('browser_open') || name.includes('playwright') || name.includes('browser_')) return 'external_app';
  if (name === 'authority_research') return 'network';
  if (name === 'authority_research_save') return 'local_write';
  if (name.includes('install') || name.includes('generate_skill') || name.includes('capability_gap_autofix')) return 'local_write';
  if (name.includes('write') || name.includes('create_') || name.includes('save') || name.includes('edit') || name.includes('file_ops')) return 'local_write';
  if (name.includes('web_search') || name.includes('url_fetch') || name.includes('search')) return 'network';
  if (name.includes('draft') || name.includes('prepare')) return 'draft';
  return 'observe';
}

function confirm(domain: ActionDomain, reason: string): ActionConstitutionDecision {
  return {
    level: 'confirm',
    domain,
    reason,
    requiresUserConfirmation: true,
  };
}

function getSensitiveClientAction(args: Record<string, any> = {}): string {
  const action = String(args.action || '').trim();
  const mode = String(args.mode || '').trim();
  if (!action) return '';
  if (action === 'start_meeting_mode' || action === 'end_meeting_mode' || action === 'set_wallpaper_mode') return action;
  if ((action === 'set_mode' || action === 'set_client_mode') && (mode === 'meeting' || mode === 'autonomous')) {
    return `${action}:${mode}`;
  }
  return '';
}
