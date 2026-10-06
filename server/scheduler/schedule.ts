

export type ParsedSchedule =
  | { type: 'interval'; intervalMs: number }
  | { type: 'cron'; fields: number[] };

const SCHEDULE_ALIASES: Record<string, ParsedSchedule> = {
  every_10s: { type: 'interval', intervalMs: 10 * 1000 },
  every_1m: { type: 'interval', intervalMs: 60 * 1000 },
  every_5m: { type: 'interval', intervalMs: 5 * 60 * 1000 },
  every_10m: { type: 'interval', intervalMs: 10 * 60 * 1000 },
  every_30m: { type: 'interval', intervalMs: 30 * 60 * 1000 },
  every_hour: { type: 'interval', intervalMs: 60 * 60 * 1000 },
  every_1h: { type: 'interval', intervalMs: 60 * 60 * 1000 },
  every_6h: { type: 'interval', intervalMs: 6 * 60 * 60 * 1000 },
  every_24h: { type: 'interval', intervalMs: 24 * 60 * 60 * 1000 },
  every_7d: { type: 'interval', intervalMs: 7 * 24 * 60 * 60 * 1000 },
  daily_9am: { type: 'cron', fields: [0, 9, -1, -1, -1] },
  evening_8pm: { type: 'cron', fields: [0, 20, -1, -1, -1] },
};

/** Parse supported fixed aliases or simple five-field cron expressions. */
export function parseSchedule(cron: string): ParsedSchedule {
  const normalized = String(cron || '').trim();
  const alias = SCHEDULE_ALIASES[normalized];
  if (alias) {
    return alias.type === 'interval'
      ? { ...alias }
      : { ...alias, fields: [...alias.fields] };
  }

  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported schedule expression: "${normalized}"`);
  }

  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const fields = parts.map((part, index) => {
    if (part === '*') return -1;
    if (!/^\d+$/.test(part)) {
      throw new Error(`Unsupported cron field "${part}" in "${normalized}"`);
    }
    const value = Number(part);
    const [min, max] = ranges[index];
    if (value < min || value > max) {
      throw new Error(`Cron field "${part}" is out of range in "${normalized}"`);
    }
    return value;
  });
  return { type: 'cron', fields };
}

/** Compute milliseconds until the next cron match */
export function nextCronTime(fields: number[]): number {
    const [minute, hour, dom, month, dow] = fields;
    const now = new Date();
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);

    // Try up to 366 days ahead (cover a full year)
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const m = next.getMinutes();
      const h = next.getHours();
      const d = next.getDate();
      const mo = next.getMonth() + 1;
      const w = next.getDay();

      const mMatch = minute < 0 || m === minute;
      const hMatch = hour < 0 || h === hour;
      const domMatch = dom < 0 || d === dom;
      const monMatch = month < 0 || mo === month;
      const dowMatch = dow < 0 || w === dow;

      if (mMatch && hMatch && domMatch && monMatch && dowMatch) {
        const ms = next.getTime() - now.getTime();
        return Math.max(1000, ms); // Minimum 1 second
      }

      next = new Date(next.getTime() + 60000); // +1 minute
    }

    return 60 * 60 * 1000; // Fallback: 1 hour
  }
