// Temporal context block generator — injects time-aware context into the system prompt

import { getUserNow, getDateString, getDayOfWeekCN, getTimeOfDay, getSeasonInfo, getNearbyHoliday, getMonthDay, isWeekend, hoursSince, daysSince, minutesSince, formatDuration } from './utils';
import { queryMemories } from '../memory/store';
import { readDB } from '../../db_layer';
import { getUserDayRange } from './utils';

export interface TemporalContext {
  dateString: string;
  dayOfWeek: string;
  timeOfDay: string;
  monthDay: string;
  season: { season: string; seasonCN: string; emoji: string; mood: string };
  holiday: { name: string; nameCN: string; mood?: string; daysUntil: number; isToday: boolean } | null;
  isWeekend: boolean;
  minutesSinceLastInteraction: number;
  sessionDurationMinutes: number;
  recentMemoryCount: number;
  userTimezone: string;
}

export function buildTemporalContext(userId: string): TemporalContext {
  const now = getUserNow(userId);
  const holiday = getNearbyHoliday(userId);

  // Last interaction time
  let minutesSinceLastInteraction = -1;
  try {
    const db = readDB();
    const interactions = (db.interactions || [])
      .filter((i: any) => i.userId === userId)
      .sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
    if (interactions.length > 0) {
      minutesSinceLastInteraction = minutesSince(interactions[0].timestamp);
    }
  } catch {}

  // Session duration (conversations active today)
  let sessionDurationMinutes = 0;
  try {
    const db = readDB();
    const today = getUserDayRange(userId);
    const todayInteractions = (db.interactions || []).filter(
      (i: any) => i.userId === userId && i.timestamp >= today.after && i.timestamp < today.before,
    ).sort((a: any, b: any) => a.timestamp.localeCompare(b.timestamp));
    if (todayInteractions.length >= 2) {
      const first = new Date(todayInteractions[0].timestamp).getTime();
      const last = new Date(todayInteractions[todayInteractions.length - 1].timestamp).getTime();
      sessionDurationMinutes = (last - first) / 60000;
    }
  } catch {}

  // Recent memory count (last 7 days)
  let recentMemoryCount = 0;
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    recentMemoryCount = queryMemories({ userId, after: sevenDaysAgo, limit: 1000 }).length;
  } catch {}

  return {
    dateString: getDateString(userId),
    dayOfWeek: getDayOfWeekCN(userId),
    timeOfDay: getTimeOfDay(userId),
    monthDay: getMonthDay(userId),
    season: getSeasonInfo(userId),
    holiday,
    isWeekend: isWeekend(userId),
    minutesSinceLastInteraction,
    sessionDurationMinutes,
    recentMemoryCount,
    userTimezone: now.toString(),
  };
}

export function generateTemporalContext(userId: string): string {
  const ctx = buildTemporalContext(userId);

  const lines: string[] = [];
  lines.push('\n## Temporal Context');
  lines.push(`- Current date: ${ctx.dateString} (${ctx.dayOfWeek}), ${ctx.monthDay}`);

  if (ctx.season) {
    lines.push(`- Season: ${ctx.season.emoji} ${ctx.season.seasonCN} — ${ctx.season.mood}`);
  }

  if (ctx.holiday) {
    if (ctx.holiday.isToday) {
      lines.push(`- Today is ${ctx.holiday.nameCN}${ctx.holiday.mood ? ` — ${ctx.holiday.mood}` : ''}`);
    } else if (Math.abs(ctx.holiday.daysUntil) <= 3) {
      const dir = ctx.holiday.daysUntil > 0 ? '即将到来' : '刚刚过去';
      lines.push(`- ${ctx.holiday.nameCN}${dir} (${Math.abs(ctx.holiday.daysUntil)}天${ctx.holiday.daysUntil > 0 ? '后' : '前'})${ctx.holiday.mood ? ` — ${ctx.holiday.mood}` : ''}`);
    }
  }

  if (ctx.isWeekend) {
    lines.push('- It is the weekend — the user may be more relaxed or pursuing personal interests.');
  } else {
    lines.push('- It is a workday — the user may be in a more focused or professional mode.');
  }

  if (ctx.minutesSinceLastInteraction >= 0) {
    if (ctx.minutesSinceLastInteraction < 1) {
      lines.push('- The user is actively talking to you right now.');
    } else if (ctx.minutesSinceLastInteraction < 60) {
      lines.push(`- The user last spoke with you ${Math.round(ctx.minutesSinceLastInteraction)} minutes ago.`);
    } else {
      lines.push(`- The user last spoke with you ${formatDuration(ctx.minutesSinceLastInteraction / 60)}.`);
    }
  }

  if (ctx.sessionDurationMinutes > 5) {
    lines.push(`- You have been talking for ${Math.round(ctx.sessionDurationMinutes)} minutes this session.`);
  }

  if (ctx.recentMemoryCount > 0) {
    lines.push(`- ${ctx.recentMemoryCount} memories have been recorded this week.`);
  }

  if (ctx.timeOfDay === 'morning') {
    lines.push('- It is morning — energy is fresh, it is a good time for planning and important tasks.');
  } else if (ctx.timeOfDay === 'afternoon') {
    lines.push('- It is afternoon — the user is in the flow of the day. Stay focused and efficient.');
  } else if (ctx.timeOfDay === 'evening') {
    lines.push('- It is evening — time to wind down and reflect on the day.');
  } else {
    lines.push('- It is late at night — keep responses concise and gentle. The user may be tired.');
  }

  return lines.join('\n');
}

export function generateTemporalContextBrief(userId: string): string {
  const ctx = buildTemporalContext(userId);
  const parts: string[] = [ctx.dateString, ctx.dayOfWeek, ctx.season.seasonCN];
  if (ctx.holiday?.isToday) {
    parts.push(ctx.holiday.nameCN);
  }
  return parts.join(' — ');
}
