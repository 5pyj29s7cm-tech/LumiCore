// Spatiotemporal unification — cross-analyze time + location for pattern detection

import { readDB } from '../../db_layer';
import { getUserNow, getDateString, getDayOfWeekCN, getTimeOfDay, getSeasonInfo, getNearbyHoliday, getMonthDay, isWeekend, hoursSince, formatDuration } from './utils';
import { queryMemories } from '../memory/store';

export interface SpatiotemporalPattern {
  type: 'location_routine' | 'temporal_habit' | 'location_topic_link';
  description: string;
  confidence: number;
  evidence: string[];
}

export interface SpatiotemporalContext {
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
  locationStats: { location: string; count: number }[];
  currentLocation: string | null;
  patterns: SpatiotemporalPattern[];
}

// ── Pattern Detection ──

export function detectSpatiotemporalPatterns(userId: string, domain = 'personal', orgId = ''): SpatiotemporalPattern[] {
  const patterns: SpatiotemporalPattern[] = [];

  try {
    const db = readDB();
    const memories: any[] = (db.memories || []).filter((m: any) =>
      m.userId === userId && (m.domain || 'personal') === domain && (m.orgId || '') === orgId
    );
    const interactions: any[] = (db.interactions || []).filter((i: any) =>
      i.userId === userId && (i.domain || 'personal') === domain && (i.orgId || '') === orgId
    );

    // ── Location routine detection ──
    const memoriesWithLocation = memories.filter((m: any) => m.location && m.location.trim());
    // Group by location (always populate for later reuse)
    const byLocation = new Map<string, any[]>();
    for (const m of memoriesWithLocation) {
      const loc = m.location.trim().toLowerCase();
      if (!byLocation.has(loc)) byLocation.set(loc, []);
      byLocation.get(loc)!.push(m);
    }

    if (memoriesWithLocation.length >= 3) {
      // Check if any location has strong day-of-week pattern (≥3 occurrences on same weekday)
      for (const [loc, locMemories] of byLocation) {
        if (loc === '') continue;
        const byDOW = new Map<string, number>();
        for (const m of locMemories) {
          const day = new Date(m.createdAt).getDay();
          const dayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day];
          byDOW.set(dayName, (byDOW.get(dayName) || 0) + 1);
        }
        for (const [dayName, count] of byDOW) {
          if (count >= 3) {
            patterns.push({
              type: 'location_routine',
              description: `你通常在${dayName}出现在"${loc}"`,
              confidence: Math.min(0.9, 0.5 + count * 0.1),
              evidence: [`${count}条${loc}的记忆创建在${dayName}`],
            });
          }
        }
      }
    }

    // ── Temporal habit detection ──
    const morningInteractions = interactions.filter((i: any) => {
      const hour = new Date(i.timestamp).getHours();
      return hour >= 6 && hour < 12;
    });
    const lateNightInteractions = interactions.filter((i: any) => {
      const hour = new Date(i.timestamp).getHours();
      return hour >= 23 || hour < 5;
    });

    if (morningInteractions.length >= 5 && morningInteractions.length > interactions.length * 0.3) {
      patterns.push({
        type: 'temporal_habit',
        description: '你经常在早上与Lumi互动，可能是晨间例行的一部分。',
        confidence: Math.min(0.9, morningInteractions.length / 20),
        evidence: [`${morningInteractions.length}次早上(6-12点)的对话`],
      });
    }

    if (lateNightInteractions.length >= 5) {
      patterns.push({
        type: 'temporal_habit',
        description: '你有深夜工作的习惯，Lumi会在这个时段保持简洁和专注。',
        confidence: Math.min(0.9, lateNightInteractions.length / 15),
        evidence: [`${lateNightInteractions.length}次深夜(23点-5点)的对话`],
      });
    }

    // ── Location-topic links ──
    for (const [loc, locMemories] of byLocation) {
      if (loc === '' || locMemories.length < 3) continue;
      const types: Record<string, number> = {};
      for (const m of locMemories) {
        types[m.type] = (types[m.type] || 0) + 1;
      }
      const dominantType = Object.entries(types).sort((a, b) => b[1] - a[1])[0];
      if (dominantType && dominantType[1] >= 2) {
        const typeLabels: Record<string, string> = {
          preference: '偏好相关',
          fact: '事实性',
          habit: '习惯相关',
          knowledge: '知识学习',
        };
        patterns.push({
          type: 'location_topic_link',
          description: `在"${loc}"时，你更多讨论${typeLabels[dominantType[0]] || dominantType[0]}的话题。`,
          confidence: Math.min(0.8, 0.4 + dominantType[1] * 0.15),
          evidence: [`${loc}: ${dominantType[1]}条${dominantType[0]}类型记忆`],
        });
      }
    }
  } catch (err) {
    console.warn('[Spatiotemporal] Pattern detection failed:', err);
  }

  return patterns;
}

