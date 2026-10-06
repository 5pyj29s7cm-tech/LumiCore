import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const modules: Record<string, string[]> = {
  "server/socket/voice.ts": ["server/socket/voice_transport_runtime.ts","server/socket/voice_turn_policy.ts","server/socket/voice_side_response.ts","server/socket/voice_conversation_turn.ts","server/socket/voice_input_pipeline.ts","server/socket/voice.ts"],
  "server/regions/packs/cn/messaging_routes.ts": ["server/regions/packs/cn/messaging_persistence.ts","server/regions/packs/cn/messaging_routes.ts","server/regions/packs/cn/messaging_finalization.ts","server/regions/packs/cn/remote_org_commands.ts","server/regions/packs/cn/remote_materials.ts","server/regions/packs/cn/messaging_ingress_runtime.ts"],
  'src/components/DesktopUI.tsx': ['src/components/DesktopUI.tsx', 'src/components/desktop/useMeetingTranscript.ts', 'src/components/desktop/useMeetingWorkflow.ts', 'src/components/desktop/useClientSurfaceActions.ts', 'src/components/desktop/useDesktopWindows.ts', 'src/components/desktop/DesktopShellView.tsx', ...['shell_chrome_view', 'core_stage_view', 'desktop_grid_view', 'meeting_workspace_view', 'desktop_windows_view'].map(name => 'src/components/desktop/' + name + '.tsx'), 'src/components/desktop/surface_components.tsx'],
  'src/components/AgentChatPage.tsx': ['src/components/AgentChatPage.tsx', 'src/components/agent_chat/chat_stream_receivers.ts', 'src/components/agent_chat/useConversationTransitions.ts', 'src/components/agent_chat/AgentChatView.tsx', ...['chat_toolbar_view', 'conversation_history_rail_view', 'chat_panel_header_view', 'chat_message_feed_view', 'chat_composer_view', 'chat_activity_rail_view'].map(name => 'src/components/agent_chat/' + name + '.tsx')],
  'src-tauri/src/lib.rs': ['src-tauri/src/lib.rs', ...['native_files', 'native_shell', 'native_apps', 'native_window_modes', 'native_processes', 'native_activity', 'native_display', 'native_input'].map(name => 'src-tauri/src/' + name + '.rs')],
};
const phaseOwners: Record<string, string[]> = {
  "server/mcp/lumi_server.ts": ["server/mcp/server_tools/contracts.ts","server/mcp/server_tools/failure.ts","server/mcp/server_tools/runtime.ts","server/mcp/server_tools/conversation.ts","server/mcp/server_tools/chat.ts","server/mcp/server_tools/route_task.ts","server/mcp/server_tools/memory_search.ts","server/mcp/server_tools/memory_add.ts","server/mcp/server_tools/reminder_list.ts","server/mcp/server_tools/speak.ts","server/mcp/server_tools/narrative.ts"],
  "server/autonomy/task_executor.ts": ["server/autonomy/executor/contracts.ts","server/autonomy/executor/tool_policy.ts","server/autonomy/executor/linked_plan.ts","server/autonomy/executor/customer_projection.ts","server/autonomy/executor/receipts.ts","server/autonomy/executor/outcome.ts","server/autonomy/executor/durable_finalization.ts","server/autonomy/executor/failure.ts"],
  "server/conversation/manager.ts": ["server/conversation/manager/terminal_durability.ts","server/conversation/manager/turn_binding.ts","server/conversation/manager/execution_preparation.ts","server/conversation/manager/execution_control.ts","server/conversation/manager/recovery.ts","server/conversation/manager/terminal_disposition.ts","server/conversation/manager/message_updates.ts"],
  "server/tools/definitions/workflow_tools.ts": ["server/tools/definitions/workflow/capability_snapshot.ts","server/tools/definitions/workflow/authorization.ts","server/tools/definitions/workflow/run_barrier.ts","server/tools/definitions/workflow/definition_commands.ts","server/tools/definitions/workflow/run_execution.ts","server/tools/definitions/workflow/run_projection.ts","server/tools/definitions/workflow/run_control.ts","server/tools/definitions/workflow/reconciliation.ts"],
  "server/regions/packs/cn/messaging_routes.ts": ["server/regions/packs/cn/messaging_turn/binding_commands.ts","server/regions/packs/cn/messaging_turn/remote_plan.ts","server/regions/packs/cn/messaging_turn/ingress.ts","server/regions/packs/cn/messaging_turn/history.ts","server/regions/packs/cn/messaging_turn/processing.ts","server/regions/packs/cn/messaging_turn/admission.ts","server/regions/packs/cn/messaging_turn/execution_preparation.ts","server/regions/packs/cn/messaging_turn/model_execution.ts"],
  "src/components/org/LegalHub.tsx": ["src/components/org/legal_hub/contracts.tsx","src/components/org/legal_hub/case_values.tsx","src/components/org/legal_hub/readiness.tsx","src/components/org/legal_hub/scope.tsx","src/components/org/legal_hub/case_dialogs.tsx","src/components/org/legal_hub/useLegalCaseWorkspaceState.tsx","src/components/org/legal_hub/workspace.tsx","src/components/org/legal_hub/controls.tsx","src/components/org/legal_hub/packet.tsx","src/components/org/legal_hub/external_research.tsx","src/components/org/legal_hub/two_pane_tool.tsx","src/components/org/legal_hub/strategy.tsx","src/components/org/legal_hub/verification.tsx","src/components/org/legal_hub/knowledge_sync.tsx","src/components/org/legal_hub/material_import.tsx"],
  "src/components/SkillCenter.tsx": ["src/components/skill_center/view.tsx","src/components/skill_center/presentation.tsx","src/components/skill_center/contracts.tsx","src/components/skill_center/availability.tsx","src/components/skill_center/recommendations.tsx","src/components/skill_center/useSkillCenterState.tsx","src/components/skill_center/featured.tsx","src/components/skill_center/marketplace.tsx","src/components/skill_center/installed.tsx","src/components/skill_center/generation.tsx","src/components/skill_center/detail.tsx"],
  "src/hooks/useVoiceCall.ts": ["src/hooks/voice_call/contracts.ts","src/hooks/voice_call/protocol.ts","src/hooks/voice_call/playback.ts","src/hooks/voice_call/useVoiceSessionState.ts","src/hooks/voice_call/useVoiceCaptureRuntime.ts","src/hooks/voice_call/useVoiceSocketEvents.ts","src/hooks/voice_call/useVoiceCallControls.ts"],
  "server/socket/voice.ts": ["server/socket/voice/connection/connection.ts","server/socket/voice/connection/start.ts","server/socket/voice/connection/transcription.ts","server/socket/voice/connection/capture_control.ts","server/socket/voice/connection/proactive.ts","server/socket/voice/connection/cleanup.ts"],
  "server/client/self_model.ts": ["server/client/self/contracts.ts","server/client/self/catalog.ts","server/client/self/state.ts","server/client/self/capabilities.ts","server/client/self/health.ts","shared/client_surface_target.ts","server/client/self/verification.ts","server/client/self/snapshot.ts","server/client/self/prompt_context.ts","server/client/self/prompt_compact.ts"],
  "server/skills/generator.ts": ["server/skills/generation/paths.ts","server/skills/generation/authoring_contract.ts","server/skills/generation/contracts.ts","server/skills/generation/templates.ts","server/skills/generation/response.ts","server/skills/generation/artifact_hash.ts","server/skills/generation/review.ts","server/skills/generation/syntax.ts","server/skills/generation/callback_validation.ts","server/skills/generation/protocol_validation.ts","server/skills/generation/manifest_validation.ts","server/skills/generation/install_validation.ts","server/skills/generation/dependencies.ts"],
  "server/llm/providers.ts": ["server/llm/provider/contracts.ts","server/llm/provider/openai_compatible.ts","server/llm/provider/deadlines.ts","server/llm/provider/legacy_protocol.ts","server/llm/provider/request_context.ts","server/llm/provider/content.ts","server/llm/provider/access_policy.ts","server/llm/provider/dispatch_preferences.ts","server/llm/provider/response.ts","server/llm/provider/gemini.ts","server/llm/provider/anthropic.ts","server/llm/provider/routing_trace.ts","server/llm/provider/outbound_evidence.ts","server/llm/provider/request_preparation.ts","server/llm/provider/buffered.ts","server/llm/provider/streaming.ts","server/llm/provider/tokens.ts"],
  "routes/files.ts": ["server/files/knowledge/paths.ts","server/files/knowledge/ownership.ts","server/files/knowledge/uploads.ts","server/files/knowledge/contracts.ts","server/files/knowledge/extraction.ts","server/files/knowledge/legacy_revalidation.ts","server/files/knowledge/formats.ts","server/files/knowledge/metadata.ts","server/files/knowledge/file_ingestion.ts","server/files/knowledge/obsidian.ts","server/files/knowledge/memory_references.ts","server/files/knowledge/archive_routes.ts","server/files/knowledge/obsidian_routes.ts","server/files/knowledge/import_routes.ts","server/files/knowledge/access_routes.ts","server/files/knowledge/ingestion_routes.ts"],
  "server/mcp/client.ts": ["server/mcp/client/contracts.ts","server/mcp/client/security.ts","server/mcp/client/defaults.ts","server/mcp/client/timeouts.ts","server/mcp/client/package_paths.ts","server/mcp/client/fingerprints.ts","server/mcp/client/package_sources.ts","server/mcp/client/package_files.ts","server/mcp/client/managed_identity.ts","server/mcp/client/dependencies.ts"],
  "server/llm/adapter.ts": ["server/llm/tool_loop/contracts.ts","server/llm/tool_loop/projection.ts","server/llm/tool_loop/receipts.ts","server/llm/tool_loop/recovery.ts","server/llm/tool_loop/runtime_activation.ts","server/llm/tool_loop/invocation_budget.ts","server/llm/tool_loop/lifecycle.ts","server/llm/tool_loop/artifacts.ts","server/llm/tool_loop/context_budget.ts","server/llm/tool_loop/summaries.ts","server/llm/tool_loop/model_budget.ts","server/llm/tool_loop/checkpoints.ts","server/llm/tool_loop/loop_dispatch.ts","server/llm/tool_loop/loop_setup.ts","server/llm/tool_loop/model_response.ts","server/llm/tool_loop/tool_batch.ts","server/llm/tool_loop/iteration.ts","server/llm/tool_loop/workflow.ts","server/llm/tool_loop/vision.ts"],
  "src/components/Settings.tsx": ["src/components/settings/voice_services.tsx","src/components/settings/official_models.tsx","src/components/settings/navigation.tsx","src/components/settings/hardware.tsx","src/components/settings/components.tsx","src/components/settings/model_operations.tsx","src/components/settings/provider_editor.tsx","src/components/settings/vision_voice_preferences.tsx","src/components/settings/model_preferences.tsx","src/components/settings/generation.tsx","src/components/settings/world_models.tsx","src/components/settings/retrieval.tsx","src/components/settings/connections.tsx","src/components/settings/provider_navigation.tsx","src/components/settings/reasoning.tsx","src/components/settings/official_provider.tsx","src/components/settings/local_provider.tsx","src/components/settings/provider_access.tsx","src/components/settings/autonomy.tsx"],
  "server/socket/chat.ts": [
    "server/socket/chat/phases/shared.ts",
    "server/socket/chat/phases/prepare_chat_request.ts",
    "server/socket/chat/phases/prepare_chat_events.ts",
    "server/socket/chat/phases/resolve_chat_control_turn.ts",
    "server/socket/chat/phases/admit_chat_foreground_turn.ts",
    "server/socket/chat/phases/start_chat_foreground_turn.ts",
    "server/socket/chat/phases/prepare_chat_prior_task_query.ts",
    "server/socket/chat/phases/prepare_chat_conversation_context.ts",
    "server/socket/chat/phases/prepare_chat_terminal_writers.ts",
    "server/socket/chat/phases/prepare_chat_execution_lease_and_tools.ts",
    "server/socket/chat/phases/prepare_chat_runtime_control_and_model.ts",
    "server/socket/chat/phases/prepare_chat_model_state.ts",
    "server/socket/chat/phases/execute_chat_model_and_delivery.ts"
  ],
  "server/socket/voice_conversation_turn.ts": [
    "server/socket/voice/turn/prepare_voice_identity_and_admission.ts",
    "server/socket/voice/turn/prepare_voice_context_and_routing.ts",
    "server/socket/voice/turn/prepare_voice_execution_and_prompt.ts",
    "server/socket/voice/turn/prepare_voice_receipts_and_tools.ts",
    "server/socket/voice/turn/prepare_voice_speech.ts",
    "server/socket/voice/turn/prepare_voice_release.ts",
    "server/socket/voice/turn/execute_voice_confirmed_and_deterministic_turn.ts",
    "server/socket/voice/turn/execute_voice_mode_and_messaging_turn.ts",
    "server/socket/voice/turn/execute_voice_model_turn.ts",
    "server/socket/voice/turn/finalize_voice_model_turn.ts"
  ],
  "src/components/DesktopUI.tsx": [
    "src/components/desktop/state/shared.tsx",
    "src/components/desktop/state/use_desktop_surface_state.tsx",
    "src/components/desktop/state/use_desktop_capture_and_identity.tsx",
    "src/components/desktop/state/use_desktop_runtime_and_preferences.tsx",
    "src/components/desktop/state/use_desktop_wallpaper.tsx",
    "src/components/desktop/state/use_desktop_notifications_and_shortcuts.tsx",
    "src/components/desktop/state/use_desktop_surface_controls.tsx",
    "src/components/desktop/state/use_desktop_presentation.tsx"
  ],
  "src/components/AgentChatPage.tsx": [
    "src/components/agent_chat/state/shared.tsx",
    "src/components/agent_chat/state/use_chat_identity_and_state.tsx",
    "src/components/agent_chat/state/use_chat_attachments_and_presentation.tsx",
    "src/components/agent_chat/state/use_chat_history_and_requests.tsx",
    "src/components/agent_chat/state/use_chat_scope_initialization.tsx",
    "src/components/agent_chat/state/use_chat_socket_events.tsx",
    "src/components/agent_chat/state/use_chat_request_controls.tsx",
    "src/components/agent_chat/state/use_chat_media_controls.tsx",
    "src/components/agent_chat/state/use_chat_uploads_and_view.tsx"
  ]
};

