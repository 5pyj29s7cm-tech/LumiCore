import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const defaultManifestPath = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'release-manifest.json');

function parseArgs(argv) {
  const args = {
    manifest: defaultManifestPath,
    outDir: '',
    clean: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifest = path.resolve(argv[++i]);
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (arg === '--no-clean') args.clean = false;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/prepare-release-bundle.mjs [options]

Options:
  --manifest <path>  Release manifest path. Defaults to src-tauri/target/release/bundle/release-manifest.json.
  --out-dir <path>   Output directory. Defaults to release-out/<product>-v<version>-<short-commit>.
  --no-clean         Do not delete an existing output directory before copying.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function slug(value) {
  return String(value || 'release')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'release';
}

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

async function copyFilePreservingName(src, destDir) {
  const dest = path.join(destDir, path.basename(src));
  await fs.copyFile(src, dest);
  return dest;
}

function readmeText(manifest, copiedFiles) {
  const generatedAt = new Date().toISOString();
  const artifacts = manifest.artifacts.map(item => {
    const copied = copiedFiles.find(file => file.source === item.file);
    return [
      `- ${item.name}`,
      `  size: ${item.sizeBytes} bytes`,
      `  sha256: ${item.sha256}`,
      copied ? `  bundled file: ${path.basename(copied.dest)}` : '',
      item.updaterSignatureFile ? `  updater signature: ${path.basename(item.updaterSignatureFile)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `LumiCore Release Bundle

Product: ${manifest.productName}
Version: ${manifest.version}
Source commit: ${manifest.git?.commit || 'unknown'}
Source branch: ${manifest.git?.branch || 'unknown'}
Manifest generated: ${manifest.generatedAt}
Bundle generated: ${generatedAt}

Artifacts

${artifacts}

Install Smoke Gate

On a Windows validation machine:

1. Install the setup EXE.
2. Launch LumiCore.
3. Open Skill Center.
4. Install Admin Assistant.
5. Confirm the skill connects and remains installed after relaunch.

Developer verification commands

npm run release:verify
npm run tauri:build
npm run smoke:installer:win
npm run release:manifest
npm run release:bundle

Notes

- Verify the setup EXE against the .sha256 file before sharing.
- Do not edit files inside this bundle after generating checksums.
- GPT-SoVITS offline voice resources are excluded unless LUMI_DESKTOP_WITH_LOCAL_VOICE=1 was set during packaging.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.manifest)) {
    throw new Error(`Release manifest not found: ${args.manifest}. Run npm run release:manifest first.`);
  }

  const manifest = await readJson(args.manifest);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error(`Manifest has no artifacts: ${args.manifest}`);
  }

  const shortCommit = String(manifest.git?.commit || 'unknown').slice(0, 7);
  const defaultOutDir = path.join(
    root,
    'release-out',
    `${slug(manifest.productName)}-v${manifest.version}-${shortCommit}`,
  );
  const outDir = args.outDir || defaultOutDir;

  if (args.clean) {
    await fs.rm(outDir, { recursive: true, force: true });
  }
  await fs.mkdir(outDir, { recursive: true });

  const copiedFiles = [];
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(root, artifact.file);
    if (!existsSync(artifactPath)) throw new Error(`Artifact missing: ${artifactPath}`);

    const digest = await sha256(artifactPath);
    if (digest !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch for ${artifact.file}. Expected ${artifact.sha256}, got ${digest}`);
    }

    const artifactDest = await copyFilePreservingName(artifactPath, outDir);
    copiedFiles.push({ source: artifact.file, dest: artifactDest });

    if (artifact.sha256File) {
      const shaPath = path.join(root, artifact.sha256File);
      if (existsSync(shaPath)) {
        await copyFilePreservingName(shaPath, outDir);
      } else {
        await fs.writeFile(path.join(outDir, `${path.basename(artifactPath)}.sha256`), `${digest}  ${path.basename(artifactPath)}\n`);
      }
    }

    if (artifact.updaterSignatureFile) {
      const signaturePath = path.join(root, artifact.updaterSignatureFile);
      if (!existsSync(signaturePath)) {
        throw new Error(`Updater signature missing: ${signaturePath}`);
      }
      await copyFilePreservingName(signaturePath, outDir);
    }
  }

  const manifestDest = path.join(outDir, 'release-manifest.json');
  await fs.copyFile(args.manifest, manifestDest);
  await fs.writeFile(path.join(outDir, 'README.txt'), readmeText(manifest, copiedFiles));

  console.log(JSON.stringify({
    ok: true,
    outDir: relative(outDir),
    files: (await fs.readdir(outDir)).sort(),
  }, null, 2));
}

main().catch(err => {
  console.error('[release-bundle] Failed:', err.message);
  process.exit(1);
});
