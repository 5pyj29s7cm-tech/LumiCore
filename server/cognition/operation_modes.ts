/**
 * Operation modes describe Lumi's execution posture.
 * The desktop presents three permission tiers:
 * - chat: visible conversation posture; model-owned foreground turns may
 *   borrow the Assistant manifest without persisting a mode change
 * - assistant: foreground helper with full local/tool/desktop permissions
 * - autonomous: assistant permissions plus long-running 24h background autonomy
 *
 * Meeting is a voice capture surface, not a fourth permission tier.
 */
import { ToolPolicy } from '../personality/types';
import type { ToolRegistry } from '../tools/registry';
import {
  LUMI_CLIENT_MODE_IDS,
  LUMI_MEETING_CAPTURE_SURFACE,
  LUMI_OPERATION_MODE_IDS,
  normalizeLumiClientMode,
  type LumiClientMode,
} from '../../shared/operation_modes';

export type OperationMode = LumiClientMode;

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
    description: 'Visible conversational posture. A user-present model-owned turn may use the ordinary foreground Assistant manifest without persistently changing the client mode; long-running work uses Autonomy.',
    promptOverlay: [
      'You are in chat mode.',
      'Answer, reason, explain, brainstorm, and help the user decide naturally.',
      'When the current model-owned turn exposes a foreground capability manifest, decide whether the user wants an answer or real execution and use only that manifest. The visible client may remain in Chat.',
      'Do not persistently change the client mode merely because semantic routing matched an action. A direct request is enough authorization for ordinary foreground work; hard confirmation and consequence boundaries still apply.',
      'Use Autonomy only for explicit continuous, unattended, or long-running work.',
      'When the task can be answered naturally without tools, just answer.',
    ].join('\n'),
    toolPolicy: {
      allowedTools: ['client_get_state', 'client_action'],
      requireConfirmation: [],
      forbiddenTools: [],
      maxIterations: 4,
    },
  },

  assistant: {
    id: 'assistant',
    label: 'Assistant',
    labelCN: 'Assistant',
    description: 'Foreground assisted execution. The user is present; LumiCore has the same practical tool, browser, app, desktop, file, and skill permissions as Autonomy for requested work, but does not start unattended loops or long autonomous absorption by default.',
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
      'Use the single LumiCore task state, scheduled/continuous monitoring, memory consolidation, learning, folder sorting, and research absorption when useful.',
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
  return normalizeLumiClientMode(mode);
}

/**
 * Prompt-sized rendering of the canonical taxonomy. This is definition data,
 * not a claim that live client state was queried in the current turn.
 */
export function buildOperationModeTaxonomyPrompt(): string {
  return [
    '## Canonical LumiCore operation-mode taxonomy',
    `LumiCore has exactly ${LUMI_OPERATION_MODE_IDS.length} persistent user-selectable operation/permission modes: ${LUMI_OPERATION_MODE_IDS.join(', ')}.`,
    `The complete client-state discriminator is ${LUMI_CLIENT_MODE_IDS.join(', ')} only because ${LUMI_MEETING_CAPTURE_SURFACE.id} represents a temporary transcription/capture surface. It is not a fourth permission mode.`,
    'Internal personality response presets and conversation styles are not operation modes, do not appear as client runtime modes, and never change tool permissions or task ownership.',
    'Never claim this taxonomy came from a current client-state check unless a successful current-turn client receipt actually exists.',
  ].join('\n');
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

/**
 * Build mode permissions from the same runtime capability manifest used by
 * model exposure and execution. Chat keeps only bounded native-client tools,
 * meeting stays tool-free, and executable tools opt into assistant/autonomous
 * through their capability metadata.
 */
export function buildOperationModeToolPolicy(
  mode: string | undefined,
  registry?: ToolRegistry,
): ToolPolicy {
  const normalized = normalizeOperationMode(mode);
  const fallback = OPERATION_MODE_CONFIGS[normalized].toolPolicy;
  if (!registry || normalized === 'chat' || normalized === 'meeting') {
    return {
      ...fallback,
      allowedTools: [...fallback.allowedTools],
      forbiddenTools: [...fallback.forbiddenTools],
      requireConfirmation: [...fallback.requireConfirmation],
      securityOverrides: fallback.securityOverrides
        ? { ...fallback.securityOverrides }
        : undefined,
    };
  }

  const manifest = registry.getCapabilityManifest()
    .filter(entry => (
      !entry.deprecated
      && entry.executable
      && entry.modes.includes(normalized)
    ));
  const securityOverrides = Object.fromEntries(
    manifest
      .map(entry => [entry.toolName, entry.modeSecurity[normalized]] as const)
      .filter((entry): entry is readonly [string, 'safe' | 'confirm' | 'forbidden'] => Boolean(entry[1])),
  );
  return {
    allowedTools: manifest.map(entry => entry.toolName),
    forbiddenTools: [],
    requireConfirmation: manifest
      .filter(entry => entry.requiresConfirmation)
      .map(entry => entry.toolName),
    ...(Object.keys(securityOverrides).length ? { securityOverrides } : {}),
    maxIterations: fallback.maxIterations,
  };
}

function normalizeModeCommandText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.,!?;:'"()\[\]{}\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u3001\uff08\uff09\u3010\u3011]/g, '');
}

