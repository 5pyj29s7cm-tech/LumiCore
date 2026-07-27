import type { LumiExecutionDecision } from './execution_decision';
import type { LumiTurnDispatch } from './turn_dispatch';
import {
  buildActionContract,
  formatActionContractPrompt,
  requestsBlankAutoCadDocument,
  requiresVisibleAutoCadExecution,
} from './action_contract';
import { isLegalEntryTurn } from './legal_entry';
import {
  getRecoveredApplicationContinuationTarget,
  isRecoveredCurrentAppEditingContinuation,
} from './action_continuation';
import { CURRENT_APP_FORBIDDEN_TOOLS } from './current_app_execution';
import {
  toolRegistry,
} from '../tools/registry';
import { projectToolDeclarationForRouting } from '../tools/capability_projection';
import type { CapabilityLane } from '../tools/types';

export type LumiCapabilityLane =
  | 'conversation'
  | 'client_surface'
  | 'self_repair'
  | 'capability_learning'
  | 'skill_workflow'
  | 'task_center'
  | 'work_takeover'
  | 'legal_casework'
  | 'messaging'
  | 'internal_memory'
  | 'artifact_work'
  | 'design_cad'
  | 'desktop_control'
  | 'web_or_account'
  | 'external_tool'
  | 'blocked_no_tools';

export interface LumiCapabilitySelectionInput {
  dispatch: LumiTurnDispatch;
  execution: LumiExecutionDecision;
  text: string;
}

