import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

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
});
