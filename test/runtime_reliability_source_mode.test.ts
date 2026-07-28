import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('runtime reliability evidence modes', () => {
  const reliabilityScript = fs.readFileSync(
    path.join(process.cwd(), 'scripts/runtime-reliability.mjs'),
    'utf8',
  );
  const releaseCheck = fs.readFileSync(
    path.join(process.cwd(), 'scripts/check-release-readiness.mjs'),
    'utf8',
  );

  it('runs current TypeScript source without overwriting packaged evidence', () => {
    expect(reliabilityScript).toContain("runtime: 'packaged'");
    expect(reliabilityScript).toContain("args.runtime === 'source'");
    expect(reliabilityScript).toContain("node_modules', 'tsx', 'dist', 'cli.mjs'");
    expect(reliabilityScript).toContain('`${args.mode}-source.json`');
  });

  it('isolates source probes from legacy developer data', () => {
    expect(reliabilityScript).toContain("path.join(dataDirectory, '.migration_skip')");
    expect(reliabilityScript).toContain("LUMI_DATA_DIR: dataRoot");
  });

  it('reports the endpoint and deadline when a functional probe times out', () => {
    expect(reliabilityScript).toContain('GET ${url} timed out after ${timeoutMs}ms');
  });

  it('requires real TTS output, memory samples, and idle reclamation', () => {
    expect(reliabilityScript).toContain("provider: 'gptsovits'");
    expect(reliabilityScript).toContain("ttsCoverage: !gptSovitsInstalled");
    expect(reliabilityScript).toContain("'missing_fixture'");
    expect(reliabilityScript).toContain('gptSovitsIdleReclamationVerified = true');
    expect(reliabilityScript).toContain('ttsProbeAudioBytes');
    expect(reliabilityScript).toContain('scrubStagedTtsFixture(runRoot)');
    expect(reliabilityScript).toContain('A fixed');
    expect(reliabilityScript).toContain('runtime soak prewarm failed its functional or resource-budget gate');
  });

  it('requires a real SpeechBrain embedding and voiceprint idle reclamation', () => {
    expect(reliabilityScript).toContain("/auth/biometric/voiceprint/enroll");
    expect(reliabilityScript).toContain('requireEmbedding: true');
    expect(reliabilityScript).toContain("voiceprintCoverage: !ttsFixtureReady");
    expect(reliabilityScript).toContain('voiceprintIdleReclamationVerified');
    expect(reliabilityScript).toContain('Promise.all(prewarmTasks)');
    expect(reliabilityScript).toContain('voiceprintWorkingSetPeakBytes');
    expect(reliabilityScript).toContain('voiceprintProbeFailureCount');
    expect(reliabilityScript).toContain('nextVoiceprintProbeAt');
    expect(releaseCheck).toContain("soak.voiceprintCoverage === 'observed'");
  });

  it('never lets source-only results satisfy packaged release gates', () => {
    expect(releaseCheck).toContain("lifecycle.runtimeKind === 'packaged'");
    expect(releaseCheck).toContain("soak.runtimeKind === 'packaged'");
  });
});
