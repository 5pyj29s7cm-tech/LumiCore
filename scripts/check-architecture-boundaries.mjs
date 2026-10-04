import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
const baselinePath = path.join(root, 'architecture/import-boundaries.json');
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\0').filter(file => /^(?:server\/|shared\/|src\/|server\.ts$)/.test(file) && /\.tsx?$/.test(file));
const databaseModule = path.join(root, 'db_layer');
const importers = [];
const duplicateProviderTypes = [];
const providerFields = new Set(['getDeepSeek', 'getGemini', 'getOpenAI', 'getAnthropic', 'getQwen', 'getOllama', 'getLmStudio', 'getArk', 'getXiaomi', 'getKimi', 'getGlm', 'getRelay', 'isOllamaAvailable', 'isLmStudioAvailable']);
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let importsDatabase = false;
  function visit(node) {
    if (file !== 'server/llm/provider_getters.ts' && (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node))) {
      const members = node.members;
      if (members.length >= 10 && members.every(member => member.name && providerFields.has(member.name.getText(source)))
        && members.some(member => member.name?.getText(source) === 'getDeepSeek' && member.type && ts.isFunctionTypeNode(member.type) && member.type.type.kind === ts.SyntaxKind.AnyKeyword)
        && members.some(member => member.name?.getText(source) === 'getGemini' && member.type && ts.isFunctionTypeNode(member.type) && member.type.type.kind === ts.SyntaxKind.AnyKeyword)) {
        duplicateProviderTypes.push(file + ':' + (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1));
      }
    }
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')
        ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      const target = path.resolve(root, path.dirname(file), specifier.text).replace(/\.(?:[cm]?js|tsx?)$/, '');
      if (target === databaseModule) importsDatabase = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (importsDatabase) importers.push(file.replaceAll('\\', '/'));
}
importers.sort();
if (process.argv.includes('--record-baseline')) {
  fs.writeFileSync(baselinePath, JSON.stringify({
    schemaVersion: 1,
    policy: 'Existing global database imports are migration debt. New importers require a reviewed scoped repository; update this allow-list explicitly with its scope justification.',
    approvedScopedImporters: {'server/org/durable_routes.ts': 'Organization-scoped snapshots, serialized writes and row-version compensation.'},
    allowedDatabaseImporters: importers,
  }, null, 2) + '\n');
} else {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const allowed = new Set([...baseline.allowedDatabaseImporters, ...Object.keys(baseline.approvedScopedImporters || {})]);
  const added = importers.filter(file => !allowed.has(file));
  if (added.length) {
    console.error('New global database dependencies require a scoped repository review:\n' + added.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('[architecture] ' + importers.length + ' existing database importers; no new unreviewed crossings.');
  }
}

if (duplicateProviderTypes.length) {
  console.error('Duplicate provider getter types must use server/llm/provider_getters.ts:\n' + duplicateProviderTypes.join('\n'));
  process.exitCode = 1;
}
