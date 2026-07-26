/**
 * Safety gate for autonomous work — controls when and how Lumi can work independently.
 * Gates: time-of-day, user-idle requirement, token budget, quiet hours.
 */
import { readDB, writeDB } from '../../db_layer';
import { isRealtimeUserActive } from './foreground_activity';

export type AutonomyLevel = 'reactive' | 'semi' | 'full';

export interface SafetyGateConfig {
  autonomyLevel: AutonomyLevel;
  alwaysOnline: boolean;
  autoProcessEnabled: boolean;
  messagingSendRequiresConfirmation: boolean;
  maxConsecutiveTasks: number;
  allowedHours: { start: number; end: number }[];  // e.g. [{start:9, end:18}]
  requireIdle: boolean;
  minIdleSeconds: number;      // default 120 (2 min)
  maxTokensPerHour: number;    // default 2000
  quietHoursEnabled: boolean;
  quietHoursStart: number;     // 0-23
  quietHoursEnd: number;       // 0-23
}

const DEFAULT_CONFIG: SafetyGateConfig = {
  autonomyLevel: 'semi',
  alwaysOnline: true,
  autoProcessEnabled: true,
  messagingSendRequiresConfirmation: false,
  maxConsecutiveTasks: 6,
  allowedHours: [{ start: 0, end: 24 }],
  requireIdle: false,
  minIdleSeconds: 0,
  maxTokensPerHour: 30000,
  quietHoursEnabled: false,
  quietHoursStart: 22,
  quietHoursEnd: 8,
};

const AUTONOMY_LEVEL_PRESETS: Record<AutonomyLevel, Partial<SafetyGateConfig>> = {
  reactive: {
    autonomyLevel: 'reactive',
    alwaysOnline: true,
    autoProcessEnabled: false,
    messagingSendRequiresConfirmation: true,
    maxConsecutiveTasks: 1,
    allowedHours: [{ start: 8, end: 22 }],
    requireIdle: true,
    minIdleSeconds: 120,
    maxTokensPerHour: 3000,
  },
  semi: {
    autonomyLevel: 'semi',
    alwaysOnline: true,
    autoProcessEnabled: true,
    messagingSendRequiresConfirmation: false,
    maxConsecutiveTasks: 6,
    allowedHours: [{ start: 0, end: 24 }],
    requireIdle: false,
    minIdleSeconds: 0,
    maxTokensPerHour: 30000,
  },
  full: {
    autonomyLevel: 'full',
    alwaysOnline: true,
    autoProcessEnabled: true,
    messagingSendRequiresConfirmation: false,
    maxConsecutiveTasks: 25,
    allowedHours: [{ start: 0, end: 24 }],
    requireIdle: false,
    minIdleSeconds: 0,
    maxTokensPerHour: 250000,
  },
};

const DB_KEY = 'autonomy_gate_config';

const configs = new Map<string, SafetyGateConfig>();
const userTokensThisHour = new Map<string, { hour: number; tokens: number }>();
const userLastIdle = new Map<string, { idleSeconds: number; timestamp: number }>();

function configScope(userId?: string): string {
  return String(userId || '').trim() || '__default__';
}

function configDbKey(userId?: string): string {
  const normalized = String(userId || '').trim();
  return normalized ? `${DB_KEY}:${normalized}` : DB_KEY;
}

export function loadGateConfig(userId?: string): SafetyGateConfig {
  const scope = configScope(userId);
  let config = { ...DEFAULT_CONFIG };
  try {
    const db = readDB();
    const settings = db.settings || [];
    const setting = settings.find((s: any) => s.key === configDbKey(userId))
      || (userId ? settings.find((s: any) => s.key === DB_KEY) : undefined);
    if (setting?.value) {
      config = normalizeGateConfig(JSON.parse(setting.value));
    }
  } catch {}
  configs.set(scope, config);
  return { ...config };
}

export function getGateConfig(userId?: string): SafetyGateConfig {
  const scope = configScope(userId);
  return { ...(configs.get(scope) || loadGateConfig(userId)) };
}

export function saveGateConfig(partial: Partial<SafetyGateConfig>, userId?: string): SafetyGateConfig {
  const current = getGateConfig(userId);
  const level = normalizeAutonomyLevel(partial.autonomyLevel);
  const patch = level ? { ...AUTONOMY_LEVEL_PRESETS[level], ...partial, autonomyLevel: level } : partial;
  const config = normalizeGateConfig({ ...current, ...patch });
  configs.set(configScope(userId), config);
  const db = readDB();
  const key = configDbKey(userId);
  let setting = (db.settings || []).find((s: any) => s.key === key);
  const value = JSON.stringify(config);
  if (setting) {
    setting.value = value;
  } else {
    if (!db.settings) db.settings = [];
    db.settings.push({ key, value });
  }
  writeDB(db);
  return { ...config };
}

