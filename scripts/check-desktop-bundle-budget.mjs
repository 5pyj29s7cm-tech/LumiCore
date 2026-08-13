import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const candidateDistDirs = process.env.LUMI_DESKTOP_DIST
  ? [path.resolve(root, process.env.LUMI_DESKTOP_DIST)]
  : [path.resolve(root, 'dist/desktop'), path.resolve(root, 'dist')];
const distDir = candidateDistDirs.find(candidate => existsSync(path.join(candidate, 'index.html')))
  || candidateDistDirs[0];
const htmlPath = path.join(distDir, 'index.html');
const limitBytes = Number(process.env.LUMI_DESKTOP_BUDGET_BYTES || 750 * 1024);

if (!existsSync(htmlPath)) {
  console.error(`[bundle-budget] desktop index missing from ${candidateDistDirs.join(' or ')}; run npm run build:desktop-ui or npm run build:frontends first.`);
  process.exit(2);
}

const html = readFileSync(htmlPath, 'utf8');
const resources = new Set();
for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
  const resource = match[1].split(/[?#]/, 1)[0];
  if (!resource || /^(?:https?:)?\/\//i.test(resource) || resource.startsWith('data:')) continue;
  resources.add(resource);
}

const preloadResources = Array.from(html.matchAll(/<link\b[^>]*rel=["']modulepreload["'][^>]*href=["']([^"']+)["'][^>]*>/gi), match => match[1]);
const forbidden = /(?:vendor-r3-|vendor-picovoice|vendor-mediapipe|vendor-terminal|\/(?:Terminal|OrbitControls|loader|esm)-)/i;
const forbiddenPreloads = preloadResources.filter(resource => forbidden.test(resource));
if (forbiddenPreloads.length) {
  console.error(`[bundle-budget] forbidden heavy desktop preload(s): ${forbiddenPreloads.join(', ')}`);
  process.exit(1);
}

const optionalChunkLimits = [
  { pattern: /^esm-[\w-]+\.js$/i, bytes: 3_600_000, label: 'wake-word optional chunk' },
  { pattern: /^OrbitControls-[\w-]+\.js$/i, bytes: 1_200_000, label: '3D optional chunk' },
  { pattern: /^Terminal-[\w-]+\.js$/i, bytes: 600_000, label: 'terminal optional chunk' },
  { pattern: /^loader-[\w-]+\.js$/i, bytes: 180_000, label: 'vision optional chunk' },
];
const assetDir = path.join(distDir, 'assets');
for (const fileName of existsSync(assetDir) ? readdirSync(assetDir) : []) {
  const budget = optionalChunkLimits.find(candidate => candidate.pattern.test(fileName));
  if (!budget) continue;
  const bytes = statSync(path.join(assetDir, fileName)).size;
  if (bytes > budget.bytes) {
    console.error(
      `[bundle-budget] blocked: ${budget.label} ${fileName} is ${(bytes / 1024).toFixed(1)} KiB, `
      + `above ${(budget.bytes / 1024).toFixed(1)} KiB.`,
    );
    process.exit(1);
  }
}

let total = gzipSync(Buffer.from(html)).byteLength;
const details = [{ resource: 'index.html', gzipBytes: total, rawBytes: Buffer.byteLength(html) }];
for (const resource of resources) {
  const relative = resource.replace(/^\/+/, '');
  const filePath = path.resolve(distDir, relative);
  if (!filePath.startsWith(`${distDir}${path.sep}`) || !existsSync(filePath)) {
    console.error(`[bundle-budget] initial resource is missing or outside dist: ${resource}`);
    process.exit(2);
  }
  const contents = readFileSync(filePath);
  const gzipBytes = gzipSync(contents).byteLength;
  total += gzipBytes;
  details.push({ resource, gzipBytes, rawBytes: statSync(filePath).size });
}

const kib = bytes => (bytes / 1024).toFixed(1);
console.log(`[bundle-budget] desktop initial resources: ${kib(total)} KiB gzip / ${kib(limitBytes)} KiB limit`);
for (const detail of details.sort((a, b) => b.gzipBytes - a.gzipBytes)) {
  console.log(`  ${kib(detail.gzipBytes).padStart(7)} KiB  ${detail.resource}`);
}

if (total > limitBytes) {
  console.error(`[bundle-budget] blocked: initial desktop payload exceeds the budget by ${kib(total - limitBytes)} KiB.`);
  process.exit(1);
}
