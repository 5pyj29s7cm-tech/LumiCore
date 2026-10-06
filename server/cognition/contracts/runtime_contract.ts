import { buildClientDiagnosticPlan } from "../client_diagnostic_result";
import { classifyRuntimeWorkIntent } from "../runtime_work_intent";
import type { LumiActionContract } from './contracts';
import { isNamedPersistentWorkTaskStatusQuery } from './navigation_contracts';
import { NONE_CONTRACT, withDefaults } from './contracts';

export function buildRuntimeControlContract(rawInput: string, text: string, primaryTaskText: string): LumiActionContract | null {

  // A named persistent takeover-task query belongs to the takeover ledger,
  // not the active runtime-work ledger. Its deterministic quick command emits
  // a verified work_takeover_task_list receipt, so do not demand the unrelated
  // runtime_work_status tool in the final completion gate.
  if (isNamedPersistentWorkTaskStatusQuery(text)) return NONE_CONTRACT;
  const diagnosticPlan = buildClientDiagnosticPlan(primaryTaskText || rawInput);
  if (diagnosticPlan.length) {
    const tools = diagnosticPlan.map(step => step.name);
    return withDefaults({ kind: 'desktop_operation', label: 'Current Lumi runtime diagnostic',
      coreAction: 'Inspect the current Lumi runtime state and explain its actual health findings.',
      preparationIsNotCompletion: ['listing generic capabilities or unrelated business integrations'],
      requiredEvidence: tools.map(name => `successful current-turn ${name} receipt`), preferredTools: tools, verificationTools: tools,
      nextStep: 'Read all required runtime receipts, identify attention items, and distinguish optional disconnected integrations from core failures.',
      caution: 'A task ledger snapshot alone does not verify client and backend health.' });
  }
  // Runtime status/cancellation has its own exact ledger contract. Classify it
  // before the generic normalized status guard so a phrase such as
  // "background task progress" cannot be reduced to a no-tool status turn.
  const runtimeWorkIntent = classifyRuntimeWorkIntent(text);
  if (runtimeWorkIntent !== 'none') {
    const cancelling = runtimeWorkIntent === 'cancel';
    return withDefaults({
      kind: 'task_control',
      label: cancelling ? 'Runtime work cancellation' : 'Runtime work status',
      coreAction: cancelling
        ? 'Cancel the active Lumi work recorded in the unified runtime ledger.'
        : 'Read the active Lumi work recorded in the unified runtime ledger.',
      preparationIsNotCompletion: [
        'listing operating-system processes',
        'checking client health',
        'saying work was stopped without a runtime cancellation receipt',
      ],
      requiredEvidence: [cancelling
        ? 'runtime_work_cancel result with ok=true and cancelled/idle for completion; cancelling proves only that the request was accepted and must be rechecked'
        : 'runtime_work_status result with ok=true and the exact active item count'],
      preferredTools: [cancelling ? 'runtime_work_cancel' : 'runtime_work_status'],
      verificationTools: ['runtime_work_status'],
      nextStep: cancelling
        ? 'Cancel the matching runtime work and report whether cancellation completed, is still draining, or there was nothing active.'
        : 'Read the runtime work ledger and report its current items without substituting a process list.',
      caution: 'Only runtime ledger receipts prove Lumi task status or cancellation.',
    });
  }
  return null;
}
