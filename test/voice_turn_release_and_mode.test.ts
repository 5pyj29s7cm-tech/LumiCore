import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { toolRecordSucceeded } from '../server/cognition/task_execution_ledger';

const filename = 'server/socket/voice_conversation_turn.ts';
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
const turn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'processVoiceInput') as ts.FunctionDeclaration;
const calls = (root: ts.Node, name: string) => {
  const result: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === name) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
};

describe('single voice release owner and mode result truth', () => {
  it('owns memory, confirmation, status and ordinary model exits in the same finally', () => {
    const owners = turn.body!.statements.filter(node => ts.isTryStatement(node) && node.finallyBlock && calls(node.finallyBlock, 'releaseVoiceTurnResources').length) as ts.TryStatement[];
    expect(owners).toHaveLength(1);
    expect(calls(turn, 'releaseVoiceTurnResources')).toHaveLength(1);
    const owner = owners[0];
    for (const name of ['persistTurnMemory', 'executeToolCall', 'finishVoiceTerminal', 'runToolSession', 'runConversationTurn']) {
      const owned = calls(owner.tryBlock, name);
      expect(owned.length, name + ' must be enclosed by the release owner').toBeGreaterThan(0);
      for (const call of calls(turn, name).filter(call => call.getStart(ast) > owner.getStart(ast))) expect(owned).toContain(call);
    }
    expect(calls(owner.finallyBlock!, 'releaseVoiceTurnResources')).toHaveLength(1);
  });
  const modeBranch = (() => {
    let found: ts.IfStatement | undefined;
    const visit = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(ast) === 'directlyAppliedMode') found = node; ts.forEachChild(node, visit); };
    visit(turn); if (!found || !ts.isBlock(found.thenStatement)) throw new Error('Voice mode implementation missing');
    const statements = found.thenStatement.statements;
    const end = statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(ast) === 'modeSynced');
    if (end < 0) throw new Error('Voice mode persistence boundary missing');
    const body = statements.slice(0, end + 1).map(node => node.getFullText(ast)).join('');
    const js = ts.transpileModule(body + '\nreturn { modeSynced, modeToolRecord };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function('desktopRelay', 'saveStoredOperationMode', 'toolRecordSucceeded', 'session', 'emitAgent', 'isCurrentTurn', 'releaseVoiceTurnResources', 'directlyAppliedMode', 'return (async () => {' + js + '})()');
  })();
  it.each([JSON.stringify({ ok: false, error: 'client refused' }), JSON.stringify({ ok: true, success: false }), '', null])('does not store meeting mode after a failed or empty client receipt (%s)', async result => {
    const save = vi.fn();
    const response = await modeBranch(async () => result, save, toolRecordSucceeded, { userId: 'owner' }, vi.fn(), () => true, vi.fn(), 'meeting');
    expect(response.modeSynced).toBe(false); expect(save).not.toHaveBeenCalled();
  });
  it('stores meeting mode only after a successful client receipt', async () => {
    const save = vi.fn();
    const response = await modeBranch(async () => JSON.stringify({ ok: true, mode: 'meeting' }), save, toolRecordSucceeded, { userId: 'owner' }, vi.fn(), () => true, vi.fn(), 'meeting');
    expect(response.modeSynced).toBe(true); expect(save).toHaveBeenCalledExactlyOnceWith('owner', 'meeting');
  });
});
