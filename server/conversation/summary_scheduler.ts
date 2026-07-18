import { makeLLMCall } from '../llm/providers';
import {
  beginConversationSummary,
  cancelConversationSummary,
  checkAutoSummary,
  setConversationSummary,
  type MessageRecord,
} from './manager';
import { isGuardGeneratedConversationRecord } from './guard_history';

export interface ConversationSummaryLlmGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
}

export interface ConversationSummaryScheduleInput {
  conversationId: string;
  userId: string;
  provider: string;
  model: string;
  domain: string;
  orgId?: string;
  llmGetters?: ConversationSummaryLlmGetters;
  /** Test/alternate generator hook; production callers use the configured LLM. */
  generateSummary?: (transcript: string, messages: MessageRecord[]) => Promise<string>;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string, error?: unknown) => void;
  };
}

export interface ConversationSummaryScheduleResult {
  scheduled: boolean;
  summarizedThroughMessageCount: number;
  completion?: Promise<boolean>;
  reason: string;
}

function buildSummaryTranscript(messages: MessageRecord[]): string {
  return messages
    .slice(-30)
    .filter(message => !isGuardGeneratedConversationRecord(message))
    .map(message => `${message.role || 'user'}: ${(message.message || '').slice(0, 200)}`)
    .join('\n')
    .trim();
}

async function generateSummaryWithLlm(
  input: ConversationSummaryScheduleInput,
  transcript: string,
): Promise<string> {
  const getters = input.llmGetters;
  if (!getters) throw new Error('Conversation summary LLM getters are unavailable.');
  const summaryPrompt = `Summarize this conversation in 2-3 concise sentences. Focus on key decisions, topics discussed, and user preferences revealed. Output only the summary — no preamble.\n\n${transcript}`;
  const result = await makeLLMCall(
    [{ role: 'user', content: summaryPrompt }],
    [],
    {
      provider: input.provider as any,
      model: input.model,
      maxTokens: 300,
      userId: input.userId,
      domain: input.domain,
      orgId: input.orgId,
    },
    getters.getDeepSeek,
    getters.getGemini,
    getters.getOpenAI,
    getters.getAnthropic,
    getters.getQwen,
    getters.getOllama,
    getters.getLmStudio,
    getters.getArk,
    getters.getXiaomi,
    getters.getKimi,
    getters.getGlm,
    getters.getRelay,
  );
  return String(result.text || '').trim();
}

/**
 * Reserve and launch one summary interval. Reservation, guard filtering,
 * failure release, and captured-count persistence are shared by every input
 * channel so voice and chat cannot drift onto different cadence rules.
 */
export function scheduleConversationSummary(
  input: ConversationSummaryScheduleInput,
): ConversationSummaryScheduleResult {
  const check = checkAutoSummary(input.conversationId);
  if (!check.needed || check.recentMessages.length === 0) {
    return {
      scheduled: false,
      summarizedThroughMessageCount: check.summarizedThroughMessageCount,
      reason: 'not eligible',
    };
  }
  if (!beginConversationSummary(input.conversationId, check.summarizedThroughMessageCount)) {
    return {
      scheduled: false,
      summarizedThroughMessageCount: check.summarizedThroughMessageCount,
      reason: 'already reserved or no longer eligible',
    };
  }

  const transcript = buildSummaryTranscript(check.recentMessages);
  if (!transcript) {
    cancelConversationSummary(input.conversationId, check.summarizedThroughMessageCount);
    return {
      scheduled: false,
      summarizedThroughMessageCount: check.summarizedThroughMessageCount,
      reason: 'no clean transcript',
    };
  }

  const completion = (async () => {
    try {
      const summary = String(
        input.generateSummary
          ? await input.generateSummary(transcript, check.recentMessages)
          : await generateSummaryWithLlm(input, transcript),
      ).trim();
      if (!summary) {
        cancelConversationSummary(input.conversationId, check.summarizedThroughMessageCount);
        return false;
      }
      const persisted = setConversationSummary(
        input.conversationId,
        summary,
        check.summarizedThroughMessageCount,
      );
      if (persisted) {
        input.log?.info?.(`[Conversation] Auto-summary generated for ${input.conversationId}`);
      }
      return persisted;
    } catch (error) {
      cancelConversationSummary(input.conversationId, check.summarizedThroughMessageCount);
      input.log?.warn?.(`[Conversation] Auto-summary failed for ${input.conversationId}`, error);
      return false;
    }
  })();

  return {
    scheduled: true,
    summarizedThroughMessageCount: check.summarizedThroughMessageCount,
    completion,
    reason: 'scheduled',
  };
}
