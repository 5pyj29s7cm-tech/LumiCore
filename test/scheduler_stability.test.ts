import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseSchedule, runAgentAutonomousAnalysis } from '../server/scheduler';
import {
  resetRealtimeUserActivityForTests,
  setRealtimeVoiceSessionActive,
} from '../server/autonomy/foreground_activity';
import { saveGateConfig } from '../server/autonomy/safety_gate';

describe('scheduler stability', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });
  afterEach(() => resetRealtimeUserActivityForTests());

  it('maps every built-in alias to its intended cadence', () => {
    expect(parseSchedule('every_10s')).toEqual({ type: 'interval', intervalMs: 10_000 });
    expect(parseSchedule('every_1m')).toEqual({ type: 'interval', intervalMs: 60_000 });
    expect(parseSchedule('every_10m')).toEqual({ type: 'interval', intervalMs: 600_000 });
    expect(parseSchedule('every_hour')).toEqual({ type: 'interval', intervalMs: 3_600_000 });
    expect(parseSchedule('every_24h')).toEqual({ type: 'interval', intervalMs: 86_400_000 });
  });

  it('uses wall-clock schedules for morning and evening jobs', () => {
    expect(parseSchedule('daily_9am')).toEqual({ type: 'cron', fields: [0, 9, -1, -1, -1] });
    expect(parseSchedule('evening_8pm')).toEqual({ type: 'cron', fields: [0, 20, -1, -1, -1] });
  });

  it('rejects invalid schedules instead of silently running them hourly', () => {
    expect(() => parseSchedule('every_sometime')).toThrow(/Unsupported schedule/);
    expect(() => parseSchedule('99 24 * * *')).toThrow(/out of range/);
    expect(() => parseSchedule('*/5 * * * *')).toThrow(/Unsupported cron field/);
  });

  it('does not start an autonomous analysis while live voice is active', async () => {
    const userId = 'scheduler-live-voice-active';
    saveGateConfig({ autonomyLevel: 'full' }, userId);
    setRealtimeVoiceSessionActive(userId, 'socket-live', true);
    const analyze = vi.fn(async () => 'should not run');

    await expect(runAgentAutonomousAnalysis(userId, analyze)).resolves.toBe('');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('aborts an in-flight autonomous analysis when live voice starts', async () => {
    const userId = 'scheduler-live-voice-race';
    saveGateConfig({ autonomyLevel: 'full' }, userId);
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    let providerSignal: AbortSignal | undefined;

    const analysis = runAgentAutonomousAnalysis(userId, signal => {
      providerSignal = signal;
      started();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await didStart;
    setRealtimeVoiceSessionActive(userId, 'socket-live', true);

    await expect(analysis).resolves.toBe('');
    expect(providerSignal?.aborted).toBe(true);
  });
});
