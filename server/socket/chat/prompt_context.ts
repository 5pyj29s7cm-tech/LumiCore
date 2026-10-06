import type { retrieveChatContext } from './context_retrieval';
import type { LumiClientMode } from '../../../shared/operation_modes';
import type { MessageRecord } from '../../conversation/manager';
import type { prepareChatPriorTaskQuery } from './phases/prepare_chat_prior_task_query';

import { buildTaskTargetAnchorProjection } from "../../conversation/task_target_anchor";

import { toolRegistry } from "../../tools/registry";

import { buildLumiExecutionPipeline } from "../../cognition/execution_pipeline";

import { restrictSystemPromptForExecutionBoundary } from "../../tools/remote_policy";

import { buildLumiRuntimeCapabilityContext } from "../../cognition/capability_context";

import { buildModeOverlay, generateSystemPrompt } from "../../personality/engine";
import { personalityRegistry } from "../../personality";

import { getConversationSummary, getTopicContext } from "../../conversation/manager";

import { buildProfessionOverlay } from "../../autonomy/professions";

type prepareChatPromptContextInput = NonNullable<Awaited<ReturnType<typeof prepareChatPriorTaskQuery>>['context']> & Pick<Awaited<ReturnType<typeof retrieveChatContext>>, 'relevantMemories' | 'ragChunks' | 'emotionalState' | 'personalityConfig' | 'kbContext'> & {
  conversationId: string;
  conversationMode: string;
  operationMode: LumiClientMode;
  persistedConversationHistory: MessageRecord[];
};
export async function prepareChatPromptContext(context: prepareChatPromptContextInput) {

      const sensory = context.sensoryFn(context.uid);
      console.log('[ChatHandler] sensory loaded');
      const personalityContext = {
        mode: 'chat' as const,
        sensory,
      };
      const personalityOptions = {
        memories: context.relevantMemories.length > 0 ? context.relevantMemories : undefined,
        ragKnowledge: context.ragChunks.length > 0 ? context.ragChunks : undefined,
        emotionalState: context.emotionalState,
        userId: context.uid,
        userText: context.text,
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
      };
      const { config: personality, systemPrompt: systemInstruction } = context.isMemoryAvatar
        ? {
            config: context.personalityConfig,
            systemPrompt: generateSystemPrompt(
              context.personalityConfig as any,
              personalityContext,
              personalityOptions,
            ),
          }
        : personalityRegistry.buildSystemPrompt(
            context.personalityId,
            personalityContext,
            personalityOptions,
          );
      console.log('[ChatHandler] systemPrompt built, personality name:', personality?.name);

      // Inject conversation summary chain for long-running conversations (anti-entropy)
      let effectiveSystemPrompt = restrictSystemPromptForExecutionBoundary(
        systemInstruction,
        context.toolSecurityContext.executionBoundary,
      );
      if (context.conversationId) {
        const summaryContext = getConversationSummary(context.conversationId);
        if (summaryContext) {
          effectiveSystemPrompt += `\n\n## Conversation Context\n${summaryContext}`;
        }
      }
      // Topic continuity: inject recent conversation topics
      if (context.conversationId) {
        const topicCtx = getTopicContext(context.conversationId);
        if (topicCtx) {
          effectiveSystemPrompt += topicCtx;
        }
      }

      // Inject conversation mode overlay (shapes interaction style without changing personality)
      if (context.conversationMode) {
        const modeOverlay = buildModeOverlay(context.conversationMode);
        if (modeOverlay) {
          effectiveSystemPrompt += '\n\n' + modeOverlay;
        }
      }
      effectiveSystemPrompt += '\n\n' + context.buildNaturalReplyStyleOverlay(context.eventSource);
      if (context.toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\nFile handling rule: attachments supplied in this request may be newly added files or verified material carried forward by the client within this same conversation. Treat their copied local paths, extracted text, and transcripts as available conversation material and keep using them for follow-up questions. Ask the user to reattach only when no usable attachment/path is supplied or a supplied path is unreadable; never ask merely because the material first appeared in an earlier turn.';
      }
      if (context.pendingConfirmationPrompt) {
        effectiveSystemPrompt += `\n\n${context.pendingConfirmationPrompt}`;
      }
      if (context.chatContextBridge) {
        effectiveSystemPrompt += '\n\n' + context.chatContextBridge;
      }
      if (context.actionContinuationBridge) {
        effectiveSystemPrompt += '\n\n' + context.actionContinuationBridge;
      }
      const currentTurnDecisionText = [
        context.visibleUserText || context.text,
        context.mediaRoutingEnvelope,
      ].filter(Boolean).join('\n\n');
      const continuationContext = [context.chatContextBridge, context.actionContinuationBridge, context.pendingConfirmationPrompt]
        .filter(Boolean)
        .join('\n\n');
      const executionTaskText = [
        context.text,
        context.actionContinuationBridge,
        context.mediaRoutingEnvelope,
      ].filter(Boolean).join('\n\n');

      const executionPipeline = buildLumiExecutionPipeline({
        requestId: context.requestId, userText: context.visibleUserText || context.text, acceptedResolution: context.acceptedTurnResolution,
        structuredMediaRequest: context.structuredMediaRequest,
        dispatch: {
          userId: context.uid,
          text: currentTurnDecisionText,
          continuationContext,
          channel: 'chat',
          source: context.eventSource,
          category: context.category,
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          operationMode: context.operationMode,
          targetIsLumi:
            personality.id === 'lumi' ||
            context.conversationAgentId === 'lumi' ||
            /lumi/i.test(currentTurnDecisionText),
        },
        registry: toolRegistry,
        personalityToolPolicy: personality.toolPolicy,
        actionTaskState: context.conversation?.actionContinuationState,
        taskRelation: context.resolvedTaskRelation,
        persistedConversationHistory: context.persistedConversationHistory,
        pendingAssistantOfferContext: context.pendingAssistantOfferContext,
        isSanctuary: context.isMemoryAvatar,
        executionBoundary: context.toolSecurityContext.executionBoundary,
        traceText: currentTurnDecisionText,
        source: context.eventSource,
      });
      context.resolvedTaskRelation = executionPipeline.taskRelation;
      const turnDispatch = executionPipeline.turnIntent;
      const turnFlow = turnDispatch.flow;
      turnFlow.currentAttachmentPaths = context.attachments.map(item => item.path).filter((value): value is string => Boolean(value));
      // i18n-allow: Explicit reference to current uploaded material.
      if (!turnFlow.acceptedTaskTarget && turnFlow.currentAttachmentPaths.length === 1 && /附件|\battachment\b/iu.test(context.visibleUserText)) {
        const projection = buildTaskTargetAnchorProjection({ taskText: context.visibleUserText, sourcePaths: turnFlow.currentAttachmentPaths });
        if (projection.pathResolved) turnFlow.acceptedTaskTarget = { target: projection.target, source: 'current_turn', sourceId: context.requestId };
      }
      const completionTaskText = executionPipeline.trustedActionContinuation
        ? context.conversation?.actionContinuationState?.goal || executionTaskText
        : executionTaskText;
      if (context.toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + turnDispatch.promptOverlay;
        effectiveSystemPrompt += '\n\n' + turnFlow.promptOverlay;
      }
      if (context.toolSecurityContext.executionBoundary !== 'remote_restricted' && executionPipeline.executionRequested) {
        effectiveSystemPrompt += '\n\n' + buildLumiRuntimeCapabilityContext({
          userId: context.uid,
          text: turnFlow.routeText,
          flow: turnFlow,
          toolRegistry,
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
        });
      }

      // Inject company knowledge base context when in work domain
      if (context.kbContext) {
        effectiveSystemPrompt += `\n\n## Company Knowledge Base\n${context.kbContext}\n\nUse the above company knowledge to inform your response. Cite article titles when referencing company policy.`;
      }

      // Inject profession context — adapt language and expertise to user's trade
      try {
        const professionOverlay = context.resolvedDomain === 'personal' ? buildProfessionOverlay() : null;
        if (professionOverlay) {
          effectiveSystemPrompt += professionOverlay;
        }
      } catch {}

      // Inject contact context when user mentions people they know
      if (context.resolvedDomain === 'personal') try {
        const { matchContactsFromText } = await import('../../contacts/store');
        const { formatContactsForContext } = await import('../../contacts/context');
        const mentioned = matchContactsFromText(context.uid, context.text);
        if (mentioned.length > 0) {
          effectiveSystemPrompt += '\n\n' + formatContactsForContext(mentioned);
          effectiveSystemPrompt += '\n\nYou know these people personally. Use this information to provide relevant, contextual responses when the user asks about them.';
        }
      } catch {}
return { turnFlow, executionPipeline, personality, effectiveSystemPrompt, executionTaskText, completionTaskText };
}
