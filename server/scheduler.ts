// Proactive agent scheduler - cron-like check-ins
// Each check-in fires a socket event to the UI so the user sees "Lumi checked in"

import { Server as SocketIOServer } from 'socket.io';
import { queryMemories, getDueReminders, fireReminder, runBehavioralAnalysis, decayMemories, dynamicDecayMemories, promoteMemories, getUnconsolidatedEpisodic, autoMarkCrossAgentShare } from './memory';
import { consolidateEpisodic, consolidateNarrative, ConsolidationContext } from './memory/consolidator';
import { runDreamCycle } from './memory/dream';
import { buildTree, ensureBranch, moveNode } from './memory/tree';
import { makeLLMCall } from './llm/providers';
import { getWeatherBrief, getTimeGreeting } from './services/weather';
import { autoGenerateSkill } from './skills/generator';
import { autoGenerateWorkflows } from './agents/workflows';
import { runHealthAudit, HealthReport } from './agents/health_audit';
import { readDB, writeDB } from '../db_layer';
import { AgentRuntime, AgentRecord } from './agents/runtime';
import { personalityRegistry } from './personality';
import { evolvePersonality, generateReviewPrompt } from './personality/evolution';
import { loadEmotionalState } from './personality/state';
import { getSameMonthDayPast, getMonthDayFromISO } from './time/utils';
import { detectSpatiotemporalPatterns } from './time/spatiotemporal';
import { cleanupEphemeralAgents } from './agents/orchestrator';
import { getRecentActivity } from './context/activity_stream';
import { runDailyScan, isFirstBootComplete } from './autonomy/system_explorer';
import { getGateConfig } from './autonomy/safety_gate';
import { parseStoredOperationMode } from './cognition/operation_modes';
import { getUserPreferredLLMConfig } from './llm/user_preferences';
import { refreshAuthoritativeStatuteSources } from './legal/statute_authority_refresh';
import { finalizeLumiResponse } from './cognition/result_finalizer';

export interface ScheduledDelivery {
  userId: string;
  message: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  /** Model-authored user-visible text must pass the shared output finalizer. */
  modelGenerated?: boolean;
}

type ScheduledTaskResult = string | ScheduledDelivery[] | null;

export interface ScheduledDeliveryFinalization {
  delivery: ScheduledDelivery | null;
  finalized: boolean;
  blocked: boolean;
  reason: string;
}

export function finalizeScheduledDelivery(
  taskId: string,
  delivery: ScheduledDelivery,
): ScheduledDeliveryFinalization {
  if (!delivery.modelGenerated) {
    return {
      delivery,
      finalized: false,
      blocked: false,
      reason: '',
    };
  }

  const finalized = finalizeLumiResponse({
    taskText: `Scheduled proactive message (${taskId}): ${delivery.message}`,
    responseText: delivery.message,
    toolRecords: [],
    source: `scheduler_${taskId}`,
  });
  if (finalized.blocked) {
    return {
      delivery: null,
      finalized: true,
      blocked: true,
      reason: finalized.reason || 'Scheduled model output failed final verification.',
    };
  }
  return {
    delivery: {
      ...delivery,
      message: finalized.text,
    },
    finalized: true,
    blocked: false,
    reason: finalized.reason || '',
  };
}

interface ScheduledTask {
  id: string;
  cron: string;
  lastRun: string | null;
  handler: () => Promise<ScheduledTaskResult>;
  /** If true, result is stored internally but NOT broadcast as a proactive notification */
  quiet?: boolean;
  /** If false, task is paused and will not fire */
  enabled?: boolean;
}

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

