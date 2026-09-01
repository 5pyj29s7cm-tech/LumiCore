import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function expectFinalizationMetadataOnEveryAgentResponse(relativePath: string): void {
  const code = source(relativePath);
  const matches = Array.from(
    code.matchAll(/(?:socket\.emit|emitAgent|emitBackground)\(\s*['"]agent:response['"]|commit(?:Chat|Task)Terminal(?:Boundary)?\(\s*\{/g),
  );
  expect(matches.length).toBeGreaterThan(0);

  for (const match of matches) {
    const index = match.index ?? 0;
    const line = code.slice(0, index).split('\n').length;
    let responseBlock = code.slice(index, index + 800);
    if (match[0].startsWith('commit')) {
      expect(code).toContain('recordChatExecutionTerminalEventDurably(');
      expect(code).toContain("reason: 'persistence_unknown'");
      continue;
    }
    if (/event\s*:\s*['"]agent:error['"]/.test(responseBlock)) {
      expect(code).toContain('sanitizeChatAgentErrorPayload(payload)');
      continue;
    }
    // Strict terminal boundaries intentionally construct the payload before the
    // publish callback. Follow an identifier argument back to its nearest
    // declaration instead of treating that safer separation as missing
    // metadata.
    const payloadIdentifier = responseBlock.match(
      /(?:socket\.emit|emitAgent|emitBackground)\(\s*['"]agent:response['"]\s*,\s*([A-Za-z_$][\w$]*)/,
    )?.[1];
    if (payloadIdentifier) {
      const declarationIndex = Math.max(
        code.lastIndexOf(`const ${payloadIdentifier} = {`, index),
        code.lastIndexOf(`let ${payloadIdentifier} = {`, index),
      );
      expect(
        declarationIndex,
        `${relativePath}:${line} publishes an undeclared response payload`,
      ).toBeGreaterThanOrEqual(0);
      responseBlock = code.slice(declarationIndex, declarationIndex + 1_200);
    }
    expect(responseBlock, `${relativePath}:${line} is missing finalized metadata`).toMatch(
      /\bfinalized\s*:/,
    );
    expect(responseBlock, `${relativePath}:${line} is missing blocked metadata`).toMatch(
      /\bblocked\s*:/,
    );
    expect(responseBlock, `${relativePath}:${line} is missing reason metadata`).toMatch(
      /\breason\s*:/,
    );
  }
}

describe('finalized output paths', () => {
  it('buffers task model text and finalizes against actual tool records', () => {
    const task = source('server/socket/task.ts');

    expect(task).toContain('shouldDeferModelOutputUntilFinalized');
    expect(task).toContain('createPreFinalizationTextGate');
    expect(task).toContain('const taskTextGate = createPreFinalizationTextGate()');
    expect(task).toContain('if (!taskLease.signal.aborted && !deferTaskModelOutput)');
    expect(task).toContain('const safeText = taskTextGate.push(chunk)');
    expect(task).toContain('taskTextGate.finish()');
    expect(task).toMatch(/(?:const|let) finalTaskToolRecords = attachDesktopReceipt\(result\.toolCalls\)/);
    expect(task).toContain('toolRecords: taskAwareRecords(finalTaskToolRecords)');
    expect(task).toContain('finalized: true');
    expect(task).toContain('blocked: finalTaskResponse.blocked');
  });

  it('keeps ordinary REST streaming but buffers action output until the final SSE event', () => {
    const rest = source('server/routes/chat_routes.ts');

    expect(rest).toContain('const restToolSessionActive = restExecutionPipeline.executionRequested');
    expect(rest).toContain('shouldDeferModelOutputUntilFinalized');
    expect(rest).toContain('createPreFinalizationTextGate');
    expect(rest).toContain('restTextGate.push(chunk)');
    expect(rest).toContain('if (!deferRestStream)');
    expect(rest).toContain('const restModelToolPolicy = restExecutionPipeline.authorizationPolicy');
    expect(rest).toContain('const restModelToolProjection = restExecutionPipeline.modelToolProjection');
    expect(rest).toContain('additionalForbiddenTools: restBoundaryForbiddenTools');
    expect(rest).toContain("'remote_restricted'");
    expect(rest).toContain('toolPolicy: restModelToolPolicy');
    expect(rest).toContain('restModelToolPolicy.maxIterations || 3');
    expect(rest).toContain("finalizeRestToolResult(responseText, result, 'rest_chat_stream')");
    expect(rest).toContain('finalizeExecutionForOutboundDelivery');
    expect(rest).toContain("'rest_chat_guard_recovery'");
    expect(rest).toContain('finalized: true');
    expect(rest).toContain('blocked: finalized.blocked');
  });

  it('gates ordinary socket chat chunks even when input routing did not predict an action', () => {
    const chat = source('server/socket/chat.ts');

    expect(chat).toContain('createPreFinalizationTextGate');
    expect(chat).toContain('const chatTextGate = createPreFinalizationTextGate()');
    expect(chat).toContain('const safeText = chatTextGate.push(chunk)');
    expect(chat).toContain('chatTextGate.finish()');
  });

  it('marks a computer-use done action as a candidate until a later screenshot confirms it', () => {
    const computerUse = source('server/agents/computer_use.ts');

    expect(computerUse).toContain('DONE_CANDIDATE');
    expect(computerUse).toContain('doneCandidate.iteration < i');
    expect(computerUse).toContain("status: blocked ? 'blocked' : 'verified'");
    expect(computerUse).toContain('completionVerified: !blocked');
    expect(computerUse).not.toContain("if (action.action === 'done') return `${prefix} 完成`");
  });

  it('resets frontend finalization state for every new request', () => {
    for (const component of [
      source('src/components/AgentChatPage.tsx'),
      source('src/components/ChatPanel.tsx'),
    ]) {
      expect(component).toContain('currentResponseFinalizationRef');
      expect(component).toContain('currentResponseFinalizationRef.current = finalization');
      expect(component).toContain('currentResponseFinalizationRef.current = null');
    }
  });

  it('marks every socket response with finalization metadata', () => {
    expectFinalizationMetadataOnEveryAgentResponse('server/socket/chat.ts');
    expectFinalizationMetadataOnEveryAgentResponse('server/socket/voice.ts');
    expectFinalizationMetadataOnEveryAgentResponse('server/socket/task.ts');
  });

  it('persists a request-fenced blocked disposition from every foreground socket', () => {
    for (const relativePath of [
      'server/socket/chat.ts',
      'server/socket/voice.ts',
      'server/socket/task.ts',
    ]) {
      const code = source(relativePath);
      expect(code).toContain('terminalTaskDisposition');
      expect(code).toContain("outcome: 'blocked'");
      expect(code).toContain('requestId');
    }
  });

  it('keeps parallel heuristic execution out of model-owned main chat', () => {
    const chat = source('server/socket/chat.ts');
    expect(chat).not.toContain('const completionCandidate = `');
    expect(chat).not.toContain('const finalizedBackground = finalizeLumiResponse({');
    expect(chat).not.toContain('registerBackgroundTask');
    expect(chat).toContain('responseText = finalResponse.text;');
  });

  it('keeps MCP chat chunks, speech, and returns behind the shared finalizer', () => {
    const mcp = source('server/mcp/lumi_server.ts');

    expect(mcp).toContain("import { finalizeLumiResponse } from '../cognition/result_finalizer';");
    expect(mcp).toContain('const bufferedChunks: string[] = [];');
    expect(mcp).toContain('chunk => bufferedChunks.push(chunk)');
    expect(mcp).not.toContain("(chunk) => bc('mcp:chunk'");
    expect(mcp).toContain('finalizeMcpResponseForDelivery({');
    expect(mcp).toContain('finalizeExecutionForOutboundDelivery({');
    expect(mcp).toContain("'mcp_chat_guard_recovery'");
    expect(mcp).toContain("source: background ? 'mcp_chat_background' : 'mcp_chat'");
    expect(mcp).toContain('bc(\'agent:response\', {');
    expect(mcp).toContain('finalized: true');
    expect(mcp).toContain('blocked: finalized.blocked');
    expect(mcp).toContain('const ttsResult = await synthesizeSpeech(finalized.text');
    expect(mcp).toContain("content: [{ type: 'text' as const, text: delivered.finalized.text }]");
    expect(mcp).toContain('.then(backgroundResponse => deliverFinalizedChatResponse(backgroundResponse, true))');
  });

  it('keeps proactive MCP speech behind the shared finalizer', () => {
    const mcp = source('server/mcp/lumi_server.ts');
    const speakStart = mcp.indexOf("'lumi_speak'");
    const speakEnd = mcp.indexOf("'lumi_narrative'", speakStart);
    const speakPath = mcp.slice(speakStart, speakEnd);

    expect(speakStart).toBeGreaterThan(0);
    expect(speakPath).toContain("source: 'mcp_speak'");
    expect(speakPath).toContain('if (finalized.blocked)');
    expect(speakPath).toContain('synthesizeSpeech(finalized.text');
    expect(speakPath).toContain('text: finalized.text');
    expect(speakPath).toContain('finalized: true');
  });

  it('finalizes the single LumiCore MCP route-task result with its real tool ledger', () => {
    const mcp = source('server/mcp/lumi_server.ts');

    expect(mcp).toContain("source: 'mcp_route_task'");
    expect(mcp).toContain('toolRecords: result.toolCalls');
    expect(mcp).toContain('result: finalized.text');
    expect(mcp).not.toContain("action: 'route_task', status: 'completed'");
  });

  it('gates voice model sentences and proactive speech before TTS', () => {
    const voice = source('server/socket/voice.ts');

    expect(voice).toContain('const modelTextGate = createPreFinalizationTextGate()');
    expect(voice).toContain('const safeText = modelTextGate.push(chunk)');
    expect(voice).toContain('modelTextGate.finish()');
    expect(voice).toContain("source: 'voice_action_history'");
    expect(voice).toContain("source: 'proactive_voice'");
    expect(voice).toContain("source: 'voice_greeting'");
    expect(voice.indexOf("source: 'proactive_voice'")).toBeLessThan(
      voice.indexOf('synthesizeSpeech(proactiveText'),
    );
    expect(voice.indexOf("source: 'voice_greeting'")).toBeLessThan(
      voice.indexOf('synthesizeSpeech(spokenGreeting'),
    );
  });

  it('never queues model candidate speech before the shared voice finalizer', () => {
    const voice = source('server/socket/voice.ts');
    const terminalBoundaryStart = voice.indexOf('const commitVoiceTerminal = async');
    const terminalBoundaryEnd = voice.indexOf('const maxIterations =', terminalBoundaryStart);
    const terminalBoundary = voice.slice(terminalBoundaryStart, terminalBoundaryEnd);
    const singleModelStart = voice.indexOf('const streamResult = await makeLLMCallStreaming(');
    const finalizerStart = voice.indexOf('let finalResponse: ReturnType<typeof finalizeLumiResponse>', singleModelStart);
    const finalCommitStart = voice.indexOf('mainTerminalCommitted = await commitVoiceTerminal({', finalizerStart);
    const modelCandidatePath = voice.slice(singleModelStart, finalizerStart);
    const finalCommitPath = voice.slice(finalCommitStart, finalCommitStart + 1_000);

    expect(terminalBoundaryStart).toBeGreaterThan(0);
    expect(singleModelStart).toBeGreaterThan(0);
    expect(finalizerStart).toBeGreaterThan(singleModelStart);
    expect(finalCommitStart).toBeGreaterThan(finalizerStart);
    expect(terminalBoundary.indexOf('recordChatExecutionTerminalEventDurably(')).toBeGreaterThan(0);
    expect(terminalBoundary.indexOf('publishCommitted:')).toBeGreaterThan(
      terminalBoundary.indexOf('recordChatExecutionTerminalEventDurably('),
    );
    expect(terminalBoundary.indexOf('queueFinalizedSpeech(input.speechText!)')).toBeGreaterThan(
      terminalBoundary.indexOf('publishCommitted:'),
    );
    expect(modelCandidatePath).not.toContain('flushSentence(');
    expect(modelCandidatePath).not.toContain('queueFinalizedSpeech(');
    expect(finalCommitPath).toContain('speechText: responseText');
    expect(voice.slice(finalizerStart, finalCommitStart + 1_000)).not.toContain('modelGateSnapshot');
  });

  it('quarantines blocked early-return socket responses from history and learning', () => {
    const chat = source('server/socket/chat.ts');
    const voice = source('server/socket/voice.ts');

    expect(chat).not.toContain('executeSkillWorkflowAdapter');
    expect(chat).not.toContain('persistBackgroundResult(');
    expect(chat).toContain("cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : cognition.intent.category");
    expect(chat).toContain('if (!finalResponse.blocked) {');

    for (const [finalized, committed] of [
      ['finalizedRecentAction', 'recentActionCommitted'],
      ['finalizedWorkflow', 'workflowCommitted'],
      ['finalizedMode', 'modeCommitted'],
      ['quickFinalized', 'quickCommitted'],
      ['confirmedFinal', 'confirmationCommitted'],
    ]) {
      expect(voice).toContain(`cognitiveIntent: ${finalized}.blocked ? 'work_product_guard' :`);
      expect(voice).toContain(`if (${committed} && !${finalized}.blocked) {`);
    }
    expect(voice.match(/cognitiveIntent: directFinal\.blocked \? 'work_product_guard' :/g)).toHaveLength(3);
    for (const committed of [
      'messagingReadCommitted',
      'messagingSendCommitted',
      'cognitionCommitted',
    ]) {
      expect(voice).toContain(`if (${committed} && !directFinal.blocked) {`);
    }
  });

  it('keeps named workflow regex shortcuts out of main chat', () => {
    const chat = source('server/socket/chat.ts');
    expect(chat).not.toContain('runWorkflowMatch');
    expect(chat).not.toContain('workflowQuickResult');
    expect(chat).not.toContain('workflowQuickToolRecords');
    expect(chat).toContain('// ── Model-owned natural-language dispatch');
    expect(chat).not.toContain('buildDeterministicClientNavigationCommand');
    expect(chat).not.toContain('quickFinalized');
  });

  it('falls back to the finalized primary workflow response when a speech summary is blocked', () => {
    const voice = source('server/socket/voice.ts');
    const workflowStart = voice.indexOf('const finalizedWorkflow = finalizeLumiResponse({');
    const workflowEnd = voice.indexOf('return;', workflowStart);
    const workflowPath = voice.slice(workflowStart, workflowEnd);

    expect(workflowPath).toContain('const finalizedWorkflowSpeech = finalizedWorkflow.blocked || !workflowSpeechSummary');
    expect(workflowPath).toContain('const workflowSpeechText = finalizedWorkflowSpeech.blocked');
    expect(workflowPath).toContain('? responseText');
    expect(workflowPath).toContain('const workflowCommitted = await commitVoiceTerminal({');
    expect(workflowPath).toContain('speechText: workflowSpeechText');
    expect(workflowPath).not.toContain('queueFinalizedSpeech(');
  });

  it('keeps chat on one canonical route with the shared capability policy and finalizer', () => {
    const chat = source('server/routes/chat_routes.ts');
    const misc = source('server/routes/misc_routes.ts');

    expect(chat).toContain('buildLumiTurnDispatch({');
    expect(chat).toContain('buildLumiExecutionPipeline({');
    expect(chat).toContain('restExecutionPipeline.authorizationPolicy');
    expect(chat).toContain('toolPolicy: restModelToolPolicy');
    expect(chat).toContain('finalizeRestChatResponse({');
    expect(chat).toContain("source: 'rest_chat'");
    expect(chat).toContain('blocked: finalized.blocked');
    expect(chat).toContain('reason: finalized.reason');
    expect(misc).not.toContain('router.post("/chat"');
    expect(misc).not.toContain('router.post("/ai/chat"');
  });

  it('keeps autonomous, scheduler, tool telemetry, and idle UI states out of false completion', () => {
    const autonomous = source('server/autonomy/task_executor.ts');
    const ambient = source('server/socket/ambient.ts');
    const feed = source('src/components/AutonomousFeed.tsx');
    const desktop = source('src/components/DesktopUI.tsx');
    const proactive = source('src/components/ProactiveNotifications.tsx');
    const scheduler = source('server/scheduler.ts');

    expect(autonomous).toContain('evaluateAutonomousTaskOutcome');
    expect(autonomous).toContain('finalizeAutonomousTaskOutcomeForDelivery');
    expect(autonomous).toContain('finalizeExecutionForOutboundDelivery');
    expect(autonomous).toContain('toolRecords,');
    expect(autonomous).toContain('if (!outcome.verified || !terminalAcceptance?.accepted)');
    expect(autonomous).toContain('verified: true');
    expect(autonomous).not.toContain('Completed with ${toolCallCount} tool calls.');
    const linkedPlanStart = autonomous.indexOf('function markLinkedPlanCompleted');
    const linkedPlanEnd = autonomous.indexOf('function markLinkedPlanFailed', linkedPlanStart);
    const linkedPlanPath = autonomous.slice(linkedPlanStart, linkedPlanEnd);
    expect(linkedPlanPath).toContain("plan.steps.find(item => item.status === 'in_progress')");
    expect(linkedPlanPath).not.toContain('for (const step of plan.steps)');
    expect(linkedPlanPath).not.toContain("status: 'completed'");
    expect(ambient).toContain('isVerifiedAutonomousHistoryItem(t)');
    expect(feed).toContain('isVerifiedAutonomousCompletionPayload(data)');

    const idleStart = desktop.indexOf("} else if (data.status === 'idle') {");
    const idleEnd = desktop.indexOf("} else if (data.status === 'error') {", idleStart);
    const idleBranch = desktop.slice(idleStart, idleEnd);
    expect(idleBranch).toContain("setAgentStatus('idle')");
    expect(idleBranch).not.toContain("setAgentStatus('done')");
    expect(idleBranch).not.toContain('workflowCompleted');
    expect(desktop).toContain('const responseBlocked = (');
    expect(desktop).toContain('data.finalized !== true');
    expect(desktop).toContain('data.blocked === true');
    expect(desktop).toContain("['cancelled', 'canceled', 'voiceprint_rejected'].includes(terminalReason)");
    expect(desktop).toContain("setAgentStatus(responseBlocked ? 'error' : 'done')");
    expect(desktop).not.toContain("text: `${data.name} ${t.workflowToolDone || 'done'}`");

    expect(proactive).toContain('export function classifyToolNotification');
    expect(proactive).not.toContain("socket.on('agent:tool_call'");
    expect(proactive).not.toContain("from 'sonner'");
    expect(proactive).not.toContain('toast.success(`Tool:');
    expect(scheduler).toContain('finalizeScheduledDelivery(task.id, delivery)');
    expect(scheduler).toContain('sanitizeExecutionResponseForDelivery(finalizeLumiResponse({');
    expect(scheduler).toContain('modelGenerated: true');
    expect(scheduler).toContain('if (!deliveryFinalization.delivery)');
  });

  it('routes every non-socket conversational surface through the shared outbound boundary', () => {
    const rest = source('server/routes/chat_routes.ts');
    const mcp = source('server/mcp/lumi_server.ts');
    const messaging = source('server/regions/packs/cn/messaging_routes.ts');

    expect(rest).toContain('finalizeExecutionForOutboundDelivery({');
    expect(mcp).toContain('finalizeExecutionForOutboundDelivery({');
    expect(messaging).toContain('finalizeMessagingResponseForDelivery({');
    expect(messaging).toContain('finalizeExecutionForOutboundDelivery({');
    expect(messaging).toContain('`${source}_guard_recovery`');
    expect(rest.match(/\bfinalizeLumiResponse\(\{/g)).toHaveLength(2);
    expect(mcp.match(/\bfinalizeLumiResponse\(\{/g)).toHaveLength(2);
  });

  it('uses one guarded summary scheduler for chat and every persisted voice path', () => {
    const chat = source('server/socket/chat.ts');
    const voice = source('server/socket/voice.ts');
    const ambient = source('server/socket/ambient.ts');

    expect(chat).toContain("from \"../conversation/summary_scheduler\"");
    expect(voice).toContain("from \"../conversation/summary_scheduler\"");
    expect(chat).toContain('scheduleChatSummary(conversationId)');
    expect(voice).toContain('const persistVoiceAssistantMessage = (');
    const terminalBoundaryStart = voice.indexOf('const commitVoiceTerminal = async');
    const terminalBoundaryEnd = voice.indexOf('const maxIterations =', terminalBoundaryStart);
    const terminalBoundary = voice.slice(terminalBoundaryStart, terminalBoundaryEnd);
    expect(voice.match(/await commitVoiceTerminal\(\{/g)?.length || 0).toBeGreaterThanOrEqual(13);
    expect(terminalBoundary).toContain('persistVoiceAssistantMessage(');
    expect(terminalBoundary).toContain('recordChatExecutionTerminalEventDurably(');
    expect(terminalBoundary).toContain('publishCommitted:');
    expect(terminalBoundary).toContain('scheduleVoiceSummary(conversationTurn.conversation.id)');
    expect(terminalBoundary.indexOf('scheduleVoiceSummary(conversationTurn.conversation.id)')).toBeGreaterThan(
      terminalBoundary.indexOf('publishCommitted:'),
    );
    expect(ambient).toContain('Auto-summary eligible for conversation');
    expect(ambient).not.toContain('Triggered auto-summary');
  });

  it('writes current early execution ledgers back without replaying history or hijacking unrelated tasks', () => {
    const chat = source('server/socket/chat.ts');
    const voice = source('server/socket/voice.ts');
    const writeback = source('server/work_takeover/execution_writeback.ts');

    expect(chat).toContain('const persistChatTakeoverExecution = (');
    expect(voice).toContain('const persistVoiceTakeoverExecution = (');
    expect(chat).toContain('if (currentToolRecords.length === 0) return null;');
    expect(voice).toContain('if (currentToolRecords.length === 0) return null;');
    expect(chat.match(/persistChatTakeoverExecution\(/g)?.length || 0).toBeGreaterThanOrEqual(2);
    expect(chat).not.toContain('executeSkillWorkflowAdapter');
    expect(voice.match(/persistVoiceTakeoverExecution\(/g)?.length || 0).toBeGreaterThanOrEqual(6);
    expect(writeback).toContain('input.flow.workTakeover.shouldResumeTask');

    expect(chat).not.toContain('registerBackgroundTask');
    for (const marker of [
      "source: 'voice_mode'",
      "source: 'voice_quick_command'",
      "source: 'voice_foreground_messaging'",
      "source: 'voice_confirmation'",
      "source: 'voice_cognition_direct'",
    ]) {
      expect(voice).toContain(marker);
    }

    const chatHistoryStart = chat.indexOf('const recentFailureExplanation =');
    const chatHistoryEnd = chat.indexOf('let pendingConfirmationCreatedThisTurn', chatHistoryStart);
    const chatHistoryPath = chat.slice(chatHistoryStart, chatHistoryEnd);
    expect(chatHistoryPath).toContain('groundedTurnEvidence.push');
    expect(chatHistoryPath).not.toContain('agent:response');
    expect(chatHistoryPath).not.toContain('persistChatTakeoverExecution(');
    const voiceHistoryStart = voice.indexOf('if (recentActionExplanation) {');
    const voiceHistoryEnd = voice.indexOf('const specialWorkflow =', voiceHistoryStart);
    expect(voice.slice(voiceHistoryStart, voiceHistoryEnd)).not.toContain('persistVoiceTakeoverExecution(');

    expect(chat).not.toContain('const terminalBackgroundRecords: ToolExecutionRecord[] = backgroundToolRecords.length > 0');
  });
});
