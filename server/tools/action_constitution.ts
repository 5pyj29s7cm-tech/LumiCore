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
const SOCIAL_CONTENT_COMMIT_PATTERN =
  /(?:^|[_\W])(?:send|post|publish|comment|reply|share|dm|message)(?:$|[_\W])|(?:\u53d1\u9001|\u53d1\u5e03|\u53d1\u8868|\u8bc4\u8bba|\u56de\u590d|\u5206\u4eab|\u79c1\u4fe1|\u7559\u8a00)/i;
const CONTENT_SUBMIT_PATTERN =
  /\bsubmit\b.{0,40}\b(?:comment|reply|message|post|video|content|draft|text)\b|\b(?:comment|reply|message|post|video|content|draft|text)\b.{0,40}\bsubmit\b|(?:\u63d0\u4ea4|\u53d1\u9001).{0,16}(?:\u8bc4\u8bba|\u56de\u590d|\u7559\u8a00|\u89c6\u9891|\u5185\u5bb9|\u6587\u6848)/i;
const GENERIC_EXTERNAL_COMMIT_PATTERN = /\b(?:submit|confirm|approve|authorize|sign|file)\b|(?:\u63d0\u4ea4|\u786e\u8ba4|\u6388\u6743|\u7b7e\u7f72|\u7acb\u6848)/i;
const HIGH_CONSEQUENCE_EXTERNAL_PATTERN =
  /\b(?:purchase|buy|transfer|pay|payment|checkout|bank|wire|charge|refund|withdraw|deposit|ad\s*spend|ads?|inventory|price|legal\s*filing|court\s*filing|file\s+case|lawsuit|signature|contract\s*execute|place\s+(?:a\s+)?(?:trade|order)|submit\s+(?:a\s+)?(?:trade|order)|cancel\s+(?:a\s+)?order|buy\s+order|sell\s+order|real\s+(?:trade|trading|order)|brokerage\s+(?:trade|order)|trading\s+password)\b|(?:\u4ed8\u6b3e|\u652f\u4ed8|\u8f6c\u8d26|\u8d2d\u4e70|\u4e0b\u5355|\u7ed3\u8d26|\u94f6\u884c|\u8ba2\u5355|\u6295\u653e|\u5e7f\u544a\u8d39|\u6539\u4ef7|\u4ef7\u683c|\u5e93\u5b58|\u7acb\u6848|\u8d77\u8bc9|\u5ead\u5ba1|\u6cd5\u9662|\u7b7e\u7f72|\u5408\u540c\u751f\u6548|\u4e70\u5165|\u5356\u51fa|\u59d4\u6258|\u64a4\u5355|\u6210\u4ea4\u786e\u8ba4|\u4ea4\u6613\u5bc6\u7801|\u5238\u5546\u4ea4\u6613|\u94f6\u8bc1\u8f6c\u8d26|\u5b9e\u76d8|\u771f\u5b9e\u4e0b\u5355|\u80a1\u7968\u4e0b\u5355)/i;
const ACCOUNT_SECURITY_PATTERN =
  /\b(?:login|log\s*in|sign\s*in|password|passkey|otp|2fa|mfa|captcha|qr|authorize|authorization|account\s*switch|switch\s*account|credential|secret|api\s*key)\b|(?:\u767b\u5f55|\u767b\u5165|\u5bc6\u7801|\u9a8c\u8bc1\u7801|\u4e8c\u6b21\u9a8c\u8bc1|\u626b\u7801|\u4eba\u673a\u9a8c\u8bc1|\u6388\u6743|\u5207\u6362\u8d26\u53f7|\u51ed\u636e|\u5bc6\u94a5)/i;
const PACKAGE_INSTALL_PATTERN = /\b(npm|pnpm|yarn|bun|pip|pip3|uv|cargo|go|gem|winget|choco|scoop|brew)\s+(?:i|install|add|update|upgrade|remove|uninstall|audit\s+fix)\b/i;
const GIT_MUTATION_PATTERN = /\bgit\s+(?:commit|push|tag|merge|rebase|reset|checkout|clean|branch\s+-d|branch\s+-D)\b/i;
const SHELL_DOWNLOAD_EXEC_PATTERN = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[\s\S]*(?:\||;|&&)\s*(?:sh|bash|powershell|pwsh|iex|invoke-expression)\b/i;
const TRUSTED_EXPLICIT_LOCAL_WRITE_TOOL_RE =
  /^(write_file|create_(?:docx|pdf|ppt|pptx|xlsx|txt|markdown|md)|transcribe_audio_to_text_file|cad_generate_dxf|document_|export_|save_)/i;

