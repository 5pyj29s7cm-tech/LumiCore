import { flushDBOrThrow } from '../../db_layer';
import {
  persistConversationModelExecutionCheckpoint,
} from '../conversation/manager';
import type { OrchestrationWorkflowCheckpoint } from '../agents/orchestrator';

export function voiceDurabilityUnknownText(): string {
  return 'Lumi could not durably confirm this voice result. Refresh the conversation state before retrying.';
}

export function sanitizeVoiceAgentErrorPayload(): {
  code: 'VOICE_EXECUTION_FAILED';
  message: string;
} {
  return {
    code: 'VOICE_EXECUTION_FAILED',
    message: 'The voice request could not be completed.',
  };
}

export class VoiceWorkflowCheckpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VoiceWorkflowCheckpointError';
  }
}

/**
 * Persist the private model hand-off and public graph receipts before the
 * coordinator is allowed to start the next wave. A compiled recovery graph
 * keeps its already-verified receipts instead of replacing them with the
 * orchestrator's intentionally empty compiled checkpoint.
 */
export async function persistVoiceWorkflowCheckpointDurably(
  input: {
    conversationId: string;
    userId: string;
    taskId: string;
    checkpoint: OrchestrationWorkflowCheckpoint;
    resumeNodeReceipts?: OrchestrationWorkflowCheckpoint['nodeReceipts'];
  },
  dependencies: {
    persist?: typeof persistConversationModelExecutionCheckpoint;
    flush?: typeof flushDBOrThrow;
  } = {},
): Promise<void> {
  const persist = dependencies.persist || persistConversationModelExecutionCheckpoint;
  const flush = dependencies.flush || flushDBOrThrow;
  const preservingRecovery = input.checkpoint.phase === 'compiled'
    && (input.resumeNodeReceipts?.length || 0) > 0;
  const persisted = persist({
    conversationId: input.conversationId,
    userId: input.userId,
    taskId: input.taskId,
    executionGraph: input.checkpoint.executionGraph,
    nodeReceipts: preservingRecovery
      ? input.resumeNodeReceipts!
      : input.checkpoint.nodeReceipts,
    privateNodeHandoffs: preservingRecovery
      ? undefined
      : input.checkpoint.privateNodeHandoffs,
    arbitrationReceipt: input.checkpoint.arbitrationReceipt,
  });
  if (!persisted) {
    throw new VoiceWorkflowCheckpointError(
      `Voice workflow ${input.checkpoint.phase} checkpoint was rejected`,
    );
  }
  try {
    await flush();
  } catch (error) {
    throw new VoiceWorkflowCheckpointError(
      `Voice workflow ${input.checkpoint.phase} checkpoint could not be flushed`,
      { cause: error },
    );
  }
}
