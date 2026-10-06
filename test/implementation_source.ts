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
  const entry = Object.keys(modules).find(name => normalized === name || normalized.endsWith('/' + name));
  if (entry) {
    const source = modules[entry].map(name => fs.readFileSync(path.resolve(name), 'utf8')).join('\n');
    return entry.startsWith('server/') ? normalizeTurnBindings(source) : source;
  }
  if (normalized === 'server/socket/chat.ts' || normalized.endsWith('/server/socket/chat.ts')) {
    let source = fs.readFileSync(file, 'utf8');
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
