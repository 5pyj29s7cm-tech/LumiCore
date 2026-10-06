import type { useChatHistoryAndRequests } from './use_chat_history_and_requests';

export const CHAT_HISTORY_LIMIT = 300;

export const CHAT_RENDER_LIMIT = 80;

export const CHAT_SEARCH_LIMIT = 200;

export const ACTIVE_CHAT_EXECUTION_TTL_MS = 24 * 60 * 60 * 1000;

export type ChatStreamReceiverInput = Pick<ReturnType<typeof useChatHistoryAndRequests>, "acceptChatExecutionEvent" | "taskRelationLedgerRef" | "isZh" | "setMessages" | "agentName" | "streamingRawTextRef" | "streamingMsgIdsRef" | "activeMediaGenerationRef" | "mediaGenerationArtifactsRef" | "mediaGenerationArtifactValidationRef" | "setMediaGenerationArtifacts" | "setMediaGeneration" | "mediaGenerationText" | "seenWorkflowToolEvents" | "chatTurnUiMetaRef" | "chatRequestLedgerRef" | "currentTurnUiMetaRef" | "setWorkflowStatus" | "pushChatProgress">;