export function getActionConstitutionPolicy(): ActionConstitutionPolicy {
  return {
    destructivePatterns: ['rm -rf', 'format', 'shutdown', 'reg delete', 'drop table', 'delete from'],
    confirmationDomains: ['local_write', 'desktop_control', 'external_app', 'messaging', 'system', 'destructive'],
    rules: [
      'Observation, reading, search, and analysis tools may run automatically when tool policy allows them.',
      'Low- and medium-risk desktop control, browser/external app preparation, and clipboard handoff may run under the active chat/assistant/autonomy tool policy without a per-step prompt.',
      'User-present foreground social/content commits such as ordinary messages, comments, replies, and non-commercial posts may run without a separate confirmation popup when the user asked for that action.',
      'Market watch actions such as stock quotes, watchlists, alerts, K-line/news/sector checks, risk plans, and paper trading are observational or simulated and may run when tools are allowed.',
      'Local writes and file generation may run automatically only when the current turn explicitly requests a local deliverable or a narrower trusted policy exists.',
      'Payments, purchases, transfers, real brokerage orders, buy/sell/cancel-order clicks, order/price/inventory/ad-spend changes, account-security transitions, legal filings/signatures, system commands, installs, package changes, git mutations, and destructive actions require confirmation or are forbidden.',
      'Background autonomous work must run under semi or full autonomy and still obey high-consequence and destructive-action boundaries.',
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
  const actionText = buildActionText(toolName, args);
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

  if (isHighConsequenceExternalCommit(actionText, toolName) && isExternalStateChangingDomain(domain)) {
    return confirm(domain, `High-consequence ${domain} action requires explicit user confirmation`);
  }

  if (isSocialContentCommit(actionText, toolName) && isExternalStateChangingDomain(domain)) {
    if (canRunSupervisedExternalCommit(context)) {
      return allow(domain, 'User-present foreground social/content commit allowed by active execution policy');
    }
    return confirm(domain, 'Social/content external commits require supervised foreground execution or an explicit relaxed messaging policy');
  }

  if (
    GENERIC_EXTERNAL_COMMIT_PATTERN.test(actionText) &&
    !isSocialContentCommit(actionText, toolName) &&
    isExternalStateChangingDomain(domain)
  ) {
    return confirm(domain, `Ambiguous external ${domain} commit requires user confirmation`);
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
  const actionText = buildActionText(toolName, args);
  const externalStateChanging = isExternalStateChangingDomain(domain);

  if (domain === 'destructive' || DESTRUCTIVE_ARG_PATTERN.test(argText)) return 'high';
  if (name.includes('install') || name.includes('uninstall') || name.includes('delete') || name.includes('remove')) return 'high';
  if (GIT_MUTATION_PATTERN.test(argText) || PACKAGE_INSTALL_PATTERN.test(argText) || SHELL_DOWNLOAD_EXEC_PATTERN.test(argText)) return 'high';
  if (externalStateChanging && isHighConsequenceExternalCommit(actionText, toolName)) return 'high';
  if (externalStateChanging && GENERIC_EXTERNAL_COMMIT_PATTERN.test(actionText) && !isSocialContentCommit(actionText, toolName)) return 'high';
  if (externalStateChanging && isSocialContentCommit(actionText, toolName)) return 'medium';
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

function allow(domain: ActionDomain, reason: string): ActionConstitutionDecision {
  return {
    level: 'safe',
    domain,
    reason,
    requiresUserConfirmation: false,
  };
}

function buildActionText(toolName: string, args: Record<string, any> = {}): string {
  return `${toolName} ${JSON.stringify(args || {})}`.toLowerCase();
}

function isExternalStateChangingDomain(domain: ActionDomain): boolean {
  return domain === 'messaging' || domain === 'external_app' || domain === 'desktop_control';
}

function isSocialContentCommit(actionText: string, toolName = ''): boolean {
  if (isPreparationOnlyAction(toolName)) return false;
  return SOCIAL_CONTENT_COMMIT_PATTERN.test(actionText) || CONTENT_SUBMIT_PATTERN.test(actionText);
}

function isHighConsequenceExternalCommit(actionText: string, toolName = ''): boolean {
  if (HIGH_CONSEQUENCE_EXTERNAL_PATTERN.test(actionText) || ACCOUNT_SECURITY_PATTERN.test(actionText)) return true;
  return GENERIC_EXTERNAL_COMMIT_PATTERN.test(actionText) && !isSocialContentCommit(actionText, toolName);
}

function isPreparationOnlyAction(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name.includes('prepare') ||
    name.includes('draft') ||
    name.includes('copy') ||
    name.includes('intake') ||
    name.includes('analyze');
}

function canRunSupervisedExternalCommit(context?: ToolContext): boolean {
  if (!context) return false;
  if (context?.supervisedExternalCommits === true) return true;
  if (context?.autonomous === true) return false;
  const source = String(context?.source || '').toLowerCase();
  if (['chat', 'voice', 'task', 'chat_preflight', 'chat_chainer', 'quick_command'].includes(source)) return true;
  if (source.startsWith('chat_') || source.startsWith('voice_')) return true;
  return isMessagingSendConfirmationRequired() === false;
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
