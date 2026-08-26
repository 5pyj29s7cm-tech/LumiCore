import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const forbiddenPaths = [
  'index.web.html',
  'src/entries/web-root.tsx',
  'src/entries/web.tsx',
  'src/platforms/web/WebPlatform.tsx',
  'src/components/FloatingAgent.tsx',
  'src/components/Footer.tsx',
  'src/components/JoinUs.tsx',
  'src/components/LandingSections.tsx',
  'src/components/MultimodalProducts.tsx',
  'src/components/Navbar.tsx',
  'src/components/ProductDetailPage.tsx',
  'src/components/ProtocolsWorld.tsx',
  'src/components/Solutions.tsx',
];

const failures = [];
for (const relativePath of forbiddenPaths) {
  try {
    await access(new URL(`../${relativePath}`, import.meta.url));
    failures.push(`website-only path must stay outside LumiCore: ${relativePath}`);
  } catch {
    // Missing is the expected state.
  }
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (packageJson.scripts?.['build:web']) failures.push('package.json must not expose build:web');

const viteConfig = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
for (const marker of ['index.web.html', "target === 'web'", "'web', 'mobile', 'all'"]) {
  if (viteConfig.includes(marker)) failures.push(`vite.config.ts still contains website marker: ${marker}`);
}

for (const requiredPath of ['index.html', 'index.mobile.html', 'src/entries/desktop-root.tsx', 'src/entries/mobile-root.tsx']) {
  try { await access(new URL(`../${requiredPath}`, import.meta.url)); }
  catch { failures.push(`required client entry is missing: ${requiredPath}`); }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`[website-boundary] standalone website boundary verified (${root})`);
