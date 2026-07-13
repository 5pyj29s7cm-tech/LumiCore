import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const catalogPath = path.join(sourceRoot, 'i18n', 'locales', 'ui.generated.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

function templateValue(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { message: node.text, expressions: [] };
  }
  if (!ts.isTemplateExpression(node)) return null;
  const expressions = [];
  let message = node.head.text;
  for (const span of node.templateSpans) {
    message += `{value${expressions.length}}${span.literal.text}`;
    expressions.push(span.expression);
  }
  return { message, expressions };
}

function isLanguageReference(node) {
  if (ts.isIdentifier(node)) return /^(?:lang|language|locale|uiLang)$/i.test(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    return /^(?:lang|language|locale|langCode)$/i.test(node.name.text);
  }
  return false;
}

function localeCondition(node) {
  if (ts.isParenthesizedExpression(node)) return localeCondition(node.expression);
  if (ts.isIdentifier(node) && /^(?:isZh|isChinese)$/i.test(node.text)) return { trueIsZh: true };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const nested = localeCondition(node.operand);
    return nested ? { trueIsZh: !nested.trueIsZh } : null;
  }
  if (!ts.isBinaryExpression(node)) return null;

  const leftLocale = isLanguageReference(node.left);
  const rightLocale = isLanguageReference(node.right);
  const literalNode = leftLocale ? node.right : rightLocale ? node.left : null;
  if (!literalNode || !ts.isStringLiteralLike(literalNode)) return null;
  if (!/^zh(?:-|$)/i.test(literalNode.text)) return null;

  if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) {
    return { trueIsZh: true };
  }
  if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) {
    return { trueIsZh: false };
  }
  return null;
}

function slug(value) {
  const words = value.toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.slice(0, 5).join('-') || 'message';
}

function messageKey(file, zh, en) {
  const component = path.basename(file).replace(/\.(?:tsx?|jsx?)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
  const hash = crypto.createHash('sha256').update(`${en}\0${zh}`).digest('hex').slice(0, 10);
  return `${component}.${slug(en)}.${hash}`;
}

function importPath(fromFile) {
  let relative = path.relative(path.dirname(fromFile), path.join(sourceRoot, 'i18n', 'uiMessages'));
  relative = relative.replace(/\\/g, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

let migrated = 0;
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
    if (ts.isConditionalExpression(node)) {
      const condition = localeCondition(node.condition);
      if (condition) {
        const trueTemplate = templateValue(node.whenTrue);
        const falseTemplate = templateValue(node.whenFalse);
        if (trueTemplate && falseTemplate) {
          const zhTemplate = condition.trueIsZh ? trueTemplate : falseTemplate;
          const enTemplate = condition.trueIsZh ? falseTemplate : trueTemplate;
          if (/[\u3400-\u9fff]/u.test(zhTemplate.message)) {
            const key = messageKey(file, zhTemplate.message, enTemplate.message);
            const valueCount = Math.max(zhTemplate.expressions.length, enTemplate.expressions.length);
            const values = [];
            for (let index = 0; index < valueCount; index++) {
              const zhExpression = zhTemplate.expressions[index]?.getText(source) || "''";
              const enExpression = enTemplate.expressions[index]?.getText(source) || "''";
              values.push(
                `value${index}: ${zhExpression === enExpression
                  ? zhExpression
                  : `{ en: ${enExpression}, zh: ${zhExpression} }`}`,
              );
            }
            const conditionText = node.condition.getText(source);
            const localeExpression = condition.trueIsZh
              ? `(${conditionText}) ? 'zh' : 'en'`
              : `(${conditionText}) ? 'en' : 'zh'`;
            const replacement = values.length
              ? `formatUiMessage('${key}', { ${values.join(', ')} }, ${localeExpression})`
              : `uiMessage('${key}', ${localeExpression})`;
            replacements.push({ start: node.getStart(source), end: node.getEnd(), replacement });
            catalog[key] = { en: enTemplate.message, zh: zhTemplate.message };
            migrated++;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (!replacements.length) continue;

  const needsFormat = replacements.some(edit => edit.replacement.startsWith('formatUiMessage('));
  const importMatch = original.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*i18n\/uiMessages['"];?/);
  if (importMatch) {
    const names = new Set(importMatch[1].split(',').map(value => value.trim()).filter(Boolean));
    names.add('uiMessage');
    if (needsFormat) names.add('formatUiMessage');
    replacements.push({
      start: importMatch.index,
      end: importMatch.index + importMatch[0].length,
      replacement: `import { ${Array.from(names).sort().join(', ')} } from '${importPath(file)}';`,
    });
  } else {
    const imports = source.statements.filter(ts.isImportDeclaration);
    const insertAt = imports.length ? imports[imports.length - 1].getEnd() : 0;
    replacements.push({
      start: insertAt,
      end: insertAt,
      replacement: `\nimport { ${needsFormat ? 'formatUiMessage, ' : ''}uiMessage } from '${importPath(file)}';`,
    });
  }

  let updated = original;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    updated = `${updated.slice(0, edit.start)}${edit.replacement}${updated.slice(edit.end)}`;
  }
  fs.writeFileSync(file, updated, 'utf8');
  changedFiles++;
}

const sortedCatalog = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(catalogPath, `${JSON.stringify(sortedCatalog, null, 2)}\n`, 'utf8');
console.log(`Migrated ${migrated} locale ternaries across ${changedFiles} files.`);
