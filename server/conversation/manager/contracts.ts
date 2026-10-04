import { type ConversationActionContinuationState } from "../../cognition/action_continuation";
import { type TaskCompletionFeedback } from "../completion_feedback";

export interface Conversation {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  status: 'active' | 'paused' | 'closed';
  mode?: string;  // Conversation style: casual, teaching, brainstorm, executive
  summary: string;
  /** Multi-level summary chain: [oldest, middle, newest]. Max 3 entries. */
  summaryChain?: string[];
  /** Number of stored messages covered by the newest successfully persisted summary. */
  lastSummaryMessageCount?: number;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
  /** Recent topic tags — tracked for cross-session continuity */
  recentTopics?: string[];
  /** ISO timestamp of the last topic change */
  lastTopicChangeAt?: string;
  /** Domain: personal or work */
  domain?: string;
  /** orgId when in work domain */
  orgId?: string;
  /** Runtime compatibility projection; durable state lives in conversation_action_tasks/receipts. */
  actionContinuationState?: ConversationActionContinuationState;
  /** Latest user turn waiting for its terminal assistant/tool record. */
  pendingActionContinuation?: {
    userText: string;
    messageId: string;
    requestId?: string;
    updatedAt: string;
  };
}


export interface MessageRecord {
  id: string;
  userId: string;
  agentId?: string;
  conversationId?: string;
  module?: string;
  message: string;
  response?: string;
  role: string;
  personality?: string;
  mode?: string;
  toolCalls?: any[];
  /** Server-derived receipt evidence retained after prompt compaction removes raw tool calls. */
  toolReceiptLedger?: string;
  /** In-process server projection; never accepted from client-supplied history. */
  toolFileObservations?: string;
  domain?: string;
  orgId?: string;
  source?: string;
  channel?: string;
  cognitiveIntent?: string;
  llmWasCalled?: boolean;
  /** Provider message identity used to keep asynchronous remote turns ordered. */
  externalMessageId?: string;
  /** Monotonic sequence within one external conversation. */
  routeSequence?: number;
  /** Time the remote transport received the message. */
  receivedAt?: string;
  /** Stable request identity for one local/socket turn. */
  requestId?: string;
  /** Proof-bound native request provenance; absent on web/remote/harness turns. */
  nativeDeviceId?: string;
  executionSessionId?: string;
  nativeClientIdentitySha256?: string;
  audioInputKind?: 'physical_microphone' | 'synthetic_accepted_transcript' | '';
  syntheticAudio?: boolean;
  captureSessionId?: string;
  sttReceiptId?: string;
  contextChainId?: string;
  previousRequestId?: string;
  /** Structured model/runtime classification for durable task ownership. */
  taskIntent?: 'task' | 'conversation' | '';
  /** Bounded, allowlisted task outcome summary shown after history reload. */
  completionFeedback?: TaskCompletionFeedback;
  timestamp: string;
}


export interface ConversationTurnOptions {
  /** Current user text, used to avoid a soft rollover during a referential follow-up. */
  userText?: string;
  /** Test/diagnostic override. Production defaults to CONVERSATION_ROLLOVER_MESSAGE_LIMIT or 240. */
  messageLimit?: number;
  /** Bind this turn to the conversation selected by the client. */
  conversationId?: string;
}


export interface ConversationTurnResult {
  conversation: Conversation;
  rolledOver: boolean;
  previousConversationId?: string;
}
