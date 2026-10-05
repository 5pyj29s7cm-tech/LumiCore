import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { providerGetterArguments, type ProviderGetters } from '../server/llm/provider_getters';

const SERVER_ROOT = fileURLToPath(new URL('../server/', import.meta.url));
const GETTER_MODULE = path.join(SERVER_ROOT, 'llm/provider_getters');
const PROVIDER_KEYS = ['getDeepSeek', 'getGemini', 'getOpenAI', 'getAnthropic', 'getQwen', 'getOllama', 'getLmStudio', 'getArk', 'getXiaomi', 'getKimi', 'getGlm', 'getRelay'];
const EXPECTED_ARGUMENT_COUNT = 3 + PROVIDER_KEYS.length;

function expandedArgumentCount(source: ts.SourceFile, call: ts.CallExpression): number {
  if (!call.arguments.some(ts.isSpreadElement)) return call.arguments.length;
  if (call.arguments.length !== 4 || call.arguments.slice(0, 3).some(ts.isSpreadElement)) return -1;
  const spread = call.arguments[3];
  if (!ts.isSpreadElement(spread) || !ts.isCallExpression(spread.expression)) return -1;
  const helper = spread.expression;
  if (!ts.isIdentifier(helper.expression) || helper.arguments.length < 1 || helper.arguments.length > 2) return -1;
  if (helper.arguments.length === 2 && (!ts.isStringLiteral(helper.arguments[1]) || !['primary', 'optional', 'all'].includes(helper.arguments[1].text))) return -1;
  const name = helper.expression.text;
  const imported = source.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) return false;
    const target = path.resolve(path.dirname(source.fileName), statement.moduleSpecifier.text).replace(/\.tsx?$/, '');
    const bindings = statement.importClause?.namedBindings;
    return target === GETTER_MODULE && bindings && ts.isNamedImports(bindings)
      && bindings.elements.some(binding => binding.name.text === name && (binding.propertyName?.text || binding.name.text) === 'providerGetterArguments');
  });
  return imported ? EXPECTED_ARGUMENT_COUNT : -1;
}

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? productionFiles(file) : entry.isFile() && /\.tsx?$/.test(file) && !file.endsWith('.d.ts') ? [file] : [];
  });
}

const sites: Array<{ file: string; line: number; count: number }> = [];
for (const file of productionFiles(SERVER_ROOT)) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['makeLLMCall', 'callAuthorizedModel'].includes(node.expression.text)) {
      sites.push({ file: path.relative(SERVER_ROOT, file).replace(/\\/g, '/'),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, count: expandedArgumentCount(source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function parsedCall(code: string) {
  const source = ts.createSourceFile(path.join(SERVER_ROOT, 'synthetic.ts'), code, ts.ScriptTarget.Latest, true);
  const statement = source.statements.find(ts.isExpressionStatement)!;
  return expandedArgumentCount(source, statement.expression as ts.CallExpression);
}

describe('production makeLLMCall provider getter contract', () => {
  it('discovers every production call without exempting arbitrary rest wrappers', () => expect(sites.length).toBeGreaterThan(0));
  it.each(sites)('$file:$line passes every provider getter', site => expect(site.count).toBe(EXPECTED_ARGUMENT_COUNT));
  it('rejects short tuples, unknown spreads, and same-name helpers from a different module', () => {
    expect(parsedCall('makeLLMCall(a,b,c,...args);')).toBe(-1);
    expect(parsedCall('import { providerGetterArguments } from "./other"; makeLLMCall(a,b,c,...providerGetterArguments(g));')).toBe(-1);
    expect(parsedCall('makeLLMCall(a,b,c,d,e,f,g,h,i,j,k,l,m,n);')).toBe(14);
    expect(parsedCall('import { providerGetterArguments as getters } from "./llm/provider_getters"; makeLLMCall(a,b,c,...getters(g));')).toBe(EXPECTED_ARGUMENT_COUNT);
  });
  it('forwards all named clients in the provider ABI order without creating them early', () => {
    const getters = Object.fromEntries(PROVIDER_KEYS.map(key => [key, vi.fn(() => key)])) as unknown as ProviderGetters;
    const prefix = [{ role: 'user' }, [], { provider: 'relay' }];
    const call = vi.fn();
    call(...prefix, ...providerGetterArguments(getters));
    expect(call.mock.calls[0].slice(0, 3)).toEqual(prefix);
    for (const getter of Object.values(getters)) expect(getter).not.toHaveBeenCalled();
    expect(call.mock.calls[0].slice(3).map(getter => getter())).toEqual(PROVIDER_KEYS);
  });
  it('preserves the tool loop fallback for every absent client without creating supplied clients early', () => {
    const supplied = vi.fn(() => 'ark-client');
    const args = providerGetterArguments({ getArk: supplied }, 'all');
    expect(args).toHaveLength(PROVIDER_KEYS.length);
    expect(supplied).not.toHaveBeenCalled();
    const arkIndex = PROVIDER_KEYS.indexOf('getArk');
    expect(args[arkIndex]).toBe(supplied);
    for (let index = 0; index < args.length; index++) {
      if (index !== arkIndex) expect(args[index]!()).toBeNull();
    }
  });
  it('retains explicit primary fallback while leaving absent optional clients absent', () => {
    const args = providerGetterArguments({}, 'primary');
    expect(args[0]()).toBeNull(); expect(args[1]()).toBeNull();
    expect(args.slice(2)).toEqual(Array(10).fill(undefined));
  });
});
