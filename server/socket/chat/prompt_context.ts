import type { retrieveChatContext } from './context_retrieval';
import type { LumiClientMode } from '../../../shared/operation_modes';
import type { MessageRecord } from '../../conversation/manager';
import type { prepareChatPriorTaskQuery } from './phases/prepare_chat_prior_task_query';

import { buildTaskTargetAnchorProjection } from "../../conversation/task_target_anchor";


import { toolRegistry } from "../../tools/registry";

import type { LumiExecutionPipeline, BuildLumiExecutionPipelineInput } from "../../cognition/execution_pipeline";

import { restrictSystemPromptForExecutionBoundary } from "../../tools/remote_policy";


import { buildModeOverlay, generateSystemPrompt } from "../../personality/engine";
import { personalityRegistry } from "../../personality";



type prepareChatPromptContextInput = NonNullable<Awaited<ReturnType<typeof prepareChatPriorTaskQuery>>['context']> & Pick<Awaited<ReturnType<typeof retrieveChatContext>>, 'emotionalState' | 'personalityConfig'> & {
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

      let effectiveSystemPrompt = restrictSystemPromptForExecutionBoundary(
        systemInstruction,
        context.toolSecurityContext.executionBoundary,
      );

      // Inject conversation mode overlay (shapes interaction style without changing personality)
      if (context.conversationMode) {
        const modeOverlay = buildModeOverlay(context.conversationMode);
        if (modeOverlay) {
          effectiveSystemPrompt += '\n\n' + modeOverlay;
        }
      }
      if (context.pendingConfirmationPrompt) {
        effectiveSystemPrompt += `\n\n${context.pendingConfirmationPrompt}`;
      }
      if (context.actionContinuationBridge) {
        effectiveSystemPrompt += '\n\n' + context.actionContinuationBridge;
      }
      const currentTurnDecisionText = [
        context.visibleUserText || context.text,
        context.mediaRoutingEnvelope,
      ].filter(Boolean).join('\n\n');
      const continuationContext = [context.actionContinuationBridge, context.pendingConfirmationPrompt]
        .filter(Boolean)
        .join('\n\n');
      const executionTaskText = [
        context.text,
        context.actionContinuationBridge,
        context.mediaRoutingEnvelope,
      ].filter(Boolean).join('\n\n');

      const planning: BuildLumiExecutionPipelineInput = {
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
      };
      return { planning, assemble: async (executionPipeline: LumiExecutionPipeline) => {
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


return { turnFlow, executionPipeline, personality, effectiveSystemPrompt, executionTaskText, completionTaskText };
      } };
}
