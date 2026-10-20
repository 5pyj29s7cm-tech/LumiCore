import { isPureOperationModeSwitchRequest, type OperationMode } from "../../../cognition/operation_modes";
import { saveStoredOperationMode } from "../../../cognition/operation_mode_store";
import { toolRegistry } from "../../../tools/registry";
import { toolRecordSucceeded } from "../../../cognition/task_execution_ledger";
import type { ToolExecutionRecord } from "../../../tools/types";
import { finalizeLumiResponse } from "../../../cognition/result_finalizer";
import { formatOperationModeSwitchResponse } from "../../../regions/messages/operation_mode_messages";
import { buildForegroundMessagingArguments, executeForegroundMessagingAction } from "../../../cognition/foreground_messaging_execution";
import { formatCnVoiceWeChatSendError, formatCnVoiceWeChatSendResult } from "../../../regions/messages/messaging_messages";
import type { executeVoiceConfirmedAndDeterministicTurn } from './execute_voice_confirmed_and_deterministic_turn';

export async function executeVoiceModeAndMessagingTurn(context: NonNullable<Awaited<ReturnType<typeof executeVoiceConfirmedAndDeterministicTurn>>["context"]>) {


    // Explicit meeting control keeps its immediate client acknowledgement.
    const directlyAppliedMode: OperationMode | null = context.requestedMode === 'meeting' ? 'meeting' : null;
    if (directlyAppliedMode) {
      const modeToolRecord: ToolExecutionRecord = {
        id: `voice-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'client_action',
        arguments: {
          action: 'start_meeting_mode',
          mode: directlyAppliedMode,
          confirmed: true,
        },
        result: '',
      };
      try {
        modeToolRecord.result = await context.desktopRelay('client_action', modeToolRecord.arguments)
          || JSON.stringify({ ok: false, error: 'Client returned no mode-switch receipt' });
      } catch (err: any) {
        modeToolRecord.error = err?.message || String(err);
        context.emitAgent('agent:notification', {
          type: 'client_action',
          level: 'warning',
          message: `Mode switch did not reach the client: ${err?.message || err}`,
        });
      }
      if (!context.isCurrentTurn()) {
        { return { terminal: true as const, context: undefined }; }
      }
      const modeSynced = toolRecordSucceeded(modeToolRecord);
      if (modeSynced) {
        saveStoredOperationMode(context.session.userId, directlyAppliedMode);
      }

      if (isPureOperationModeSwitchRequest(context.userText, context.requestedMode)) {
        context.responseText = formatOperationModeSwitchResponse(directlyAppliedMode, modeSynced, context.userText);
        const finalizedMode = finalizeLumiResponse({
          taskText: context.actionIntentText,
          responseText: context.responseText,
          toolRecords: [modeToolRecord],
          source: 'voice',
          flow: context.turnFlow,
          taskId: context.actionTaskExecution.state?.taskId,
          requestId: context.requestId,
        });
        context.responseText = finalizedMode.text;
        await context.finishVoiceTerminal({
          text: context.responseText,
          source: "voice_mode",
          blocked: finalizedMode.blocked,
          reason: finalizedMode.reason || '',
          cognitiveIntent: finalizedMode.blocked ? 'work_product_guard' : 'operation_mode',
          llmWasCalled: false,
          toolCalls: [modeToolRecord],
          speechText: context.responseText,
          notification: finalizedMode.notification,
          persistTerminalState: () => context.persistVoiceTakeoverExecution(context.responseText, {
            toolRecords: [modeToolRecord],
            source: 'voice_mode',
            sourceInteractionId: `voice_mode_${Date.now()}`,
            finalizationBlocked: finalizedMode.blocked,
            assistantTextTrusted: !finalizedMode.blocked,
            finalizationReason: finalizedMode.reason,
          }),
        }, {
          onCommitted: () => {
            context.persistVoiceLearning(context.responseText, {
              toolRecords: [modeToolRecord],
              sourceInteractionId: `voice_mode_${Date.now()}`,
              logLabel: 'voice mode switch',
            });
          },
        });
        { return { terminal: true as const, context: undefined }; }
      }
    }

    const foregroundWeChatReadArgs = buildForegroundMessagingArguments('read', context.executionPipeline.normalizedIntent);
    const foregroundWeChatSendArgs = buildForegroundMessagingArguments('send', context.executionPipeline.normalizedIntent);
    // Read intent retains precedence: incoming messages must never enter a send capability.
    const foregroundMessagingAction = foregroundWeChatReadArgs ? 'read' : 'send';
    const foregroundMessagingArgs = foregroundWeChatReadArgs || foregroundWeChatSendArgs;
    if (foregroundMessagingArgs && context.toolSessionActive && !context.clientActionOnlyTurn && !context.selfRepairTurn) {
      const reading = foregroundMessagingAction === 'read';
      const source = reading ? 'voice_foreground_messaging_read' : 'voice_foreground_messaging';
      const correlationId = `voice-wechat-${foregroundMessagingAction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let toolRecord: ToolExecutionRecord = { id: correlationId,
        name: reading ? 'wechat_read_recent_chat' : 'wechat_send_message', arguments: foregroundMessagingArgs, result: '' };
      try {
        const foregroundExecution = await executeForegroundMessagingAction({
          action: foregroundMessagingAction, normalizedIntent: context.executionPipeline.normalizedIntent,
          registry: toolRegistry, correlationId,
          arguments: foregroundMessagingArgs, context: context.toolContext,
          onLifecycle: event => context.emitToolLifecycle({ correlationId: event.correlationId,
            name: event.name, arguments: event.arguments,
            ...(event.phase === 'finish' && event.result ? { result: context.formatToolResultForUi(event.result) } : {}),
            ...(event.error ? { error: event.error } : {}),
          }),
        });
        toolRecord = foregroundExecution.record;
        if (toolRecord.error) throw new Error(toolRecord.error);
        if (!context.isCurrentTurn()) {
          { return { terminal: true as const, context: undefined }; }
        }
        const parsed = foregroundExecution.parsed;
        const contact = String(foregroundMessagingArgs.contact || '').trim();
        if (reading) {
          const summary = String(parsed.contentSummary || '').trim();
          const evidence = String(parsed.uiSnapshotPreview || '').slice(0, 1200);
          context.responseText = parsed.read && summary
            ? contact
              ? `我已经定位到你和${contact}的微信聊天。可见最近内容如下：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
              : `我已经读到当前微信聊天的可见最近内容：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
            : parsed.read
              ? contact
                ? `我已经定位到你和${contact}的微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
                : `我已经定位到当前微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
              : `这次还没完成。卡住的位置：微信前台聊天读取。${String(parsed.visionError || parsed.note || '没有拿到可读的聊天内容证据。')}`; // i18n-allow: reviewed Chinese messaging-read blocker.
        } else {
          context.responseText = formatCnVoiceWeChatSendResult(contact, String(foregroundMessagingArgs.message || '').trim(),
            parsed.sent === true && parsed.verificationStatus === 'verified');
        }
      } catch (error: any) {
        toolRecord.error = error?.message || String(error);
        if (!context.isCurrentTurn()) {
          { return { terminal: true as const, context: undefined }; }
        }
        context.responseText = reading
          ? `这次还没完成。卡住的位置：微信前台聊天读取：${toolRecord.error}。我不会把只打开或聚焦微信说成已读到聊天内容。` // i18n-allow: reviewed Chinese messaging-read failure receipt.
          : formatCnVoiceWeChatSendError(toolRecord.error);
      }
      const directFinal = finalizeLumiResponse({ taskText: context.actionIntentText, responseText: context.responseText, toolRecords: [toolRecord],
        source: 'voice', flow: context.turnFlow, taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId });
      context.responseText = directFinal.text;
      const interactionId = () => `voice_wechat_${foregroundMessagingAction}_${Date.now()}`;
      await context.finishVoiceTerminal({ text: context.responseText, source, blocked: directFinal.blocked,
        reason: directFinal.reason || '', cognitiveIntent: directFinal.blocked ? 'work_product_guard' : reading ? 'messaging_read' : 'messaging',
        llmWasCalled: false, toolCalls: [toolRecord], speechText: context.responseText, notification: directFinal.notification,
        persistTerminalState: () => context.persistVoiceTakeoverExecution(context.responseText, { toolRecords: [toolRecord], source,
          sourceInteractionId: interactionId(), finalizationBlocked: directFinal.blocked,
          assistantTextTrusted: !directFinal.blocked, finalizationReason: directFinal.reason }),
      }, {
        onCommitted: () => context.persistVoiceLearning(context.responseText, { toolRecords: [toolRecord], sourceInteractionId: interactionId(),
          logLabel: reading ? 'voice foreground messaging read' : 'voice foreground messaging' }),
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }
  return { terminal: false as const, context };
}
