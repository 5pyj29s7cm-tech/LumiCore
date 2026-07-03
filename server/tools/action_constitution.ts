import { getGateConfig, isExternalAppAutomationAllowed, isMessagingSendConfirmationRequired } from '../autonomy/safety_gate';
import type { SecurityLevel, ToolContext } from './types';

export type ActionDomain = 'observe' | 'draft' | 'local_write' | 'desktop_control' | 'external_app' | 'messaging' | 'system' | 'network' | 'destructive';

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

const DESTRUCTIVE_ARG_PATTERN = /\b(rm\s+-rf|del\s+\/[sqf]|format\b|shutdown\b|reboot\b|reg\s+delete|erase\b|remove-item\b.*-recurse|drop\s+table|delete\s+from)\b/i;
const MESSAGE_SEND_PATTERN = /\b(send|post|submit|publish|reply|purchase|buy|transfer|pay)\b/i;

export function getActionConstitutionPolicy(): ActionConstitutionPolicy {
  return {
    destructivePatterns: ['rm -rf', 'format', 'shutdown', 'reg delete', 'drop table', 'delete from'],
    confirmationDomains: ['local_write', 'desktop_control', 'external_app', 'messaging', 'system', 'destructive'],
    rules: [
      'Observation, reading, search, and analysis tools may run automatically when tool policy allows them.',
      'Local writes, file generation, desktop control, browser/external app automation, and system operations require confirmation unless a narrower trusted policy already exists.',
      'Messaging send/post/submit/purchase/payment actions require confirmation.',
      'Destructive commands are forbidden unless implemented as an explicitly confirmed safe tool.',
      'Autonomous background work cannot use external app automation unless the autonomy gate enables it.',
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
    if (!gate.autoProcessEnabled) {
      return {
        level: 'forbidden',
        domain,
        reason: 'Autonomous work is disabled until the user confirms a workflow',
        requiresUserConfirmation: true,
      };
    }
  }

  if ((domain === 'desktop_control' || domain === 'external_app') && context?.autonomous === true && !isExternalAppAutomationAllowed()) {
    return {
      level: 'forbidden',
      domain,
      reason: 'External app automation is disabled for autonomous work',
      requiresUserConfirmation: true,
    };
  }

  if (domain === 'messaging' && (isMessagingSendConfirmationRequired() || MESSAGE_SEND_PATTERN.test(argText))) {
    return confirm(domain, 'Messaging actions require user confirmation');
  }

  if (domain === 'system' || domain === 'desktop_control' || domain === 'external_app' || domain === 'local_write') {
    if (currentLevel === 'safe') {
      return confirm(domain, `${domain} action requires confirmation by Action Constitution`);
    }
  }

  return {
    level: currentLevel,
    domain,
    reason: 'Action Constitution allows current tool security level',
    requiresUserConfirmation: currentLevel === 'confirm',
  };
}

export function classifyAction(toolName: string, args: Record<string, any> = {}): ActionDomain {
  const name = toolName.toLowerCase();
  const argText = JSON.stringify(args || {}).toLowerCase();

  if (name === 'client_action') return getSensitiveClientAction(args) ? 'desktop_control' : 'observe';
  if (DESTRUCTIVE_ARG_PATTERN.test(argText) || /\b(delete|remove|wipe|format|kill|shutdown|reboot)\b/.test(name)) return 'destructive';
  if (name === 'desktop_system_info' || name === 'desktop_list_files' || name === 'desktop_path_info' || name === 'desktop_active_window' || name === 'desktop_running_processes' || name === 'desktop_ui_snapshot') return 'observe';
  if (name.includes('wechat') || name.includes('feishu') || name.includes('wecom') || name.includes('message')) return 'messaging';
  if (name === 'computer_use' || name.startsWith('desktop_') || name.includes('mouse') || name.includes('keyboard') || name.includes('screenshot')) return 'desktop_control';
  if (name.includes('external_app') || name.includes('web_login') || name.includes('logged_in') || name.includes('cad_') || name.includes('browser_open')) return 'external_app';
  if (name === 'authority_research') return 'network';
  if (name === 'authority_research_save') return 'local_write';
  if (name.includes('write') || name.includes('create_') || name.includes('save') || name.includes('edit') || name.includes('file_ops')) return 'local_write';
  if (name.includes('run_command') || name.includes('terminal') || name.includes('shell') || name.includes('code_execution')) return 'system';
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
