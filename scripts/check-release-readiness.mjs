import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  return {
    strictPublish: argv.includes('--strict-publish'),
    allowDirty: argv.includes('--allow-dirty'),
    json: argv.includes('--json'),
  };
}

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
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

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isPlaceholder(value) {
  return !value || /REPLACE_WITH|YOUR_|PLACEHOLDER|TODO|TBD/i.test(String(value));
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function add(checks, status, id, message, detail = undefined) {
  checks.push({ status, id, message, detail });
}

function pass(checks, id, message, detail) {
  add(checks, 'pass', id, message, detail);
}

function warnOrFail(checks, strict, id, message, detail) {
  add(checks, strict ? 'fail' : 'warn', id, message, detail);
}

function fail(checks, id, message, detail) {
  add(checks, 'fail', id, message, detail);
}

function parseCargoVersion(cargoToml) {
  const match = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match?.[1] || '';
}

function releaseBundleDir(productName, version, shortHead) {
  const slug = String(productName || 'release')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'release';
  return path.join(root, 'release-out', `${slug}-v${version}-${shortHead}`);
}

async function checkArtifact(checks, manifest, artifact, strictPublish) {
  const artifactPath = path.join(root, artifact.file);
  if (!existsSync(artifactPath)) {
    fail(checks, 'artifact.exists', `Missing artifact: ${artifact.file}`);
    return;
  }

  const digest = await sha256(artifactPath);
  if (digest !== artifact.sha256) {
    fail(checks, 'artifact.sha256', `SHA-256 mismatch for ${artifact.file}`, {
      expected: artifact.sha256,
      actual: digest,
    });
  } else {
    pass(checks, 'artifact.sha256', `Artifact hash matches: ${artifact.name}`);
  }

  if (artifact.sha256File) {
    const shaFilePath = path.join(root, artifact.sha256File);
    if (!existsSync(shaFilePath)) {
      fail(checks, 'artifact.sha-file', `Missing SHA-256 file: ${artifact.sha256File}`);
    } else {
      const shaText = await readText(shaFilePath);
      if (!shaText.includes(digest) || !shaText.includes(path.basename(artifactPath))) {
        fail(checks, 'artifact.sha-file', `SHA-256 file does not match artifact: ${artifact.sha256File}`);
      } else {
        pass(checks, 'artifact.sha-file', `SHA-256 sidecar matches: ${relative(shaFilePath)}`);
      }
    }
  }

  const stat = await fs.stat(artifactPath);
  if (stat.size !== artifact.sizeBytes) {
    fail(checks, 'artifact.size', `Artifact size changed after manifest generation: ${artifact.file}`, {
      expected: artifact.sizeBytes,
      actual: stat.size,
    });
  } else {
    pass(checks, 'artifact.size', `Artifact size matches manifest: ${artifact.name}`);
  }

  if (artifact.kind === 'windows-installer') {
    const updaterSignaturePath = `${artifactPath}.sig`;
    if (existsSync(updaterSignaturePath) && (await fs.stat(updaterSignaturePath)).size > 0) {
      pass(checks, 'artifact.updater-signature', `Updater signature exists: ${relative(updaterSignaturePath)}`);
    } else {
      warnOrFail(checks, strictPublish, 'artifact.updater-signature', `Updater signature is missing: ${relative(updaterSignaturePath)}`);
    }

    if (process.platform === 'win32') {
      let status = '';
      try {
        status = execFileSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-AuthenticodeSignature -LiteralPath ${powershellLiteral(artifactPath)}).Status.ToString()`,
        ], { encoding: 'utf8', windowsHide: true }).trim();
      } catch (error) {
        status = String(error?.message || error);
      }
      if (status === 'Valid') {
        pass(checks, 'artifact.authenticode', `Authenticode signature is valid: ${artifact.name}`);
      } else {
        warnOrFail(checks, strictPublish, 'artifact.authenticode', `Authenticode signature is not valid: ${artifact.name}`, status || 'unknown');
      }
    } else {
      warnOrFail(checks, strictPublish, 'artifact.authenticode', 'Authenticode verification must run on Windows');
    }
  }
}

async function checkReliabilityEvidence(checks, strict, head) {
  const evidenceDir = path.join(root, 'artifacts', 'runtime-reliability');
  const lifecyclePath = path.join(evidenceDir, 'lifecycle.json');
  const soakPath = path.join(evidenceDir, 'soak.json');

  if (existsSync(lifecyclePath)) {
    const lifecycle = await readJson(lifecyclePath);
    const valid = lifecycle.ok === true && lifecycle.buildId === head && lifecycle.iterations >= 50 && lifecycle.orphanProcesses === 0
      && lifecycle.baselineMs > 0 && lifecycle.p95Ms <= lifecycle.baselineMs * 0.75;
    if (valid) pass(checks, 'reliability.lifecycle', `50-run lifecycle P95 passed at ${lifecycle.p95Ms} ms`);
    else warnOrFail(checks, strict, 'reliability.lifecycle', 'Lifecycle evidence must cover the current commit, 50 runs, zero orphans, and a 25% P95 improvement', lifecycle);
  } else {
    warnOrFail(checks, strict, 'reliability.lifecycle', 'Missing 50-run lifecycle evidence', relative(lifecyclePath));
  }

  if (existsSync(soakPath)) {
    const soak = await readJson(soakPath);
    const valid = soak.ok === true && soak.buildId === head && soak.requestedHours >= 2 && soak.elapsedMs >= 1.99 * 60 * 60 * 1000
      && soak.mixedRounds >= 200 && soak.healthProbeInterruptions === 0
      && soak.backendRestarts === 0 && soak.mcpConsecutiveCrashes === 0 && soak.databaseDirty === false && soak.unhandledExceptions === 0
      && soak.sidecarBudgetExceeded?.gptSovits === 0 && soak.sidecarBudgetExceeded?.voiceprint === 0
      && soak.idleReclamationVerified === true
      && (soak.ttsCoverage === 'not_installed' || (soak.ttsCoverage === 'observed' && soak.ttsWorkingSetSamples >= 2 && soak.ttsLastHourGrowthRate <= 0.1));
    if (valid) pass(checks, 'reliability.soak', 'Two-hour, 200-round runtime soak evidence passed');
    else warnOrFail(checks, strict, 'reliability.soak', 'Soak evidence must cover the current commit, two hours, 200 mixed rounds, sidecar budgets, idle reclamation, and TTS growth <= 10%', soak);
  } else {
    warnOrFail(checks, strict, 'reliability.soak', 'Missing two-hour mixed-call soak evidence', relative(soakPath));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checks = [];

  const pkg = await readJson(path.join(root, 'package.json'));
  const tauri = await readJson(path.join(root, 'src-tauri', 'tauri.conf.json'));
  const cargoToml = await readText(path.join(root, 'src-tauri', 'Cargo.toml'));
  const cargoVersion = parseCargoVersion(cargoToml);
  const head = git(['rev-parse', 'HEAD'], 'unknown');
  const shortHead = git(['rev-parse', '--short', 'HEAD'], 'unknown');
  const dirtyStatus = git(['status', '--short'], '');

  await checkReliabilityEvidence(checks, args.strictPublish, head);

  const runtimeMetaPath = path.join(root, 'desktop-resources', 'dist-server', 'runtime-meta.json');
  if (!existsSync(runtimeMetaPath)) {
    fail(checks, 'runtime-meta.exists', `Packaged runtime metadata missing: ${relative(runtimeMetaPath)}`);
  } else {
    const runtimeMeta = await readJson(runtimeMetaPath);
    if (runtimeMeta.schemaVersion === 1 && runtimeMeta.version === pkg.version && runtimeMeta.buildId === head) {
      pass(checks, 'runtime-meta.identity', `Packaged runtime metadata matches v${pkg.version} ${shortHead}`);
    } else {
      fail(checks, 'runtime-meta.identity', 'Packaged runtime metadata must match the current version and commit', runtimeMeta);
    }
    if (args.strictPublish && runtimeMeta.channel !== 'public') {
      fail(checks, 'runtime-meta.channel', 'Strict publication requires a public runtime channel', runtimeMeta.channel || null);
    } else {
      pass(checks, 'runtime-meta.channel', `Runtime channel is ${runtimeMeta.channel || 'unknown'}`);
    }
  }

  if (pkg.version === tauri.version && tauri.version === cargoVersion) {
    pass(checks, 'version.sync', `Version synchronized at ${pkg.version}`);
  } else {
    fail(checks, 'version.sync', 'package.json, tauri.conf.json, and Cargo.toml versions must match', {
      packageJson: pkg.version,
      tauri: tauri.version,
      cargo: cargoVersion,
    });
  }

  if (!dirtyStatus || args.allowDirty) {
    pass(checks, 'git.clean', args.allowDirty ? 'Git dirtiness allowed for this dry run' : 'Git worktree is clean');
  } else {
    fail(checks, 'git.clean', 'Git worktree is dirty. Commit or stash before generating a release.', dirtyStatus.split(/\r?\n/));
  }

  const updater = tauri.plugins?.updater || {};
  if (isPlaceholder(updater.pubkey)) {
    warnOrFail(checks, args.strictPublish, 'updater.pubkey', 'Updater pubkey is still a placeholder', {
      current: updater.pubkey || null,
    });
  } else {
    pass(checks, 'updater.pubkey', 'Updater pubkey is configured');
  }

  const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
  const badEndpoints = endpoints.filter(endpoint => !/^https:\/\//i.test(String(endpoint)) || isPlaceholder(endpoint));
  if (endpoints.length > 0 && badEndpoints.length === 0) {
    pass(checks, 'updater.endpoints', 'Updater endpoints are configured over HTTPS', endpoints);
  } else {
    warnOrFail(checks, args.strictPublish, 'updater.endpoints', 'Updater endpoint must be a real HTTPS endpoint', endpoints);
  }

  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    pass(checks, 'updater.private-key', 'Updater signing private key is available in the environment');
  } else {
    warnOrFail(checks, args.strictPublish, 'updater.private-key', 'TAURI_SIGNING_PRIVATE_KEY is not set for updater artifact signing');
  }

  if (tauri.bundle?.createUpdaterArtifacts === true) {
    pass(checks, 'updater.artifacts-enabled', 'Tauri updater artifacts are enabled');
  } else {
    warnOrFail(checks, args.strictPublish, 'updater.artifacts-enabled', 'Public builds must enable bundle.createUpdaterArtifacts');
  }

  if (process.env.LUMI_COMMERCIAL_LICENSE_APPROVED === '1') {
    pass(checks, 'license.commercial-distribution', 'Commercial distribution license approval is recorded for this build');
  } else {
    warnOrFail(checks, args.strictPublish, 'license.commercial-distribution', 'Set LUMI_COMMERCIAL_LICENSE_APPROVED=1 only after the responsible owner approves AGPL/commercial distribution');
  }

  if (process.env.LUMI_DEPENDENCY_RISK_APPROVED === '1') {
    pass(checks, 'dependency.risk-approval', 'Tracked low/moderate production dependency findings have owner approval');
  } else {
    warnOrFail(checks, args.strictPublish, 'dependency.risk-approval', 'Set LUMI_DEPENDENCY_RISK_APPROVED=1 only after the release owner signs the current risk register');
  }

  const windowsBundle = tauri.bundle?.windows || {};
  const hasWindowsSigningSignal = Boolean(
    windowsBundle.certificateThumbprint ||
    windowsBundle.certificateFile ||
    windowsBundle.signCommand ||
    process.env.TAURI_BUNDLE_WINDOWS_CERTIFICATE_THUMBPRINT ||
    process.env.TAURI_BUNDLE_WINDOWS_CERTIFICATE_PATH ||
    process.env.WINDOWS_CODESIGN_CERTIFICATE_PATH,
  );
  if (hasWindowsSigningSignal) {
    pass(checks, 'windows.codesign', 'Windows code-signing signal is configured');
  } else {
    warnOrFail(checks, args.strictPublish, 'windows.codesign', 'Windows Authenticode signing is not configured');
  }

  const manifestPath = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'release-manifest.json');
  let manifest = null;
  if (!existsSync(manifestPath)) {
    fail(checks, 'manifest.exists', `Release manifest missing: ${relative(manifestPath)}`);
  } else {
    manifest = await readJson(manifestPath);
    pass(checks, 'manifest.exists', `Release manifest exists: ${relative(manifestPath)}`);

    if (manifest.git?.commit === head) {
      pass(checks, 'manifest.commit', `Manifest commit matches HEAD ${shortHead}`);
    } else {
      fail(checks, 'manifest.commit', 'Manifest must be regenerated for current HEAD', {
        manifestCommit: manifest.git?.commit || null,
        head,
      });
    }

    if (manifest.version === tauri.version) {
      pass(checks, 'manifest.version', `Manifest version matches ${manifest.version}`);
    } else {
      fail(checks, 'manifest.version', 'Manifest version does not match tauri.conf.json', {
        manifest: manifest.version,
        tauri: tauri.version,
      });
    }

    if (manifest.runtime?.version === tauri.version && manifest.runtime?.buildId === head) {
      pass(checks, 'manifest.runtime', 'Manifest runtime identity matches the current build');
    } else {
      fail(checks, 'manifest.runtime', 'Manifest runtime metadata is missing or stale', manifest.runtime || null);
    }
    if (args.strictPublish && manifest.runtime?.channel !== 'public') {
      fail(checks, 'manifest.channel', 'Public manifest must declare the public channel', manifest.runtime?.channel || null);
    }

    if (Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0) {
      for (const artifact of manifest.artifacts) {
        await checkArtifact(checks, manifest, artifact, args.strictPublish);
      }
    } else {
      fail(checks, 'manifest.artifacts', 'Manifest has no release artifacts');
    }
  }

  if (manifest) {
    const outDir = releaseBundleDir(manifest.productName, manifest.version, shortHead);
    if (!existsSync(outDir)) {
      fail(checks, 'release-bundle.exists', `Release bundle missing for current commit: ${relative(outDir)}`);
    } else {
      pass(checks, 'release-bundle.exists', `Release bundle exists: ${relative(outDir)}`);
      const requiredFiles = ['release-manifest.json', 'README.txt'];
      for (const fileName of requiredFiles) {
        const filePath = path.join(outDir, fileName);
        if (existsSync(filePath)) pass(checks, 'release-bundle.file', `Bundle contains ${fileName}`);
        else fail(checks, 'release-bundle.file', `Bundle missing ${fileName}`);
      }
      for (const artifact of manifest.artifacts || []) {
        for (const fileName of [artifact.name, `${artifact.name}.sha256`]) {
          const filePath = path.join(outDir, fileName);
          if (existsSync(filePath)) pass(checks, 'release-bundle.artifact', `Bundle contains ${fileName}`);
          else fail(checks, 'release-bundle.artifact', `Bundle missing ${fileName}`);
        }
      }
      const bundledManifest = await readJson(path.join(outDir, 'release-manifest.json'));
      if (bundledManifest.git?.commit === head) {
        pass(checks, 'release-bundle.commit', 'Bundled manifest commit matches HEAD');
      } else {
        fail(checks, 'release-bundle.commit', 'Bundled manifest is stale', {
          bundledCommit: bundledManifest.git?.commit || null,
          head,
        });
      }
    }
  }

  const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');
  if (!existsSync(releaseNotesPath)) {
    fail(checks, 'release-notes.exists', 'RELEASE_NOTES.md is missing');
  } else {
    const notes = await readText(releaseNotesPath);
    const containsVersion = notes.includes(`v${tauri.version}`) || notes.includes(`Version ${tauri.version}`);
    if (containsVersion) {
      pass(checks, 'release-notes.current', `Release notes mention v${tauri.version}`);
    } else {
      fail(checks, 'release-notes.current', 'Release notes must mention the current version', {
        version: tauri.version,
      });
    }
  }

  const envExamplePath = path.join(root, '.env.example');
  const envExample = existsSync(envExamplePath) ? await readText(envExamplePath) : '';
  const downloadUrl = envExample.match(/^LUMI_DOWNLOAD_URL=(.+)$/m)?.[1]?.trim() || '';
  if (/^https:\/\//i.test(downloadUrl) && !isPlaceholder(downloadUrl)) {
    pass(checks, 'download-url.configured', `Download URL configured: ${downloadUrl}`);
  } else {
    warnOrFail(checks, args.strictPublish, 'download-url.configured', 'LUMI_DOWNLOAD_URL must be a real HTTPS download page', downloadUrl || null);
  }

  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    ok: (counts.fail || 0) === 0,
    strictPublish: args.strictPublish,
    version: tauri.version,
    commit: head,
    shortCommit: shortHead,
    counts: {
      pass: counts.pass || 0,
      warn: counts.warn || 0,
      fail: counts.fail || 0,
    },
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Lumi release readiness: v${summary.version} ${summary.shortCommit}`);
    for (const check of checks) {
      const label = check.status.toUpperCase().padEnd(4);
      console.log(`${label} ${check.id} - ${check.message}`);
      if (check.detail !== undefined && check.status !== 'pass') {
        console.log(`     ${JSON.stringify(check.detail)}`);
      }
    }
    console.log(`Summary: ${summary.counts.pass} pass, ${summary.counts.warn} warn, ${summary.counts.fail} fail`);
  }

  if (!summary.ok) process.exit(1);
}

main().catch(err => {
  console.error('[release-readiness] Failed:', err.message);
  process.exit(1);
});
