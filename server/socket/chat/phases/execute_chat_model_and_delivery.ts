import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { executeChatModelTurn } from "../model_execution";
import { completeChatTurn } from "../result_delivery";
import { getVerifiedClientModeChange } from "../client_surface";
import { saveStoredOperationMode } from "../../../cognition/operation_mode_store";
import type { prepareChatModelState } from './prepare_chat_model_state';

export async function executeChatModelAndDelivery(context: NonNullable<Awaited<ReturnType<typeof prepareChatModelState>>["context"]>) {

      const finalResponse = await executeChatModelTurn(context);

      const verifiedClientMode = getVerifiedClientModeChange(context.allToolRecords);
      if (verifiedClientMode) saveStoredOperationMode(context.uid, verifiedClientMode);
      await completeChatTurn(extendTurnBindings(context, {
    finalResponse,
  }));
  return { terminal: false as const, context };
}
