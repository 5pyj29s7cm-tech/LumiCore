// Time-space utilities — all local computation, zero LLM cost, zero npm deps

import { readDB, writeDB } from '../../db_layer';

// ── User timezone ──

export function getUserTimezone(userId: string): string {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === `timezone_${userId}`);
    return setting?.value || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function setUserTimezone(userId: string, tz: string): void {
  new Intl.DateTimeFormat('en', { timeZone: tz }).format();
  const db = readDB();
  if (!db.settings) db.settings = [];
  const existing = db.settings.findIndex((s: any) => s.key === `timezone_${userId}`);
  if (existing >= 0) {
    db.settings[existing].value = tz;
  } else {
    db.settings.push({ key: `timezone_${userId}`, value: tz });
  }
  writeDB(db);
}

function zonedParts(userId: string, instant: Date): number[] {
  let timeZone = getUserTimezone(userId);
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { timeZone = 'Asia/Shanghai'; }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  return ['year', 'month', 'day', 'hour', 'minute', 'second']
    .map(type => Number(parts.find(part => part.type === type)!.value));
}

/** Wall-clock calendar fields for display. Use Date.now() for elapsed time. */
export function getUserNow(userId: string): Date {
  const [year, month, day, hour, minute, second] = zonedParts(userId, new Date());
  return new Date(year, month - 1, day, hour, minute, second);
}

/** Convert user-local midnight boundaries to actual UTC instants (including DST). */
export function getUserDayRange(userId: string, instant = new Date()): { after: string; before: string } {
  const [year, month, day] = zonedParts(userId, instant);
  const midnight = (target: number) => {
    let guess = target;
    for (let attempt = 0; attempt < 4; attempt++) {
      const [y, m, d, h, min, s] = zonedParts(userId, new Date(guess));
      const correction = target - Date.UTC(y, m - 1, d, h, min, s);
      if (!correction) break;
      guess += correction;
    }
    return new Date(guess).toISOString();
  };
  return { after: midnight(Date.UTC(year, month - 1, day)), before: midnight(Date.UTC(year, month - 1, day + 1)) };
}

// ── Date queries ──

export function getDateString(userId: string): string {
  const now = getUserNow(userId);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function getDayOfWeek(userId: string): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[getUserNow(userId).getDay()];
}

export function getDayOfWeekCN(userId: string): string {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return days[getUserNow(userId).getDay()];
}

export function getMonthDay(userId: string): string {
  const now = getUserNow(userId);
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

export function isWeekend(userId: string): boolean {
  const day = getUserNow(userId).getDay();
  return day === 0 || day === 6;
}

export function getCurrentYear(userId: string): number {
  return getUserNow(userId).getFullYear();
}

// ── Time intervals ──

export function hoursSince(isoString: string): number {
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60);
}

export function daysSince(isoString: string): number {
  return hoursSince(isoString) / 24;
}

export function minutesSince(isoString: string): number {
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60);
}

export function formatDuration(hours: number): string {
  if (hours < 1 / 60) return '刚刚';
  if (hours < 1) return `${Math.round(hours * 60)}分钟前`;
  if (hours < 24) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h}小时${m}分钟前` : `${h}小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  return `${Math.floor(months / 12)}年前`;
}

