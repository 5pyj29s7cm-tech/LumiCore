import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const baselinePath = path.join(root, 'scripts', 'i18n-hardcode-baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const SOURCE_EXT_RE = /\.tsx?$/;

const scanTargets = [
  'src',
  'server',
  'server.ts',
  'launcher.ts',
  'db_layer.ts',
];

function normalizePath(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function shouldSkip(file) {
  const relative = normalizePath(file);
  return relative.includes('/node_modules/')
    || relative.includes('/dist/')
    || relative.includes('/dist-server/')
    || /(?:^|\/)i18n(?:\/|$)/.test(relative)
    || relative.startsWith('server/regions/')
    || relative === 'src/lib/translations.ts'
    || /\.(?:test|spec)\.tsx?$/.test(relative)
    || relative.includes('/__tests__/');
}

function walk(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    return SOURCE_EXT_RE.test(targetPath) && !shouldSkip(targetPath) ? [targetPath] : [];
  }
  return fs.readdirSync(targetPath, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(targetPath, entry.name);
    if (entry.isDirectory()) return walk(target);
    return SOURCE_EXT_RE.test(entry.name) && !shouldSkip(target) ? [target] : [];
  });
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  if (ts.isJsxText(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) return node.text;
  return null;
}

function fingerprint(value) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 20);
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  function visit(node) {
    const value = literalText(node);
    if (value && HAN_RE.test(value)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const lines = text.split(/\r?\n/);
      const currentLine = lines[position.line] || '';
      const previousLine = lines[position.line - 1] || '';
      const previousPreviousLine = lines[position.line - 2] || '';
      if (
        !currentLine.includes('i18n-allow')
        && !previousLine.includes('i18n-allow')
        && !previousPreviousLine.includes('i18n-allow')
      ) {
        violations.push({
          fingerprint: fingerprint(value),
          line: position.line + 1,
          preview: value.replace(/\s+/g, ' ').trim().slice(0, 100),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

const files = Array.from(new Set(scanTargets.flatMap(scanTarget => walk(path.join(root, scanTarget))))).sort();
const current = {};
const evidence = new Map();

for (const file of files) {
  const relative = normalizePath(file);
  const counts = {};
  for (const violation of scanFile(file)) {
    counts[violation.fingerprint] = (counts[violation.fingerprint] || 0) + 1;
    const key = `${relative}:${violation.fingerprint}`;
    if (!evidence.has(key)) evidence.set(key, violation);
  }
  if (Object.keys(counts).length) current[relative] = counts;
}

if (writeBaseline) {
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({ version: 1, violations: current }, null, 2)}\n`,
    'utf8',
  );
  const count = Object.values(current).reduce(
    (sum, entries) => sum + Object.values(entries).reduce((inner, value) => inner + value, 0),
    0,
  );
  console.log(`Wrote i18n baseline with ${count} legacy literals across ${Object.keys(current).length} files.`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error('Missing scripts/i18n-hardcode-baseline.json. Run npm run lint:i18n:baseline after reviewing current violations.');
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))?.violations || {};
const additions = [];
for (const [file, entries] of Object.entries(current)) {
  for (const [hash, count] of Object.entries(entries)) {
    const allowed = Number(baseline[file]?.[hash] || 0);
    if (count <= allowed) continue;
    const detail = evidence.get(`${file}:${hash}`);
    additions.push({ file, count: count - allowed, ...detail });
  }
}

if (additions.length) {
  console.error('New hardcoded Han text was found outside locale or regional resources:');
  for (const item of additions.slice(0, 40)) {
    console.error(`- ${item.file}:${item.line} (+${item.count}) ${JSON.stringify(item.preview)}`);
  }
  if (additions.length > 40) console.error(`- ...and ${additions.length - 40} more`);
  console.error('Move user-visible text into src/i18n, move region-specific capability text into server/regions, or add a reviewed i18n-allow marker for input-recognition literals.');
  process.exit(1);
}

console.log(`i18n boundary check passed (${files.length} source files, no new hardcoded Han literals).`);
