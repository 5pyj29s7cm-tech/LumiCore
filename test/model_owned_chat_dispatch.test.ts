import { readImplementationSource } from './implementation_source';
import './helpers';
import { enCatalog } from '../src/i18n/locales/catalog_en';
import { zhCatalog } from '../src/i18n/locales/catalog_zh';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { buildModelCapabilityPolicy } from '../server/cognition/capability_selection';
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
      allowedTools: ['*'],
      forbiddenTools: [],
      maxIterations: 80,
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
    expect(advisory.flow.requestedMode).toBeNull();
    expect(advisory.flow.effectiveOperationMode).toBe('assistant');

    const structured = buildLumiTurnDispatch({
      userId: 'model_owned_mode_boundary_user',
      text: 'structured mode control',
      channel: 'chat',
      source: 'structured_client_event',
      operationMode: 'chat',
      requestedMode: 'autonomous',
      targetIsLumi: true,
    });
    expect(structured.flow.effectiveOperationMode).toBe('assistant');
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
      toolDeclarations: [{
        type: 'function',
        function: {
          name: 'desktop_list_apps',
          description: 'List launchable desktop applications.',
          parameters: { type: 'object', properties: {} },
        },
      }, {
        type: 'function',
        function: {
          name: 'desktop_open',
          description: 'Open one exact desktop target.',
          parameters: { type: 'object', properties: {} },
        },
      }, {
        type: 'function',
        function: {
          name: 'desktop_active_window',
          description: 'Read the active desktop window.',
          parameters: { type: 'object', properties: {} },
        },
      }] as any,
    });

    expect(dispatch.flow.effectiveOperationMode).toBe('assistant');
    expect(dispatch.flow.modelToolAccess).toBe('manifest');
    expect(buildModelCapabilityPolicy(execution).allowedTools).toEqual(expect.arrayContaining([
      'desktop_list_apps',
      'desktop_open',
      'desktop_active_window',
    ]));
    expect(buildModelCapabilityPolicy(execution).maxIterations).toBeGreaterThanOrEqual(3);
  });

  it('describes Chat foreground escalation consistently with the hard runtime policy', () => {
    const adapterRegistrySource = readImplementationSource(path.resolve(process.cwd(), 'server/adapters/registry.ts'), 'utf8');
    const generatedMessages = JSON.parse(readImplementationSource(
      path.resolve(process.cwd(), 'src/i18n/locales/ui.generated.json'),
      'utf8',
    ));

    expect(enCatalog.modeChatDesc).toContain("Clear action requests may use Assistant's foreground tools for that turn");
    expect(zhCatalog.modeChatDesc).toContain('明确要求执行时，该回合可调用助手模式的前台工具');
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
      decisionReason: expect.stringContaining('explicit tool or work action'),
      blockedBy: [],
    });
  });

  it('wires the main model loop to the hard capability policy', () => {

    const chatSource = readImplementationSource(path.resolve(process.cwd(), 'server/socket/chat.ts'), 'utf8');
    expect(chatSource).toContain('toolPolicy: modelCapabilityPolicy');
    expect(chatSource).toContain('// ── Model-owned natural-language dispatch');
    expect(chatSource).not.toContain('quickFinalized');
    expect(chatSource).not.toContain('const directlyAppliedMode');
    expect(chatSource).not.toContain('registerBackgroundTask');
    expect(chatSource).not.toContain('runNLChainer');
    expect(chatSource).toContain('recognition and legacy quick matches are advisory inputs');
    expect(chatSource).not.toContain('executeSkillWorkflowAdapter');
    expect(chatSource).not.toContain('runWorkflowMatch');
    expect(chatSource).not.toContain('const capabilityMetaResponse');
    expect(chatSource).not.toContain('const deterministicKnowledgeInspection');
    expect(chatSource).not.toContain("reason: 'conversation_execution_facts'");
    // A blocked finalizer may clear an action lease before receipt binding only
    // when this turn produced no tool records.  With evidence (for example a
    // verified WPS active-window observation), persistence must retain the
    // lease until the terminal assistant row has been written.
    expect(chatSource).toContain('toolSessionActive && allToolRecords.length === 0');
    // Natural-language dispatch remains model-owned. Tool-capable fresh turns
    // create only a durable task envelope before the model/tool relay so every
    // receipt has a stable taskId; preparation itself does not execute tools.
    const taskOwner = readFileSync('server/conversation/planned_execution.ts', 'utf8');
    expect(chatSource).toContain('preparePlannedConversationExecution({');
    expect(chatSource).not.toContain('const bindsExistingAction =');
    expect(chatSource).toContain('acceptedRuntimeCleanup: Boolean(acceptedRuntimeCleanupOffer && conversationId)');
    expect(taskOwner).toContain('execution.capabilityPlan.taskLedgerRequired');
    expect(taskOwner.match(/prepareConversationActionExecution\(\{/g)).toHaveLength(1);
    expect(chatSource).toContain('userMessageId: acceptedUserMessageId');
    expect(chatSource).not.toContain('persistConversationExecutionPlan');
    expect(chatSource).not.toContain("setConversationActionExecutionStatus(conversationId, uid, 'executing'");
    // A cancellation is recorded as a terminal continuation boundary.  Normal
    // model-owned turns defer task preparation, but a cancellation must not
    // enqueue that deferred work after the user has revoked it.
    expect(chatSource).toContain('deferActionPreparation: !confirmationCancellationRequested');
    expect(chatSource).toContain('skipActionContinuation: confirmationCancellationRequested');
  });

  it('uses model-owned hard policies and further narrows the public REST entrance', () => {
    const messaging = readImplementationSource(path.resolve(process.cwd(), 'server/regions/packs/cn/messaging_routes.ts'), 'utf8');
    const rest = readImplementationSource(path.resolve(process.cwd(), 'server/routes/chat_routes.ts'), 'utf8');
    const misc = readImplementationSource(path.resolve(process.cwd(), 'server/routes/misc_routes.ts'), 'utf8');

    expect(messaging).toContain('const modelToolPolicy = executionPlan.authorizationPolicy');
    expect(messaging).toContain('const modelToolProjection = executionPlan.modelToolProjection');
    expect(messaging).not.toContain('toolPolicy: executionDecision.toolPolicy');
    expect(messaging).toContain('modelToolPolicy.maxIterations || executionDecision.maxIterations');
    expect(messaging).toContain('isPureOperationModeSwitchRequest(requestText, requestedMode)');

    expect(rest).toContain('return await runLumiEntryTurn({');
    expect(rest).toContain('maxIterations: execution.authorizationPolicy.maxIterations || 3');
    expect(readFileSync('server/cognition/turn_execution.ts', 'utf8')).toContain('...assembled.model, execution, messages,');
    expect(readFileSync('server/cognition/turn_model.ts', 'utf8')).toContain('modelToolProjection: execution.modelToolProjection');
    expect(rest).toContain('executionBoundary,');
    expect(rest).not.toContain('buildModelToolProjection');
    expect(rest).not.toMatch(/restExecutionDecision\.(?:baseToolPolicy|toolPolicy|maxIterations|toolRoute)\s*=/);
    expect(rest).toContain("'remote_restricted'");
    expect(readFileSync('server/cognition/turn_model.ts', 'utf8')).toContain('toolPolicy: execution.authorizationPolicy');
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
});
