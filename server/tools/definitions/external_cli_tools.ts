import { CN_EXTERNAL_CLI_MESSAGES } from '../../regions/packs/cn/external_cli_messages';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { executeExternalCli, getExternalCliRun, inspectExternalClis } from '../../external_agents/cli_runtime';

export function registerExternalCliTools(registry: ToolRegistry): void {
  registry.register({
    name: 'external_cli_status', description: 'Inspect locally installed Codex CLI and Claude Code CLI versions and authentication without sending a model task. These use their own CLI accounts/configuration, not Lumi model routing.',
    parameters: { type: 'object', properties: {} }, handler: (_args, context) => inspectExternalClis(context), permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({ id: 'external-agent.cli.status', family: 'external-ai-cli', lane: 'agents', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'CLI install and authentication status only', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'targets'], successStatuses: ['completed'], failureStatuses: ['failed'], successSignals: ['version and auth status returned'], limitations: ['Does not test model availability or quota.'] } }),
  });
  registry.register({
    name: 'external_cli_run',
    description: 'Delegate one bounded task to a named Codex CLI or Claude Code CLI on this Lumi host, returning live progress, terminal result, and verified changed deliverables. Lumi remains the task owner. Specify necessary context in prompt and an absolute project cwd. Default read-only. Use workspace-write only for authorized edits. To continue, pass a previous Lumi runId as resumeRunId; never open desktop AI windows or invent external session IDs. Cancellation uses the existing Lumi task cancellation. Provider completion is not proof of business correctness; verify results. Deliverable paths return to chat/archive.',
    parameters: { type: 'object', properties: {
      provider: { type: 'string', enum: ['codex', 'claude'] }, prompt: { type: 'string', description: 'Complete bounded task plus necessary user context and constraints. Do not forward unrelated conversation history.' },
      cwd: { type: 'string', description: 'Absolute project/work directory. Required on the first call; resume inherits it.' },
      access: { type: 'string', enum: ['read-only', 'workspace-write'] }, resumeRunId: { type: 'string', description: 'Lumi runId returned by a settled external_cli_run.' },
      timeoutMs: { type: 'number', description: 'Maximum run duration, up to 900000 ms (15 minutes).' },
    }, required: ['provider', 'prompt'] }, handler: executeExternalCli, permission: 'user', securityLevel: 'confirm',
    capability: { ...capabilityContract({ id: 'external-agent.cli.run', family: 'external-ai-cli', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'process_execution', scope: 'one named CLI and its task-owned subprocesses', reversible: false }, { type: 'external_communication', scope: 'necessary task context submitted through the selected CLI account', reversible: false }, { type: 'local_write', scope: 'authorized project edits and Lumi output deliverables', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'runId', 'exitCode', 'response', 'verificationScope', 'artifacts'], requiredValues: { ok: true, exitCode: 0 }, successStatuses: ['completed'], failureStatuses: ['failed', 'blocked', 'cancelled', 'timed_out', 'interrupted'], successSignals: ['CLI emitted a successful terminal response; attached output bytes were verified on disk'], limitations: ['Lumi must separately validate source changes and user-requested behavior. Claude tool permissions are not an OS filesystem sandbox.'] } }),
      intents: ['Codex CLI', 'Claude Code CLI', ...CN_EXTERNAL_CLI_MESSAGES.delegationIntents], tags: ['codex', 'claude code', 'cli', 'external ai', 'delegation'] },
    evidence: capabilityEvidence({ id: 'external-agent.cli.run', operation: 'mutate', subjectArgument: 'cwd', limitations: ['Provider-reported success alone does not verify business correctness.'] }),
  });
  registry.register({
    name: 'external_cli_get_run', description: 'Read the owning user/workspace external CLI run receipt, including failure/cancellation and full response. This does not execute or resume a task.',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] }, handler: getExternalCliRun, permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({ id: 'external-agent.cli.receipt', family: 'external-ai-cli', lane: 'agents', operation: 'observe', risk: 'low', sideEffects: [{ type: 'local_read', scope: 'owned CLI run receipt', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['runId', 'status'], successStatuses: ['completed', 'running'], failureStatuses: ['failed', 'cancelled', 'timed_out', 'interrupted'], successSignals: ['Owned run receipt loaded'], limitations: ['A running receipt is not completion evidence.'] } }),
  });
}
