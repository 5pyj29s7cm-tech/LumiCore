import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const catalogPath = path.join(sourceRoot, 'i18n', 'locales', 'ui.generated.json');
const catalog = fs.existsSync(catalogPath)
  ? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  : {};

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

function literalValue(node) {
  if (!node) return null;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function templateValue(node) {
  const literal = literalValue(node);
  if (literal !== null) return { message: literal, expressions: [] };
  if (!node || !ts.isTemplateExpression(node)) return null;
  const expressions = [];
  let message = node.head.text;
  for (const span of node.templateSpans) {
    message += `{value${expressions.length}}${span.literal.text}`;
    expressions.push(span.expression);
  }
  return { message, expressions };
}

function slug(value) {
  const words = value.toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.slice(0, 5).join('-') || 'message';
}

function importPath(fromFile) {
  let relative = path.relative(path.dirname(fromFile), path.join(sourceRoot, 'i18n', 'uiMessages'));
  relative = relative.replace(/\\/g, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function messageKey(file, zh, en) {
  const component = path.basename(file).replace(/\.(?:tsx?|jsx?)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
  const hash = crypto.createHash('sha256').update(`${en}\0${zh}`).digest('hex').slice(0, 10);
  return `${component}.${slug(en)}.${hash}`;
}

let migratedCalls = 0;
let changedFiles = 0;

for (const file of walk(sourceRoot)) {
  if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
  const original = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    original,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const replacements = [];

  function visit(node) {
    if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && (node.expression.text === 'ui' || node.expression.text === 'localize')) {
      let zh = literalValue(node.arguments[0]);
      let en = literalValue(node.arguments[1]);
      let explicitLocaleExpression = '';

      if (zh === null || en === null) {
        zh = literalValue(node.arguments[1]);
        en = literalValue(node.arguments[2]);
        if (zh !== null && en !== null && node.arguments[0]) {
          explicitLocaleExpression = node.arguments[0].getText(source);
        }
      }

      if (zh !== null && en !== null) {
        const key = messageKey(file, zh, en);
        const replacement = explicitLocaleExpression
          ? `uiMessage('${key}', (${explicitLocaleExpression}) ? 'zh' : 'en')`
          : `uiMessage('${key}')`;
        replacements.push({ start: node.getStart(source), end: node.getEnd(), replacement });
        catalog[key] = { en, zh };
      } else {
        let zhTemplate = templateValue(node.arguments[0]);
        let enTemplate = templateValue(node.arguments[1]);
        let explicitLocaleExpression = '';
        if (!zhTemplate || !enTemplate) {
          zhTemplate = templateValue(node.arguments[1]);
          enTemplate = templateValue(node.arguments[2]);
          if (zhTemplate && enTemplate && node.arguments[0]) {
            explicitLocaleExpression = node.arguments[0].getText(source);
          }
        }
        if (zhTemplate && enTemplate) {
          const key = messageKey(file, zhTemplate.message, enTemplate.message);
          const valueCount = Math.max(zhTemplate.expressions.length, enTemplate.expressions.length);
          const values = [];
          for (let index = 0; index < valueCount; index++) {
            const zhExpression = zhTemplate.expressions[index]?.getText(source) || "''";
            const enExpression = enTemplate.expressions[index]?.getText(source) || "''";
            const expression = zhExpression === enExpression
              ? zhExpression
              : `{ en: ${enExpression}, zh: ${zhExpression} }`;
            values.push(`value${index}: ${expression}`);
          }
          const localeArgument = explicitLocaleExpression
            ? `, (${explicitLocaleExpression}) ? 'zh' : 'en'`
            : '';
          replacements.push({
            start: node.getStart(source),
            end: node.getEnd(),
            replacement: `formatUiMessage('${key}', { ${values.join(', ')} }${localeArgument})`,
          });
          catalog[key] = { en: enTemplate.message, zh: zhTemplate.message };
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (!replacements.length) continue;

  const needsFormat = replacements.some(edit => edit.replacement.includes('formatUiMessage('));
  const hasImport = original.includes("from '../i18n/uiMessages'")
    || original.includes("from './i18n/uiMessages'")
    || original.includes('i18n/uiMessages');
  if (!hasImport) {
    const imports = source.statements.filter(ts.isImportDeclaration);
    const insertAt = imports.length ? imports[imports.length - 1].getEnd() : 0;
    replacements.push({
      start: insertAt,
      end: insertAt,
      replacement: `\nimport { ${needsFormat ? 'formatUiMessage, ' : ''}uiMessage } from '${importPath(file)}';`,
    });
  } else if (needsFormat) {
    const importMatch = original.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*i18n\/uiMessages['"];?/);
    if (importMatch && !importMatch[1].includes('formatUiMessage')) {
      replacements.push({
        start: importMatch.index,
        end: importMatch.index + importMatch[0].length,
        replacement: importMatch[0].replace('{', '{ formatUiMessage,'),
      });
    }
  }

  let updated = original;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    updated = `${updated.slice(0, edit.start)}${edit.replacement}${updated.slice(edit.end)}`;
  }
  fs.writeFileSync(file, updated, 'utf8');
  migratedCalls += replacements.length - (hasImport ? 0 : 1);
  changedFiles++;
}

const sortedCatalog = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(catalogPath, `${JSON.stringify(sortedCatalog, null, 2)}\n`, 'utf8');
console.log(`Migrated ${migratedCalls} static UI messages across ${changedFiles} files.`);
