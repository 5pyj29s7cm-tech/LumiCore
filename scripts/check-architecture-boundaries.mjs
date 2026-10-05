import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
const baselinePath = path.join(root, 'architecture/import-boundaries.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const violations = [];
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\0').filter(file => /^(?:server\/|shared\/|src\/|server\.ts$)/.test(file) && /\.tsx?$/.test(file));
const databaseModule = path.join(root, 'db_layer');
const importers = [];
const databaseBindings = new Map();
const duplicateProviderTypes = [];
const providerFields = new Set(['getDeepSeek', 'getGemini', 'getOpenAI', 'getAnthropic', 'getQwen', 'getOllama', 'getLmStudio', 'getArk', 'getXiaomi', 'getKimi', 'getGlm', 'getRelay', 'isOllamaAvailable', 'isLmStudioAvailable']);
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let importsDatabase = false;
  const bindings = new Set();
  const tableReadAliases = new Set();
  const tableReads = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && tableReadAliases.has(node.expression.text)) {
      const selection = node.arguments[0];
      tableReads.push(selection && ts.isArrayLiteralExpression(selection) && selection.elements.every(ts.isStringLiteral)
        ? selection.elements.map(element => element.text) : null);
    }
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
      if (target === databaseModule) {
        importsDatabase = true;
        if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
          && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name) {
          for (const binding of node.importClause.namedBindings.elements) {
            const name = (binding.propertyName || binding.name).text;
            bindings.add(name);
            if (name === 'readDatabaseTables') tableReadAliases.add(binding.name.text);
          }
        } else bindings.add('*');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const tableGrant = baseline.approvedTableImporters?.[file];
  const sqlGrant = baseline.approvedSqlImporters?.[file];
  const grant = tableGrant || sqlGrant;
  if (grant && [...bindings].some(binding => !grant.allowedExports.includes(binding))) violations.push(file + ': undeclared database export');
  if (tableReadAliases.size && (!tableGrant || tableReads.some(keys => !keys?.length || new Set(keys).size !== keys.length || keys.some(key => !tableGrant.tables.includes(key))))) {
    violations.push(file + ': table selection must be a nonempty distinct literal subset of the module grant');
  }
  if (bindings.has('readDB') || bindings.has('writeDB')) violations.push(file + ': full database root access is forbidden');
  if (importsDatabase) {
    const normalized = file.replaceAll('\\', '/');
    importers.push(normalized);
    databaseBindings.set(normalized, bindings);
  }
}
importers.sort();
if (process.argv.includes('--record-baseline')) {
  throw new Error('Global database baselines cannot be regenerated; review explicit table/export grants.');

} else {
  const durability = baseline.approvedDurabilityImporters || {};
  const allowed = new Set([...baseline.allowedDatabaseImporters, ...Object.keys(baseline.approvedScopedImporters || {}), ...Object.keys(durability), ...Object.keys(baseline.approvedTableImporters || {}), ...Object.keys(baseline.approvedSqlImporters || {})]);
  const escapedFences = importers.filter(file => durability[file]
    && [...databaseBindings.get(file)].some(binding => !durability[file].allowedExports.includes(binding)));
  if (escapedFences.length) {
    console.error('Durability-only modules cannot regain database reads, writes or SQL:\n' + escapedFences.join('\n'));
    process.exitCode = 1;
  }
  const added = importers.filter(file => !allowed.has(file));
  if (added.length) {
    console.error('New global database dependencies require a scoped repository review:\n' + added.join('\n'));
    process.exitCode = 1;
  } else if (!escapedFences.length) {
    console.log('[architecture] ' + importers.length + ' database importers: '
      + importers.filter(file => baseline.allowedDatabaseImporters.includes(file)).length + ' legacy, '
      + importers.filter(file => baseline.approvedScopedImporters?.[file]).length + ' scoped, '
      + importers.filter(file => durability[file]).length + ' durability-only, ' + importers.filter(file => baseline.approvedTableImporters?.[file]).length + ' selected-table, ' + importers.filter(file => baseline.approvedSqlImporters?.[file]).length + ' SQL; no new unreviewed crossings.');
  }
}

if (violations.length) { console.error('Database scope violations:\n' + violations.join('\n')); process.exitCode = 1; }

if (duplicateProviderTypes.length) {
  console.error('Duplicate provider getter types must use server/llm/provider_getters.ts:\n' + duplicateProviderTypes.join('\n'));
  process.exitCode = 1;
}
