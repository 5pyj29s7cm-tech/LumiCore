import { beforeEach, describe, expect, it } from 'vitest';
import {
  getVoiceLatencyStats,
  markVoiceLatencyMilestone,
  resetVoiceLatencyStoreForTests,
  startVoiceLatencyTrace,
} from '../server/monitor/voice_latency_store';

beforeEach(() => resetVoiceLatencyStoreForTests());

describe('voice latency timeline', () => {
  it('records one trace without conversation text or audio content', () => {
    startVoiceLatencyTrace({
      requestId: 'voice-1',
      provider: 'qwen',
      domain: 'personal',
      speechEndedAt: 1_000,
      asrFinalAt: 1_180,
      pipelineStartedAt: 1_340,
    });
    markVoiceLatencyMilestone('voice-1', 'firstModelTokenAt', 1_500);
    markVoiceLatencyMilestone('voice-1', 'firstTtsReadyAt', 1_800);
    markVoiceLatencyMilestone('voice-1', 'firstPlaybackAt', 1_900);

    expect(getVoiceLatencyStats(2_000)).toMatchObject({
      completedTurns: 1,
      activeTurns: 0,
      stages: {
        endpointToAsrFinal: { lastMs: 180, count: 1 },
        asrFinalToPipeline: { lastMs: 160, count: 1 },
        pipelineToFirstModelToken: { lastMs: 160, count: 1 },
        pipelineToFirstTtsReady: { lastMs: 460, count: 1 },
        ttsReadyToFirstPlayback: { lastMs: 100, count: 1 },
        endpointToFirstPlayback: { lastMs: 900, count: 1 },
      },
    });
  });

  it('keeps the first occurrence of every milestone', () => {
    startVoiceLatencyTrace({ requestId: 'voice-2', pipelineStartedAt: 100 });
    markVoiceLatencyMilestone('voice-2', 'firstTtsReadyAt', 250);
    markVoiceLatencyMilestone('voice-2', 'firstTtsReadyAt', 500);
    markVoiceLatencyMilestone('voice-2', 'firstPlaybackAt', 300);

    expect(getVoiceLatencyStats(400).stages.pipelineToFirstTtsReady.lastMs).toBe(150);
  });

  it('reports incomplete turns separately until playback starts', () => {
    startVoiceLatencyTrace({ requestId: 'voice-3', pipelineStartedAt: 100 });
    markVoiceLatencyMilestone('voice-3', 'firstModelTokenAt', 180);

    expect(getVoiceLatencyStats(200)).toMatchObject({ completedTurns: 0, activeTurns: 1 });
  });
});
