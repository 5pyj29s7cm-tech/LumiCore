import type { prepareChatPriorTaskQuery } from './phases/prepare_chat_prior_task_query';

import { loadEmotionalState, loadHIMState } from "../../personality/state";

import { personalityRegistry } from "../../personality";



import { scopedEmotionalStateKey } from "../scope";

type retrieveChatContextInput = NonNullable<Awaited<ReturnType<typeof prepareChatPriorTaskQuery>>['context']>;
export async function retrieveChatContext(context: retrieveChatContextInput) {

      const personalityConfig = context.isMemoryAvatar && context.memoryAvatar?.personalityConfig
        ? context.memoryAvatar.personalityConfig
        : personalityRegistry.getForUser(
            context.personalityId,
            context.uid,
            context.resolvedDomain === 'work' ? context.resolvedOrgId : undefined,
          );
      console.log('[ChatHandler] personalityConfig:', !!personalityConfig);
      const emotionKey = scopedEmotionalStateKey(context.uid, context.requestScope, context.isMemoryAvatar ? context.conversationAgentId : undefined);
      const emotionalState = loadEmotionalState(emotionKey);
      const himState = loadHIMState(emotionKey);
      console.log('[ChatHandler] emotionalState loaded');
return { emotionalState, personalityConfig, himState, emotionKey };
}
