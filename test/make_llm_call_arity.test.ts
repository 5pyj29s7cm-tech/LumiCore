import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

interface MakeLlmCallSite {
  file: string;
  line: number;
  argumentCount: number;
  callee: string;
}

interface AuthorizedModelWrapper {
  sourceFile: ts.SourceFile;
  declaration: ts.VariableDeclaration;
  file: string;
  line: number;
}

const SERVER_ROOT = fileURLToPath(new URL('../server/', import.meta.url));
const EXPECTED_ARGUMENT_COUNT = 15;

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolutePath);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    return [absolutePath];
  });
}

function collectMakeLlmCallSites(): { sites: MakeLlmCallSite[]; wrappers: AuthorizedModelWrapper[] } {
  const sites: MakeLlmCallSite[] = [];
  const wrappers: AuthorizedModelWrapper[] = [];

  for (const file of productionTypeScriptFiles(SERVER_ROOT)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'callAuthorizedModel') {
        wrappers.push({ sourceFile, declaration: node,
          file: path.relative(SERVER_ROOT, file).replace(/\\/g, '/'),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
      // A call expression cannot match the makeLLMCall function declaration,
      // so this scans production invocations without counting its definition.
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && ['makeLLMCall', 'callAuthorizedModel'].includes(node.expression.text)
      ) {
        const parent = node.parent;
        const arrow = ts.isReturnStatement(parent) && ts.isBlock(parent.parent) ? parent.parent.parent : undefined;
        const declaration = arrow && ts.isArrowFunction(arrow) ? arrow.parent : undefined;
        // This single forwarding call is validated below as an exact typed
        // rest wrapper. Its callers, and all other direct calls, still need
        // all 15 explicit arguments; arbitrary spread calls are not exempt.
        const authorizedForwardingCall = node.expression.text === 'makeLLMCall'
          && declaration && ts.isVariableDeclaration(declaration)
          && ts.isIdentifier(declaration.name) && declaration.name.text === 'callAuthorizedModel';
        if (authorizedForwardingCall) return;
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        sites.push({
          file: path.relative(SERVER_ROOT, file).replace(/\\/g, '/'),
          line: position.line + 1,
          argumentCount: node.arguments.length,
          callee: node.expression.text,
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  sites.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line,
  );
  return { sites, wrappers };
}

const { sites: productionCallSites, wrappers: authorizedWrappers } = collectMakeLlmCallSites();

describe('production makeLLMCall provider getter contract', () => {
  it('discovers production call sites', () => {
    expect(productionCallSites.length).toBeGreaterThan(0);
    expect(productionCallSites.some(site => site.callee === 'callAuthorizedModel')).toBe(true);
    expect(authorizedWrappers.map(wrapper => wrapper.file)).toEqual(['socket/chat.ts']);
  });

  it.each(authorizedWrappers)('$file:$line authorizes then forwards the full typed argument tuple unchanged', wrapper => {
    const arrow = wrapper.declaration.initializer;
    expect(arrow && ts.isArrowFunction(arrow)).toBe(true);
    if (!arrow || !ts.isArrowFunction(arrow)) throw new Error('Expected the authorized model arrow wrapper');
    expect(arrow.parameters).toHaveLength(1);
    const parameter = arrow.parameters[0];
    expect(parameter.dotDotDotToken).toBeDefined();
    expect(parameter.name.getText(wrapper.sourceFile)).toBe('args');
    expect(parameter.type && ts.isTypeReferenceNode(parameter.type)).toBe(true);
    if (!parameter.type || !ts.isTypeReferenceNode(parameter.type)) throw new Error('Expected a typed provider argument tuple');
    expect(parameter.type.typeName.getText(wrapper.sourceFile)).toBe('Parameters');
    expect(parameter.type.typeArguments).toHaveLength(1);
    const typeQuery = parameter.type.typeArguments![0];
    expect(ts.isTypeQueryNode(typeQuery)).toBe(true);
    if (!ts.isTypeQueryNode(typeQuery)) throw new Error('Expected Parameters<typeof makeLLMCall>');
    expect(typeQuery.exprName.getText(wrapper.sourceFile)).toBe('makeLLMCall');
    expect(ts.isBlock(arrow.body)).toBe(true);
    if (!ts.isBlock(arrow.body)) throw new Error('Expected authorization before forwarding');
    expect(arrow.body.statements).toHaveLength(2);
    expect(arrow.body.statements[0].getText(wrapper.sourceFile)).toBe('turnAuthorization.assertCurrent();');
    const returned = arrow.body.statements[1];
    expect(ts.isReturnStatement(returned)).toBe(true);
    if (!ts.isReturnStatement(returned) || !returned.expression || !ts.isCallExpression(returned.expression)) {
      throw new Error('Expected the direct provider call to be returned');
    }
    const call = returned.expression;
    expect(call.expression.getText(wrapper.sourceFile)).toBe('makeLLMCall');
    expect(call.arguments).toHaveLength(1);
    expect(ts.isSpreadElement(call.arguments[0])).toBe(true);
    if (!ts.isSpreadElement(call.arguments[0])) throw new Error('Expected complete rest-tuple forwarding');
    expect(call.arguments[0].expression.getText(wrapper.sourceFile)).toBe('args');

    // Execute only the structurally verified wrapper with inert collaborators.
    // Distinct sentinels expose missing, reordered, or copied getter arguments.
    const compiled = ts.transpileModule(`return (${arrow.getText(wrapper.sourceFile)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const order: string[] = [];
    let received: unknown[] = [];
    const result = {};
    const authority = { assertCurrent() { order.push('authorize'); } };
    const forward = new Function('makeLLMCall', 'turnAuthorization', compiled)(
      (...args: unknown[]) => { order.push('call'); received = args; return result; }, authority,
    ) as (...args: unknown[]) => unknown;
    const sentinels = Array.from({ length: EXPECTED_ARGUMENT_COUNT }, (_, index) => ({ index }));
    expect(forward(...sentinels)).toBe(result);
    expect(order).toEqual(['authorize', 'call']);
    expect(received).toHaveLength(EXPECTED_ARGUMENT_COUNT);
    received.forEach((value, index) => expect(value).toBe(sentinels[index]));
    authority.assertCurrent = () => { throw new Error('Authorization revoked'); };
    expect(() => forward(...sentinels)).toThrow('Authorization revoked');
    expect(order).toEqual(['authorize', 'call']);
  });

  it.each(productionCallSites)('$file:$line passes every provider getter', callSite => {
    expect(callSite.argumentCount).toBe(EXPECTED_ARGUMENT_COUNT);
  });
});
