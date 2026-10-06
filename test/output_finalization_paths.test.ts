import { readImplementationSource } from './implementation_source';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readImplementationSource(path.join(process.cwd(), relativePath), 'utf8');
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
  it('keeps ordinary REST streaming but buffers action output until the final SSE event', () => {
    const rest = source('server/routes/chat_routes.ts');

    expect(rest).toContain('const deferRestStream = execution.executionRequested');
    expect(rest).toContain('shouldDeferModelOutputUntilFinalized');
    expect(rest).toContain('createPreFinalizationTextGate');
    expect(rest).toContain('restTextGate.push(chunk)');
    expect(rest).toContain('return await runLumiEntryTurn({');
    expect(source('server/cognition/turn_execution.ts')).toContain('...assembled.model, execution, messages, assertCurrent');
    expect(source('server/cognition/turn_model.ts')).toContain('modelToolProjection: execution.modelToolProjection');
    expect(rest).toContain('executionBoundary,');
    expect(rest).toContain("'remote_restricted'");
    expect(source('server/cognition/turn_model.ts')).toContain('toolPolicy: execution.authorizationPolicy');
    expect(rest).toContain('execution.authorizationPolicy.maxIterations || 3');
    expect(rest).toContain('runLumiEntryTurn({');
    expect(source('server/cognition/turn_execution.ts')).toContain('await runPreparedLumiTurn({');
    expect(source('server/cognition/prepared_turn.ts')).toContain('await finalizeLumiResponseForDelivery({');
    expect(source('server/cognition/response_delivery.ts')).toContain('finalizeExecutionForOutboundDelivery');
    expect(source('server/cognition/prepared_turn.ts')).toContain("input.model.context?.source || input.model.config.source || source) + '_guard_recovery'");
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
    ]) {
      expect(component).toContain('currentTurnUiMetaRef');
      expect(component).toContain('currentTurnUiMetaRef.current.finalization = finalization');
      expect(component).toContain('currentTurnUiMetaRef.current = { hadTool: false, needsEvidence: false, finalization: null }');
      expect(component).not.toContain('currentResponseFinalizationRef');
    }
  });

  it('marks every socket response with finalization metadata', () => {
    expectFinalizationMetadataOnEveryAgentResponse('server/socket/chat.ts');
    expectFinalizationMetadataOnEveryAgentResponse('server/socket/voice.ts');
  });

  it('persists a request-fenced blocked disposition from every foreground socket', () => {
    for (const relativePath of [
      'server/socket/chat.ts',
      'server/socket/voice.ts',
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

  it('keeps MCP chunks, speech and returns behind the shared durable turn driver', () => {
    const mcp = source('server/mcp/lumi_server.ts');
    const driver = source('server/cognition/turn_execution.ts');
    expect(mcp).toContain('const responsePromise = runLumiEntryTurn({');
    expect(source('server/mcp/server_tools/conversation.ts')).not.toContain('finalizeLumiResponseForDelivery({');
    expect(mcp).not.toContain('runResolvedLumiTurn(');
    expect(driver).toContain('await runPreparedLumiTurn({');
    expect(source('server/cognition/prepared_turn.ts')).toContain('await finalizeLumiResponseForDelivery({');
    expect(source('server/cognition/prepared_turn.ts')).toContain("input.model.context?.source || input.model.config.source || source) + '_guard_recovery'");
    expect(driver.indexOf('await commit(finalized,')).toBeLessThan(driver.indexOf('return await input.deliver(executed)'));
    expect(mcp).toContain('const deliver = async ({ finalized, toolRecords }: ExecutedLumiTurn)');
    expect(mcp).toContain("source: 'mcp_chat', action: 'chat'");
    expect(mcp).toContain("deliverySource: () => background ? entry.source + '_background' : entry.source");
    expect(mcp).toContain("emit('agent:response', {");
    expect(mcp).toContain('finalized: true');
    expect(mcp).toContain('blocked: finalized.blocked');
    expect(mcp).toContain('const ttsResult = await synthesizeSpeech(finalized.text');
    expect(mcp).toContain("content: [{ type: 'text' as const, text: delivered.finalized.text }]");
    expect(mcp).not.toContain("chunk => emit('mcp:chunk'");
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
    expect(mcp).toContain("runMcpConversationTurn(runtime, { message: task, personalityId: 'lumi' }, MCP_TASK_ENTRY)");
    expect(source('server/cognition/prepared_turn.ts')).toContain('mergeToolExecutionRecords(input.toolRecords || [], result.toolCalls || [])');
    expect(source('server/cognition/prepared_turn.ts')).toContain('taskId: input.taskId, requestId: input.requestId');
    expect(mcp).toContain('result: response.content[0].text');
    expect(mcp).toContain('text: delivered.finalized.text');
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
    const driver = source('server/cognition/prepared_turn.ts');
    const modelEntry = source('server/socket/voice/turn/execute_voice_model_turn.ts');
    const deliveryEntry = source('server/socket/voice/turn/finalize_voice_model_turn.ts');
    const terminalBoundaryStart = voice.indexOf('const commitVoiceTerminal = async');
    const terminalBoundaryEnd = voice.indexOf('const maxIterations =', terminalBoundaryStart);
    const terminalBoundary = voice.slice(terminalBoundaryStart, terminalBoundaryEnd);
    const modelStart = driver.indexOf('await runResolvedLumiTurn(input.model)');
    const finalizerStart = driver.indexOf('await finalizeLumiResponseForDelivery({');
    expect(modelStart).toBeGreaterThan(0); expect(finalizerStart).toBeGreaterThan(modelStart);
    expect(modelEntry).toContain('const completed = await runPreparedLumiTurn({');
    expect(modelEntry).toContain('execution: context.executionPipeline');
    expect(modelEntry).toContain('context.responseText = completed.finalized.text;');
    expect(deliveryEntry).toContain('const finalResponse = context.finalResponse;');
    expect(deliveryEntry).toContain('mainTerminalCommitted = await context.finishVoiceTerminal({');
    expect(deliveryEntry).not.toContain('runResolvedLumiRecovery');
    expect(source('server/cognition/turn_model.ts')).toContain('if (!execution.executionRequested)');
    expect(terminalBoundaryStart).toBeGreaterThan(0);
    expect(terminalBoundary.indexOf('persistAuthorizedTerminalReceipt(')).toBeGreaterThan(0);
    expect(terminalBoundary.indexOf('publishCommitted:')).toBeGreaterThan(terminalBoundary.indexOf('persistAuthorizedTerminalReceipt('));
    expect(terminalBoundary.indexOf('queueFinalizedSpeech(input.speechText!)')).toBeGreaterThan(terminalBoundary.indexOf('publishCommitted:'));
    expect(modelEntry).not.toContain('flushSentence('); expect(modelEntry).not.toContain('queueFinalizedSpeech(');
    expect(modelEntry).toContain('const onChunk = (chunk: string) => {');
    expect(modelEntry).toContain('context.modelTextGate.finish();');
    expect(deliveryEntry).toContain('speechText: context.responseText');
    expect(deliveryEntry).not.toContain('modelGateSnapshot');
  });

  it('quarantines blocked early-return socket responses from history and learning', () => {
    const chat = source('server/socket/chat.ts');
    const voice = source('server/socket/voice.ts');

    expect(chat).not.toContain('executeSkillWorkflowAdapter');
    expect(chat).not.toContain('persistBackgroundResult(');
    expect(chat).toContain("cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : executionPipeline.normalizedIntent.kind");
    expect(chat).toContain('if (!finalResponse.blocked) {');

    for (const finalized of ['finalizedRecentAction', 'finalizedMode', 'confirmedFinal']) {
      expect(voice).toContain(`cognitiveIntent: ${finalized}.blocked ? 'work_product_guard' :`);
    }
    expect(voice.match(/cognitiveIntent: directFinal\.blocked \? 'work_product_guard' :/g)).toHaveLength(1);
    expect(voice.match(/await finishVoiceTerminal\(\{/g)?.length).toBeGreaterThanOrEqual(4);
    expect(voice).not.toContain('await commitVoiceTerminal(');
    expect(voice).toContain('commit: commitVoiceTerminal');
    const completion = source('server/socket/voice/terminal_completion.ts');
    expect(completion).toContain('if (committed && !input.blocked) options.onCommitted?.()');
    expect(completion.indexOf('if (!deps.isCurrent())')).toBeLessThan(completion.indexOf('options.onCommitted?.()'));

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

  it('keeps both interactive transports on model-owned natural-language execution', () => {
    for (const file of ['server/socket/chat.ts', 'server/socket/voice.ts']) {
      const entry = source(file);
      expect(entry).not.toContain('executeSkillWorkflowAdapter');
      expect(entry).not.toContain('preMatchedQuickResult');
      expect(entry).not.toContain('quickFinalized');
      expect(entry).toContain('runPreparedLumiTurn({');
    }
  });

  it('keeps chat on one canonical route with the shared capability policy and finalizer', () => {
    const chat = source('server/routes/chat_routes.ts');
    const misc = source('server/routes/misc_routes.ts');

    expect(chat).toContain('runLumiEntryTurn({');
    const driver = source('server/cognition/turn_execution.ts');
    expect(driver).toContain('buildLumiExecutionPipeline({');
    expect(chat).toContain('execution.authorizationPolicy.maxIterations || 3');
    expect(driver).toContain('...assembled.model, execution, messages, assertCurrent');
    expect(source('server/cognition/turn_model.ts')).toContain('toolPolicy: execution.authorizationPolicy');
    expect(driver).toContain('await runPreparedLumiTurn({');
    expect(source('server/cognition/prepared_turn.ts')).toContain('await finalizeLumiResponseForDelivery({');
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
    const scheduler = source('server/scheduler.ts') + source('server/scheduler/delivery_finalization.ts') + source('server/scheduler/builtins/personal_memory.ts') + source('server/scheduler/builtins/growth.ts');

    expect(autonomous).toContain('evaluateAutonomousTaskOutcome');
    expect(autonomous).toContain('finalizeAutonomousTaskOutcomeForDelivery');
    expect(autonomous).toContain('finalizeExecutionForOutboundDelivery');
    expect(autonomous).toContain('toolRecords,');
    expect(autonomous).toContain('if (!outcome.verified || !terminalAcceptance?.accepted)');
    expect(autonomous).toContain('verified: true');
    expect(autonomous).not.toContain('Completed with ${toolCallCount} tool calls.');
    const planner = source('server/autonomy/planner.ts');
    const linkedPlanStart = planner.indexOf('export function stageAutonomousPlanCompletion(');
    const linkedPlanEnd = planner.indexOf('function normalizeScope(', linkedPlanStart);
    expect(linkedPlanStart).toBeGreaterThanOrEqual(0);
    expect(linkedPlanEnd).toBeGreaterThan(linkedPlanStart);
    const linkedPlanPath = planner.slice(linkedPlanStart, linkedPlanEnd);
    expect(linkedPlanPath).toContain("plan.steps.find(candidate => candidate.status === 'in_progress')");
    expect(linkedPlanPath).toContain("plan.steps.find(candidate => candidate.status === 'pending')");
    expect(linkedPlanPath.match(/\bstep\.status\s*=\s*'done'/g)).toHaveLength(1);
    expect(linkedPlanPath).not.toContain('for (const step of plan.steps)');
    expect(linkedPlanPath).toContain("if (plan.steps.every(candidate => candidate.status === 'done' || candidate.status === 'skipped'))");
    expect(linkedPlanPath.indexOf("plan.status = 'completed'")).toBeGreaterThan(linkedPlanPath.indexOf('if (plan.steps.every('));
    const hideUnsavedPlan = linkedPlanPath.indexOf('pendingAutonomousPlanCompletions.set(taskId, pending)');
    expect(hideUnsavedPlan).toBeGreaterThanOrEqual(0);
    expect(linkedPlanPath.indexOf('commitDatabaseTables(db)')).toBeGreaterThan(hideUnsavedPlan);
    expect(planner).toContain('.map(projectPlanCompletion)');
    expect(planner).toContain('return plan ? projectPlanCompletion(plan) : null');
    expect(autonomous).toContain('stageAutonomousPlanCompletion(task.id, task.planId, planScopeForTask(task), clipPlanResult(summary))');
    const planSaveStart = autonomous.indexOf('async function flushAutonomousTaskFinalizations(');
    const planSaveEnd = autonomous.indexOf('export async function retryAutonomousTaskFinalizations(', planSaveStart);
    expect(planSaveStart).toBeGreaterThanOrEqual(0);
    expect(planSaveEnd).toBeGreaterThan(planSaveStart);
    const planSavePath = autonomous.slice(planSaveStart, planSaveEnd);
    const saveBarrier = planSavePath.indexOf('await persistAutonomousTaskQueue()');
    const exposeSavedPlan = planSavePath.indexOf('completion.confirmPlanSaved?.()');
    expect(saveBarrier).toBeGreaterThanOrEqual(0);
    expect(exposeSavedPlan).toBeGreaterThan(saveBarrier);
    expect(planSavePath.indexOf('io.to(completion.room).emit(')).toBeGreaterThan(exposeSavedPlan);
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

    const delivery = source('server/cognition/response_delivery.ts');
    expect(rest).toContain('runLumiEntryTurn({');
    expect(source('server/cognition/turn_execution.ts')).toContain('await runPreparedLumiTurn({');
    expect(source('server/cognition/prepared_turn.ts')).toContain('await finalizeLumiResponseForDelivery({');
    expect(delivery).toContain('finalizeExecutionForOutboundDelivery({');
    expect(mcp).toContain('runLumiEntryTurn({');
    expect(source('server/cognition/turn_execution.ts')).toContain('await runPreparedLumiTurn({');
    expect(source('server/cognition/prepared_turn.ts')).toContain('await finalizeLumiResponseForDelivery({');
    expect(messaging).toContain('finalizeMessagingResponseForDelivery({');
    expect(messaging).toContain('finalizeLumiResponseForDelivery({ ...input, toolRecords: currentMessagingFinalizationRecords(input) });');
    const messagingModel = source('server/regions/packs/cn/messaging_turn/model_execution.ts');
    expect(messagingModel).toContain('await runPreparedLumiTurn({');
    expect(messagingModel).toContain('source: context.source, taskText: context.routingText');
    expect(messagingModel).not.toContain('runResolvedLumiRecovery(');
    expect(delivery.match(/\bfinalizeLumiResponse\(\{/g)).toHaveLength(1);
    expect(delivery).toContain('input.initialFinalization || finalize(input.responseText, toolRecords, input.source, input.completionGuard)');
    expect(delivery).toContain('input.refinalize || ((candidateText, records, completionGuard) => finalize(candidateText, records, `${input.source}_guard_recovery`, completionGuard))');
    expect(rest).not.toMatch(/\bfinalizeLumiResponse\(\{/);
    expect(mcp).not.toMatch(/\bfinalizeLumiResponse\(\{/);
    expect(mcp).not.toContain('async function finalizeMcpResponseForDelivery');
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
    expect(voice.match(/await (?:commitVoiceTerminal|finishVoiceTerminal)\(\{/g)?.length || 0).toBe(11);
    expect(terminalBoundary).toContain('persistVoiceAssistantMessage(');
    expect(terminalBoundary).toContain('persistAuthorizedTerminalReceipt(');
    expect(source('server/socket/chat_terminal_boundary.ts')).toContain('recordChatExecutionTerminalEventDurably(');
    expect(terminalBoundary).toContain('publishCommitted:');
    expect(terminalBoundary).toContain('scheduleVoiceSummary(conversationTurn.conversation.id)');
    expect(terminalBoundary.indexOf('scheduleVoiceSummary(conversationTurn.conversation.id)')).toBeGreaterThan(
      terminalBoundary.indexOf('publishCommitted:'),
    );
    expect(ambient).not.toContain('triggerIdleProcessing');
    expect(ambient).not.toContain('readDB');
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
    expect(voice.match(/persistVoiceTakeoverExecution\(/g)?.length || 0).toBe(3);
    expect(writeback).toContain('input.flow.workTakeover.shouldResumeTask');

    expect(chat).not.toContain('registerBackgroundTask');
    for (const marker of [
      "source: 'voice_mode'",
      "source: 'voice_confirmation'",
    ]) {
      expect(voice).toContain(marker);
    }

    expect(voice).toContain("const source = reading ? 'voice_foreground_messaging_read' : 'voice_foreground_messaging'");
    expect(voice).toContain('persistVoiceTakeoverExecution(responseText, { toolRecords: [toolRecord], source,');
    const chatHistoryStart = chat.indexOf('const recentFailureExplanation =');
    const chatHistoryEnd = chat.indexOf('let pendingConfirmationCreatedThisTurn', chatHistoryStart);
    const chatHistoryPath = chat.slice(chatHistoryStart, chatHistoryEnd);
    expect(chatHistoryPath).toContain('groundedTurnEvidence.push');
    expect(chatHistoryPath).not.toContain('agent:response');
    expect(chatHistoryPath).not.toContain('persistChatTakeoverExecution(');
    const voiceHistoryStart = voice.indexOf('if (recentActionExplanation) {');
    const voiceHistoryEnd = voice.indexOf('const directlyAppliedMode:', voiceHistoryStart);
    expect(voice.slice(voiceHistoryStart, voiceHistoryEnd)).not.toContain('persistVoiceTakeoverExecution(');

    expect(chat).not.toContain('const terminalBackgroundRecords: ToolExecutionRecord[] = backgroundToolRecords.length > 0');
  });
});