export function formatMinutesAgo(minutes: number): string {
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${Math.round(minutes)}分钟前`;
  return formatDuration(minutes / 60);
}

export function getTimeOfDay(userId: string): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = getUserNow(userId).getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

// ── Season info ──

export function getSeasonInfo(userId: string): { season: string; seasonCN: string; emoji: string; mood: string } {
  const month = getUserNow(userId).getMonth() + 1; // JavaScript months are 0-indexed
  const day = getUserNow(userId).getDate();

  // Using traditional East Asian seasonal divisions
  // Spring: Feb 4 – May 5, Summer: May 6 – Aug 7, Autumn: Aug 8 – Nov 7, Winter: Nov 8 – Feb 3
  if (month === 2 && day >= 4 || month === 3 || month === 4 || month === 5 && day <= 5) {
    return { season: 'spring', seasonCN: '春季', emoji: '🌸', mood: '生机盎然，万物复苏' };
  }
  if (month === 5 && day >= 6 || month === 6 || month === 7 || month === 8 && day <= 7) {
    return { season: 'summer', seasonCN: '夏季', emoji: '☀️', mood: '热情似火，阳光充足' };
  }
  if (month === 8 && day >= 8 || month === 9 || month === 10 || month === 11 && day <= 7) {
    return { season: 'autumn', seasonCN: '秋季', emoji: '🍂', mood: '天高气爽，收获的季节' };
  }
  return { season: 'winter', seasonCN: '冬季', emoji: '❄️', mood: '安静内敛，适合沉淀思考' };
}

// ── Chinese holidays (Gregorian fixed + lunar approximation) ──

interface HolidayEntry {
  name: string;
  nameCN: string;
  /** 1-12 month (lunar month for isLunar), 1-31 day */
  month: number;
  day: number;
  isLunar?: boolean;
  mood?: string;
}

// Gregorian-fixed holidays
const GREGORIAN_HOLIDAYS: HolidayEntry[] = [
  { name: 'New Year', nameCN: '元旦', month: 1, day: 1, mood: '新的一年开始了' },
  { name: "Valentine's Day", nameCN: '情人节', month: 2, day: 14, mood: '浪漫的一天' },
  { name: "International Women's Day", nameCN: '妇女节', month: 3, day: 8 },
  { name: 'April Fools', nameCN: '愚人节', month: 4, day: 1 },
  { name: 'Labor Day', nameCN: '劳动节', month: 5, day: 1, mood: '劳动者的节日' },
  { name: "Children's Day", nameCN: '儿童节', month: 6, day: 1 },
  { name: 'Party Founding Day', nameCN: '建党节', month: 7, day: 1 },
  { name: "Army Day", nameCN: '建军节', month: 8, day: 1 },
  { name: "Teachers' Day", nameCN: '教师节', month: 9, day: 10 },
  { name: 'National Day', nameCN: '国庆节', month: 10, day: 1, mood: '祖国的生日，举国欢庆' },
  { name: 'Halloween', nameCN: '万圣节', month: 10, day: 31 },
  { name: 'Christmas Eve', nameCN: '平安夜', month: 12, day: 24 },
  { name: 'Christmas', nameCN: '圣诞节', month: 12, day: 25 },
  { name: "New Year's Eve", nameCN: '除夕（公历）', month: 12, day: 31, mood: '一年即将结束' },
];

// Lunar holidays — approximate Gregorian dates for 2025/2026
// Accurate enough for seasonal context, not for calendar-precision
const LUNAR_HOLIDAYS_BY_YEAR: Record<number, HolidayEntry[]> = {
  2025: [
    { name: 'Spring Festival', nameCN: '春节', month: 1, day: 29, isLunar: true, mood: '辞旧迎新，合家团圆' },
    { name: 'Lantern Festival', nameCN: '元宵节', month: 2, day: 12, isLunar: true, mood: '赏花灯，吃元宵' },
    { name: 'Qingming Festival', nameCN: '清明节', month: 4, day: 4, isLunar: true, mood: '缅怀先人，踏青' },
    { name: 'Dragon Boat Festival', nameCN: '端午节', month: 5, day: 31, isLunar: true, mood: '赛龙舟，吃粽子' },
    { name: 'Qixi Festival', nameCN: '七夕', month: 8, day: 29, isLunar: true, mood: '中国情人节' },
    { name: 'Mid-Autumn Festival', nameCN: '中秋节', month: 10, day: 6, isLunar: true, mood: '月圆人团圆，吃月饼' },
    { name: 'Double Ninth Festival', nameCN: '重阳节', month: 10, day: 29, isLunar: true, mood: '登高望远' },
    { name: 'Winter Solstice', nameCN: '冬至', month: 12, day: 21, isLunar: true, mood: '吃饺子/汤圆' },
  ],
  2026: [
    { name: 'Spring Festival', nameCN: '春节', month: 2, day: 17, isLunar: true, mood: '辞旧迎新，合家团圆' },
    { name: 'Lantern Festival', nameCN: '元宵节', month: 3, day: 3, isLunar: true, mood: '赏花灯，吃元宵' },
    { name: 'Qingming Festival', nameCN: '清明节', month: 4, day: 5, isLunar: true, mood: '缅怀先人，踏青' },
    { name: 'Dragon Boat Festival', nameCN: '端午节', month: 6, day: 19, isLunar: true, mood: '赛龙舟，吃粽子' },
    { name: 'Qixi Festival', nameCN: '七夕', month: 8, day: 17, isLunar: true, mood: '中国情人节' },
    { name: 'Mid-Autumn Festival', nameCN: '中秋节', month: 9, day: 25, isLunar: true, mood: '月圆人团圆，吃月饼' },
    { name: 'Double Ninth Festival', nameCN: '重阳节', month: 10, day: 18, isLunar: true, mood: '登高望远' },
    { name: 'Winter Solstice', nameCN: '冬至', month: 12, day: 22, isLunar: true, mood: '吃饺子/汤圆' },
  ],
  2027: [
    { name: 'Spring Festival', nameCN: '春节', month: 2, day: 6, isLunar: true, mood: '辞旧迎新，合家团圆' },
    { name: 'Lantern Festival', nameCN: '元宵节', month: 2, day: 20, isLunar: true, mood: '赏花灯，吃元宵' },
    { name: 'Qingming Festival', nameCN: '清明节', month: 4, day: 5, isLunar: true, mood: '缅怀先人，踏青' },
    { name: 'Dragon Boat Festival', nameCN: '端午节', month: 6, day: 9, isLunar: true, mood: '赛龙舟，吃粽子' },
    { name: 'Qixi Festival', nameCN: '七夕', month: 8, day: 6, isLunar: true, mood: '中国情人节' },
    { name: 'Mid-Autumn Festival', nameCN: '中秋节', month: 9, day: 15, isLunar: true, mood: '月圆人团圆，吃月饼' },
    { name: 'Double Ninth Festival', nameCN: '重阳节', month: 10, day: 8, isLunar: true, mood: '登高望远' },
    { name: 'Winter Solstice', nameCN: '冬至', month: 12, day: 22, isLunar: true, mood: '吃饺子/汤圆' },
  ],
};

export interface HolidayResult {
  name: string;
  nameCN: string;
  mood?: string;
  daysUntil: number;
  isToday: boolean;
}

export function getNearbyHoliday(userId: string): HolidayResult | null {
  const now = getUserNow(userId);
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  // Merge all holidays for current year
  const allHolidays: HolidayEntry[] = [
    ...GREGORIAN_HOLIDAYS,
    ...(LUNAR_HOLIDAYS_BY_YEAR[year] || []),
  ];

  // Find closest holiday within a 7-day window (before or after)
  let best: HolidayResult | null = null;
  let bestDiff = Infinity;

  for (const h of allHolidays) {
    const holidayDate = new Date(year, h.month - 1, h.day);
    const diffDays = Math.abs(
      (new Date(year, month - 1, day).getTime() - holidayDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (diffDays <= 7 && diffDays < bestDiff) {
      bestDiff = diffDays;
      best = {
        name: h.name,
        nameCN: h.nameCN,
        mood: h.mood,
        daysUntil: Math.round(
          (holidayDate.getTime() - new Date(year, month - 1, day).getTime()) / (1000 * 60 * 60 * 24),
        ),
        isToday: diffDays === 0,
      };
    }
  }

  return best;
}

export function getHolidayForDate(date: Date): HolidayResult | null {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  const allHolidays: HolidayEntry[] = [
    ...GREGORIAN_HOLIDAYS,
    ...(LUNAR_HOLIDAYS_BY_YEAR[year] || []),
  ];

  for (const h of allHolidays) {
    if (h.month === month && h.day === day) {
      return {
        name: h.name,
        nameCN: h.nameCN,
        mood: h.mood,
        daysUntil: 0,
        isToday: true,
      };
    }
  }

  return null;
}

// ── Same-month-day helper (for "this day in history" queries) ──

export function getMonthDayFromISO(isoString: string): string {
  const d = new Date(isoString);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

export function getSameMonthDayPast(userId: string): { after: string; before: string; label: string } {
  const now = getUserNow(userId);
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const year = now.getFullYear();

  const pastYear = year - 1;
  const after = `${pastYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const before = `${pastYear}-${String(month).padStart(2, '0')}-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`;

  return { after, before, label: `${pastYear}年${month}月${day}日` };
}