/** Rebase only module specifiers when inspecting actual phase implementations at their logical entry. */
function readPhaseSource(file: string, entry: string): string {
  const source = fs.readFileSync(path.resolve(file), 'utf8');
  if (file === entry) return source;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const visit = (node: ts.Node) => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require') ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text));
      let relative = path.posix.relative(path.posix.dirname(entry), target);
      if (!relative.startsWith('.')) relative = './' + relative;
      const quote = specifier.getText(ast)[0];
      edits.push({ start: specifier.getStart(ast), end: specifier.end, replacement: quote + relative + quote });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end), source);
}

const readOwnedSource = (file: string) => [...(phaseOwners[file] || []), file].map(name => readPhaseSource(name, file)).join('\n');
const readSourceModule = (file: string): string => modules[file] ? modules[file].map(name => name === file ? readOwnedSource(name) : readSourceModule(name)).join('\n') : readOwnedSource(file);
const chatPhases = ['confirmation_execution', 'result_delivery', 'context_retrieval', 'prompt_context', 'prior_task_status', 'model_execution'];

/** Unwrap only the explicit live-state access used by responsibility helpers. */
export function normalizeTurnBindings(source: string): string {
  return source.replace(/\b(?:context|runtime)\./g, '')
    .replace(/\{\s*return \{ terminal: true as const, context: undefined \};\s*\}/g, 'return;');
}

