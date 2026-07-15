import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const outDir = path.join(root, 'desktop-resources');
const includeLocalVoice = process.env.LUMI_DESKTOP_WITH_LOCAL_VOICE === '1';

const runtimeNodeModules = ['sqlite3', 'bindings', 'file-uri-to-path', 'sharp', 'detect-libc', 'semver'];
const runtimePackageTrees = [
  'tsx',
  // build-server.mjs keeps this CommonJS SDK external so Node supplies
  // __dirname and the rest of the CommonJS module wrapper at runtime.
  '@larksuiteoapi/node-sdk',
  '@modelcontextprotocol/sdk',
  'zod',
  'jszip',
  'mammoth',
  'pdf-parse',
  'exceljs',
  'pdf-lib',
  'playwright-core',
];
const optionalRuntimePackageTrees = [
  'mailparser',
  'cheerio',
  'fetcher-mcp',
  'mcp-crawl4ai',
  '@minimax/mcp-js',
  '@e2b/mcp-server',
];
const runtimeScopedNodeModules = {
  '@img': [
    'colour',
    'sharp-win32-x64',
    'sharp-win32-arm64',
    'sharp-win32-ia32',
    'sharp-wasm32',
    'sharp-libvips-win32-x64',
    'sharp-libvips-win32-arm64',
    'sharp-libvips-win32-ia32',
  ],
};
const ignoredNames = new Set([
  '.git',
  '.github',
  '.cache',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '__pycache__',
  '.ipynb_checkpoints',
]);

function shouldCopy(src) {
  const name = path.basename(src);
  if (ignoredNames.has(name)) return false;
  if (name === '.env' || name.startsWith('.env.')) return false;
  if (name.endsWith('.pyc') || name.endsWith('.pyo') || name.endsWith('.log')) return false;
  return true;
}

function shouldCopyServerRuntime(src) {
  if (!shouldCopy(src)) return false;
  const normalized = src.split(path.sep).join('/');
  // Runtime MCP config is user/machine state. Ship config.example.json instead.
  if (normalized.endsWith('/server/mcp/config.json')) return false;
  return true;
}

async function copyIfExists(src, dest) {
  if (!existsSync(src)) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function copyDir(src, dest, filter = shouldCopy) {
  if (!existsSync(src)) return;
  await fs.cp(src, dest, {
    recursive: true,
    force: true,
    filter,
  });
}

function packagePath(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split('/'));
}

function resolvePackage(packageName, searchEntries) {
  for (const entry of searchEntries) {
    const packageSrc = packagePath(entry.srcNodeModules, packageName);
    if (existsSync(packageSrc)) {
      return {
        src: packageSrc,
        dest: packagePath(entry.destNodeModules, packageName),
      };
    }
  }
  return null;
}

async function readPackageJson(packageDir) {
  try {
    const manifest = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
    return JSON.parse(manifest);
  } catch {
    return null;
  }
}

async function copyPackageDependencyTree(packageName, searchEntries, seen = new Set(), optional = false) {
  const resolved = resolvePackage(packageName, searchEntries);
  if (!resolved) {
    if (optional) return;
    throw new Error(`Missing runtime package "${packageName}". Run npm install before preparing desktop resources.`);
  }

  const seenKey = path.resolve(resolved.dest);
  if (seen.has(seenKey)) return;
  seen.add(seenKey);

  await copyDir(resolved.src, resolved.dest);

  const manifest = await readPackageJson(resolved.src);
  if (!manifest) return;

  const dependencies = manifest.dependencies ?? {};
  const optionalDependencies = manifest.optionalDependencies ?? {};
  const dependencyNames = new Set([
    ...Object.keys(dependencies),
    ...Object.keys(optionalDependencies),
  ]);

  const nestedSearchEntry = {
    srcNodeModules: path.join(resolved.src, 'node_modules'),
    destNodeModules: path.join(resolved.dest, 'node_modules'),
  };

  for (const dependencyName of dependencyNames) {
    await copyPackageDependencyTree(
      dependencyName,
      [nestedSearchEntry, ...searchEntries],
      seen,
      Object.prototype.hasOwnProperty.call(optionalDependencies, dependencyName),
    );
  }
}

