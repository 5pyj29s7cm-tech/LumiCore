import { buildTextReplyStyleOverlay } from "../../../cognition/reply_style";
import { convergeForegroundRequestBeforeRelease, type ForegroundRequestReleaseInput, type ForegroundRequestReleaseResult as ChatForegroundRequestReleaseResult, type ForegroundRequestDurabilityDependencies } from "../../../conversation/manager";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";

export async function convergeChatForegroundRequestBeforeRelease(
  input: ForegroundRequestReleaseInput,
  dependencies: ForegroundRequestDurabilityDependencies = {},
): Promise<ChatForegroundRequestReleaseResult> {
  return convergeForegroundRequestBeforeRelease({
    ...input,
    channel: 'Chat',
  }, dependencies);
}

export function chatDurabilityUnknownText(userText: string): string {
  return /[\u3400-\u9fff]/u.test(userText)
    ? CN_TASK_EXECUTION_MESSAGES.persistenceUnknown
    : 'The final state of this turn could not be saved reliably, so I did not mark it complete. If an external action may have run, verify its actual result before retrying.';
}

export function buildNaturalReplyStyleOverlay(source?: string): string {
  return buildTextReplyStyleOverlay(source === 'voice' ? 'voice' : 'chat');
}
