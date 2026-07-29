import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { getVoiceprintRuntimeRoots } from '../server/biometrics/voiceprint_provider';
import { getGptSovitsRuntimeRoots } from '../server/tts/gptsovits_runtime';

describe('voiceprint sidecar supervision', () => {
  const provider = fs.readFileSync(
    path.join(process.cwd(), 'server/biometrics/voiceprint_provider.ts'),
    'utf8',
  );
  const bootstrap = fs.readFileSync(
    path.join(process.cwd(), 'server/runtime/bootstrap.ts'),
    'utf8',
  );

  it('stores downloaded model files under the configured Lumi data root', () => {
    expect(provider).toContain("getDataDirectory('voiceprint_models')");
    expect(provider).toContain('LUMI_VOICEPRINT_MODEL_DIR:');
  });

  it('publishes last activity and stops the child during backend shutdown', () => {
    expect(provider).toContain('lastUsedAt: this.lastUsedAt');
    expect(provider).toContain('export async function stopVoiceprintRuntime');
    expect(provider).toContain("proc.kill('SIGTERM')");
    expect(provider).toContain("proc.kill('SIGKILL')");
    expect(bootstrap).toContain('await stopVoiceprintRuntime()');
  });

  it('samples the full process tree frequently enough to enforce memory budgets', () => {
    const monitor = fs.readFileSync(
      path.join(process.cwd(), 'server/runtime/process_resource_monitor.ts'),
      'utf8',
    );
    expect(monitor).toContain('Get-CimInstance Win32_Process');
    expect(monitor).toContain('collectLinuxProcessTree');
    expect(monitor).toContain('peakPrivateBytes');
    expect(monitor).toContain('privateBudgetBytes');
    expect(provider).toContain('intervalMs: 5_000');
    expect(provider).toContain('LUMI_VOICEPRINT_COLD_START_TIMEOUT_MS');
    expect(provider).toContain('this.warmed');
    expect(provider).toContain('Math.max(timeoutMs, COLD_START_TIMEOUT_MS)');
  });

  it('keeps bounded headroom for the observed GPT-SoVITS startup peak', () => {
    const runtime = fs.readFileSync(
      path.join(process.cwd(), 'server/tts/gptsovits_runtime.ts'),
      'utf8',
    );
    expect(runtime).toContain("GPTSOVITS_MEMORY_BUDGET_MB) || 8_192");
    expect(runtime).toContain("GPTSOVITS_PRIVATE_MEMORY_BUDGET_MB) || 12_288");
  });

  it('finds offline voice resources beside the packaged dist-server directory', () => {
    const packagedCwd = path.join(process.cwd(), 'desktop-resources', 'dist-server');
    const resourceRoot = path.dirname(packagedCwd);

    expect(getGptSovitsRuntimeRoots(packagedCwd)).toContain(resourceRoot);
    expect(getVoiceprintRuntimeRoots(packagedCwd, packagedCwd)).toContain(resourceRoot);
  });

  it('leaves GPT-SoVITS lifecycle ownership with the supervised Node runtime', () => {
    const nativeRuntime = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/lib.rs'),
      'utf8',
    );
    expect(nativeRuntime).toContain("GPT-SoVITS is owned by the Node backend's supervised, on-demand");
    expect(nativeRuntime).not.toContain('fn spawn_python(');
    expect(nativeRuntime).not.toContain('Restarting Python API');
  });
});
