import type { prepareChatPriorTaskQuery } from './phases/prepare_chat_prior_task_query';

import { queryMemoriesVector, CONVERSATIONAL_MEMORY_EVIDENCE } from "../../memory";
import { loadEmotionalState, loadHIMState, vectorMemoryBias } from "../../personality/state";

import { personalityRegistry } from "../../personality";
import { buildMemoryAvatarContext } from "../../memory_avatar/store";

import { retrieveChunks } from "../../agents/rag";
import { runRetrievalRequest } from "../../llm/retrieval_request";

import { retrieveConversationKnowledge } from "../../knowledge/conversation_retrieval";

import { scopedEmotionalStateKey } from "../scope";

type retrieveChatContextInput = NonNullable<Awaited<ReturnType<typeof prepareChatPriorTaskQuery>>['context']>;
export async function retrieveChatContext(context: retrieveChatContextInput) {

      // Retrieve personality vector early to bias memory retrieval (cross-system fusion: vector→memory)
      const personalityConfig = context.isMemoryAvatar && context.memoryAvatar?.personalityConfig
        ? context.memoryAvatar.personalityConfig
        : personalityRegistry.getForUser(
            context.personalityId,
            context.uid,
            context.resolvedDomain === 'work' ? context.resolvedOrgId : undefined,
          );
      console.log('[ChatHandler] personalityConfig:', !!personalityConfig);
      const retrievalBiases = personalityConfig?.personalityVector
        ? vectorMemoryBias(personalityConfig.personalityVector)
        : { typeWeights: {}, perspectiveWeights: {} };

      // Vector semantic search with keyword fallback
      context.markTurnTiming('memoryStart');
      const relevantMemories = await runRetrievalRequest(signal => queryMemoriesVector({
        userId: context.uid,
        query: context.text,
        limit: context.isMemoryAvatar ? Math.min(20, Number(context.memoryAvatar?.personalityConfig?.memoryPolicy?.retrieveLimit) || 10) : 5,
        minConfidence: context.isMemoryAvatar ? (Number(context.memoryAvatar?.personalityConfig?.memoryPolicy?.minConfidence) || 0.3) : 0.4,
        agentId: context.isMemoryAvatar ? context.conversationAgentId : undefined,
        retrievalTypeWeights: retrievalBiases.typeWeights,
        retrievalPerspectiveWeights: retrievalBiases.perspectiveWeights,
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
        useVector: true,
        evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
        recordRetrieval: true,
        signal,
      }), context.abortController.signal);
      context.turnAuthorization.assertCurrent();
      context.markTurnTiming('memoryEnd');
      console.log('[ChatHandler] relevantMemories (vector):', relevantMemories.length);

      // RAG: retrieve relevant knowledge chunks from agent-scoped and Lumi knowledge.
      let ragChunks: string[] = context.isMemoryAvatar
        ? buildMemoryAvatarContext(context.uid, context.conversationAgentId, context.text)
        : [];
      const ragAgentIds = context.isMemoryAvatar
        ? [context.conversationAgentId]
        : Array.from(new Set([context.conversationAgentId, 'lumi'].filter(Boolean)));
      for (const ragAgentId of ragAgentIds) {
        const chunks = await runRetrievalRequest(signal => retrieveChunks(context.uid, ragAgentId, context.text, 3, {
          domain: context.resolvedDomain,
          orgId: context.resolvedDomain === 'work' ? context.resolvedOrgId : '',
          signal,
        }), context.abortController.signal);
        context.turnAuthorization.assertCurrent();
        for (const chunk of chunks) {
          const content = (chunk as any).content;
          const citedContent = content ? `${chunk.citation}\n${content}` : '';
          if (citedContent && !ragChunks.includes(citedContent)) ragChunks.push(citedContent);
          if (ragChunks.length >= 5) break;
        }
        if (ragChunks.length >= 5) break;
      }

      context.markTurnTiming('ragEnd');
      // The edition knowledge adapter owns both organization and local case sources.
      let kbContext: string | undefined;
      if (!context.isMemoryAvatar) {
        try {
          kbContext = await runRetrievalRequest(signal => retrieveConversationKnowledge({
            userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId,
          }, context.text, { signal }), context.abortController.signal);
          context.turnAuthorization.assertCurrent();
        } catch (err: any) {
          context.abortController.signal.throwIfAborted();
          console.warn('[ChatHandler] KB search failed:', err.message);
        }
      }

      const emotionKey = scopedEmotionalStateKey(context.uid, context.requestScope, context.isMemoryAvatar ? context.conversationAgentId : undefined);
      const emotionalState = loadEmotionalState(emotionKey);
      const himState = loadHIMState(emotionKey);
      console.log('[ChatHandler] emotionalState loaded');
      const isNovel = relevantMemories.length < 2;
return { relevantMemories, ragChunks, emotionalState, personalityConfig, kbContext, isNovel, himState, emotionKey };
}
