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
    expect(desktopEntry).toContain('initializeSharedSocketRuntime();');
    expect(desktopUi).not.toContain('HardcoreBootSequence');
    expect(startup).not.toContain('Core Temperature');
    expect(startup).not.toContain('absolute inset-0 bg-white');
  });

  it('keeps the native window hidden until the dark webview shell has loaded', () => {
    const tauriConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));
    const rustEntry = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
    const activation = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/window_activation.rs'), 'utf8');

    expect(tauriConfig.app.windows[0].visible).toBe(false);
    expect(rustEntry).toContain('.on_page_load(move |webview, payload|');
    expect(rustEntry).toContain('PageLoadEvent::Finished');
    expect(rustEntry).toContain('show_main_window_impl(webview.app_handle(), "page_load");');
    expect(rustEntry).toContain('execute_window_activation_steps(restore_result, operations)');
    expect(activation).toContain('step("show", operations.show())');
    expect(activation).toContain('step("unminimize", operations.unminimize())');
    expect(activation).toContain('step("focus_window", operations.focus_window())');
    expect(activation).toContain('step("focus_webview", operations.focus_webview())');
  });

  it('keeps macOS media, automation, and protected-folder permission prompts in source configuration', () => {
    const tauriConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));
    const plistPath = path.join(process.cwd(), 'src-tauri', tauriConfig.bundle.macOS.infoPlist);
    const infoPlist = fs.readFileSync(plistPath, 'utf8');

    expect(infoPlist).toContain('<key>NSCameraUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSMicrophoneUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSAppleEventsUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSDesktopFolderUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSDocumentsFolderUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSDownloadsFolderUsageDescription</key>');
    expect(infoPlist).not.toContain('<key>CFBundleVersion</key>');
    expect(infoPlist).not.toContain('<key>CFBundleExecutable</key>');
    expect(fs.existsSync(path.join(process.cwd(), '.github/workflows/build-macos.yml'))).toBe(false);
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
    const publicCi = fs.readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseGuide = fs.readFileSync(path.join(process.cwd(), 'COMMERCIAL_RELEASE.md'), 'utf8');
    expect(publicCi).toContain('Run complete Vitest suite');
    expect(publicCi).toContain('Build desktop and mobile frontends');
    expect(releaseGuide).toContain('Source availability and signed binary distribution are separate release decisions.');
    expect(releaseGuide).toContain('npm run release:check -- --strict-publish');
    expect(fs.existsSync(path.join(process.cwd(), '.github/workflows/build-windows.yml'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), '.github/workflows/reliability-windows.yml'))).toBe(false);
  });

  it('packages Sharp native dependencies for the build host instead of Windows-only binaries', () => {
    const resourceScript = fs.readFileSync(path.join(process.cwd(), 'scripts/prepare-desktop-resources.mjs'), 'utf8');
    expect(resourceScript).toContain('sharp-darwin-${sharpArch}');
    expect(resourceScript).toContain('sharp-win32-${sharpArch}');
    expect(resourceScript).toContain('platformSharpPackages');
    expect(resourceScript).not.toContain("'sharp-win32-x64',");
  });
});