function stripModeCommandCourtesy(text: string): string {
  return text.replace(/(?:\u5427|\u4e00\u4e0b|\u597d\u5417|\u53ef\u4ee5\u5417|please)$/i, '');
}

const MODE_SWITCH_VERB_RE = /(?:\u5207\u6362|\u5207\u5230|\u5207\u6210|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8|\u5f00\u59cb|\u8bbe\u4e3a|\u8bbe\u7f6e\u4e3a|\u5207\u56de|\u56de\u5230|switch|change|enter|start|open|set)/i;
const MODE_TARGET_RES: Readonly<Record<OperationMode, RegExp>> = {
  chat: /(?:\u7eaf\u804a\u5929|\u804a\u5929\u6a21\u5f0f|chatmode)/i,
  assistant: /(?:\u52a9\u624b\u6a21\u5f0f|\u52a9\u7406\u6a21\u5f0f|assistantmode)/i,
  autonomous: /(?:\u81ea\u4e3b\u6a21\u5f0f|\u81ea\u4e3b\u6267\u884c|\u81ea\u52a8\u6267\u884c|autonomymode|autonomousmode|autoexecutemode)/i,
  meeting: /(?:\u4f1a\u8bae\u6a21\u5f0f|meetingmode)/i,
};

const PURE_MODE_COMMAND_RES: Readonly<Record<OperationMode, RegExp>> = {
  chat: /^(?:(?:lumi|\u9732\u7c73))?(?:(?:\u8bf7|\u5e2e\u6211|\u7ed9\u6211|\u9ebb\u70e6))?(?:(?:\u5207\u6362|\u5207\u5230|\u5207\u6210|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8|\u5f00\u59cb|\u8bbe\u4e3a|\u8bbe\u7f6e\u4e3a|\u5207\u56de|\u56de\u5230|switch|change|enter|start|open|set)(?:\u5230|\u6210|to)?)?(?:\u7eaf\u804a\u5929|\u804a\u5929\u6a21\u5f0f|\u804a\u5929|chatmode|chat)$/i,
  assistant: /^(?:(?:lumi|\u9732\u7c73))?(?:(?:\u8bf7|\u5e2e\u6211|\u7ed9\u6211|\u9ebb\u70e6))?(?:(?:\u5207\u6362|\u5207\u5230|\u5207\u6210|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8|\u5f00\u59cb|\u8bbe\u4e3a|\u8bbe\u7f6e\u4e3a|\u5207\u56de|\u56de\u5230|switch|change|enter|start|open|set)(?:\u5230|\u6210|to)?)?(?:\u52a9\u624b\u6a21\u5f0f|\u52a9\u7406\u6a21\u5f0f|\u52a9\u624b|\u52a9\u7406|assistantmode|assistant)$/i,
  autonomous: /^(?:(?:lumi|\u9732\u7c73))?(?:(?:\u8bf7|\u5e2e\u6211|\u7ed9\u6211|\u9ebb\u70e6))?(?:(?:\u5207\u6362|\u5207\u5230|\u5207\u6210|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8|\u5f00\u59cb|\u8bbe\u4e3a|\u8bbe\u7f6e\u4e3a|\u5207\u56de|\u56de\u5230|switch|change|enter|start|open|set)(?:\u5230|\u6210|to)?)?(?:\u81ea\u4e3b\u6a21\u5f0f|\u81ea\u4e3b\u6267\u884c|\u81ea\u52a8\u6267\u884c|\u81ea\u4e3b|autonomymode|autonomousmode|autonomy|autonomous|autoexecute)$/i,
  meeting: /^(?:(?:lumi|\u9732\u7c73))?(?:(?:\u8bf7|\u5e2e\u6211|\u7ed9\u6211|\u9ebb\u70e6))?(?:(?:\u5207\u6362|\u5207\u5230|\u5207\u6210|\u6362\u5230|\u8fdb\u5165|\u6253\u5f00|\u5f00\u542f|\u542f\u52a8|\u5f00\u59cb|\u8bbe\u4e3a|\u8bbe\u7f6e\u4e3a|\u5207\u56de|\u56de\u5230|switch|change|enter|start|open|set)(?:\u5230|\u6210|to)?)?(?:\u4f1a\u8bae\u6a21\u5f0f|\u4f1a\u8bae|meetingmode|meeting)$/i,
};

export function detectRequestedOperationMode(text: string): OperationMode | null {
  const normalized = stripModeCommandCourtesy(normalizeModeCommandText(text));
  if (!normalized) return null;

  for (const mode of LUMI_CLIENT_MODE_IDS) {
    if (PURE_MODE_COMMAND_RES[mode].test(normalized)) return mode;
  }

  if (!MODE_SWITCH_VERB_RE.test(normalized)) return null;
  for (const mode of [LUMI_MEETING_CAPTURE_SURFACE.id, ...LUMI_OPERATION_MODE_IDS]) {
    if (MODE_TARGET_RES[mode].test(normalized)) return mode;
  }
  return null;
}

export function isPureOperationModeSwitchRequest(text: string, mode?: OperationMode | null): boolean {
  const requested = mode || detectRequestedOperationMode(text);
  return Boolean(requested && PURE_MODE_COMMAND_RES[requested].test(
    stripModeCommandCourtesy(normalizeModeCommandText(text)),
  ));
}
