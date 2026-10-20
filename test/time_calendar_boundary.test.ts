import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { getDateString, getDayOfWeek, getMonthDay, getUserDayRange, setUserTimezone } from '../server/time/utils';
import { buildTemporalContext } from '../server/time/temporal_context';
import { generateSpatiotemporalContext } from '../server/time/spatiotemporal';
import { generateSystemPrompt } from '../server/personality/engine';
import { personalityRegistry } from '../server/personality/registry';

describe('user calendar boundaries', () => {
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => vi.useRealTimers());
  it('keeps the date, weekday, and today activity in the same Shanghai day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T16:30:00Z'));
    const userId = 'calendar-shanghai';
    setUserTimezone(userId, 'Asia/Shanghai');
    expect(getDateString(userId)).toBe('2026-09-07');
    expect(getDateString(userId, new Date('2026-09-06T15:59:00Z'))).toBe('2026-09-06');
    expect(getMonthDay(userId)).toBe('9月7日');
    expect(getDayOfWeek(userId)).toBe('Monday');
    expect(getUserDayRange(userId)).toEqual({ after: '2026-09-06T16:00:00.000Z', before: '2026-09-07T16:00:00.000Z' });
    const db = readDB();
    db.interactions.push(...['2026-09-06T16:20:00Z', '2026-09-06T15:59:00Z', '2026-09-06T16:05:00Z'].map((timestamp, index) => ({ id: `calendar-${index}`, userId, message: 'synthetic', timestamp })));
    writeDB(db);
    expect(buildTemporalContext(userId).sessionDurationMinutes).toBe(15);
  });
  it('grounds first dialogue in retained owner history, including legacy pairs, instead of sampled memory dates', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T06:30:00Z'));
    const userId = 'history-boundary';
    setUserTimezone(userId, 'Asia/Shanghai');
    const base = { userId, agentId: 'lumi', role: 'user', message: 'hello', timestamp: '2026-01-01T12:00:00Z' };
    const db = readDB();
    db.interactions.push(
      ...[
        { userId: 'another-owner' }, { role: 'assistant' }, { role: 'tool' }, { role: 'agent' },
        { mode: 'proactive' }, { mode: 'system' }, { source: 'test:acceptance' },
        { agentId: 'memory_avatar_person' }, { agentId: 'another-agent' },
        { domain: 'work', orgId: 'company' }, { orgId: 'another-workspace' },
        { timestamp: 'invalid-date' }, { timestamp: '2027-01-01' }, { message: '' },
      ].map((patch, index) => ({ ...base, ...patch, id: `excluded-history-${index}` })),
      { ...base, id: 'legacy-first', role: '', agentId: 'legacy-generated-id', module: 'lumi', response: 'hello', timestamp: '2026-04-09T12:31:42.009Z' },
      { ...base, id: 'current', timestamp: '2026-10-09T06:29:00Z' },
    );
    writeDB(db);
    const context = generateSpatiotemporalContext(userId);
    const firstLine = context.split('\n').find(line => line.includes('Earliest retained'));
    expect(firstLine).toContain('2026-04-09');
    expect(firstLine).toContain('overrides dates inferred from memories or earlier assistant replies');
    expect(context).toContain('actively talking');
    personalityRegistry.load();
    const config = personalityRegistry.get('lumi')!;
    for (const sensory of [undefined, { audio: true, deviceCount: 1, activeDeviceTypes: [], visual: false, spatial: false, haptic: false, holographic: false }]) {
      const prompt = generateSystemPrompt(config, { mode: 'chat', sensory }, { userId, domain: 'personal' });
      expect(prompt).toContain(firstLine!);
    }
    const avatarPrompt = generateSystemPrompt({ ...config, id: 'memory_avatar_person' }, { mode: 'chat' }, { userId });
    expect(avatarPrompt).not.toContain(firstLine!);
    expect(generateSpatiotemporalContext(userId, 'work', 'company')).toContain('Earliest retained user dialogue with this agent in this workspace: 2026-01-01');
    expect(generateSpatiotemporalContext(userId, 'personal', '', 'another-agent')).not.toContain('2026-04-09');
    expect(generateSpatiotemporalContext(userId, 'personal', '', 'memory_avatar_person')).not.toContain('Earliest retained');
    expect(generateSpatiotemporalContext('no-retained-history')).not.toContain('Earliest retained');
  });
  it.each([
    ['2026-03-08T16:00:00Z', 23], ['2026-11-01T16:00:00Z', 25],
  ])('uses actual DST day length at %s', (iso, hours) => {
    setUserTimezone('calendar-ny', 'America/New_York');
    const day = getUserDayRange('calendar-ny', new Date(iso));
    expect((Date.parse(day.before) - Date.parse(day.after)) / 3600000).toBe(hours);
  });
});
