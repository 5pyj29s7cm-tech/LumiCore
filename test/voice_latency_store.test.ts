import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeRuntimeLogLine } from '../server/runtime/file_logger';
import {
  getVoiceLatencyStats,
  markVoiceLatencyMilestone,
  recordVoicePlaybackMetrics,
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

  it('distinguishes preparation, shared model runner, synthesis and client decode durations', () => {
    startVoiceLatencyTrace({ requestId: 'stages', pipelineStartedAt: 100 });
    markVoiceLatencyMilestone('stages', 'firstModelRequestAt', 300);
    markVoiceLatencyMilestone('stages', 'firstModelTokenAt', 900);
    markVoiceLatencyMilestone('stages', 'firstTtsRequestedAt', 950);
    markVoiceLatencyMilestone('stages', 'firstTtsReadyAt', 1_400);
    recordVoicePlaybackMetrics('stages', { clientDecodeMs: 42, clientReceiptToPlaybackMs: 80 });
    markVoiceLatencyMilestone('stages', 'firstPlaybackAt', 1_500);
    expect(getVoiceLatencyStats(2_000).stages).toMatchObject({
      pipelineToFirstModelRequest: { lastMs: 200 },
      modelRequestToFirstToken: { lastMs: 600 },
      ttsSynthesis: { lastMs: 450 },
      clientDecode: { lastMs: 42 },
      clientReceiptToPlayback: { lastMs: 80 },
    });
  });

  it('ignores invalid or repeated playback metrics without corrupting stage averages', () => {
    startVoiceLatencyTrace({ requestId: 'bounded', pipelineStartedAt: 100 });
    markVoiceLatencyMilestone('bounded', 'firstModelRequestAt', NaN);
    recordVoicePlaybackMetrics('bounded', { clientDecodeMs: -1, clientReceiptToPlaybackMs: Infinity });
    recordVoicePlaybackMetrics('bounded', { clientDecodeMs: 10, clientReceiptToPlaybackMs: 120_001 });
    recordVoicePlaybackMetrics('bounded', { clientDecodeMs: 999, clientReceiptToPlaybackMs: 30 });
    markVoiceLatencyMilestone('bounded', 'firstPlaybackAt', 300);
    recordVoicePlaybackMetrics('bounded', { clientDecodeMs: 888 });
    expect(getVoiceLatencyStats(400).stages).toMatchObject({
      pipelineToFirstModelRequest: { count: 0 },
      clientDecode: { count: 1, lastMs: 10 },
      clientReceiptToPlayback: { count: 1, lastMs: 30 },
    });
  });

  it('keeps numeric timing evidence in the existing sanitized runtime log', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      startVoiceLatencyTrace({ requestId: 'voice-log', provider: 'relay', domain: 'personal', pipelineStartedAt: 100 });
      markVoiceLatencyMilestone('voice-log', 'firstModelRequestAt', 200);
      markVoiceLatencyMilestone('voice-log', 'firstModelTokenAt', 300);
      recordVoicePlaybackMetrics('voice-log', { clientDecodeMs: 12, clientReceiptToPlaybackMs: 20 });
      markVoiceLatencyMilestone('voice-log', 'firstPlaybackAt', 400);
      const line = sanitizeRuntimeLogLine(log.mock.calls[0]);
      expect(line).toContain('VoiceLatency');
      expect(line).toContain("requestId: 'voice-log'");
      expect(line).toContain('firstModelRequestAt: 200');
      expect(line).toContain('firstModelTokenAt: 300');
      expect(line).toContain('clientDecodeMs: 12');
      expect(Object.keys(log.mock.calls[0][1])).not.toEqual(expect.arrayContaining(['text', 'audio', 'prompt']));
    } finally { log.mockRestore(); }
  });
});
