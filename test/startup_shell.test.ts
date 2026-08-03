import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('desktop startup shell', () => {
  it('paints a dark first frame before React mounts', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('id="lumi-preload"');
    expect(html).toContain('background: #080a0d');
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('uses one truthful startup sequence without the old white flash', () => {
    const desktopEntry = fs.readFileSync(path.join(process.cwd(), 'src/entries/desktop.tsx'), 'utf8');
    const desktopUi = fs.readFileSync(path.join(process.cwd(), 'src/components/DesktopUI.tsx'), 'utf8');
    const startup = fs.readFileSync(path.join(process.cwd(), 'src/components/StartupSequence.tsx'), 'utf8');

    expect(desktopEntry).toContain('<StartupSequence ready={!shell.loading} />');
    expect(desktopUi).not.toContain('HardcoreBootSequence');
    expect(startup).not.toContain('Core Temperature');
    expect(startup).not.toContain('absolute inset-0 bg-white');
  });

  it('keeps the native window hidden until the dark webview shell has loaded', () => {
    const tauriConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));
    const rustEntry = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');

    expect(tauriConfig.app.windows[0].visible).toBe(false);
    expect(rustEntry).toContain('.on_page_load(move |webview, payload|');
    expect(rustEntry).toContain('PageLoadEvent::Finished');
    expect(rustEntry).toContain('webview.window().show()');
  });

  it('merges macOS media, automation, and protected-folder permission prompts at bundle time', () => {
    const tauriConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));
    const plistPath = path.join(process.cwd(), 'src-tauri', tauriConfig.bundle.macOS.infoPlist);
    const infoPlist = fs.readFileSync(plistPath, 'utf8');
    const macBuildWorkflow = fs.readFileSync(
      path.join(process.cwd(), '.github/workflows/build-macos.yml'),
      'utf8',
    );

    expect(infoPlist).toContain('<key>NSCameraUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSMicrophoneUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSAppleEventsUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSDesktopFolderUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSDocumentsFolderUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSDownloadsFolderUsageDescription</key>');
    expect(infoPlist).not.toContain('<key>CFBundleVersion</key>');
    expect(infoPlist).not.toContain('<key>CFBundleExecutable</key>');
    expect(macBuildWorkflow).toContain("Print :NSCameraUsageDescription");
    expect(macBuildWorkflow).toContain("Print :NSMicrophoneUsageDescription");
    expect(macBuildWorkflow).toContain("Print :NSAppleEventsUsageDescription");
    expect(macBuildWorkflow).toContain('CFBundleShortVersionString');
  });

  it('keeps the legacy macOS open fallback after indexed and LaunchServices app lookup', () => {
    const rustEntry = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
    const indexed = rustEntry.indexOf('try_launch_macos_app(&target)');
    const registered = rustEntry.indexOf('Command::new("open").args(["-a", &target])');
    const legacy = rustEntry.indexOf('Command::new("open").arg(&target).output()');

    expect(indexed).toBeGreaterThan(-1);
    expect(registered).toBeGreaterThan(indexed);
    expect(legacy).toBeGreaterThan(registered);
  });

  it('tracks the replacement backend after a supervised restart', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'launcher.ts'), 'utf8');
    expect(launcher).toContain('currentChild = restartServer()');
    expect(launcher).toContain('scheduleServerRestart(500)');
    expect(launcher).toContain('scheduleServerRestart(delay)');
    expect(launcher).not.toContain('setTimeout(() => restartServer()');
  });

  it('keeps the CommonJS Lark SDK outside the ESM server bundle and packages it', () => {
    const buildScript = fs.readFileSync(path.join(process.cwd(), 'scripts/build-server.mjs'), 'utf8');
    const resourceScript = fs.readFileSync(path.join(process.cwd(), 'scripts/prepare-desktop-resources.mjs'), 'utf8');
    const packagedSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts/smoke-packaged-first-run.mjs'), 'utf8');

    expect(buildScript).toContain("'@larksuiteoapi/node-sdk'");
    expect(resourceScript).toContain("'@larksuiteoapi/node-sdk'");
    expect(packagedSmoke).toContain("'packaged Lark SDK'");
  });

  it('packages immutable runtime version metadata and verifies it on first run', () => {
    const buildScript = fs.readFileSync(path.join(process.cwd(), 'scripts/build-server.mjs'), 'utf8');
    const resourceScript = fs.readFileSync(path.join(process.cwd(), 'scripts/prepare-desktop-resources.mjs'), 'utf8');
    const packagedSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts/smoke-packaged-first-run.mjs'), 'utf8');

    expect(buildScript).toContain("dist-server/runtime-meta.json");
    expect(buildScript).toContain('LUMI_RUNTIME_META_FILE');
    expect(resourceScript).toContain("'runtime-meta.json'");
    expect(resourceScript).toContain('await fs.rm(resolvedDest, { recursive: true, force: true })');
    expect(packagedSmoke).toContain('Runtime metadata mismatch');
    expect(packagedSmoke).toContain('does not match expected commit');
    expect(packagedSmoke).toContain('socket.io/?EIO=4&transport=polling');
    expect(packagedSmoke).toContain("path.join(dataRoot, 'data', 'lumi.db')");
    expect(packagedSmoke).toContain('Packaged runtime wrote into its resource directory');
  });

  it('filters release artifacts by the current version and embeds runtime identity', () => {
    const manifestWriter = fs.readFileSync(path.join(process.cwd(), 'scripts/write-release-manifest.mjs'), 'utf8');
    const bundleWriter = fs.readFileSync(path.join(process.cwd(), 'scripts/prepare-release-bundle.mjs'), 'utf8');
    expect(manifestWriter).toContain("path.basename(filePath).includes(tauri.version)");
    expect(manifestWriter).toContain('runtime: runtimeMeta');
    expect(manifestWriter).toContain('updaterSignatureFile');
    expect(bundleWriter).toContain('artifact.updaterSignatureFile');
  });

  it('keeps public updates and commercial distribution behind explicit release gates', () => {
    const rustEntry = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
    const rustBuild = fs.readFileSync(path.join(process.cwd(), 'src-tauri/build.rs'), 'utf8');
    const releaseCheck = fs.readFileSync(path.join(process.cwd(), 'scripts/check-release-readiness.mjs'), 'utf8');
    expect(rustEntry).toContain('option_env!("LUMI_RELEASE_CHANNEL") == Some("public")');
    expect(rustBuild).toContain('cargo:rerun-if-env-changed=LUMI_RELEASE_CHANNEL');
    expect(rustBuild).toContain('cargo:rustc-env=LUMI_RELEASE_CHANNEL=');
    expect(releaseCheck).toContain('LUMI_COMMERCIAL_LICENSE_APPROVED');
    expect(releaseCheck).toContain('LUMI_DEPENDENCY_RISK_APPROVED');
    expect(releaseCheck).toContain("runtimeMeta.channel !== 'public'");
    expect(releaseCheck).toContain('Get-AuthenticodeSignature');
    expect(releaseCheck).toContain('artifact.updater-signature');
    expect(releaseCheck).toContain('LUMI_RELEASE_TAURI_CONFIG');
    const windowsWorkflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/build-windows.yml'), 'utf8');
    expect(windowsWorkflow).toContain('createUpdaterArtifacts');
    expect(windowsWorkflow).toContain('npx tauri build --config $env:LUMI_RELEASE_TAURI_CONFIG');
    expect(windowsWorkflow).not.toContain("Set-Content -LiteralPath $configPath");
    expect(windowsWorkflow).toContain("always() && !cancelled() && hashFiles('src-tauri/target/release/bundle/nsis/*.exe') != ''");
    expect(windowsWorkflow).toContain("name: lumi-os-windows-${{ inputs.channel || 'internal' }}-${{ github.sha }}");
    expect(windowsWorkflow).toContain("LUMI_COLD_START_BASELINE_MS: ${{ inputs.channel == 'public' && vars.LUMI_COLD_START_BASELINE_MS || '' }}");
    expect(windowsWorkflow).toContain("$env:LUMI_RELEASE_CHANNEL -eq 'public'");
    expect(windowsWorkflow).toContain('npm run stress:lifecycle');
    expect(windowsWorkflow).not.toContain('Upload unverified internal installer');
    expect(windowsWorkflow).not.toContain('lumi-os-windows-internal-unverified');
    const reliabilityWorkflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/reliability-windows.yml'), 'utf8');
    expect(reliabilityWorkflow).toContain('--duration-hours 24');
    expect(reliabilityWorkflow).toContain('LUMI_TTS_RELIABILITY_FIXTURE_DIR');
    expect(reliabilityWorkflow).toContain('New-Item -ItemType Junction');
  });

  it('packages Sharp native dependencies for the build host instead of Windows-only binaries', () => {
    const resourceScript = fs.readFileSync(path.join(process.cwd(), 'scripts/prepare-desktop-resources.mjs'), 'utf8');
    expect(resourceScript).toContain('sharp-darwin-${sharpArch}');
    expect(resourceScript).toContain('sharp-win32-${sharpArch}');
    expect(resourceScript).toContain('platformSharpPackages');
    expect(resourceScript).not.toContain("'sharp-win32-x64',");
  });
});