// ── Unified Context Generation ──

export function generateSpatiotemporalContext(userId: string, domain = 'personal', orgId = ''): string {
  const lines: string[] = [];
  lines.push('\n## Spatiotemporal Context');

  // ── Time ──
  const now = getUserNow(userId);
  const dateStr = getDateString(userId);
  const dow = getDayOfWeekCN(userId);
  const tod = getTimeOfDay(userId);
  const season = getSeasonInfo(userId);
  const holiday = getNearbyHoliday(userId);
  const isWeek = isWeekend(userId);

  lines.push(`- Now: ${dateStr} (${dow}), ${season.emoji} ${season.seasonCN}, ${tod}`);

  if (holiday) {
    if (holiday.isToday) {
      lines.push(`- Today is ${holiday.nameCN}${holiday.mood ? ` — ${holiday.mood}` : ''}.`);
    } else if (Math.abs(holiday.daysUntil) <= 3) {
      const dir = holiday.daysUntil > 0 ? 'coming' : 'passed';
      lines.push(`- ${holiday.nameCN}${dir === 'coming' ? '即将到来' : '刚刚过去'}.`);
    }
  }

  lines.push(`- ${isWeek ? 'Weekend' : 'Workday'} — ${season.mood}.`);

  // ── Recency ──
  try {
    const db = readDB();
    const userInteractions = (db.interactions || [])
      .filter((i: any) => i.userId === userId && (i.domain || 'personal') === domain && (i.orgId || '') === orgId)
      .sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));

    if (userInteractions.length > 0) {
      const lastTs = userInteractions[0].timestamp;
      const hrsSince = hoursSince(lastTs);
      if (hrsSince < 0.05) {
        lines.push('- The user is actively talking to you right now.');
      } else if (hrsSince < 24) {
        lines.push(`- User last active: ${formatDuration(hrsSince)}.`);
      } else {
        lines.push(`- User last active: ${formatDuration(hrsSince)} — they may be returning after a break.`);
      }
    }
  } catch {}

  // ── Space ──
  try {
    const memories = queryMemories({ userId, limit: 100, minConfidence: 0, domain, orgId });
    const memsWithLoc = memories.filter(m => m.location && m.location.trim());
    if (memsWithLoc.length > 0) {
      const byLoc = new Map<string, number>();
      for (const m of memsWithLoc) {
        const loc = m.location!.trim().toLowerCase();
        byLoc.set(loc, (byLoc.get(loc) || 0) + 1);
      }
      const sortedLocs = [...byLoc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const locStr = sortedLocs.map(([loc, count]) => `${loc} (${count})`).join(', ');
      lines.push(`- Known locations: ${locStr}`);
    }
  } catch {}

  // ── Patterns ──
  try {
    const patterns = detectSpatiotemporalPatterns(userId, domain, orgId);
    if (patterns.length > 0) {
      lines.push('- Learned patterns:');
      for (const p of patterns.slice(0, 3)) {
        lines.push(`  - ${p.description} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
      }
    }
  } catch {}

  return lines.join('\n');
}

export function generateSpatiotemporalContextBrief(userId: string): string {
  const dateStr = getDateString(userId);
  const dow = getDayOfWeekCN(userId);
  const season = getSeasonInfo(userId);
  return `${dateStr} ${dow} ${season.emoji} ${season.seasonCN}`;
}
