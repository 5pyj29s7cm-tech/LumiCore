/**
 * Operation modes describe Lumi's execution posture.
 * The desktop presents three permission tiers:
 * - chat: conversation only
 * - assistant: foreground helper with full local/tool/desktop permissions
 * - autonomous: assistant permissions plus long-running 24h background autonomy
 *
 * Meeting is a voice capture surface, not a fourth permission tier.
 */
import { ToolPolicy } from '../personality/types';

export type OperationMode = 'chat' | 'assistant' | 'autonomous' | 'meeting';

export interface OperationModeConfig {
  id: OperationMode;
  label: string;
  labelCN: string;
  description: string;
  promptOverlay: string;
  toolPolicy: ToolPolicy;
}

const HIGH_PERMISSION_OVERRIDES: NonNullable<ToolPolicy['securityOverrides']> = {
  desktop_run_command: 'safe',
  run_command: 'safe',
  write_file: 'safe',
  create_docx: 'safe',
  create_pdf: 'safe',
  create_ppt: 'safe',
  create_xlsx: 'safe',
  cad_generate_autocad_draw_script: 'safe',
  cad_run_autocad_draw_script: 'safe',
  'mcp_cad-drafting_autocad_playback_file': 'safe',
};

export const OPERATION_MODE_CONFIGS: Record<OperationMode, OperationModeConfig> = {
  chat: {
    id: 'chat',
    label: 'Chat',
    labelCN: 'Chat',
    description: 'Pure conversation. Lumi answers, thinks, explains, and may suggest or switch into a higher mode when action is needed, but does not operate tools, apps, files, commands, desktop control, teams, or background work from chat mode.',
    promptOverlay: [
      'You are in chat mode.',
      'This mode is pure conversation: answer, reason, explain, brainstorm, and help the user decide.',
      'Do not call tools, operate the desktop, run commands, write files, open apps, assemble teams, or claim that external work has started.',
      'If the user asks for real action, explain briefly that the task needs Assistant mode for foreground execution or Autonomy mode for long-running work.',
      'You may help the user switch modes when the request is explicitly about Lumi/client mode control, but external execution still waits for the higher mode.',
      'When the task can be answered naturally without tools, just answer.',
    ].join('\n'),
    toolPolicy: {
      allowedTools: [],
      requireConfirmation: [],
      forbiddenTools: ['*'],
      maxIterations: 0,
    },
  },

  assistant: {
    id: 'assistant',
    label: 'Assistant',
    labelCN: 'Assistant',
    description: 'Foreground assisted execution. The user is present; Lumi has the same practical tool, browser, app, desktop, file, skill, and team permissions as Autonomy for requested work, but does not start 24h unattended loops or long background absorption by default.',
    promptOverlay: [
      'You are in assistant mode.',
      'Assistant mode is high-permission foreground work: assume the user is present and wants Lumi to proceed when they ask for action.',
      'Use tools, browser control, saved/authorized login sessions, local files, skills, teams, and visible desktop control as needed without per-tool permission chatter.',
      'Ask one short question only when the missing detail would change the target, recipient, account, file, or outcome. Otherwise continue and verify.',
      'For visible desktop work, inspect the active window/screen, use accessible UI controls when available, use the virtual cursor path for raw clicks when helpful, and verify the result before claiming completion.',
      'Assistant may downshift into pure chat for conversational turns. If a task clearly needs hours of monitoring, background learning, or continuous absorption, switch or ask to switch to Autonomy.',
      'Ordinary user-requested messages, comments, replies, non-commercial posts, local deliverables, CAD/application handoffs, and saved/authorized login session reuse can proceed without a separate tool popup.',
      'Stop for explicit confirmation or handoff only at hard boundaries: payments, purchases, transfers, real brokerage orders, ad spend, price/inventory/order changes, first-time login, QR/OTP/captcha/passkey/security verification, account switching, credential storage, third-party authorization, legal filing/signature/final submission, ambiguous high-consequence submit, destructive actions, installs, package changes, git mutations, or privileged system changes.',
      'Stock watch, quote checks, watchlists, alerts, trading plans, and paper trading can run as observational/simulated work; real brokerage orders, cancel-orders, trading passwords, and fund transfers require confirmation.',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [],
      forbiddenTools: [],
      securityOverrides: HIGH_PERMISSION_OVERRIDES,
      maxIterations: 80,
    },
  },

  autonomous: {
    id: 'autonomous',
    label: 'Autonomy',
    labelCN: 'Autonomy',
    description: 'Long-running autonomous execution. Same foreground permissions as Assistant, plus proactive 24h operation, background queues, monitoring, learning, sorting, absorption, and ultra-long task continuation within safety boundaries.',
    promptOverlay: [
      'You are in autonomy mode.',
      'Autonomy has the same practical permissions as assistant mode, plus permission to keep working across long horizons.',
      'Use background queues, task center state, scheduled/continuous monitoring, memory consolidation, learning, folder sorting, research absorption, and multi-agent work when useful.',
      'Ask proactive questions when a missing fact blocks progress, then continue once answered. Do not stop after one sub-step if a safe next step is available.',
      'For ultra-long tasks, keep durable state, checkpoints, artifacts, blockers, and next actions so Lumi can resume after sleep, restart, or window hiding.',
      'For visible desktop work, keep progress observable, inspect before acting, use the virtual cursor path when helpful, and verify results.',
      'Do not spam permission popups for ordinary tools. Hard boundaries still require confirmation or handoff: payments, purchases, transfers, real brokerage orders, ad spend, price/inventory/order changes, first-time login, QR/OTP/captcha/passkey/security verification, account switching, credential storage, third-party authorization, legal filing/signature/final submission, ambiguous high-consequence submit, destructive actions, installs, package changes, git mutations, or privileged system changes.',
      'Market watch and paper-trading loops may continue; real-money brokerage actions still stop for explicit confirmation.',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [],
      forbiddenTools: [],
      securityOverrides: HIGH_PERMISSION_OVERRIDES,
      maxIterations: 240,
    },
  },

  meeting: {
    id: 'meeting',
    label: 'Meeting',
    labelCN: 'Meeting',
    description: 'Transcription-only meeting notes. Lumi listens and records, but does not answer or execute tools for each utterance.',
    promptOverlay: 'Meeting mode is transcription-only. Record speech as meeting notes. Do not call tools, operate the desktop, speak responses, or treat every utterance as a command.',
    toolPolicy: {
      allowedTools: [],
      requireConfirmation: [],
      forbiddenTools: ['*'],
      maxIterations: 0,
    },
  },
};

export function normalizeOperationMode(mode?: string): OperationMode {
  if (mode === 'chat' || mode === 'assistant' || mode === 'autonomous' || mode === 'meeting') return mode;
  if (mode === 'music') return 'assistant';
  if (mode === 'desktop_control' || mode === 'terminal') return 'assistant';
  return 'assistant';
}

export function parseStoredOperationMode(value: unknown): OperationMode {
  if (typeof value !== 'string') return normalizeOperationMode((value as any)?.mode);
  try {
    const parsed = JSON.parse(value);
    return normalizeOperationMode(parsed?.mode ?? parsed);
  } catch {
    return normalizeOperationMode(value);
  }
}

export function getOperationModeConfig(mode?: string): OperationModeConfig {
  return OPERATION_MODE_CONFIGS[normalizeOperationMode(mode)];
}
