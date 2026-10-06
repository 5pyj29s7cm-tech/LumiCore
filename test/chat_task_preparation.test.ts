import { readImplementationSource } from './implementation_source';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const source = readImplementationSource('server/socket/chat.ts', 'utf8');
const ast = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true);
let preparation: ts.VariableDeclaration | undefined, resumes: ts.VariableDeclaration | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'preparation') preparation = node;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'resumesAction') resumes = node;
  ts.forEachChild(node, visit);
};
visit(ast);
if (!preparation?.initializer || !resumes?.initializer) throw new Error('Chat preparation implementation missing');
const js = ts.transpileModule('const resumesAction = ' + resumes.initializer.getText(ast) + '; const preparation = ' + preparation.initializer.getText(ast) + '; return preparation;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const evaluate = new Function('acceptedRuntimeCleanupOffer', 'conversationId', 'selectedConversationId', 'bindsExistingAction', 'existingActionState', 'pendingConfirmation', 'capabilitySelection', 'structuredMediaRequest', 'modelCapabilityPolicy', 'actionFollowupIntent', js);
const policy = { allowedTools: ['read_file'], requireConfirmation: [], forbiddenTools: ['payment'], maxIterations: 4 };
const plan = (state: { cleanup?: boolean; conversation?: string; bound?: boolean; task?: string; pending?: boolean; ledger?: boolean; media?: boolean; feedback?: string } = {}) => evaluate(
  state.cleanup ? {} : null, state.conversation ?? 'conversation', 'selected', Boolean(state.bound), { taskId: state.task }, state.pending ? {} : null,
  { taskLedgerRequired: Boolean(state.ledger) }, state.media ? {} : null, policy, state.feedback || '',
);
describe('one chat task preparation decision', () => {
  it('keeps greetings and status queries taskless even when an old task exists', () => {
    expect(plan()).toBeNull(); expect(plan({ task: 'old', feedback: 'status' })).toBeNull();
  });
  it.each([{ ledger: true }, { media: true }, { pending: true }])('creates a fresh task only for admitted work or a taskless pending grant (%o)', state => {
    expect(plan(state)).toEqual({ conversationId: 'conversation', toolPolicy: policy, followupIntent: '', forceTask: true });
  });
  it('resumes an explicitly bound continuation without forcing a new task', () => {
    expect(plan({ bound: true, task: 'old', feedback: 'correction' })).toEqual({ conversationId: 'conversation', toolPolicy: policy,
      followupIntent: 'correction', forceResume: true, preserveExistingTask: true });
  });
  it('resumes an exact pending grant in the selected conversation when the local conversation variable is absent', () => {
    expect(plan({ conversation: '', task: 'old', pending: true })).toEqual({ conversationId: 'selected', toolPolicy: policy,
      followupIntent: '', forceResume: true, preserveExistingTask: true });
  });
  it('gives accepted cleanup its own narrow mutation task rather than adopting the preceding status task', () => {
    expect(plan({ cleanup: true, bound: true, task: 'status', pending: true })).toEqual({ conversationId: 'conversation',
      toolPolicy: { allowedTools: ['runtime_work_cancel'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 },
      forceTask: true, forceNewTask: true, preserveExistingTask: false });
  });
  it('does not prepare fresh or cleanup work without an admitted conversation', () => {
    expect(plan({ conversation: '', ledger: true, media: true })).toBeNull();
    expect(plan({ conversation: '', cleanup: true, ledger: true })).toBeNull();
  });
});