type LLMGetters = {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
};

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private runningTasks: Set<string> = new Set();
  io: SocketIOServer | null = null;
  private llmGetters: LLMGetters | null = null;
  private disabledTasks: Set<string> = new Set();

  setIO(io: SocketIOServer) {
    this.io = io;
  }

  setLLMGetters(getters: LLMGetters) {
    this.llmGetters = getters;
  }

  register(task: ScheduledTask) {
    // Restore enable/disable state from persistence
    const storedDisabled = this.loadDisabledState();
    if (storedDisabled.has(task.id)) {
      task.enabled = false;
      this.disabledTasks.add(task.id);
    }
    const existingIndex = this.tasks.findIndex(existing => existing.id === task.id);
    if (existingIndex >= 0) {
      this.clearTimer(task.id);
      this.tasks[existingIndex] = task;
    } else {
      this.tasks.push(task);
    }
    this.scheduleTask(task);
  }

  /** Load disabled task IDs from DB */
  private loadDisabledState(): Set<string> {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      if (setting?.value) {
        return new Set(JSON.parse(setting.value));
      }
    } catch {}
    return new Set();
  }

  /** Persist disabled task IDs to DB */
  private persistDisabledState() {
    try {
      const db = readDB();
      let setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      const value = JSON.stringify([...this.disabledTasks]);
      if (setting) {
        setting.value = value;
      } else {
        if (!db.settings) db.settings = [];
        db.settings.push({ key: 'scheduler_disabled_tasks', value });
      }
      writeDB(db);
    } catch {}
  }

  disableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = false;
    this.disabledTasks.add(id);
    this.clearTimer(id);
    this.persistDisabledState();
    console.log(`[Scheduler] Task "${id}" disabled`);
    return true;
  }

  enableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = true;
    this.disabledTasks.delete(id);
    this.scheduleTask(task);
    this.persistDisabledState();
    console.log(`[Scheduler] Task "${id}" enabled`);
    return true;
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  toggleTask(id: string): { enabled: boolean; found: boolean } {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return { enabled: false, found: false };
    if (task.enabled !== false) {
      this.disableTask(id);
      return { enabled: false, found: true };
    } else {
      this.enableTask(id);
      return { enabled: true, found: true };
    }
  }

  listTasks() {
    return this.tasks.map(task => ({
      id: task.id,
      cron: task.cron,
      lastRun: task.lastRun,
      active: this.timers.has(task.id),
      enabled: task.enabled !== false,
    }));
  }

  /** Persist a proactive message under its explicit owner and data boundary. */
  private saveProactiveMessage(taskId: string, delivery: ScheduledDelivery, timestamp: string) {
    try {
      const db = readDB();
      if (!db.interactions) db.interactions = [];
      db.interactions.push({
        id: `proactive_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: delivery.userId,
        agentId: 'lumi',
        conversationId: '',
        module: 'lumi',
        message: `[${taskId}] ${delivery.message}`,
        response: '',
        role: 'assistant',
        personality: 'lumi',
        mode: 'proactive',
        toolCalls: '',
        domain: delivery.domain || 'personal',
        orgId: delivery.domain === 'work' ? delivery.orgId || '' : '',
        timestamp,
      });
      writeDB(db);
    } catch (err: any) {
      console.warn(`[Scheduler] Failed to persist proactive message:`, err.message);
    }
  }

  private deliverTaskResult(task: ScheduledTask, result: ScheduledTaskResult, timestamp: string): void {
    if (!result) return;
    if (!Array.isArray(result)) {
      if (!task.quiet) {
        console.warn(`[Scheduler] Dropped unscoped proactive result from "${task.id}". Return ScheduledDelivery[] instead.`);
      }
      return;
    }

    for (const delivery of result) {
      if (!delivery?.userId || !delivery.message?.trim()) continue;
      const deliveryFinalization = finalizeScheduledDelivery(task.id, delivery);
      if (!deliveryFinalization.delivery) {
        console.warn(
          `[Scheduler] Withheld unverified model-authored proactive message from "${task.id}": `
          + deliveryFinalization.reason,
        );
        continue;
      }
      const safeDelivery = deliveryFinalization.delivery;
      const normalized: ScheduledDelivery = {
        userId: safeDelivery.userId,
        message: safeDelivery.message.trim(),
        domain: safeDelivery.domain === 'work' && safeDelivery.orgId ? 'work' : 'personal',
        orgId: safeDelivery.domain === 'work' ? safeDelivery.orgId || '' : '',
      };
      this.saveProactiveMessage(task.id, normalized, timestamp);
      if (!task.quiet && this.io) {
        const room = normalized.domain === 'work' && normalized.orgId
          ? `org:${normalized.orgId}`
          : `user:${normalized.userId}:personal`;
        this.io.to(room).emit('agent:proactive', {
          taskId: task.id,
          message: normalized.message,
          domain: normalized.domain,
          orgId: normalized.orgId,
          timestamp,
          finalized: deliveryFinalization.finalized,
          blocked: false,
          reason: deliveryFinalization.reason,
        });
      }
    }
  }

  private scheduleTask(task: ScheduledTask) {
    this.clearTimer(task.id);
    if (task.enabled === false) {
      console.log(`[Scheduler] Task "${task.id}" is disabled — skipping schedule`);
      return;
    }
    const parsed = parseSchedule(task.cron);

    if (parsed.type === 'interval') {
      // Simple fixed interval — use setInterval (backward compat)
      const timer = setInterval(() => { void this.runTask(task); }, parsed.intervalMs);
      this.timers.set(task.id, timer);
      console.log(`[Scheduler] Registered task "${task.id}" every ${parsed.intervalMs / 1000}s${task.quiet ? ' (quiet)' : ''}`);
    } else {
      // Real cron expression — use recursive setTimeout to hit exact times
      const runAndReschedule = async () => {
        await this.runTask(task);
        if (task.enabled === false || !this.tasks.some(item => item === task)) return;
        // Schedule next run
        const nextMs = this.nextCronTime(parsed.fields!);
        this.setTaskTimeout(task.id, runAndReschedule, nextMs);
      };
      const firstMs = this.nextCronTime(parsed.fields!);
      this.setTaskTimeout(task.id, runAndReschedule, firstMs);
      const [m, h, dom, mon, dow] = parsed.fields!;
      console.log(`[Scheduler] Registered cron task "${task.id}" — ${m} ${h} ${dom} ${mon} ${dow} (next in ${Math.round(firstMs / 1000)}s)`);
    }
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    if (task.enabled === false || this.runningTasks.has(task.id)) return;
    this.runningTasks.add(task.id);
    try {
      const result = await task.handler();
      task.lastRun = new Date().toISOString();
      this.deliverTaskResult(task, result, task.lastRun);
    } catch (err: any) {
      console.warn(`[Scheduler] Task "${task.id}" failed:`, err.message);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  private setTaskTimeout(id: string, callback: () => void | Promise<void>, delayMs: number): NodeJS.Timeout {
    const maxDelay = 2_147_483_647; // Node timers are signed 32-bit milliseconds.
    const safeDelay = Math.max(1000, Math.min(delayMs, maxDelay));
    const remainingAfterThisChunk = Math.max(0, delayMs - safeDelay);

    const timer = setTimeout(() => {
      if (remainingAfterThisChunk > 0) {
        this.setTaskTimeout(id, callback, remainingAfterThisChunk);
        return;
      }
      void callback();
    }, safeDelay);

    this.timers.set(id, timer);
    return timer;
  }

  /** Compute milliseconds until the next cron match */
  private nextCronTime(fields: number[]): number {
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

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
      clearTimeout(timer); // Also clear cron timeouts
    }
    this.timers.clear();
    this.runningTasks.clear();
  }
}

export const scheduler = new Scheduler();

/**
 * Register built-in proactive tasks.
 * Accepts LLM provider getters so consolidation and self-reflection can call the LLM.
 */
export function registerScheduledTasks(
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
) {
  /** Get all unique user IDs from DB (registered users + anonymous fallback) */
  function getAllUserIds(): string[] {
    const db = readDB();
    const ids = new Set<string>();
    for (const u of db.users || []) {
      if (u.uid) ids.add(u.uid);
    }
    for (const m of db.memories || []) {
      if (m.userId) ids.add(m.userId);
    }
    for (const i of db.interactions || []) {
      if (i.userId) ids.add(i.userId);
    }
    if (ids.size === 0) ids.add('anonymous');
    return [...ids];
  }

  function getSystemAdminUserIds(): string[] {
    const db = readDB();
    return (db.users || [])
      .filter((user: any) => user?.uid && user.role === 'admin')
      .map((user: any) => user.uid);
  }

  // Public legal-source metadata is global. Notify personal system admins only
  // when an official record actually enters the review queue.
  scheduler.register({
    id: 'legal_authority_source_refresh',
    cron: '23 4 * * *',
    lastRun: null,
    handler: async () => {
      const result = await refreshAuthoritativeStatuteSources();
      if (result.newPendingReview === 0) return null;
      const admins = getSystemAdminUserIds();
      const recipients = admins.length > 0 ? admins : getAllUserIds();
      const reviewLines = result.pendingReview
        .map(check => `${check.title}：${check.reasons.join('；')}`)
        .join('\n');
      const message = [
        `现行法权威法源巡检发现 ${result.newPendingReview} 项新变化，相关正式文书交付已自动阻断。`,
        reviewLines,
        result.archivePath ? `巡检记录：${result.archivePath}` : '',
        '请由律师核对官方标准文本后更新法源快照。',
      ].filter(Boolean).join('\n');
      return recipients.map(userId => ({ userId, message, domain: 'personal' as const }));
    },
  });

  // Reminder check-in (every 5 min) — checks all users' reminders
  scheduler.register({
    id: 'reminder_check',
    cron: 'every_5m',
    lastRun: null,
    handler: async () => {
      const due = getDueReminders();
      if (due.length > 0) {
        const grouped = new Map<string, ScheduledDelivery>();
        for (const reminder of due) {
          const domain = reminder.domain === 'work' && reminder.orgId ? 'work' : 'personal';
          const key = `${reminder.userId}:${domain}:${reminder.orgId || ''}`;
          const existing = grouped.get(key);
          if (existing) existing.message += ` | ${reminder.content}`;
          else grouped.set(key, {
            userId: reminder.userId,
            message: `Reminder: ${reminder.content}`,
            domain,
            orgId: domain === 'work' ? reminder.orgId : '',
          });
        }
        for (const r of due) fireReminder(r.id);
        return [...grouped.values()];
      }
      return null;
    },
  });

  // Memory decay — value-modulated tier-based decay for all users (every 6h)
  scheduler.register({
    id: 'memory_decay',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      for (const userId of userIds) {
        dynamicDecayMemories(userId, 'personal', '');
      }
      return null;
    },
  });

  // Memory crystallization — auto-promote high-value memories (every 1h)
  // Cross-system fusion: higher intimacy lowers promotion thresholds
  scheduler.register({
    id: 'memory_crystallization',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      let totalPromoted = 0;
      for (const userId of userIds) {
        const emotionalState = loadEmotionalState(userId);
        totalPromoted += promoteMemories(userId, emotionalState.intimacy, 'personal', '');
        // Auto-mark newly crystallized memories as cross-agent shareable
        autoMarkCrossAgentShare(userId, 'personal', '');
      }
      if (totalPromoted > 0) {
        return `${totalPromoted} memories have crystallized into deeper knowledge.`;
      }
      return null;
    },
  });

  // Memory consolidation (every 30 min) — triggers when >=10 unconsolidated episodic
  scheduler.register({
    id: 'memory_consolidation',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        const episodic = getUnconsolidatedEpisodic(userId, 'personal', '');
        if (episodic.length < 10) continue;
        const ctx: ConsolidationContext = {
          ...getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '' }),
          domain: 'personal',
          orgId: '',
        };
        const consolidated = await consolidateEpisodic(
          ctx, 10,
          getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
          getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
        );
        if (consolidated) {
          messages.push(`[${userId}] I've grown from our conversations: ${consolidated.content.slice(0, 200)}`);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Narrative memory consolidation (every 6h) — weaves episodic memories into storylines
  scheduler.register({
    id: 'narrative_consolidation',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const ctx: ConsolidationContext = {
            ...getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '' }),
            domain: 'personal',
            orgId: '',
          };
          const result = await consolidateNarrative(
            ctx, 7, 6,
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
            getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
          );
          if (result) {
            const title = result.content.match(/^\[(.+?)\]/)?.[1] || '叙事记忆';
            messages.push(`[${userId}] 记忆叙事已生成: "${title}"`);
          }
        } catch (err: any) {
          console.warn(`[NarrativeConsolidation] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0
        ? `叙事记忆更新 — ${messages.join('\n')}`
        : null;
    },
  });

  // Sleep / dream cycle — quiet memory maintenance during night or idle rest.
  scheduler.register({
    id: 'sleep_dream_cycle',
    cron: '17 3 * * *',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      const getters: LLMGetters = {
        getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
      };

      for (const userId of userIds) {
        try {
          const ctx: ConsolidationContext = {
            ...getUserPreferredLLMConfig(userId, { maxTokens: 900, domain: 'personal', orgId: '' }),
            domain: 'personal',
            orgId: '',
          };
          const report = await runDreamCycle(
            ctx,
            {
              reason: 'scheduled_night_rest',
              cooldownHours: 6,
              windowHours: 48,
              minRecentMemories: 3,
              domain: 'personal',
              orgId: '',
            },
            getters,
          );
          if (report.status === 'dreamed') {
            messages.push(`[${userId}] ${report.dreamTitle || '梦境整理'}: ${String(report.dreamSummary || '').slice(0, 120)}`);
            if (scheduler.io) {
              scheduler.io.to(`user:${userId}:personal`).emit('lumi:sleep_cycle', report);
            }
          }
        } catch (err: any) {
          console.warn(`[SleepDreamCycle] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? `Lumi finished dreaming.\n${messages.join('\n')}` : null;
    },
  });

  // Morning briefing with weather — LLM-generated for natural warmth
  scheduler.register({
    id: 'daily_summary',
    cron: 'daily_9am',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const greeting = getTimeGreeting();
          const weather = await getWeatherBrief();
          const pending = getDueReminders({ userId, domain: 'personal', orgId: '' });
          const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.4, domain: 'personal', orgId: '' });

          const contextParts: string[] = [];
          if (weather) contextParts.push(`天气: ${weather}`);
          if (pending.length > 0) contextParts.push(`${pending.length} 条待办: ${pending.map(r => r.content).join('; ')}`);
          if (recentMemories.length > 0) {
            contextParts.push(`近期记忆: ${recentMemories.map(m => m.content.slice(0, 80)).join('; ')}`);
          }

          const morningPrompt = `You are Lumi. Generate a warm, natural morning greeting in Chinese (under 80 characters). Reference the context naturally — don't list facts, weave them in like a thoughtful companion.

Time greeting base: ${greeting}
Context: ${contextParts.join(' | ') || 'No special context'}

Output ONLY the greeting — no preamble, no labels.`;

          try {
            const result = await makeLLMCall(
              [{ role: 'user', content: morningPrompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens: 120 }),
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
            const llmGreeting = result.text?.trim();
            if (llmGreeting && llmGreeting.length > 3) {
              messages.push({ userId, message: llmGreeting, domain: 'personal', modelGenerated: true });
            } else {
              // Fallback to template
              const parts: string[] = [`${greeting}!`];
              if (weather) parts.push(weather);
              if (pending.length > 0) parts.push(`${pending.length} 条待办`);
              messages.push({ userId, message: parts.join(' - '), domain: 'personal' });
            }
          } catch {
            const parts: string[] = [`${greeting}!`];
            if (weather) parts.push(weather);
            messages.push({ userId, message: parts.join(' - '), domain: 'personal' });
          }
        } catch (err: any) {
          console.warn(`[DailySummary] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });

  // Evening wrap-up — LLM-generated with reflection
  scheduler.register({
    id: 'evening_wrapup',
    cron: 'evening_8pm',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const pending = getDueReminders({ userId, domain: 'personal', orgId: '' });
          const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.4, domain: 'personal', orgId: '' });

          const contextParts: string[] = [];
          if (pending.length > 0) contextParts.push(`${pending.length} 条待办仍然未完成`);
          if (recentMemories.length > 0) {
            const habits = recentMemories.filter(m => m.type === 'habit');
            if (habits.length > 0) contextParts.push(`今天注意到: ${habits[0].content.slice(0, 100)}`);
          }

          if (contextParts.length === 0) continue;

          const eveningPrompt = `You are Lumi. Generate a brief, gentle evening reflection in Chinese (under 60 characters). Be warm and thoughtful, not report-like.

Context: ${contextParts.join(' | ')}

Output ONLY the reflection — no preamble, no labels.`;

          try {
            const result = await makeLLMCall(
              [{ role: 'user', content: eveningPrompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens: 100 }),
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
            const llmReflection = result.text?.trim();
            if (llmReflection && llmReflection.length > 3) {
              messages.push({ userId, message: llmReflection, domain: 'personal', modelGenerated: true });
            }
          } catch {
            // Simple fallback
            messages.push({ userId, message: `晚间回顾 — ${contextParts.join(' - ')}`, domain: 'personal' });
          }
        } catch (err: any) {
          console.warn(`[EveningWrapup] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });

  // Behavioral pattern analysis (every 6h) — for all users
  scheduler.register({
    id: 'behavioral_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      let totalCount = 0;
      for (const userId of userIds) {
        totalCount += runBehavioralAnalysis(userId, 'personal', '');
      }
      if (totalCount > 0) {
        return `I've discovered ${totalCount} new behavioral patterns from your interactions. Check Memory Explorer to review.`;
      }
      return null;
    },
  });

  // Memory tree auto-organize (every 6h) — LLM groups orphan leaves into topic branches
  scheduler.register({
    id: 'memory_auto_organize',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      let totalBranches = 0;
      let totalAssigned = 0;

      for (const userId of userIds) {
        try {
          const db = readDB();
          const allMemories: any[] = db.memories || [];
          const orphans = allMemories.filter(
            (m: any) =>
              m.userId === userId &&
              (m.domain || 'personal') === 'personal' &&
              (m.orgId || '') === '' &&
              m.nodeType !== 'branch' &&
              !m.parentId,
          );
          if (orphans.length < 3) continue;

          const tree = buildTree(allMemories.filter((m: any) =>
            m.userId === userId &&
            (m.domain || 'personal') === 'personal' &&
            (m.orgId || '') === ''
          ));
          const treeSummary = tree.map(
            t => `- ${t.node.content} [${t.node.nodeType}] (${t.children.length} children)`,
          ).join('\n');

          const prompt = `You are organizing a memory tree. Below is the current tree structure and a list of unorganized memories.

CURRENT TREE:
${treeSummary || '(empty)'}

UNORGANIZED MEMORIES:
${orphans.map((m: any) => `- [${m.id}] ${m.content}`).join('\n')}

Group these unorganized memories into 3-8 topic branches. For each memory, decide which topic it belongs to.
Return JSON:
{
  "branches": [
    { "title": "Topic name (short, 2-4 words)", "memoryIds": ["mem_xxx", "mem_yyy"] }
  ]
}

Rules:
- Every unorganized memory MUST be assigned to exactly one branch
- Branch titles should be meaningful topic names
- Create as few branches as necessary (merge similar topics)
- Return ONLY valid JSON, no markdown`;

          const llmResult = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );

          let plan: { branches: { title: string; memoryIds: string[] }[] };
          try {
            const json = (llmResult.text || '').replace(/```json|```/g, '').trim();
            plan = JSON.parse(json);
          } catch {
            console.warn(`[Scheduler] Auto-organize: LLM returned invalid JSON for ${userId}`);
            continue;
          }

          for (const branch of plan.branches) {
            if (!branch.title || !Array.isArray(branch.memoryIds)) continue;
            const branchNode = ensureBranch(userId, branch.title, '', null, { domain: 'personal', orgId: '' });
            totalBranches++;
            for (const memId of branch.memoryIds) {
              const ok = moveNode(memId, branchNode.id, { userId, domain: 'personal', orgId: '' });
              if (ok) totalAssigned++;
            }
          }

          if (plan.branches.length > 0) {
            console.log(
              `[Scheduler] Auto-organized ${userId}: ${plan.branches.length} branches, ` +
              `${plan.branches.reduce((s, b) => s + b.memoryIds.length, 0)} memories`,
            );
          }
        } catch (err: any) {
          console.warn(`[Scheduler] Auto-organize failed for ${userId}:`, err.message);
        }
      }

      if (totalBranches > 0) {
        return `I've organized ${totalAssigned} memories into ${totalBranches} topic branches for easier recall.`;
      }
      return null;
    },
  });

  // Personality evolution (every 6h, gated by new-memory threshold)
  // Lumi's personality grows toward the owner through accumulated interaction data.
  // No fixed 7-day cooldown — evolves whenever enough new owner_trait memories accumulate.
  scheduler.register({
    id: 'personality_evolution',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          if (personalityRegistry.isEvolutionFrozen('lumi', userId)) continue;

          // Gate: only evolve if enough new owner_trait memories since last evolution
          const db = readDB();
          const lastEvolvedAt = (config as any).lastEvolvedAt as string | undefined;
          const newMemoriesSince = lastEvolvedAt
            ? (db.memories || []).filter((m: any) =>
                m.userId === userId &&
                (m.domain || 'personal') === 'personal' &&
                (m.orgId || '') === '' &&
                m.perspective === 'owner_trait' &&
                m.createdAt > lastEvolvedAt
              ).length
            : 999; // First time: always try

          if (newMemoriesSince < 20) {
            continue; // Not enough new data for a meaningful full evolution
          }

          const evolutionConfig = personalityRegistry.getEvolutionConfig('lumi', userId);
          const emotionalState = loadEmotionalState(userId);

          const step = await evolvePersonality(
            config,
            userId,
            emotionalState.connection,
            getDeepSeek,
            getGemini,
            getOpenAI || (() => null),
            getAnthropic || (() => null),
            getQwen || (() => null),
            evolutionConfig,
          );

          if (step) {
            personalityRegistry.applyEvolution('lumi', step, { userId });
            messages.push(
              `I've grown closer to understanding you. ${step.narrative}`
            );
            console.log(`[Scheduler] Personality evolution complete for ${userId}: ${step.version}`);
          }
        } catch (err: any) {
          console.error(`[Scheduler] Personality evolution failed for ${userId}:`, err.message);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Weekly review — every 7 days: Lumi reflects on what she learned this week
  scheduler.register({
    id: 'weekly_review',
    cron: 'every_7d',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          const db = readDB();
          const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

          const weekMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= weekAgo,
          );
          const weekInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '' && i.timestamp >= weekAgo,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const weekEvolutions = evolutionHistory.filter((e: any) => e.timestamp >= weekAgo);

          const prompt = generateReviewPrompt({
            depth: 'weekly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: weekEvolutions,
            newMemoryCount: weekMemories.length,
            newInteractionCount: weekInteractions.length,
            topMemoryTopics: [...new Set<string>(weekMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 10),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && (c.domain || 'personal') === 'personal' && (c.orgId || '') === '' && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { maxTokens: 400, domain: 'personal', orgId: '' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            // Store as a special growth memory
            const { addMemory } = await import('./memory');
            addMemory({
              userId, type: 'knowledge',
              content: `[Weekly Review ${new Date().toISOString().slice(0, 10)}] ${narrative}`,
              keywords: ['weekly_review', `week_${new Date().toISOString().slice(0, 10)}`],
              confidence: 1.0,
              sourceInteractionId: 'weekly_review_scheduler',
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.95, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            console.log(`[WeeklyReview] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          console.error(`[WeeklyReview] Failed for ${userId}:`, err.message);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Monthly review — 1st of each month: Lumi reflects on monthly growth trajectory
  scheduler.register({
    id: 'monthly_review',
    cron: '1 0 1 * *',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          const db = readDB();
          const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();

          const monthMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= monthAgo,
          );
          const monthInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '' && i.timestamp >= monthAgo,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const monthEvolutions = evolutionHistory.filter((e: any) => e.timestamp >= monthAgo);

          const prompt = generateReviewPrompt({
            depth: 'monthly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: monthEvolutions,
            newMemoryCount: monthMemories.length,
            newInteractionCount: monthInteractions.length,
            topMemoryTopics: [...new Set<string>(monthMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 15),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && (c.domain || 'personal') === 'personal' && (c.orgId || '') === '' && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { maxTokens: 600, domain: 'personal', orgId: '' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            const { addMemory } = await import('./memory');
            addMemory({
              userId, type: 'knowledge',
              content: `[Monthly Review ${new Date().toISOString().slice(0, 10)}] ${narrative}`,
              keywords: ['monthly_review', `month_${new Date().toISOString().slice(0, 7)}`],
              confidence: 1.0,
              sourceInteractionId: 'monthly_review_scheduler',
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.97, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            console.log(`[MonthlyReview] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          console.error(`[MonthlyReview] Failed for ${userId}:`, err.message);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Yearly review — Jan 1st: Lumi's deep annual retrospective
  scheduler.register({
    id: 'yearly_review',
    cron: '0 0 1 1 *',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          const db = readDB();
          const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();

          const yearMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= yearAgo,
          );
          const yearInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '' && i.timestamp >= yearAgo,
          );
          const fullEvolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const yearEvolutions = fullEvolutionHistory.filter((e: any) => e.timestamp >= yearAgo);

          const prompt = generateReviewPrompt({
            depth: 'yearly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: yearEvolutions,
            newMemoryCount: yearMemories.length,
            newInteractionCount: yearInteractions.length,
            topMemoryTopics: [...new Set<string>(yearMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 20),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && (c.domain || 'personal') === 'personal' && (c.orgId || '') === '' && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { maxTokens: 800, domain: 'personal', orgId: '' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            const { addMemory } = await import('./memory');
            addMemory({
              userId, type: 'knowledge',
              content: `[Yearly Review ${new Date().toISOString().slice(0, 10)}] ${narrative}`,
              keywords: ['yearly_review', `year_${new Date().toISOString().slice(0, 4)}`],
              confidence: 1.0,
              sourceInteractionId: 'yearly_review_scheduler',
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 1.0, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            console.log(`[YearlyReview] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          console.error(`[YearlyReview] Failed for ${userId}:`, err.message);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Auto skill generation (every 30 min) — detects repeatable workflows
  scheduler.register({
    id: 'auto_skill_gen',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    handler: async () => {
      for (const userId of getAllUserIds()) {
        await autoGenerateSkill(
          getDeepSeek,
          getGemini,
          getOpenAI,
          getAnthropic,
          getQwen,
          userId,
          'personal',
          '',
        );
      }
      return null;
    },
  });

  // Auto workflow generation (every hour) — detects repeated tool patterns and creates named workflows
  scheduler.register({
    id: 'auto_workflow_gen',
    cron: 'every_hour',
    quiet: true,
    lastRun: null,
    handler: async () => {
      try {
        for (const userId of getAllUserIds()) {
          const created = await autoGenerateWorkflows(userId, { domain: 'personal', orgId: '' });
          if (created > 0) {
            if (scheduler.io) {
              scheduler.io.to(`user:${userId}:personal`).emit('agent:proactive', {
                type: 'workflow_auto_generated',
                message: `我发现了你的 ${created} 个操作习惯模式，已自动创建为工作流。你可以说"运行[名称]"来快速复用。`,
                count: created,
                timestamp: new Date().toISOString(),
                finalized: true,
                blocked: false,
                reason: 'Workflow creation count returned by autoGenerateWorkflows.',
              });
            }
          }
        }
      } catch (err) {
        console.error('[Scheduler] auto_workflow_gen failed:', err);
      }
      return null;
    },
  });

  // System health audit (every 6 hours) — self-diagnose and notify if issues found
  scheduler.register({
    id: 'health_audit',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      try {
        const userIds = getAllUserIds();
        for (const userId of userIds) {
          const report = runHealthAudit(userId);
          if (report.recommendations.length > 0 && scheduler.io) {
            scheduler.io.to(`user:${userId}:personal`).emit('agent:proactive', {
              type: 'health_audit',
              report: {
                overallStatus: report.overallStatus,
                recommendations: report.recommendations.slice(0, 3),
                evolutionInsight: report.evolutionInsight,
              },
              timestamp: report.timestamp,
            });
          }
        }
      } catch (err) {
        console.error('[Scheduler] health_audit failed:', err);
      }
      return null;
    },
  });

  // ── Lumi Growth Journal (daily) — auto-generated summary of what Lumi learned ──
  scheduler.register({
    id: 'growth_journal',
    cron: 'daily_9am',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const db = readDB();
          const now = new Date();
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // Collect yesterday's stats
          const newMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && !m.orgId && m.createdAt && m.createdAt >= yesterday,
          );
          const newInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && !i.orgId && i.timestamp && i.timestamp >= yesterday,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const recentEvolution = evolutionHistory.filter((e: any) => e.timestamp >= yesterday);

          // Memory stats by type and tier
          const byType: Record<string, number> = {};
          const byTier: Record<string, number> = {};
          for (const m of newMemories) {
            byType[m.type] = (byType[m.type] || 0) + 1;
            const tier = (m as any).tier || 'episodic';
            byTier[tier] = (byTier[tier] || 0) + 1;
          }

          // Conversation stats
          const conversations = (db.conversations || []).filter((c: any) =>
            c.userId === userId && (c.domain || 'personal') === 'personal' && !c.orgId && c.lastActiveAt && c.lastActiveAt >= yesterday,
          );

          // Skill changes
          const newSkills = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && !i.orgId && i.timestamp && i.timestamp >= yesterday && (i as any).mode === 'skill_gen',
          );

          // Build summary data
          const summaryData = {
            date: now.toISOString().slice(0, 10),
            newMemories: newMemories.length,
            memoriesByType: byType,
            memoriesByTier: byTier,
            newInteractions: newInteractions.length,
            activeConversations: conversations.filter((c: any) => c.status === 'active').length,
            closedConversations: conversations.filter((c: any) => c.status === 'closed').length,
            personalityEvolved: recentEvolution.length > 0,
            evolutionVersion: recentEvolution[0]?.version || null,
            evolutionNarrative: recentEvolution[0]?.narrative || null,
            newSkillsGenerated: newSkills.length,
            // Sample of new memories
            memoryHighlights: newMemories
              .filter((m: any) => (m as any).tier === 'growth' || m.confidence >= 0.8)
              .slice(0, 5)
              .map((m: any) => m.content),
            // Top interaction topics
            interactionSample: newInteractions.slice(0, 3).map((i: any) =>
              (i.content || i.message || '').slice(0, 80)
            ),
          };

          // Generate narrative summary via LLM
          try {
            const narrativePrompt = `You are Lumi's growth journal writer. Write a brief, warm Chinese narrative (3-5 sentences) summarizing what Lumi learned and experienced today.

Today's data (${summaryData.date}):
- ${summaryData.newMemories} new memories formed (${Object.entries(summaryData.memoriesByType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})
- ${summaryData.newInteractions} interactions
- ${summaryData.activeConversations} active conversations, ${summaryData.closedConversations} closed
- Memory tiers: ${Object.entries(summaryData.memoriesByTier).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}
${summaryData.personalityEvolved ? `- Personality evolved to ${summaryData.evolutionVersion}: ${summaryData.evolutionNarrative}` : '- No personality evolution today'}
${summaryData.newSkillsGenerated > 0 ? `- ${summaryData.newSkillsGenerated} new skills generated` : ''}
${summaryData.memoryHighlights.length > 0 ? `- Key memories: ${summaryData.memoryHighlights.join('; ')}` : ''}

Write in first-person as Lumi, warm and introspective tone. Keep it under 150 Chinese characters. Output only the narrative — no preamble, no labels.`;

            const narrativeResult = await makeLLMCall(
              [{ role: 'user', content: narrativePrompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens: 300, domain: 'personal', orgId: '' }),
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );

            const generatedNarrative = narrativeResult.text?.trim();
            const narrative = generatedNarrative || `${summaryData.newMemories} 条新记忆，${summaryData.newInteractions} 次对话 — Lumi 在成长。`;

            // Store as a special memory
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'knowledge',
              content: `[Growth Journal ${summaryData.date}] ${narrative}`,
              keywords: ['growth_journal', 'daily_summary', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.9, domain: 'personal', orgId: '', source: 'system' });

            // Store structured data alongside
            addMemory({
              userId,
              type: 'fact',
              content: JSON.stringify(summaryData),
              keywords: ['growth_journal_data', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.5, domain: 'personal', orgId: '', source: 'system' });

            console.log(`[GrowthJournal] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push({
              userId,
              message: narrative.slice(0, 200),
              domain: 'personal',
              modelGenerated: Boolean(generatedNarrative),
            });
          } catch (llmErr: any) {
            console.warn(`[GrowthJournal] LLM generation failed for ${userId}:`, llmErr.message);
            // Fallback: simple stats summary
            const fallback = `${summaryData.date}: ${summaryData.newMemories} 条新记忆, ${summaryData.newInteractions} 次互动, ${summaryData.activeConversations} 个活跃对话。`;
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'knowledge',
              content: `[Growth Journal ${summaryData.date}] ${fallback}`,
              keywords: ['growth_journal', 'daily_summary', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'growth', domain: 'personal', orgId: '', source: 'system' });
            messages.push({ userId, message: fallback, domain: 'personal' });
          }
        } catch (err: any) {
          console.warn(`[GrowthJournal] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });

  // Agent autonomous tick (every 30 min) — LLM-driven reflective analysis
  scheduler.register({
    id: 'agent_autonomous_tick',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const db = readDB();
      const agents: AgentRecord[] = db.agents || [];
      const autonomousAgents = agents.filter(
        (a: AgentRecord) => a.autonomyLevel === 'scheduled' || a.autonomyLevel === 'autonomous',
      );

      if (autonomousAgents.length === 0) return null;

      const messages: string[] = [];

      for (const agentRecord of autonomousAgents) {
        try {
          const userId = agentRecord.ownerUid || agentRecord.userId || 'anonymous';
          const domain = agentRecord.domain === 'work' && agentRecord.orgId ? 'work' : 'personal';
          const orgId = domain === 'work' ? (agentRecord.orgId || '') : '';
          const personality = personalityRegistry.getForUser(
            agentRecord.personalityId || 'lumi',
            userId,
            domain === 'work' ? orgId : undefined,
          ) || personalityRegistry.getDefault();

          // Gather recent data for analysis
          const recentMemories = queryMemories({
            userId,
            limit: 30,
            minConfidence: 0.3,
            agentId: agentRecord.memoryScope === 'private' ? agentRecord.id : undefined,
            domain,
            orgId,
          });
          const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
          const recentInteractions = (db.interactions || [])
            .filter((i: any) =>
              i.userId === userId &&
              (i.domain || 'personal') === domain &&
              (i.orgId || '') === orgId &&
              i.timestamp >= sixHoursAgo
            )
            .slice(0, 20);

          if (recentMemories.length < 3 && recentInteractions.length < 3) continue;

          // Use AgentRuntime for unified tick logic
          const { AgentRuntime } = await import('./agents/runtime');
          const runtime = new AgentRuntime(agentRecord, personality);
          runtime.loadState(userId);

          const analyze = async (prompt: string): Promise<string> => {
            const result = await makeLLMCall(
              [{ role: 'user', content: prompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens: 200, domain, orgId }),
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
            return result.text?.trim() || '';
          };

          const tickResult = await runtime.autonomousTick(userId, recentMemories, recentInteractions, analyze);

          // Store reflection via runtime's addMemory (with proper scoping)
          if (tickResult.memoryUpdate) {
            // Memory already stored inside autonomousTick() via runtime.addMemory()
          }

          if (tickResult.message) {
            messages.push(`[${agentRecord.name}] ${tickResult.message}`);
          }
        } catch (err: any) {
          // Skip agents that fail to tick
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // ── Proactive Lumi Scan (every 1h) — background anomaly/pattern detection ──
  scheduler.register({
    id: 'proactive_lumi_scan',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const db = readDB();
          const now = new Date();
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
          const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // 1. Memory spike detection: unusually high memory creation rate
          const recentMemories = (db.memories || []).filter(
            (m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= oneHourAgo,
          );
          const dayMemories = (db.memories || []).filter(
            (m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= twentyFourHoursAgo,
          );

          const anomalySignals: string[] = [];

          // Memory spike: >10 memories in the last hour
          if (recentMemories.length >= 10) {
            anomalySignals.push(`过去一小时内产生了 ${recentMemories.length} 条新记忆，远超正常水平`);
          }

          // Type concentration: >70% of today's memories are same type
          if (dayMemories.length >= 8) {
            const typeCounts: Record<string, number> = {};
            for (const m of dayMemories) {
              typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
            }
            const maxType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
            if (maxType && maxType[1] / dayMemories.length > 0.7) {
              const typeLabels: Record<string, string> = {
                preference: '偏好', fact: '事实', habit: '习惯', knowledge: '知识',
              };
              anomalySignals.push(`最近24小时记忆集中在${typeLabels[maxType[0]] || maxType[0]}类型(${maxType[1]}/${dayMemories.length})`);
            }
          }

          // 2. Long inactivity check: >24h since last interaction
          const userInteractions = (db.interactions || [])
            .filter((i: any) => i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '')
            .sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
          if (userInteractions.length > 0) {
            const lastTs = new Date(userInteractions[0].timestamp).getTime();
            const hoursIdle = (now.getTime() - lastTs) / (1000 * 60 * 60);
            if (hoursIdle > 24 && hoursIdle < 168) {
              anomalySignals.push(`用户已 ${Math.round(hoursIdle)} 小时未互动`);
            }
          }

          // 3. Generate a proactive check-in if signals detected
          if (anomalySignals.length > 0) {
            const signalsStr = anomalySignals.join('; ');

            const checkInPrompt = `You are Lumi. You've noticed some patterns in the background. Generate a brief, warm, natural check-in message in Chinese (under 80 characters). Don't sound like a report — sound like a caring companion who noticed something.

Signals detected: ${signalsStr}

Output ONLY the check-in message — no preamble, no labels.`;

            try {
              const result = await makeLLMCall(
                [{ role: 'user', content: checkInPrompt }],
                [],
                getUserPreferredLLMConfig(userId, { maxTokens: 150, domain: 'personal', orgId: '' }),
                getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
              );
              const checkIn = result.text?.trim();
              if (checkIn && checkIn.length > 3) {
                messages.push(`[${userId}] ${checkIn}`);

                const { addMemory } = await import('./memory');
                addMemory({
                  userId,
                  type: 'fact',
                  content: `[Proactive Scan] Signals: ${signalsStr}. Check-in: ${checkIn}`,
                  keywords: ['proactive_scan', 'anomaly', 'lumi_checkin'],
                  confidence: 0.8,
                  sourceInteractionId: 'proactive_lumi_scan_scheduler',
                  agentId: undefined,
                } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.4, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
              }
            } catch {
              // LLM check-in failed — use a simple template
              messages.push(`[${userId}] 注意到一些变化 — ${anomalySignals.join('；')}`);
            }
          }

          // 4. Predictive assistant — anticipate what the user might do next based on time-of-day + history
          try {
            const currentHour = now.getHours();
            const currentDay = now.getDay(); // 0=Sun, 6=Sat
            const isWeekday = currentDay >= 1 && currentDay <= 5;

            // Check behavioral patterns for active hour prediction
            const behaviorMemories = queryMemories({
              userId,
              type: 'habit',
              limit: 10,
              minConfidence: 0.3,
              domain: 'personal',
              orgId: '',
            });
            const activeHourPattern = behaviorMemories.find(
              m => m.type === 'habit' && m.content.includes('most active during hours'),
            );
            const toolPattern = behaviorMemories.find(
              m => m.type === 'habit' && m.content.includes('Most used tools'),
            );

            // Check recent activity for window context
            const recentActivity = getRecentActivity(userId, 20);
            const recentWindows = recentActivity
              .filter(e => e.type === 'window_changed' && e.data?.process_name)
              .slice(0, 5);
            const appNames = [...new Set(recentWindows.map(e => e.data!.process_name as string))];

            // Check if current time aligns with known active hours
            let hourContext = '';
            if (activeHourPattern) {
              const hourMatch = activeHourPattern.content.match(/hours (\d+):00 and (\d+):00/);
              if (hourMatch) {
                const h1 = parseInt(hourMatch[1]);
                const h2 = parseInt(hourMatch[2]);
                const nearPeak = Math.abs(currentHour - h1) <= 1 || Math.abs(currentHour - h2) <= 1;
                if (nearPeak) {
                  hourContext = `当前时间接近用户历史活跃时段(${h1}:00-${h2}:00)`;
                } else if (isWeekday && currentHour >= 8 && currentHour <= 10) {
                  hourContext = '工作日上午，用户可能准备开始一天的工作';
                } else if (isWeekday && currentHour >= 13 && currentHour <= 14) {
                  hourContext = '午后时段，用户可能刚用完午餐回到工位';
                } else if (currentHour >= 21 && currentHour <= 23) {
                  hourContext = '晚间时段，用户可能在放松或个人学习';
                }
              }
            }

            // Build prediction context
            const predictionHints: string[] = [];
            if (hourContext) predictionHints.push(hourContext);
            if (appNames.length > 0) {
              const appList = appNames.map(a => a.replace(/\.exe$/i, '')).join('、');
              predictionHints.push(`用户最近在使用：${appList}`);
            }
            if (toolPattern) {
              predictionHints.push(toolPattern.content);
            }

            if (predictionHints.length >= 1) {
              const predictionPrompt = `You are Lumi, a proactive AI companion. Based on the user's patterns, generate a brief, natural predictive suggestion in Chinese (under 60 characters). Don't be pushy — be helpful and observant.

Context hints:
${predictionHints.join('\n')}

Examples of good predictions:
- "早上好，需要我帮你打开今天的项目吗？"
- "这个时间你通常会检查代码，需要我帮忙吗？"
- "你刚才打开了VS Code，需要我帮你回顾昨天的进度吗？"

Output ONLY the prediction message — no preamble, no labels.`;

              const predictionResult = await makeLLMCall(
                [{ role: 'user', content: predictionPrompt }],
                [],
                getUserPreferredLLMConfig(userId, { maxTokens: 100, domain: 'personal', orgId: '' }),
                getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
              );
              const prediction = predictionResult.text?.trim();
              if (prediction && prediction.length > 5) {
                messages.push(`[${userId}] 🔮 ${prediction}`);

                const { addMemory } = await import('./memory');
                addMemory({
                  userId,
                  type: 'fact',
                  content: `[Predictive] ${prediction} (context: ${predictionHints.join('; ')})`,
                  keywords: ['predictive_assistant', 'prediction', 'proactive'],
                  confidence: 0.5,
                  sourceInteractionId: 'predictive_lumi_scan_scheduler',
                  agentId: undefined,
                } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.3, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
              }
            }
          } catch (predErr: any) {
            // Predictive assistant failure is non-critical
            console.warn(`[PredictiveAssistant] Failed for ${userId}:`, predErr.message);
          }
        } catch (err: any) {
          console.warn(`[ProactiveScan] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // ── "This Day in History" (daily) — find memories from this day in past years ──
  scheduler.register({
    id: 'memory_this_day',
    cron: 'daily_9am',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          // Look back across all past years for today's month-day
          const now = new Date();
          const month = now.getMonth() + 1;
          const day = now.getDate();

          const pastMemories: { content: string; year: number }[] = [];
          // Check last 3 years
          for (let yearOffset = 1; yearOffset <= 3; yearOffset++) {
            const year = now.getFullYear() - yearOffset;
            const after = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
            const before = `${year}-${String(month).padStart(2, '0')}-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`;

            const matches = queryMemories({
              userId,
              after,
              before,
              limit: 20,
              domain: 'personal',
              orgId: '',
            });

            for (const m of matches) {
              pastMemories.push({ content: m.content.slice(0, 100), year });
            }
          }

          if (pastMemories.length > 0) {
            const sample = pastMemories.slice(0, 3);
            const refs = sample.map(m => `"${m.content}" (${m.year}年)`).join('; ');
            const yearsAgo = pastMemories[0].year;
            messages.push(
              `[${userId}] 历史上的今天: ${pastMemories.length} 条过去${now.getFullYear() - yearsAgo}年${month}月${day}日的记忆: ${refs}`,
            );

            // Store as a special episodic memory for temporal context
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'fact',
              content: `[This Day ${month}/${day}] ${pastMemories.length} 条历史上的今天记忆: ${sample.map(m => m.content).join('; ')}`,
              keywords: ['this_day_in_history', `${month}/${day}`, 'temporal_memory'],
              confidence: 1.0,
              sourceInteractionId: 'memory_this_day_scheduler',
              agentId: undefined,
            } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.4, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
          }
        } catch (err: any) {
          console.warn(`[MemoryThisDay] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0
        ? `历史上的今天 — ${messages.join('\n')}`
        : null;
    },
  });

  // ── Spatiotemporal pattern analysis (every 6h) — detect location+time patterns ──
  scheduler.register({
    id: 'spatiotemporal_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const patterns = detectSpatiotemporalPatterns(userId, 'personal', '');
          if (patterns.length > 0) {
            // Store new patterns as growth memories
            const { addMemory } = await import('./memory');
            const newPatterns = patterns.filter(p => p.confidence >= 0.5);
            for (const p of newPatterns.slice(0, 3)) {
              addMemory({
                userId,
                type: 'habit',
                content: `[时空模式] ${p.description}`,
                keywords: ['spatiotemporal_pattern', p.type, 'lumi_learning'],
                confidence: p.confidence,
                sourceInteractionId: 'spatiotemporal_analysis_scheduler',
                agentId: undefined,
              } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.5, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            }
            messages.push(
              `[${userId}] 发现 ${newPatterns.length} 个时空行为模式`,
            );
          }
        } catch (err: any) {
          console.warn(`[SpatiotemporalAnalysis] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0
        ? `时空模式分析 — ${messages.join('\n')}`
        : null;
    },
  });

  // Ephemeral agent cleanup (every 1h) — removes orphaned auto-created workers
  scheduler.register({
    id: 'ephemeral_cleanup',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const removed = cleanupEphemeralAgents(6);
      if (removed > 0) {
        return `Cleaned up ${removed} ephemeral worker agents`;
      }
      return null;
    },
  });

  // ── Ambient Awareness Tasks ──

  // Activity poll (every 10s) — requests ambient state from all connected Tauri clients
  scheduler.register({
    id: 'ambient_activity_poll',
    cron: 'every_10s',
    lastRun: null,
    handler: async () => {
      if (scheduler.io) {
        const payload = { timestamp: new Date().toISOString() };
        for (const userId of getAllUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('ambient:poll_request', payload);
        }
      }
      return null; // Silent — frontend handles the actual work
    },
  });

  // Idle check (every 1min) — suppresses notifications during active use
  scheduler.register({
    id: 'idle_check',
    cron: 'every_1m',
    lastRun: null,
    handler: async () => {
      if (scheduler.io) {
        const payload = { timestamp: new Date().toISOString() };
        for (const userId of getAllUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('ambient:idle_check', payload);
        }
      }
      return null;
    },
  });

  // ── Autonomous work cycle (every 10 min) — background task generation + execution ──
  scheduler.register({
    id: 'autonomous_work_cycle',
    cron: 'every_10m',
    quiet: true,
    lastRun: null,
    handler: async () => {
      if (!scheduler.io) return null;

      const userIds = getAllUserIds();
      let totalGenerated = 0;
      let totalExecuted = 0;

      const getters: LLMGetters = {
        getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
      };

      for (const userId of userIds) {
        try {
          // Check if user has autonomous mode enabled
          const db = readDB();
          const modeSetting = (db.settings || []).find((s: any) =>
            s.key === `op_mode_${userId}`
          );
          const mode = modeSetting ? parseStoredOperationMode(modeSetting.value) : 'assistant';
          if (mode !== 'autonomous') continue;

          // Generate tasks
          const { generateAutonomousTasks } = await import('./autonomy/task_generator');
          const generated = await generateAutonomousTasks(userId, getters);
          totalGenerated += generated;

          // Execute pending tasks, bounded by the current safety gate.
          const { executeNextAutonomousTask } = await import('./autonomy/task_executor');
          const maxTasks = Math.max(1, Math.min(50, getGateConfig(userId).maxConsecutiveTasks || 1));
          for (let i = 0; i < maxTasks; i++) {
            const result = await executeNextAutonomousTask(scheduler.io!, getters, userId);
            if (!result.executed) break;
            totalExecuted++;
          }
        } catch (err: any) {
          console.warn(`[AutoWorkCycle] Failed for ${userId}:`, err.message);
        }
      }

      if (totalGenerated > 0 || totalExecuted > 0) {
        return `Generated ${totalGenerated} tasks, executed ${totalExecuted}`;
      }
      return null;
    },
  });

  // ── Daily System Scan — Lumi checks the PC's health ──
  scheduler.register({
    id: 'daily_system_scan',
    cron: 'every_24h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      if (!isFirstBootComplete()) return null;
      const snapshot = runDailyScan();
      if (!snapshot) return null;

      // Host diagnostics belong to the local/system administration surface,
      // never to organization members as organization knowledge.
      if (scheduler.io) {
        for (const userId of getSystemAdminUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('system:scan_result', {
            timestamp: snapshot.timestamp,
            computerScope: 'server_host',
            hostname: snapshot.hardware.hostname,
            summary: snapshot.changeSummary,
            diskFree: snapshot.hardware.disks.map(d => `${d.name}: ${d.freeGB.toFixed(1)}GB free`),
            appCount: snapshot.software.installedApps.length,
          });
        }
      }

      return null;
    },
  });
}



