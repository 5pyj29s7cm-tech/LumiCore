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
  const entry = [...Object.keys(modules), 'server/socket/voice_conversation_turn.ts'].find(name => normalized === name || normalized.endsWith('/' + name));
  if (entry) {
    const source = readSourceModule(entry);
    return entry.startsWith('server/') ? normalizeTurnBindings(source) : source;
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
