import { CN_ACTION_CONTRACT_BLOCKERS } from "../../regions/messages/voice_fast_path_messages";
import { compact } from "../action_contract_support";
import type { LumiActionContract } from './contracts';

export function formatActionContractPrompt(contract: LumiActionContract): string {
  if (!contract.applies) return '';
  const capabilityRequirements = contract.preferredCapabilities.map(requirement => {
    const operations = requirement.operations?.length
      ? `; operations=${requirement.operations.join('|')}`
      : '';
    return `lanes=${requirement.lanes.join('|')}${operations}; terms=${requirement.terms.join('|')}`;
  });
  return [
    '## Lumi Action Contract',
    `Action type: ${contract.label}.`,
    `Core action: ${contract.coreAction}.`,
    contract.preparationIsNotCompletion.length
      ? `Preparation is not completion: ${contract.preparationIsNotCompletion.join('; ')}.`
      : '',
    contract.requiredEvidence.length
      ? `Required completion evidence: ${contract.requiredEvidence.join('; ')}.`
      : '',
    capabilityRequirements.length
      ? `Capability requirements: ${capabilityRequirements.join('; ')}. Resolve actual tools from the current CapabilityManifest.`
      : '',
    contract.caution ? `Caution: ${contract.caution}` : '',
    contract.nextStep ? `If blocked: ${contract.nextStep}` : '',
  ].filter(Boolean).join('\n');
}

export function summarizeActionContractBlocker(contract: LumiActionContract, failure = ''): string {
  if (!contract.applies) return failure || '';
  const safeFailure = compact(failure);
  if (contract.kind === 'task_control') {
    return CN_ACTION_CONTRACT_BLOCKERS.taskControl(safeFailure);
  }
  if (contract.kind === 'messaging_read') {
    return CN_ACTION_CONTRACT_BLOCKERS.messagingRead(safeFailure);
  }
  if (contract.kind === 'cad_drafting') {
    return CN_ACTION_CONTRACT_BLOCKERS.cadDrafting(safeFailure);
  }
  return CN_ACTION_CONTRACT_BLOCKERS.generic(safeFailure);
}
