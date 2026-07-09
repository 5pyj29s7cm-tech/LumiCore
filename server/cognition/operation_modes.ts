/**
 * Operation modes describe how much autonomy Lumi has.
 * Desktop control, terminal commands, tools, skills, teams, and sub-agents are
 * execution capabilities selected inside assistant/auto mode, not top-level modes.
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

export const OPERATION_MODE_CONFIGS: Record<OperationMode, OperationModeConfig> = {
  chat: {
    id: 'chat',
    label: 'Chat',
    labelCN: 'Chat',
    description: 'Conversation-first. Lumi answers naturally by default, but explicit user commands can still use tools because chat is an entrance into the same local Lumi.',
    promptOverlay: 'This is conversation-first chat mode. If the user is only talking or asking a question, answer naturally and do not call tools. If this turn was routed here because the user gave an explicit actionable command, first provide a concise action guide unless the task is trivial, then use the appropriate tools and client actions while respecting confirmation boundaries. If the work surface is ambiguous, ask whether to work in chat, tools, or directly on the desktop. Do not pretend you acted without tool evidence.',
    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [
        'desktop_run_command',
        'run_command',
        'write_file',
        'file_delete',
        'delete_file',
        'rm',
        'unlink',
        'format',
        'rmdir',
        'uninstall',
      ],
      forbiddenTools: [],
      maxIterations: 12,
    },
  },

  assistant: {
    id: 'assistant',
    label: 'Assistant',
    labelCN: 'Assistant',
    description: 'Guided assistance. Lumi can use desktop, terminal, tools, skills, and teams when the request asks for action.',
    promptOverlay: [
      'You are in assistant mode.',
      'Before handling a non-trivial task, give the user a concise action guide: where you will work (chat, tools, run logs, or desktop), what you will do first, and what needs confirmation.',
      'If the user did not specify a work surface and the choice matters, ask one short question instead of guessing.',
      'Choose the least disruptive execution capability for the user request: normal reply, tool, skill, file action, terminal command, mouse/keyboard desktop control, team/sub-agent, or run log inspection.',
      'Open the run log only when the user asks for logs or when debugging client/runtime failures.',
      'For visible desktop work, explain what you are about to do, inspect the screen/active window, show and move the cursor before clicks when available, use wallpaper mode for immersive confirmed sessions, and verify the result.',
      'For command/file/network actions, keep the user informed and respect confirmations.',
      'For supervised foreground work, ordinary user-requested messages, comments, replies, and non-commercial content posts can proceed; payments, purchases, transfers, account-security transitions, legal filings/signatures, ambiguous submits, and destructive/system actions still require confirmation.',
      'Stock watch, quote checks, watchlists, alerts, trading plans, and paper trading can run as observational/simulated work; real brokerage orders, cancel-orders, trading passwords, and fund transfers require confirmation.',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [
        'desktop_run_command',
        'run_command',
        'write_file',
      ],
      forbiddenTools: [],
      maxIterations: 25,
    },
  },

  autonomous: {
    id: 'autonomous',
    label: 'Autonomy',
    labelCN: '自主',
    description: 'Multi-step autonomous work. Lumi gives an action guide, then plans, uses tools, operates the desktop, opens run logs when useful, and coordinates agents with visible progress.',
    promptOverlay: [
      'You are in autonomy mode.',
      'Start with a concise action guide before running a multi-step task: route, major steps, expected outputs, and confirmation points.',
      'If the work surface is unclear, ask whether to use chat tools, run logs, or direct desktop control before proceeding.',
      'Work through the task end-to-end when the user gives an actionable request.',
      'Use the appropriate capabilities: desktop mouse/keyboard, terminal, files, skills, tools, MCP, run logs, team agents, and sub-agents.',
      'For visible desktop work, keep the user oriented: name the task, show/move the cursor before clicks when available, verify results, and report exact blockers.',
      'Keep progress visible, summarize major steps, and do not hide failures.',
      'Dangerous or destructive actions still require confirmation.',
      'Foreground social/content commits requested by the user can run with visible progress; high-consequence commits such as payment, purchase, transfer, account-security, legal filing/signature, ambiguous submit, and destructive/system changes still require confirmation.',
      'Market watch and paper-trading loops may continue with visible progress; real-money brokerage actions still stop for explicit confirmation.',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [
        'file_delete',
        'delete_file',
        'rm',
        'unlink',
        'format',
        'rmdir',
        'uninstall',
        'desktop_run_command',
      ],
      forbiddenTools: [],
      securityOverrides: {
        desktop_run_command: 'safe',
        run_command: 'safe',
        write_file: 'safe',
      },
      maxIterations: 50,
    },
  },

  meeting: {
    id: 'meeting',
    label: 'Meeting',
    labelCN: '会议',
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
