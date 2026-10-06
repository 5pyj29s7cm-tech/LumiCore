import { normalizeTurnBindings, readImplementationSource } from './implementation_source';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { toolRecordSucceeded } from '../server/cognition/task_execution_ledger';

const filename = 'server/socket/voice_conversation_turn.ts';
const source = readImplementationSource(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
const turn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'processAdmittedVoiceTurn') as ts.FunctionDeclaration;
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name).map(node => [node.name!.text, node]));
const calls = (root: ts.Node, name: string) => {
  const result = new Set<ts.CallExpression>();
  const expanded = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(ast);
      if (callee === name) result.add(node);
      const implementation = functions.get(callee);
      if (implementation && !expanded.has(callee)) { expanded.add(callee); visit(implementation.body!); }
    }
    ts.forEachChild(node, visit);
  };
  visit(root); return [...result];
};

describe('single voice release owner and mode result truth', () => {
  it('owns memory, confirmation, status and ordinary model exits in the shared finally', () => {
    const entryCalls = calls(turn, 'runLumiEntryTurn');
    expect(entryCalls).toHaveLength(1);
    const input = entryCalls[0].arguments[0] as ts.ObjectLiteralExpression;
    const property = (name: string) => input.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === name) as ts.PropertyAssignment;
    const assembly = property('assemble').initializer;
    const failure = property('onFailure').initializer;
    const settlement = property('settle').initializer;
    expect(calls(turn, 'releaseVoiceTurnResources')).toHaveLength(1);
    expect(calls(settlement, 'releaseVoiceTurnResources')).toHaveLength(1);
    for (const name of ['persistTurnMemory', 'executeConfirmedToolStep', 'finishVoiceTerminal', 'prepareVoiceModelTurn']) {
      expect([...calls(assembly, name), ...calls(failure, name)].length, name + ' must be owned by entry assembly or failure').toBeGreaterThan(0);
    }
    expect(calls(turn, 'runPreparedLumiTurn')).toHaveLength(0);
    const coreSource = readImplementationSource('server/cognition/turn_execution.ts', 'utf8');
    const coreAst = ts.createSourceFile('turn_execution.ts', coreSource, ts.ScriptTarget.Latest, true);
    const core = coreAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runLumiEntryTurn') as ts.FunctionDeclaration;
    const owner = core.body!.statements.find(node => ts.isTryStatement(node) && node.finallyBlock) as ts.TryStatement;
    expect(owner.tryBlock.getText(coreAst)).toContain('await runPreparedLumiTurn({');
    const release = owner.finallyBlock!.getText(coreAst);
    expect(release).toContain('await input.settle?.()');
    expect(release.indexOf('await input.settle?.()')).toBeLessThan(release.indexOf('admission?.release()'));
  });
  const modeBranch = (() => {
    let found: ts.IfStatement | undefined;
    const visit = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(ast) === 'directlyAppliedMode') found = node; ts.forEachChild(node, visit); };
    visit(ast); if (!found || !ts.isBlock(found.thenStatement)) throw new Error('Voice mode implementation missing');
    const statements = found.thenStatement.statements;
    const end = statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(ast) === 'modeSynced');
    if (end < 0) throw new Error('Voice mode persistence boundary missing');
    const body = normalizeTurnBindings(statements.slice(0, end + 1).map(node => node.getFullText(ast)).join(''));
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
