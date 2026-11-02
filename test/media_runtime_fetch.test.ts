import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const script = path.resolve('scripts/fetch-media-runtime.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const allowed = ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt'];
const upstream = JSON.parse(fs.readFileSync(path.resolve('scripts/media-runtime.manifest.json'), 'utf8'));

function fixture(extra: Array<{ name: string; content: string }> = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-media-fetch-'));
  roots.push(root);
  const archive = path.join(root, 'fixture.zip');
  const members = allowed.map(name => ({ name: `${upstream.archive.rootDirectory}/${name}`, content: `Synthetic pinned fixture: ${name}` }));
  const manifest = structuredClone(upstream);
  manifest.files = allowed.map((name, index) => ({ path: name, size: Buffer.byteLength(members[index].content), sha256: sha(members[index].content) }));
  fs.writeFileSync(path.join(root, 'members.json'), JSON.stringify([...members, ...extra]));
  const builder = path.join(root, 'make-zip.ps1');
  fs.writeFileSync(builder, `param([string]$Request,[string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($Output,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($member in (Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    $entry = $zip.CreateEntry($member.name)
    $stream = $entry.Open()
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($member.content); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
  }
} finally { $zip.Dispose() }
`);
  const built = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', builder,
    '-Request', path.join(root, 'members.json'), '-Output', archive], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  expect(built.status, built.stderr).toBe(0);
  manifest.archive.sha256 = sha(fs.readFileSync(archive));
  manifest.archive.sizeBytes = fs.statSync(archive).size;
  const manifestFile = path.join(root, 'manifest.json');
  const envFile = path.join(root, 'github-env');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(envFile, '');
  return { root, archive, manifest, manifestFile, envFile, destination: path.join(root, 'verified') };
}

function run(f: ReturnType<typeof fixture>) {
  fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DestinationDirectory', f.destination, '-ManifestPath', f.manifestFile, '-ArchivePath', f.archive,
    '-GitHubEnvFile', f.envFile], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lumi-media-fetch-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'win32')('pinned Windows media acquisition without network or executable execution', () => {
  it('extracts only the four reviewed bytes and publishes an absolute source after verification', () => {
    const f = fixture([{ name: `${upstream.archive.rootDirectory}/extra-user-data.txt`, content: 'Must not ship' },
      { name: '../escaped.txt', content: 'Must not be extracted' }]);
    const result = run(f);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ filesVerified: 4, executablesRun: 0, reused: false, sourceDirectory: f.destination, license: 'GPL-3.0-or-later' });
    for (const entry of f.manifest.files) expect(sha(fs.readFileSync(path.join(f.destination, entry.path)))).toBe(entry.sha256);
    expect(fs.existsSync(path.join(f.destination, 'extra-user-data.txt'))).toBe(false);
    expect(fs.existsSync(path.join(f.root, 'escaped.txt'))).toBe(false);
    expect(fs.readFileSync(f.envFile, 'utf8')).toBe(`LUMI_MEDIA_RUNTIME_SOURCE=${f.destination}\n`);
  });

  it('reuses only an already fully verified source and does not need an archive read', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    fs.unlinkSync(f.archive);
    const result = run(f);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).reused).toBe(true);
  });

  it('rejects changed archive bytes before publishing any source', () => {
    const f = fixture();
    fs.appendFileSync(f.archive, 'tamper');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from pinned manifest');
    expect(fs.existsSync(f.destination)).toBe(false);
    expect(fs.readFileSync(f.envFile, 'utf8')).toBe('');
  });

  it('rejects archive hash mismatch even when size is unchanged', () => {
    const f = fixture();
    f.manifest.archive.sha256 = 'a'.repeat(64);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from pinned manifest');
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('uses the repository manifest by default and rejects a synthetic archive against its real pins', () => {
    const f = fixture();
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-DestinationDirectory', f.destination, '-ArchivePath', f.archive], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from pinned manifest');
    expect(result.stderr).not.toContain('Join-Path');
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('rejects mismatched executable pins after whole-archive verification', () => {
    const f = fixture();
    f.manifest.files[0].sha256 = 'b'.repeat(64);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from pinned manifest');
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('rejects duplicate selected ZIP members rather than choosing one', () => {
    const f = fixture([{ name: `${upstream.archive.rootDirectory}/LICENSE`, content: 'Synthetic pinned fixture: LICENSE' }]);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('duplicate/wrong-size pinned ZIP member');
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('does not overwrite or silently repair a modified cached runtime', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    const file = path.join(f.destination, 'bin/ffmpeg.exe');
    fs.writeFileSync(file, 'keep this modified file');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep this modified file');
  });

  it('rejects an unexpected file in an existing source instead of packaging it', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    fs.writeFileSync(path.join(f.destination, 'not-reviewed.txt'), 'preserve');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly the four pinned files');
    expect(fs.readFileSync(path.join(f.destination, 'not-reviewed.txt'), 'utf8')).toBe('preserve');
  });

  it('rejects a nonfree or unreviewed-license manifest', () => {
    const f = fixture();
    f.manifest.license.nonfreeEnabled = true;
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('license policy');
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('rejects a changed archive root or unsafe selected path', () => {
    const f = fixture();
    f.manifest.files[0].path = '../ffmpeg.exe';
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid Windows media manifest file set');
    expect(fs.existsSync(f.destination)).toBe(false);
  });
});