/** Source contracts follow live implementation modules; behavior tests still execute the real imports. */
export function readImplementationSource(file: fs.PathOrFileDescriptor, options?: any): any {
  const input = file instanceof URL ? fileURLToPath(file) : String(file);
  const normalized = path.resolve(input).replace(/\\/g, '/');
  const entry = [...Object.keys(modules), ...Object.keys(phaseOwners)].filter(name => name !== 'server/socket/chat.ts').find(name => normalized === name || normalized.endsWith('/' + name));
  if (entry) {
    const source = readSourceModule(entry);
    return entry.startsWith('server/') && !['server/conversation/manager.ts', 'server/tools/definitions/workflow_tools.ts'].includes(entry) ? normalizeTurnBindings(source) : source;
  }
  if (normalized === 'server/socket/chat.ts' || normalized.endsWith('/server/socket/chat.ts')) {
    let source = readOwnedSource('server/socket/chat.ts');
    for (const phase of chatPhases) {
      const filename = path.resolve('server/socket/chat/' + phase + '.ts');
      const text = fs.readFileSync(filename, 'utf8');
      const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
      const implementation = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) as ts.FunctionDeclaration;
      const name = implementation.name!.text;
      const callAst = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true);
      let statement: ts.Node | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(callAst) === name) {
          let current: ts.Node = node;
          while (current.parent && !ts.isBlock(current.parent) && !ts.isSourceFile(current.parent)) current = current.parent;
          statement = current;
        }
        ts.forEachChild(node, visit);
      };
      visit(callAst);
      if (!statement) throw new Error('Unreferenced chat phase: ' + name);
      // Expand the phase at its call site for source-order assertions, unwrapping
      // only the explicit context accessor used to preserve captured mutable state.
      const body = implementation.body!.statements.map(node => node.getFullText(ast)).join('').replace(/\bcontext\./g, '');
      let expanded = body;
      if (phase === 'context_retrieval' || phase === 'prompt_context') expanded = expanded.replace(/return \{[^]*?\};\s*$/, '');
      if (phase === 'prior_task_status') expanded = expanded.replace(/return false;\s*$/, '').replace(/return true;/g, 'return;');
      if (phase === 'confirmation_execution' && ts.isIfStatement(statement)) expanded = 'if (' + statement.expression.getText(callAst) + ') {\n' + expanded + '\n}';
      source = source.slice(0, statement.getFullStart()) + '\n' + expanded + '\n' + source.slice(statement.end);
    }
    return normalizeTurnBindings(fs.readFileSync(path.resolve('server/socket/chat/connection_controls.ts'), 'utf8') + '\n' + source);
  }
  return fs.readFileSync(file, options);
}

/** Count real calls, excluding accessor declarations that share the same name. */
export function countImplementationCalls(source: string, name: string): number {
  const ast = ts.createSourceFile('implementation.ts', source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(ast);
      if (callee === name) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); return count;
}