async function prepareServer() {
  const src = path.join(root, 'dist-server');
  const dest = path.join(outDir, 'dist-server');
  const destNodeModules = path.join(dest, 'node_modules');
  const runtimePackageSearchEntries = [
    {
      srcNodeModules: path.join(src, 'node_modules'),
      destNodeModules,
    },
    {
      srcNodeModules: path.join(root, 'node_modules'),
      destNodeModules,
    },
  ];

  await fs.mkdir(dest, { recursive: true });
  const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodeBinaryPath = path.join(src, nodeBinaryName);
  if (!existsSync(nodeBinaryPath)) {
    throw new Error(`Missing ${nodeBinaryName} in dist-server. Run npm run prepare:node before packaging the desktop app.`);
  }
  await copyIfExists(path.join(src, nodeBinaryName), path.join(dest, nodeBinaryName));
  await copyIfExists(path.join(src, 'entry.cjs'), path.join(dest, 'entry.cjs'));
  await copyIfExists(path.join(src, 'server.mjs'), path.join(dest, 'server.mjs'));
  await copyIfExists(path.join(src, 'server.cjs'), path.join(dest, 'server.cjs'));
  await copyIfExists(path.join(src, 'package.json'), path.join(dest, 'package.json'));
  await copyIfExists(path.join(src, '.env'), path.join(dest, '.env'));
  if (process.platform === 'win32') {
    await copyIfExists(path.join(src, 'hide-console.cjs'), path.join(dest, 'hide-console.cjs'));
  }
  // Copy server runtime files (configs, skills, MCP, personality) from dist-server or project root
  const distServerDir = path.join(src, 'server');
  const projectServerDir = path.join(root, 'server');
  if (existsSync(distServerDir)) {
    await copyDir(distServerDir, path.join(dest, 'server'), shouldCopyServerRuntime);
  } else if (existsSync(projectServerDir)) {
    await copyDir(projectServerDir, path.join(dest, 'server'), shouldCopyServerRuntime);
  }

  for (const moduleName of runtimeNodeModules) {
    const srcPath = path.join(src, 'node_modules', moduleName);
    const fallbackPath = path.join(root, 'node_modules', moduleName);
    const moduleSrc = existsSync(srcPath) ? srcPath : fallbackPath;
    await copyDir(moduleSrc, path.join(dest, 'node_modules', moduleName));
  }

  for (const [scopeName, packageNames] of Object.entries(runtimeScopedNodeModules)) {
    for (const packageName of packageNames) {
      const srcPath = path.join(src, 'node_modules', scopeName, packageName);
      const fallbackPath = path.join(root, 'node_modules', scopeName, packageName);
      const moduleSrc = existsSync(srcPath) ? srcPath : fallbackPath;
      await copyDir(moduleSrc, path.join(dest, 'node_modules', scopeName, packageName));
    }
  }

  for (const packageName of runtimePackageTrees) {
    await copyPackageDependencyTree(packageName, runtimePackageSearchEntries);
  }

  for (const packageName of optionalRuntimePackageTrees) {
    await copyPackageDependencyTree(packageName, runtimePackageSearchEntries, new Set(), true);
  }
}

async function prepareGptSovits() {
  const dest = path.join(outDir, 'gpt-sovits-src');
  await fs.mkdir(dest, { recursive: true });

  if (includeLocalVoice) {
    await copyDir(path.join(root, 'gpt-sovits-src'), dest);
  } else {
    await fs.writeFile(path.join(dest, '.keep'), '');
  }
}

async function prepareVoiceTrainingData() {
  const dest = path.join(outDir, 'data', 'voice_training');
  await fs.mkdir(dest, { recursive: true });

  if (includeLocalVoice) {
    await copyDir(path.join(root, 'data', 'voice_training'), dest);
  } else {
    await fs.writeFile(path.join(dest, '.keep'), '');
  }
}

/**
 * Copy WebView2Loader.dll if it exists (post-cargo-build). If not (pre-cargo-build),
 * create a placeholder so resource path checks pass; beforeBundleCommand replaces it.
 */
async function prepareWebView2Dll() {
  const dllDest = path.join(outDir, 'WebView2Loader.dll');
  await fs.mkdir(outDir, { recursive: true });
  const dllSrc = path.join(root, 'src-tauri', 'target', 'release', 'WebView2Loader.dll');
  if (existsSync(dllSrc)) {
    await fs.copyFile(dllSrc, dllDest);
  } else {
    // Placeholder — real DLL will be copied by beforeBundleCommand
    await fs.writeFile(dllDest, '');
  }
}

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
await prepareServer();
await prepareGptSovits();
await prepareVoiceTrainingData();
await prepareWebView2Dll();

console.log(`Prepared desktop resources at ${path.relative(root, outDir)}`);
if (!includeLocalVoice) {
  console.log('Local GPT-SoVITS resources skipped. Set LUMI_DESKTOP_WITH_LOCAL_VOICE=1 for the large offline voice bundle.');
}
