import { extendTurnBindings } from "../../../cognition/turn_bindings";
import type { ExecutedLumiTurn } from "../../../cognition/turn_execution";
import { mergeToolExecutionRecords } from "../../../cognition/task_execution_ledger";
import { completeChatTurn } from "../result_delivery";
import { getVerifiedClientModeChange } from "../client_surface";
import { saveStoredOperationMode } from "../../../cognition/operation_mode_store";
import type { prepareChatModelState } from './prepare_chat_model_state';

export async function executeChatModelAndDelivery(context: NonNullable<Awaited<ReturnType<typeof prepareChatModelState>>["context"]>, completed: ExecutedLumiTurn) {

  const currentRecords = completed.toolRecords.filter(record => !context.priorTaskRecords.some(prior => prior.id
    ? prior.id === record.id : prior.name === record.name && prior.result === record.result && prior.error === record.error));
  context.allToolRecords.splice(0, context.allToolRecords.length, ...mergeToolExecutionRecords(context.allToolRecords, currentRecords));
  context.responseText = completed.finalized.text;
      const finalResponse = completed.finalized;

      const verifiedClientMode = getVerifiedClientModeChange(context.allToolRecords);
      if (verifiedClientMode) saveStoredOperationMode(context.uid, verifiedClientMode);
      await completeChatTurn(extendTurnBindings(context, {
    finalResponse,
  }));
  return { terminal: false as const, context };
}
