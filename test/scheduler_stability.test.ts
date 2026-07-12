import './helpers';
import { describe, expect, it } from 'vitest';
import { parseSchedule } from '../server/scheduler';

describe('scheduler stability', () => {
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
});