function normalizeGateConfig(input: Partial<SafetyGateConfig>): SafetyGateConfig {
  const supportedInput = {
    ...(input as Partial<SafetyGateConfig> & { externalAppAutomationEnabled?: boolean }),
  };
  // Drop the removed global external-app switch when loading old configs.
  delete supportedInput.externalAppAutomationEnabled;
  const next = { ...DEFAULT_CONFIG, ...supportedInput };
  const explicitLevel = normalizeAutonomyLevel(input.autonomyLevel);
  const hasLegacyShape =
    Object.prototype.hasOwnProperty.call(input, 'autoProcessEnabled') ||
    Object.prototype.hasOwnProperty.call(input, 'requireIdle') ||
    Object.prototype.hasOwnProperty.call(input, 'allowedHours');
  next.autonomyLevel = explicitLevel || (hasLegacyShape ? deriveAutonomyLevel(next) : DEFAULT_CONFIG.autonomyLevel);
  next.allowedHours = Array.isArray(next.allowedHours) && next.allowedHours.length > 0
    ? next.allowedHours
        .map(range => ({
          start: Math.max(0, Math.min(23, Number(range?.start) || 0)),
          end: Math.max(0, Math.min(24, Number(range?.end) || 24)),
        }))
        .filter(range => range.end > range.start)
    : DEFAULT_CONFIG.allowedHours;
  next.minIdleSeconds = Math.max(0, Math.min(3600, Number(next.minIdleSeconds) || DEFAULT_CONFIG.minIdleSeconds));
  next.maxTokensPerHour = Math.max(100, Math.min(250000, Number(next.maxTokensPerHour) || DEFAULT_CONFIG.maxTokensPerHour));
  next.maxConsecutiveTasks = Math.max(1, Math.min(50, Number(next.maxConsecutiveTasks) || DEFAULT_CONFIG.maxConsecutiveTasks));
  next.alwaysOnline = Boolean(next.alwaysOnline);
  next.autoProcessEnabled = Boolean(next.autoProcessEnabled);
  next.messagingSendRequiresConfirmation = next.messagingSendRequiresConfirmation !== false;
  next.requireIdle = Boolean(next.requireIdle);
  next.quietHoursEnabled = Boolean(next.quietHoursEnabled);
  next.quietHoursStart = Math.max(0, Math.min(23, Number(next.quietHoursStart) || DEFAULT_CONFIG.quietHoursStart));
  next.quietHoursEnd = Math.max(0, Math.min(23, Number(next.quietHoursEnd) || DEFAULT_CONFIG.quietHoursEnd));
  return next;
}

function normalizeAutonomyLevel(value: any): AutonomyLevel | null {
  return value === 'reactive' || value === 'semi' || value === 'full' ? value : null;
}

export function autonomyLevelForOperationMode(mode: string): AutonomyLevel | null {
  if (mode === 'chat') return 'reactive';
  if (mode === 'assistant') return 'semi';
  if (mode === 'autonomous') return 'full';
  return null;
}

function deriveAutonomyLevel(input: Partial<SafetyGateConfig>): AutonomyLevel {
  if (!input.autoProcessEnabled) return 'reactive';
  if (input.requireIdle === false && input.allowedHours?.length === 1 && input.allowedHours[0]?.start === 0 && input.allowedHours[0]?.end === 24) {
    return 'full';
  }
  return 'semi';
}

/** Called from ambient poller socket handler to record latest idle state */
export function reportIdleState(userId: string, idleSeconds: number) {
  userLastIdle.set(userId, { idleSeconds, timestamp: Date.now() });
}

export function getRecentIdleState(userId: string): { idleSeconds: number; timestamp: number; ageSeconds: number } | null {
  const idle = userLastIdle.get(userId);
  if (!idle) return null;
  return {
    ...idle,
    ageSeconds: Math.round((Date.now() - idle.timestamp) / 1000),
  };
}

/** Check if autonomous work is currently allowed for this user */
export function isAutonomousWorkAllowed(userId?: string): { allowed: boolean; reason?: string } {
  const cfg = getGateConfig(userId);
  const now = new Date();
  const hour = now.getHours();

  if (userId && isRealtimeUserActive(userId)) {
    return { allowed: false, reason: 'Live user voice session has priority over background autonomy' };
  }

  if (!cfg.alwaysOnline) {
    return { allowed: false, reason: 'Always Online is disabled' };
  }

  if (cfg.autonomyLevel === 'reactive' || !cfg.autoProcessEnabled) {
    return { allowed: false, reason: 'Autonomous level is reactive; automatic processing is disabled' };
  }

  if (cfg.autonomyLevel === 'full') {
    return { allowed: true };
  }

  // 1. Time-of-day gate
  const inAllowedHours = cfg.allowedHours.some(
    range => hour >= range.start && hour < range.end,
  );
  if (!inAllowedHours) {
    return { allowed: false, reason: `Current hour (${hour}) is outside allowed ranges` };
  }

  // 2. Quiet hours — suppress proactive notifications, not work itself
  // (quiet hours don't block work, they just suppress notifications — handled elsewhere)

  // 3. Idle gate
  if (cfg.requireIdle && userId) {
    const idle = userLastIdle.get(userId);
    if (!idle || Date.now() - idle.timestamp > 60000) {
      return { allowed: false, reason: 'No recent idle data from client' };
    }
    if (idle.idleSeconds < cfg.minIdleSeconds) {
      return { allowed: false, reason: `User active (idle ${idle.idleSeconds}s < ${cfg.minIdleSeconds}s required)` };
    }
  }

  // 4. Token budget
  if (userId) {
    const entry = userTokensThisHour.get(userId);
    if (entry && entry.hour === hour && entry.tokens >= cfg.maxTokensPerHour) {
      return { allowed: false, reason: `Token budget exhausted (${entry.tokens}/${cfg.maxTokensPerHour})` };
    }
  }

  return { allowed: true };
}

export function isMessagingSendConfirmationRequired(userId?: string): boolean {
  return getGateConfig(userId).messagingSendRequiresConfirmation !== false;
}

/** Record token usage for budget tracking */
export function recordAutonomousTokens(userId: string, tokens: number) {
  const hour = new Date().getHours();
  const entry = userTokensThisHour.get(userId);
  if (!entry || entry.hour !== hour) {
    userTokensThisHour.set(userId, { hour, tokens });
  } else {
    entry.tokens += tokens;
  }
}

// Load config on import
loadGateConfig();