export interface LumiCapabilitySelection {
  lane: LumiCapabilityLane;
  primary: string;
  reasons: string[];
  preferredTools: string[];
  promptOverlay: string;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function routeHas(input: LumiCapabilitySelectionInput, ...categories: string[]): boolean {
  const present = new Set(input.execution.toolRoute?.categories || []);
  return categories.some(category => present.has(category));
}

function routeHasTool(input: LumiCapabilitySelectionInput, pattern: RegExp): boolean {
  return (input.execution.toolRoute?.toolNames || []).some(name => pattern.test(name));
}

function availablePreferredTools(input: LumiCapabilitySelectionInput, lane: LumiCapabilityLane): string[] {
  const routeTools = input.execution.toolRoute?.toolNames || [];
  const allowedNames = (input.execution.toolPolicy.allowedTools || []).filter(name => name && name !== '*');
  // The turn route is already the manifest-derived narrow capability set.
  // Personality policy is only a fallback when no route exists; using the
  // whole policy here reintroduces unrelated tools and hides the useful ones
  // behind the preferred-tool cap.
  const available = new Set(routeTools.length ? routeTools : allowedNames);
  const manifestLane: Partial<Record<LumiCapabilityLane, CapabilityLane[]>> = {
    client_surface: ['client'],
    self_repair: ['client', 'system', 'desktop'],
    capability_learning: ['agents'],
    skill_workflow: ['agents'],
    task_center: ['agents'],
    work_takeover: ['agents'],
    legal_casework: ['industry', 'web', 'office'],
    messaging: ['messaging', 'desktop'],
    internal_memory: ['memory'],
    artifact_work: ['files', 'office', 'media'],
    design_cad: ['cad', 'media', 'files', 'desktop'],
    desktop_control: ['desktop'],
    web_or_account: ['web'],
    external_tool: ['agents', 'desktop', 'web'],
  };
  const lanes = new Set(manifestLane[lane] || []);
  const runtimeManifest = toolRegistry.getCapabilityManifest(input.execution.toolPolicy, {
    executableOnly: true,
  });
  const manifest = runtimeManifest.length > 0
    ? runtimeManifest
    : routeTools.map(name => projectToolDeclarationForRouting({
        function: { name, description: name.replace(/_/g, ' ') },
      }));
  const manifestMatches = manifest
    .filter(entry => (
      available.has(entry.toolName)
      && !entry.deprecated
      && (lanes.size === 0 || lanes.has(entry.lane))
    ))
    .map(entry => entry.toolName);
  if (manifestMatches.length > 0) {
    const routeOrder = new Map(routeTools.map((name, index) => [name, index]));
    return unique(manifestMatches).sort((left, right) => (
      (routeOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (routeOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    )).slice(0, 48);
  }
  return unique(routeTools.filter(name => available.has(name))).slice(0, 48);
}

function fallbackPrimary(input: LumiCapabilitySelectionInput): string {
  const route = input.execution.toolRoute;
  if (route?.categories.length) return route.categories.join(', ');
  if (input.dispatch.flow.workSurfaceRoute.directDesktop) return 'desktop/software control';
  if (input.dispatch.flow.workSurfaceRoute.artifactFirst) return 'artifact production';
  return input.dispatch.boundary;
}

function asksForRawDesktopOperation(text: string): boolean {
  return /\b(?:mouse|keyboard|cursor|click|drag|type|uia|computer_use|coordinate|screen\s+control|desktop\s+control)\b/i.test(text)
    || /(?:\u9f20\u6807|\u952e\u76d8|\u5149\u6807|\u70b9\u51fb|\u62d6\u62fd|\u8f93\u5165|\u5750\u6807|\u63a5\u7ba1\u684c\u9762|\u684c\u9762\u63a7\u5236|\u5c4f\u5e55\u63a7\u5236|\u539f\u751f\u63a7\u4ef6)/u.test(text);
}

function asksForDesktopAiCollaboration(text: string): boolean {
  return /(?:WorkBuddy|Codex|ChatGPT|Claude|Gemini|DeepSeek|Kimi|豆包|通义|文心|Perplexity|Cursor|Copilot|Ollama|LM Studio|Cherry Studio|AnythingLLM|外部AI|外部 AI|桌面AI|桌面 AI|其它AI|其他AI|AI工具|AI客户端|AI\s*app)/iu.test(text)
    || /(?:问|发给|发送给|交给|询问)[\s\S]{0,80}(?:AI|模型|agent|智能体)/iu.test(text)
    || /(?:AI|模型|agent|智能体)[\s\S]{0,80}(?:回答|结果|总结|对比|汇总)/iu.test(text);
}

function selectLane(input: LumiCapabilitySelectionInput): Pick<LumiCapabilitySelection, 'lane' | 'primary' | 'reasons'> {
  const flow = input.dispatch.flow;
  const text = compact(input.text || flow.routeText);
  const reasons: string[] = [
    `turn boundary=${input.dispatch.boundary}`,
    `channel=${input.dispatch.channel}`,
  ];

  if (input.dispatch.boundary === 'client_action') {
    return {
      lane: 'client_surface',
      primary: 'Lumi client state/action',
      reasons: [...reasons, 'the user is controlling Lumi client UI or mode'],
    };
  }

  if (input.dispatch.boundary === 'self_repair') {
    return {
      lane: 'self_repair',
      primary: 'Lumi self inspection and recovery',
      reasons: [...reasons, 'the turn is diagnostic or repair-oriented'],
    };
  }

  if (input.execution.allowToolUse && isRecoveredCurrentAppEditingContinuation(text)) {
    const appTarget = getRecoveredApplicationContinuationTarget(text);
    return {
      lane: 'desktop_control',
      primary: appTarget ? `visible current-app control (${appTarget})` : 'visible current-app control',
      reasons: [
        ...reasons,
        'a successful desktop_open receipt recovered the target application',
        'the newest referential instruction edits inside that application and must not be reclassified from its text payload',
      ],
    };
  }

  if (input.dispatch.boundary === 'skill_workflow' || flow.specialWorkflow) {
    const workflow = flow.specialWorkflow;
    return {
      lane: 'skill_workflow',
      primary: workflow ? `${workflow.skillId}/${workflow.id}` : 'matched skill workflow',
      reasons: [...reasons, 'a learned repeatable workflow matched this turn'],
    };
  }

  if (flow.executionGovernance.capabilityLearningIntent !== 'none') {
    return {
      lane: 'capability_learning',
      primary: flow.executionGovernance.capabilityLearningIntent,
      reasons: [...reasons, flow.executionGovernance.capabilityLearningReason],
    };
  }

  if (input.dispatch.boundary === 'task_center') {
    return {
      lane: 'task_center',
      primary: 'persistent task center',
      reasons: [...reasons, 'the user entered through task center'],
    };
  }

  if (input.dispatch.boundary === 'work_takeover') {
    return {
      lane: 'work_takeover',
      primary: flow.workTakeover.latestTask?.id || 'active work takeover task',
      reasons: [...reasons, `active task continuation intent=${flow.workTakeover.intent || 'unknown'} strength=${flow.workTakeover.strength}`],
    };
  }

  if (!input.execution.allowToolUse) {
    return input.dispatch.boundary === 'conversation'
      ? {
          lane: 'conversation',
          primary: 'natural conversation',
          reasons: [...reasons, 'tools are intentionally off for this turn'],
        }
      : {
          lane: 'blocked_no_tools',
          primary: fallbackPrimary(input),
          reasons: [...reasons, 'the turn wants action but tool access is off'],
        };
  }

  const actionContract = buildActionContract(text);
  if (routeHas(input, 'sleep_dream') || routeHasTool(input, /^lumi_sleep_/)) {
    return {
      lane: 'internal_memory',
      primary: 'sleep/dream memory consolidation',
      reasons: [...reasons, 'sleep, dream, or memory consolidation tools matched'],
    };
  }

  if (
    actionContract.kind === 'browser_account' ||
    (!routeHas(input, 'legal') && routeHas(input, 'authenticated_web', 'web_research'))
  ) {
    return {
      lane: 'web_or_account',
      primary: actionContract.kind === 'browser_account' ? 'browser/account session work' : 'browser web work',
      reasons: [...reasons, 'browser, login, saved-session, or authenticated web tools matched before artifact handling'],
    };
  }

  if (routeHas(input, 'legal') || routeHasTool(input, /^(legal_|mcp_legal-casework_)/) || isLegalEntryTurn(text)) {
    return {
      lane: 'legal_casework',
      primary: 'legal casework and legal documents',
      reasons: [...reasons, 'legal casework, legal source, or remote legal intake tools matched'],
    };
  }

  if (asksForDesktopAiCollaboration(text) && (routeHas(input, 'external_control') || routeHasTool(input, /^desktop_ai_/))) {
    return {
      lane: 'desktop_control',
      primary: 'desktop AI collaboration',
      reasons: [...reasons, 'the user wants Lumi to ask local desktop AI apps and collect their answers'],
    };
  }

  if (routeHas(input, 'messaging') || routeHasTool(input, /^(wechat_|feishu_|recent_emails|send_email)/)) {
    return {
      lane: 'messaging',
      primary: 'message handoff and reply drafting',
      reasons: [...reasons, 'message or account communication tools matched'],
    };
  }

  if (routeHas(input, 'cad_design') && flow.workSurfaceRoute.directDesktop && !asksForRawDesktopOperation(text)) {
    return {
      lane: 'design_cad',
      primary: 'design/CAD production with visible CAD-app execution',
      reasons: [...reasons, 'CAD/design tools matched and the visible app is an execution target, not the whole plan'],
    };
  }

  if (flow.workSurfaceRoute.directDesktop || routeHas(input, 'external_control')) {
    return {
      lane: 'desktop_control',
      primary: 'visible desktop/software control',
      reasons: [...reasons, 'the task needs screen, cursor, native UI, or external app control'],
    };
  }

  if (routeHas(input, 'cad_design') || routeHasTool(input, /^(cad_|floorplan_|generate_image|edit_image)/)) {
    return {
      lane: 'design_cad',
      primary: 'design/CAD production',
      reasons: [...reasons, 'design, floor plan, CAD, or visual production tools matched'],
    };
  }

  if (flow.workSurfaceRoute.artifactFirst || routeHas(input, 'documents') || routeHasTool(input, /^(create_|pdf_|ocr_|extract_)/)) {
    return {
      lane: 'artifact_work',
      primary: 'local artifact production',
      reasons: [...reasons, 'the task should produce or inspect files before claiming results'],
    };
  }

  if (routeHasTool(input, /^(desktop_|computer_use$)/)) {
    return {
      lane: 'desktop_control',
      primary: 'visible desktop/software control',
      reasons: [...reasons, 'desktop/system tools matched and no browser or artifact lane was stronger'],
    };
  }

  if (input.execution.toolRoute?.toolNames.length) {
    return {
      lane: 'external_tool',
      primary: fallbackPrimary(input),
      reasons: [...reasons, 'a narrowed external tool route is available'],
    };
  }

  return {
    lane: text ? 'conversation' : 'blocked_no_tools',
    primary: text ? 'natural conversation' : 'empty turn',
    reasons: [...reasons, text ? 'no stronger capability lane matched' : 'empty user text'],
  };
}

function laneRule(selection: Pick<LumiCapabilitySelection, 'lane'>, text = ''): string {
  switch (selection.lane) {
    case 'conversation':
      return 'Answer as Lumi. Do not invent work, tool calls, or hidden task progress.';
    case 'client_surface':
      return 'Stay on Lumi client state/action. Do not drift into desktop, browser, files, or task execution.';
    case 'self_repair':
      return 'Inspect state first, try one safe recovery when possible, verify, then report plainly.';
    case 'capability_learning':
      return 'Inspect existing skills/adapters/tools first; reuse or stabilize before adding anything new. Do not hard-code an industry demo into Lumi core.';
    case 'skill_workflow':
      return 'Use the learned workflow as a reusable capability. Parameterize every step from this user turn and active task state.';
    case 'task_center':
      return 'Treat this as persistent work with task state, artifacts, blockers, confirmation boundaries, and a concise result.';
    case 'work_takeover':
      return 'Continue the active task instead of starting over. Preserve context, advance the next safe step, verify evidence, and update the task.';
    case 'legal_casework':
      return 'Use the unified legal casework path across personal chat, company chat, voice, task center, and remote bot intake. Start from the case workspace/source intake, apply the major-premise/minor-premise/conclusion chain, verify current effective law before final documents, and stop for confirmation before filing, signing, paying, submitting, or committing a final legal position.';
    case 'messaging':
      return 'Use messaging tools as a bridge to customer or account communication. For explicit ordinary foreground sends, use the dedicated send tool and visible cursor path; draft before sending when the boundary is ambiguous.';
    case 'internal_memory':
      return 'Use Lumi sleep/dream tools for internal memory consolidation. Keep core identity stable, preserve original memories, mark uncertainty, and report only the dream status or useful next questions.';
    case 'artifact_work':
      return 'Produce or inspect local files first, verify content and existence, then explain what is ready and what still needs confirmation.';
    case 'design_cad':
      if (requestsBlankAutoCadDocument(text)) {
        return 'Use mcp_cad-drafting_autocad_new_document to create and focus exactly one real blank AutoCAD drawing. Do not prepare geometry, infer dimensions, draw a placeholder boundary, or claim source verification.';
      }
      if (requiresVisibleAutoCadExecution(text)) {
        return 'Run floorplan_extract_geometry and continue only when it returns geometryReady=true, geometryVerified=true, and a geometryReceiptPath; then call cad_prepare_autocad_operations with the receipt handoff directly. Never copy, shorten, or reconstruct coordinates in chat. Then call mcp_cad-drafting_autocad_playback_file for observable stroke-by-stroke drawing in real AutoCAD; never substitute DXF/DWG generation, LISP, scripts, batch commands, cursor drawing, or an opened window. Accept completion only when the verified operationSetId matches and operationCount=expectedEntityCount=entitiesAdded with entityCountMatches=true.';
      }
      return 'Prefer structured design/CAD tools over raw cursor work; use desktop CAD only when the user asks to operate visible software or a tool needs it.';
    case 'desktop_control':
      if (isRecoveredCurrentAppEditingContinuation(text)) {
        return 'Follow the current-app UIA state machine. Observe the active window and UI tree, invoke one precise New/Blank control, re-snapshot, and do not type or paste until the fresh UI tree proves an editable Document/editor control. Focus that control, type through desktop_ui_type, and verify the requested text. Never repeat the same New/Blank selector or fall back to computer_use/raw coordinates.';
      }
      return 'Use screen/window state as evidence. Move through visible UI deliberately and verify the app/result before claiming completion.';
    case 'web_or_account':
      return 'Treat this as browser/account execution. First inspect saved login profiles or existing sessions; for known legal/account sites, create or reuse the matching authorized profile only when allowed, then run web_login_run visibly and verify the logged-in or target result page. Do not rely on raw iframe JavaScript hacks as the main plan. Stop with the exact blocker at missing credentials, QR/captcha/2FA/passkey/account switching, access limits, payment, irreversible publish, or missing target-result evidence.';
    case 'external_tool':
      return 'Use the selected external tools as Lumi hands, keep ownership of the result, and verify before final claims.';
    case 'blocked_no_tools':
    default:
      return 'Do not pretend to execute. Explain the boundary or ask one short clarification.';
  }
}

export function buildLumiCapabilitySelection(input: LumiCapabilitySelectionInput): LumiCapabilitySelection {
  const selected = selectLane(input);
  const routeText = input.text || input.dispatch.flow.routeText || '';
  const actionContract = buildActionContract(routeText);
  const visibleAutoCad = selected.lane === 'design_cad' && requiresVisibleAutoCadExecution(routeText);
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(routeText);
  const effectiveAllowed = new Set(
    (input.execution.toolPolicy.allowedTools || []).filter(name => name && name !== '*'),
  );
  const contractPreferredTools = actionContract.applies
    ? actionContract.preferredTools.filter(name => (
        effectiveAllowed.has(name)
      ))
    : [];
  const preferredTools = unique([
    ...availablePreferredTools(input, selected.lane),
    ...contractPreferredTools,
  ]).filter(name => (
    (!visibleAutoCad || ![
      'cad_generate_dxf',
      'mcp_cad-drafting_cad_renovation_folder_workflow',
    ].includes(name))
    && (!recoveredCurrentAppEdit
      || !(CURRENT_APP_FORBIDDEN_TOOLS as readonly string[]).includes(name))
  )).slice(0, 48);
  const routeCategories = input.execution.toolRoute?.categories || [];
  const promptOverlay = [
    '## Lumi Capability Selection',
    `Selected lane: ${selected.lane}.`,
    `Primary capability: ${selected.primary}.`,
    `Why: ${unique(selected.reasons).join('; ')}.`,
    routeCategories.length ? `Tool route categories: ${routeCategories.join(', ')}.` : 'Tool route categories: none.',
    preferredTools.length ? `Preferred tools for this lane: ${preferredTools.join(', ')}.` : 'Preferred tools for this lane: none.',
    laneRule(selected, routeText),
    formatActionContractPrompt(actionContract),
    'This lane is an execution bias, not a fixed script. If the newest user wording contradicts it, follow the newest wording and update task state when work is persistent.',
  ].filter(Boolean).join('\n');

  return {
    ...selected,
    preferredTools,
    promptOverlay,
  };
}
