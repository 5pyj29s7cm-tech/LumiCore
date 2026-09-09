import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { getDateString, getDayOfWeek, getMonthDay, getUserDayRange, setUserTimezone } from '../server/time/utils';
import { buildTemporalContext } from '../server/time/temporal_context';

describe('user calendar boundaries', () => {
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => vi.useRealTimers());
  it('keeps the date, weekday, and today activity in the same Shanghai day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T16:30:00Z'));
    const userId = 'calendar-shanghai';
    setUserTimezone(userId, 'Asia/Shanghai');
    expect(getDateString(userId)).toBe('2026-09-07');
    expect(getMonthDay(userId)).toBe('9月7日');
    expect(getDayOfWeek(userId)).toBe('Monday');
    expect(getUserDayRange(userId)).toEqual({ after: '2026-09-06T16:00:00.000Z', before: '2026-09-07T16:00:00.000Z' });
    const db = readDB();
    db.interactions.push(...['2026-09-06T16:20:00Z', '2026-09-06T15:59:00Z', '2026-09-06T16:05:00Z'].map((timestamp, index) => ({ id: `calendar-${index}`, userId, message: 'synthetic', timestamp })));
    writeDB(db);
    expect(buildTemporalContext(userId).sessionDurationMinutes).toBe(15);
  });
  it.each([
    ['2026-03-08T16:00:00Z', 23], ['2026-11-01T16:00:00Z', 25],
  ])('uses actual DST day length at %s', (iso, hours) => {
    setUserTimezone('calendar-ny', 'America/New_York');
    const day = getUserDayRange('calendar-ny', new Date(iso));
    expect((Date.parse(day.before) - Date.parse(day.after)) / 3600000).toBe(hours);
  });
});
