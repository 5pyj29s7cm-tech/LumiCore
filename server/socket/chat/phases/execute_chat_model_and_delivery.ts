import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { executeChatModelTurn } from "../model_execution";
import { completeChatTurn } from "../result_delivery";
import { getVerifiedClientModeChange } from "../client_surface";
import { saveStoredOperationMode } from "../../../cognition/operation_mode_store";
import { withDesktopExecutionReceipt } from "../../../desktop/execution_runtime";
import type { prepareChatModelState } from './prepare_chat_model_state';

export async function executeChatModelAndDelivery(context: NonNullable<Awaited<ReturnType<typeof prepareChatModelState>>["context"]>) {

      await executeChatModelTurn(context);

      context.chatTextGate.finish();
      const finalizedDesktopRecords = withDesktopExecutionReceipt(context.allToolRecords, context.desktopExecutionTracker);
      if (finalizedDesktopRecords.length > context.allToolRecords.length) {
        context.allToolRecords.push(...finalizedDesktopRecords.slice(context.allToolRecords.length));
      }
      const verifiedClientMode = getVerifiedClientModeChange(context.allToolRecords);
      if (verifiedClientMode) saveStoredOperationMode(context.uid, verifiedClientMode);
      const finalTaskRecords = context.taskAwareRecords(context.allToolRecords);
      await completeChatTurn(extendTurnBindings(context, {
    finalTaskRecords: finalTaskRecords as typeof finalTaskRecords,
  }));
  return { terminal: false as const, context };
}
