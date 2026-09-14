import type { ToolExecutionRecord } from '../tools/types';
import { artifactRecordMatchesTurn } from '../tools/artifact_evidence';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { classifyExternalCliIntent, requestedCliProviders } from './external_cli_intent';
import { CN_EXTERNAL_CLI_MESSAGES } from '../regions/packs/cn/external_cli_messages';

interface CliStatusTarget {
  provider: 'codex' | 'claude';
  installed: boolean;
  ready: boolean;
  status: string;
  version?: string;
}

/** One receipt projection for tool-loop exit, channel delivery and task completion. */
export function verifiedExternalCliStatus(
  task: string,
  records: ToolExecutionRecord[],
  turn: { requestId?: string; taskId?: string } = {},
): CliStatusTarget[] | null {
  if (classifyExternalCliIntent(task) !== 'inspect') return null;
  const record = [...records].reverse().find(item => item.name === 'external_cli_status' && artifactRecordMatchesTurn(item, turn));
  if (!record || record.error || record.terminalVerification?.status !== 'verified') return null;
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  if (!payload || payload.ok !== true || payload.status !== 'completed' || !Array.isArray(payload.targets)) return null;
  const requested = requestedCliProviders(task);
  const providers = requested.length ? requested : ['codex', 'claude'];
  const result: CliStatusTarget[] = [];
  for (const provider of providers) {
    const matches = payload.targets.filter((target: any) => target?.provider === provider);
    if (matches.length !== 1) return null;
    const target = matches[0];
    if (typeof target.installed !== 'boolean' || typeof target.ready !== 'boolean' || typeof target.status !== 'string'
      || (target.ready && (!target.installed || target.status !== 'ready'))) return null;
    result.push(target);
  }
  return result;
}

export function formatExternalCliStatus(task: string, targets: CliStatusTarget[]): string {
  const zh = /[\u3400-\u9fff]/u.test(task);
  const lines = targets.map(target => {
    const name = target.provider === 'codex' ? 'Codex CLI' : 'Claude Code CLI';
    const version = String(target.version || '').replace(/[\r\n]/gu, ' ').slice(0, 100);
    if (target.ready) return zh ? CN_EXTERNAL_CLI_MESSAGES.ready(name, version)
      : `${name} is installed and its login/configuration check passed${version ? ` (${version})` : ''}.`;
    if (!target.installed) return zh ? CN_EXTERNAL_CLI_MESSAGES.notInstalled(name) : `${name} was not found on this machine.`;
    return zh ? CN_EXTERNAL_CLI_MESSAGES.unavailable(name)
      : `${name} is installed, but its login/configuration check did not pass.`;
  });
  if (targets.every(target => target.ready)) lines.unshift(zh ? CN_EXTERNAL_CLI_MESSAGES.canDelegate : 'I can delegate tasks through the local CLI interface.');
  lines.push(zh ? CN_EXTERNAL_CLI_MESSAGES.statusScope
    : 'This checked local status only; no task was run and model quota was not verified. A task needs a project directory and instructions.');
  return lines.join('\n');
}
