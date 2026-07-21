import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function expectFinalizationMetadataOnEveryAgentResponse(relativePath: string): void {
  const code = source(relativePath);
  const matches = Array.from(
    code.matchAll(/(?:socket\.emit|emitAgent|emitBackground)\(\s*['"]agent:response['"]/g),
  );
  expect(matches.length).toBeGreaterThan(0);

  for (const match of matches) {
    const index = match.index ?? 0;
    const line = code.slice(0, index).split('\n').length;
    const responseBlock = code.slice(index, index + 800);
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
    expect(task).toContain('if (!cancelled && !deferTaskModelOutput)');
    expect(task).toContain('const safeText = taskTextGate.push(chunk)');
    expect(task).toContain('taskTextGate.finish()');
    expect(task).toContain('const orchestratedToolRecords: ToolExecutionRecord[] = []');
    expect(task).toContain('toolRecords: orchestratedToolRecords');
    expect(task).toContain('toolRecords: result.toolCalls');
    expect(task).toContain('finalized: true');
    expect(task).toContain('blocked: finalTaskResponse.blocked');
  });

  it('does not announce orchestrator completion before shared final validation', () => {
    const orchestrator = source('server/agents/orchestrator.ts');

    expect(orchestrator).toContain('Workflow result ready for final validation');
    expect(orchestrator).not.toContain('[Orchestrator] Workflow complete');
  });

  it('keeps ordinary REST streaming but buffers action output until the final SSE event', () => {
    const rest = source('server/routes/chat_routes.ts');

    expect(rest).toContain('restExecutionDecision.allowToolUse');
    expect(rest).toContain('shouldDeferModelOutputUntilFinalized');
    expect(rest).toContain('createPreFinalizationTextGate');
    expect(rest).toContain('restTextGate.push(chunk)');
    expect(rest).toContain('if (!deferRestStream)');
    expect(rest).toContain('toolPolicy: restExecutionDecision.toolPolicy');
    expect(rest).toContain('source: \'rest_chat_stream\'');
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

  it('validates the complete background-success candidate and marks non-success exits blocked', () => {
    const chat = source('server/socket/chat.ts');
    const backgroundStart = chat.indexOf('const completionCandidate = `');
    const finalizerStart = chat.indexOf('const finalizedBackground = finalizeLumiResponse({', backgroundStart);
    const backgroundEnd = chat.indexOf('}, 30);', finalizerStart);
    const backgroundPath = chat.slice(backgroundStart, backgroundEnd);

    expect(backgroundStart).toBeGreaterThan(0);
    expect(finalizerStart).toBeGreaterThan(backgroundStart);
    expect(backgroundPath).toContain('responseText: completionCandidate');
    expect(backgroundPath).toContain('const completionText = finalizedBackground.text;');
    expect(backgroundPath).toContain('? failBackgroundTask(');
    expect(backgroundPath).toContain(': completeBackgroundTask(backgroundTaskId, completionText)');
    expect(backgroundPath).not.toContain('finalText = finalizedBackground.text;');

    const cancelledResponses = Array.from(
      backgroundPath.matchAll(/reason:\s*'cancelled'[\s\S]{0,80}/g),
      match => match[0],
    );
    expect(cancelledResponses).toHaveLength(2);
    expect(backgroundPath.match(/blocked:\s*true/g)?.length || 0).toBeGreaterThanOrEqual(3);
  });

  it('keeps MCP chat chunks, speech, and returns behind the shared finalizer', () => {
    const mcp = source('server/mcp/lumi_server.ts');

    expect(mcp).toContain("import { finalizeLumiResponse } from '../cognition/result_finalizer';");
    expect(mcp).toContain('const bufferedChunks: string[] = [];');
    expect(mcp).toContain('(chunk) => bufferedChunks.push(chunk)');
    expect(mcp).not.toContain("(chunk) => bc('mcp:chunk'");
    expect(mcp).toContain('const finalized = finalizeLumiResponse({');
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

  it('finalizes both direct and orchestrated MCP route-task results with real tool ledgers', () => {
    const mcp = source('server/mcp/lumi_server.ts');

    expect(mcp).toContain("source: 'mcp_route_task'");
    expect(mcp).toContain('toolRecords: result.toolCalls');
    expect(mcp).toContain('const workflowToolRecords: ToolExecutionRecord[] = [];');
    expect(mcp).toContain('toolRecords: workflowToolRecords');
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

  it('never queues model or orchestrator candidate speech before the shared voice finalizer', () => {
    const voice = source('server/socket/voice.ts');
    const orchestratorStart = voice.indexOf('if (shouldOrchestrate) {');
    const singleModelStart = voice.indexOf('if (!usedOrchestrator) {', orchestratorStart);
    const finalizerStart = voice.indexOf('const finalResponse = finalizeLumiResponse({', singleModelStart);
    const finalSpeechStart = voice.indexOf('queueFinalizedSpeech(responseText)', finalizerStart);
    const orchestratorCandidatePath = voice.slice(orchestratorStart, singleModelStart);
    const modelCandidatePath = voice.slice(singleModelStart, finalizerStart);

    expect(orchestratorStart).toBeGreaterThan(0);
    expect(singleModelStart).toBeGreaterThan(orchestratorStart);
    expect(finalizerStart).toBeGreaterThan(singleModelStart);
    expect(finalSpeechStart).toBeGreaterThan(finalizerStart);
    expect(orchestratorCandidatePath).not.toContain('flushSentence(s)');
    expect(orchestratorCandidatePath).toContain('flushSentence(voiceLeadIn)');
    expect(orchestratorCandidatePath).toContain('shouldForwardPreFinalizationProgress(voiceLeadIn)');
    expect(orchestratorCandidatePath).toContain('shouldForwardPreFinalizationProgress(msg)');
    expect(modelCandidatePath).not.toContain('flushSentence(');
    expect(voice.slice(finalizerStart, finalSpeechStart + 80)).not.toContain('modelGateSnapshot');
  });

  it('quarantines blocked early-return socket responses from history and learning', () => {
    const chat = source('server/socket/chat.ts');
    const voice = source('server/socket/voice.ts');

    for (const finalized of [
      'finalizedMode',
      'finalizedWorkflow',
      'quickFinalized',
      'profileFinalized',
    ]) {
      expect(chat).toContain(`cognitiveIntent: ${finalized}.blocked ? 'work_product_guard' : undefined`);
      expect(chat).toContain(`if (!${finalized}.blocked) {`);
    }
    expect(chat).toContain('if (!finalizedWorkflowQuick.blocked) {');
    expect(chat).toContain("cognitiveIntent: finalizedWorkflow.blocked ? 'work_product_guard' : specialWorkflow.id");
    expect(chat).toContain("cognitiveIntent: guarded ? 'work_product_guard' : undefined");
    expect(chat).toContain("cognitiveIntent: guarded ? 'work_product_guard' : cognition.intent.category");
    expect(chat).toContain('persistBackgroundResult(completionText, backgroundToolRecords, finalizedBackground.blocked, deliver)');
    expect(chat).toContain('const deliver = isLatestUserTurn(executionScope, requestId)');
    expect(chat).toContain('if (conversationId && deliverToConversation) {');
    expect(chat).toContain('if (conversationId && !quickFinalized.blocked) {');

    for (const finalized of [
      'finalizedRecentAction',
      'finalizedWorkflow',
      'finalizedMode',
      'quickFinalized',
      'profileFinalized',
      'musicFinalized',
    ]) {
      expect(voice).toContain(`cognitiveIntent: ${finalized}.blocked ? 'work_product_guard' :`);
      expect(voice).toContain(`if (!${finalized}.blocked) {`);
    }
    expect(voice.match(/cognitiveIntent: directFinal\.blocked \? 'work_product_guard' :/g)).toHaveLength(2);
    expect(voice.match(/if \(!directFinal\.blocked\) \{/g)).toHaveLength(2);
  });

  it('persists finalized stored-workflow turns with tool evidence before conversation sync', () => {
    const chat = source('server/socket/chat.ts');
    const workflowStart = chat.indexOf('if (workflowQuickResult) {');
    const workflowEnd = chat.indexOf('// ── Quick Command Fast-Path', workflowStart);
    const workflowPath = chat.slice(workflowStart, workflowEnd);

    expect(workflowStart).toBeGreaterThan(0);
    expect(workflowEnd).toBeGreaterThan(workflowStart);
    expect(workflowPath).toContain("role: 'user'");
    expect(workflowPath).toContain("role: 'tool'");
    expect(workflowPath).toContain('summarizeToolRecordForPersistence(record)');
    expect(workflowPath).toContain("role: 'assistant'");
    expect(workflowPath).toContain('toolCalls: workflowQuickToolRecords.length ? workflowQuickToolRecords : undefined');
    expect(workflowPath).toContain("cognitiveIntent: finalizedWorkflowQuick.blocked ? 'work_product_guard' : undefined");
    expect(workflowPath.indexOf('emitAgent("agent:response"')).toBeLessThan(
      workflowPath.indexOf("socket.emit('chat:conversation_updated'"),
    );
    expect(workflowPath).toContain('if (!finalizedWorkflowQuick.blocked) {');
    expect(workflowPath).toContain('trackTopic(conversationId, topic)');
  });

  it('falls back to the finalized primary workflow response when a speech summary is blocked', () => {
    const voice = source('server/socket/voice.ts');
    const workflowStart = voice.indexOf('const finalizedWorkflow = finalizeLumiResponse({');
    const workflowEnd = voice.indexOf('return;', workflowStart);
    const workflowPath = voice.slice(workflowStart, workflowEnd);

    expect(workflowPath).toContain('const finalizedWorkflowSpeech = finalizedWorkflow.blocked || !workflowSpeechSummary');
    expect(workflowPath).toContain('const workflowSpeechText = finalizedWorkflowSpeech.blocked');
    expect(workflowPath).toContain('? responseText');
    expect(workflowPath).toContain('queueFinalizedSpeech(workflowSpeechText)');
  });

  it('keeps the legacy misc chat route behind the shared finalizer', () => {
    const misc = source('server/routes/misc_routes.ts');

    expect(misc).toContain('finalizeLumiResponse({');
    expect(misc).toContain("source: 'misc_chat'");
    expect(misc).toContain('blocked: finalized.blocked');
    expect(misc).toContain('reason: finalized.reason');
  });

  it('keeps autonomous, scheduler, tool telemetry, and idle UI states out of false completion', () => {
    const autonomous = source('server/autonomy/task_executor.ts');
    const ambient = source('server/socket/ambient.ts');
    const feed = source('src/components/AutonomousFeed.tsx');
    const desktop = source('src/components/DesktopUI.tsx');
    const proactive = source('src/components/ProactiveNotifications.tsx');
    const scheduler = source('server/scheduler.ts');

    expect(autonomous).toContain('evaluateAutonomousTaskOutcome');
    expect(autonomous).toContain('toolRecords,');
    expect(autonomous).toContain('if (!outcome.verified)');
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
    expect(scheduler).toContain('modelGenerated: true');
    expect(scheduler).toContain('if (!deliveryFinalization.delivery)');
  });

  it('uses one guarded summary scheduler for chat and every persisted voice path', () => {
    const chat = source('server/socket/chat.ts');
    const voice = source('server/socket/voice.ts');
    const ambient = source('server/socket/ambient.ts');

    expect(chat).toContain("from \"../conversation/summary_scheduler\"");
    expect(voice).toContain("from \"../conversation/summary_scheduler\"");
    expect(chat).toContain('scheduleChatSummary(conversationId)');
    expect(voice.match(/scheduleVoiceSummary\([^)]*\.id\)/g)?.length || 0).toBeGreaterThanOrEqual(9);
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
    expect(chat.match(/persistChatTakeoverExecution\(/g)?.length || 0).toBeGreaterThanOrEqual(8);
    expect(voice.match(/persistVoiceTakeoverExecution\(/g)?.length || 0).toBeGreaterThanOrEqual(8);
    expect(writeback).toContain('input.flow.workTakeover.shouldResumeTask');

    for (const marker of [
      "source: 'chat_mode'",
      "source: 'workflow'",
      "source: 'chat_quick_command'",
      "source: 'chat_music_profile'",
      "source: 'background_delegation'",
    ]) {
      expect(chat).toContain(marker);
    }
    for (const marker of [
      "source: 'voice_mode'",
      "source: 'voice_quick_command'",
      "source: 'voice_foreground_messaging'",
      "source: 'voice_music_profile'",
      "source: 'voice_music_execution'",
      "source: 'voice_cognition_direct'",
    ]) {
      expect(voice).toContain(marker);
    }

    const chatHistoryStart = chat.indexOf('const recentFailureExplanation =');
    const chatHistoryEnd = chat.indexOf('//', chat.indexOf('return;', chatHistoryStart) + 1);
    expect(chat.slice(chatHistoryStart, chatHistoryEnd)).not.toContain('persistChatTakeoverExecution(');
    const voiceHistoryStart = voice.indexOf('if (recentActionExplanation) {');
    const voiceHistoryEnd = voice.indexOf('const specialWorkflow =', voiceHistoryStart);
    expect(voice.slice(voiceHistoryStart, voiceHistoryEnd)).not.toContain('persistVoiceTakeoverExecution(');

    expect(chat).toContain('const terminalBackgroundRecords: ToolExecutionRecord[] = backgroundToolRecords.length > 0');
    expect(chat).toContain("name: 'background_delegation'");
    expect(chat).toContain('toolRecords: terminalBackgroundRecords');
  });
});
