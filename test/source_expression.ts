import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const sources = new Map<string, ts.SourceFile>();
export function readSourceAst(file: string): ts.SourceFile {
  if (!sources.has(file)) sources.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return sources.get(file)!;
}

/** Execute the current production expression with explicit test dependencies. */
export function extractSourceExpression(file: string, name: string, dependencies: Record<string, unknown>): any {
  const ast = readSourceAst(file);
  let expression = '';
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
