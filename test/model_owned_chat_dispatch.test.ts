import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  LEGACY_INTENT_CLASSIFIER_AUTHORITY,
  legacyIntentCanOwnNaturalLanguageDecision,
} from '../server/cognition/intent';
import { handleLLMFailure, processInput } from '../server/cognition';
import {
  getNormalizedIntentRuntimeRole,
  normalizeActionIntent,
} from '../server/cognition/normalized_action_intent';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { buildModelCapabilityPolicy } from '../server/cognition/capability_selection';
import { buildQuickCommandToolPolicy } from '../server/cognition/quick_commands';
import { buildOperationModeToolPolicy } from '../server/cognition/operation_modes';
import {
  shouldAllowToolUseForTurn,
  traceToolIntentDecision,
} from '../server/cognition/tool_intent';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import {
  buildLumiExecutionDecision,
  type LumiExecutionDecision,
} from '../server/cognition/execution_decision';

describe('model-owned main chat architecture', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it.each([
    '你好 Lumi',
    '你是谁，能做什么？',
    '打开记事本',
    '创建一个文本文件并核验内容',
    '刚才为什么失败？请继续解决',
  ])('keeps legacy intent classification advisory for natural language: %s', async (text) => {
    const result = await processInput(text, {
      userId: 'model_owned_chat_user',
      personalityId: 'lumi',
      personalityName: 'Lumi',
      llmProvider: 'test',
      llmModel: 'test',
      isLLMAvailable: true,
    });

    expect(LEGACY_INTENT_CLASSIFIER_AUTHORITY).toBe('advisory');
    expect(legacyIntentCanOwnNaturalLanguageDecision()).toBe(false);
    expect(result.directToolExecuted).toBe(false);
    expect(result.responseText).toBe('');
  });

  it('keeps text-derived client navigation advisory and reserves deterministic ownership for structured events', () => {
    const navigation = normalizeActionIntent('打开技能大厅');
    expect(getNormalizedIntentRuntimeRole(navigation)).toBe('advisory');
    expect(getNormalizedIntentRuntimeRole(navigation, 'natural_language')).toBe('advisory');
    expect(getNormalizedIntentRuntimeRole(navigation, 'model_selected_capability')).toBe('advisory');
    expect(getNormalizedIntentRuntimeRole(navigation, 'structured_client_event')).toBe('native_client_event');
    expect(getNormalizedIntentRuntimeRole(normalizeActionIntent('打开记事本'))).toBe('advisory');
    expect(getNormalizedIntentRuntimeRole(normalizeActionIntent('给阿陆发一条微信'))).toBe('advisory');
  });

  it('keeps a chat workflow match as a model hint instead of an executable dispatch owner', () => {
    const dispatch = buildLumiTurnDispatch({
      userId: 'model_owned_workflow_user',
      text: 'Lumi, show me a visible demo of yourself',
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.flow.workflowHint?.id).toBe('self_intro_demo');
    expect(dispatch.flow.workflowRouting).toBe('model_hint');
    expect(dispatch.flow.specialWorkflow).toBeNull();
    expect(dispatch.boundary).not.toBe('skill_workflow');
    expect(dispatch.flow.promptOverlay).toContain('capability candidates');
  });

  it('uses semantic routes for ranking without turning them into the model authorization ceiling', () => {
    const execution = {
      allowToolUse: true,
      baseToolPolicy: {
        allowedTools: ['*'],
        forbiddenTools: ['desktop_run_command'],
        requireConfirmation: ['send_email'],
        maxIterations: 8,
      },
      toolPolicy: {
        allowedTools: ['read_file'],
        forbiddenTools: ['desktop_run_command', 'payment_submit'],
        requireConfirmation: ['send_email', 'wechat_send_message'],
        maxIterations: 3,
      },
      maxIterations: 3,
    } as LumiExecutionDecision;

    expect(buildModelCapabilityPolicy(execution)).toEqual({
      allowedTools: ['*'],
      forbiddenTools: ['desktop_run_command'],
      requireConfirmation: ['send_email'],
      maxIterations: 8,
    });
  });

  it('keeps a stable bounded client manifest visible in hard chat mode', () => {
    expect(buildOperationModeToolPolicy('chat')).toMatchObject({
      allowedTools: ['client_get_state', 'client_action'],
      forbiddenTools: [],
      maxIterations: 4,
    });
  });

  it('does not let natural-language mode detection widen the verified hard mode', () => {
    const advisory = buildLumiTurnDispatch({
      userId: 'model_owned_mode_boundary_user',
      text: '开始自主执行模式',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    expect(advisory.flow.requestedMode).toBe('autonomous');
    expect(advisory.flow.effectiveOperationMode).toBe('chat');

    const structured = buildLumiTurnDispatch({
      userId: 'model_owned_mode_boundary_user',
      text: 'structured mode control',
      channel: 'chat',
      source: 'structured_client_event',
      operationMode: 'chat',
      requestedMode: 'autonomous',
      targetIsLumi: true,
    });
    expect(structured.flow.effectiveOperationMode).toBe('autonomous');
  });

  it('executes an ordinary foreground request from Chat without persisting a UI-mode flip', () => {
    const dispatch = buildLumiTurnDispatch({
      userId: 'model_owned_foreground_action_user',
      text: 'Open Notepad and write the requested note.',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const execution = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: dispatch.flow.routeText,
      toolDeclarations: [],
    });

    expect(dispatch.flow.effectiveOperationMode).toBe('chat');
    expect(dispatch.flow.modelToolAccess).toBe('manifest');
    expect(buildModelCapabilityPolicy(execution).allowedTools).toContain('*');
    expect(buildModelCapabilityPolicy(execution).maxIterations).toBe(80);
  });

  it('describes Chat foreground escalation consistently with the hard runtime policy', () => {
    const translationsSource = readFileSync(path.resolve(process.cwd(), 'src/lib/translations.ts'), 'utf8');
    const adapterRegistrySource = readFileSync(path.resolve(process.cwd(), 'server/adapters/registry.ts'), 'utf8');
    const generatedMessages = JSON.parse(readFileSync(
      path.resolve(process.cwd(), 'src/i18n/locales/ui.generated.json'),
      'utf8',
    ));

    expect(translationsSource).toContain("Clear action requests may use Assistant's foreground tools for that turn");
    expect(translationsSource).toContain('明确要求执行时，该回合可调用助手模式的前台工具');
    expect(generatedMessages['desktop-onboarding.chat-answer-only-no-proactive.fb6dff28d4'].en)
      .toContain('explicit action requests may use Assistant tools');
    expect(generatedMessages['desktop-ui.pure-conversation-answers-and-discussion.10bb20f365'].en)
      .not.toContain('no tools');
    expect(adapterRegistrySource).not.toContain('Chat is pure conversation');

    const trace = traceToolIntentDecision(
      'Open Notepad and write the requested note.',
      'chat',
      'chat',
    );
    expect(shouldAllowToolUseForTurn(trace.text, trace.source, trace.operationMode)).toBe(true);
    expect(trace).toMatchObject({
      allowToolUse: true,
      decisionReason: expect.stringContaining('Assistant capabilities may be borrowed'),
      blockedBy: [],
    });
  });

  it('keeps quick-command matches fail-closed and wires the main model loop to the hard capability policy', () => {
    const policy = {
      allowedTools: ['client_get_state'],
      forbiddenTools: ['desktop_run_command'],
      requireConfirmation: [],
      maxIterations: 4,
    };
    expect(buildQuickCommandToolPolicy(policy, 'browser_open_task')).toBe(policy);

    const chatSource = readFileSync(path.resolve(process.cwd(), 'server/socket/chat.ts'), 'utf8');
    expect(chatSource).toContain('toolPolicy: modelCapabilityPolicy');
    expect(chatSource).toContain('// ── Model-owned natural-language dispatch');
    expect(chatSource).not.toContain('buildDeterministicClientNavigationCommand');
    expect(chatSource).not.toContain('buildQuickCommandToolPolicy');
    expect(chatSource).not.toContain('quickFinalized');
    expect(chatSource).not.toContain('const directlyAppliedMode');
    expect(chatSource).not.toContain('registerBackgroundTask');
    expect(chatSource).not.toContain('runOrchestratedTask');
    expect(chatSource).not.toContain('runNLChainer');
    expect(chatSource).toContain('## Advisory execution candidates');
    expect(chatSource).not.toContain('executeSkillWorkflowAdapter');
    expect(chatSource).not.toContain('runWorkflowMatch');
    expect(chatSource).not.toContain('const capabilityMetaResponse');
    expect(chatSource).not.toContain('const deterministicKnowledgeInspection');
    expect(chatSource).not.toContain("reason: 'conversation_execution_facts'");
    // Natural-language dispatch remains model-owned. Preparation is limited to
    // an already-issued durable task/revision selected by structured feedback.
    expect(chatSource).toContain('const bindsExistingAction = Boolean(');
    expect(chatSource).toContain('prepareConversationActionExecution({');
    expect(chatSource).toContain('userMessageId: acceptedUserMessageId');
    expect(chatSource).not.toContain('forceTask: true');
    expect(chatSource).not.toContain('persistConversationExecutionPlan');
    expect(chatSource).not.toContain("setConversationActionExecutionStatus(conversationId, uid, 'executing'");
    // A cancellation is recorded as a terminal continuation boundary.  Normal
    // model-owned turns defer task preparation, but a cancellation must not
    // enqueue that deferred work after the user has revoked it.
    expect(chatSource).toContain('deferActionPreparation: !confirmationCancellationRequested');
    expect(chatSource).toContain('skipActionContinuation: confirmationCancellationRequested');
  });

  it('uses model-owned hard policies and further narrows the public REST entrance', () => {
    const messaging = readFileSync(path.resolve(process.cwd(), 'server/regions/packs/cn/messaging_routes.ts'), 'utf8');
    const rest = readFileSync(path.resolve(process.cwd(), 'server/routes/chat_routes.ts'), 'utf8');
    const misc = readFileSync(path.resolve(process.cwd(), 'server/routes/misc_routes.ts'), 'utf8');

    expect(messaging).toContain('const modelToolPolicy = buildModelCapabilityPolicy(executionDecision)');
    expect(messaging).not.toContain('toolPolicy: executionDecision.toolPolicy');
    expect(messaging).toContain('modelToolPolicy.maxIterations || executionDecision.maxIterations');
    expect(messaging).toContain('isPureOperationModeSwitchRequest(requestText, requestedMode)');

    expect(rest).toContain('const restModelToolPolicy = restrictToolPolicyForExecutionBoundary(');
    expect(rest).toContain('buildModelCapabilityPolicy(restExecutionDecision)');
    expect(rest).toContain("'remote_restricted'");
    expect(rest).toContain('toolPolicy: restModelToolPolicy');
    expect(rest).toContain('isSanctuary: !req.user');

    // misc_routes used to mount a second, less constrained /chat handler.
    // There must now be one canonical REST entrance in chat_routes only.
    expect(misc).not.toContain('router.post("/chat"');
    expect(misc).not.toContain("router.post('/chat'");
    expect(misc).not.toContain('buildModelCapabilityPolicy');
  });

  it('uses finalization as an evidence boundary without replacing compatible model-authored chat prose', () => {
    const responseText = '好的，技能大厅已经打开。';
    const result = finalizeLumiResponse({
      taskText: '打开技能大厅',
      responseText,
      source: 'chat',
      flow: { clientActionOnlyTurn: true } as any,
      toolRecords: [{
        name: 'client_action',
        arguments: { action: 'open_skills' },
        result: JSON.stringify({
          ok: true,
          action: 'open_skills',
          target: 'skills',
          verification: { status: 'verified', message: 'Skills is open.' },
        }),
      }],
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
    expect(result.reason).not.toContain('Model-authored wording preserved');
  });

  it('keeps the exhausted-model response transport-safe instead of impersonating Lumi with canned intent replies', () => {
    const intent = {
      category: 'command' as const,
      confidence: 0.99,
      entities: {},
      needsLLM: false,
      directToolCall: { name: 'desktop_open', args: { app: 'notepad' } },
    };
    const result = handleLLMFailure(intent, new Error('secret provider detail'));
    expect(result.isFallback).toBe(true);
    expect(result.directToolExecuted).toBe(false);
    expect(result.responseText).not.toContain('secret provider detail');
    expect(result.responseText).not.toContain('打开记事本');
    expect(result.responseText).not.toContain('核心功能还在');
  });
});
