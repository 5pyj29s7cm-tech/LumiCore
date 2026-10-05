import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';

const sources = new Map<string, ts.SourceFile>();
export function readSourceAst(file: string): ts.SourceFile {
  if (!sources.has(file)) sources.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return sources.get(file)!;
}

/** Execute the current production expression with explicit test dependencies. */
export function extractSourceExpression(file: string, name: string, dependencies: Record<string, unknown>): any {
  const visited = new Set<string>();
  let expression = '';
  const findExpression = (sourcePath: string): void => {
  if (visited.has(sourcePath)) return;
  visited.add(sourcePath);
  const ast = readSourceAst(sourcePath);
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      const init = node.initializer;
      expression = ts.isCallExpression(init) && ['useCallback', 'useMemo'].includes(init.expression.getText(ast))
        ? init.arguments[0].getText(ast) : init.getText(ast);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(ast).replace(/^export\s+/, '');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (expression) return;
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const relative = statement.moduleSpecifier.text;
    if (!relative.startsWith('.')) continue;
    const base = path.resolve(path.dirname(sourcePath), relative);
    const imported = [base + '.ts', base + '.tsx'].find(candidate => fs.existsSync(candidate));
    if (imported) findExpression(imported);
    if (expression) return;
  }
  };
  findExpression(file);
  if (!expression) throw new Error('Production expression missing: ' + file + ':' + name);
  return vm.runInNewContext(ts.transpileModule('(' + expression + ')', {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, dependencies);
}

/** Load a complete hook with explicit imports while preserving the test's browser globals. */
export function loadSourceModule<T>(file: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected hook dependency: ' + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports as T;
}
