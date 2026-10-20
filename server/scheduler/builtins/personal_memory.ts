import type { ScheduledTask, ScheduledDelivery } from "../../scheduler";
import type { ScheduledBuiltinContext } from "./context";
import { dynamicDecayMemories, promoteMemories, getUnconsolidatedEpisodic, getDueReminders, queryMemories, runBehavioralAnalysis } from "../../memory";
import { loadEmotionalState } from "../../personality/state";
import { ConsolidationContext, consolidateEpisodic, consolidateNarrative } from "../../memory/consolidator";
import { getUserPreferredLLMConfig } from "../../llm/user_preferences";
import { runDreamCycle } from "../../memory/dream";
import { getTimeOfDay } from "../../time/utils";
import { makeLLMCall } from "../../llm/providers";
import { backfillEmbeddings } from "../../memory/store";
import { organizePersonalMemories } from "../../memory/auto_organize";
import { providerGetterArguments } from "../../llm/provider_getters";

export function createPersonalMemoryTasks(context: ScheduledBuiltinContext): ScheduledTask[] {
  const { scheduler, getAllUserIds, redactSchedulerDiagnostic, getters } = context;
  const tasks: ScheduledTask[] = [];


  // Memory decay — value-modulated tier-based decay for all users (every 6h)
  tasks.push({
    id: 'memory_decay',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
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
  tasks.push({
    id: 'memory_crystallization',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      let totalPromoted = 0;
      for (const userId of userIds) {
        const emotionalState = loadEmotionalState(userId);
        totalPromoted += promoteMemories(userId, emotionalState.intimacy, 'personal', '');
      }
      if (totalPromoted > 0) {
        return `${totalPromoted} memories have crystallized into deeper knowledge.`;
      }
      return null;
    },
  });


  // Memory consolidation (every 30 min) — triggers when >=10 unconsolidated episodic
  tasks.push({
    id: 'memory_consolidation',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async (execution) => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        execution?.signal.throwIfAborted();
        const episodic = getUnconsolidatedEpisodic(userId, 'personal', '');
        if (episodic.length < 10) continue;
        const ctx: ConsolidationContext = {
          ...getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '', source: 'scheduler_memory_consolidation' }),
          signal: execution?.signal,
          domain: 'personal',
          orgId: '',
        };
        const consolidated = await consolidateEpisodic(
          ctx, 10,
          ...providerGetterArguments(getters),
        );
        if (consolidated) {
          messages.push(`[${userId}] I've grown from our conversations: ${consolidated.content.slice(0, 200)}`);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });


  // Narrative memory consolidation (every 6h) — weaves episodic memories into storylines
  tasks.push({
    id: 'narrative_consolidation',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async (execution) => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        execution?.signal.throwIfAborted();
        try {
          const ctx: ConsolidationContext = {
            ...getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '', source: 'scheduler_narrative_consolidation' }),
            signal: execution?.signal,
            domain: 'personal',
            orgId: '',
          };
          const result = await consolidateNarrative(
            ctx, 7, 6,
            ...providerGetterArguments(getters),
          );
          if (result) {
            const title = result.content.match(/^\[(.+?)\]/)?.[1] || '叙事记忆';
            messages.push(`[${userId}] 记忆叙事已生成: "${title}"`);
          }
        } catch (err: any) {
          console.warn(`[NarrativeConsolidation] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0
        ? `叙事记忆更新 — ${messages.join('\n')}`
        : null;
    },
  });


  // Sleep / dream cycle — quiet memory maintenance during night or idle rest.
  tasks.push({
    id: 'sleep_dream_cycle',
    cron: '17 3 * * *',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];


      for (const userId of userIds) {
        try {
          const ctx: ConsolidationContext = {
            ...getUserPreferredLLMConfig(userId, { maxTokens: 900, domain: 'personal', orgId: '', source: 'scheduler_sleep_dream_cycle' }),
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
          console.warn(`[SleepDreamCycle] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? `Lumi finished dreaming.\n${messages.join('\n')}` : null;
    },
  });


  // Daily briefing uses user-local time and confirmed personal context.
  tasks.push({
    id: 'daily_summary',
    cron: 'daily_9am',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const timeOfDay = getTimeOfDay(userId);
          const greeting = `Good ${timeOfDay === 'night' ? 'evening' : timeOfDay}`;          const pending = getDueReminders({ userId, domain: 'personal', orgId: '' });
          const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.4, domain: 'personal', orgId: '' });

          const contextParts: string[] = [];          if (pending.length > 0) contextParts.push(`${pending.length} 条待办: ${pending.map(r => r.content).join('; ')}`);
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
              getUserPreferredLLMConfig(userId, { maxTokens: 120, source: 'scheduler_daily_summary' }),
              ...providerGetterArguments(getters),
            );
            const llmGreeting = result.text?.trim();
            if (llmGreeting && llmGreeting.length > 3) {
              messages.push({ userId, message: llmGreeting, domain: 'personal', modelGenerated: true });
            } else {
              // Fallback to template
              const parts: string[] = [`${greeting}!`];
              if (pending.length > 0) parts.push(`${pending.length} 条待办`);
              messages.push({ userId, message: parts.join(' - '), domain: 'personal' });
            }
          } catch {
            const parts: string[] = [`${greeting}!`];
            messages.push({ userId, message: parts.join(' - '), domain: 'personal' });
          }
        } catch (err: any) {
          console.warn(`[DailySummary] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });


  // Evening wrap-up — LLM-generated with reflection
  tasks.push({
    id: 'evening_wrapup',
    cron: 'evening_8pm',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async run => {
      const signal = run?.signal || new AbortController().signal;
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        signal.throwIfAborted();
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
              { ...getUserPreferredLLMConfig(userId, { maxTokens: 100, source: 'scheduler_evening_wrapup' }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
              ...providerGetterArguments(getters),
            );
            signal.throwIfAborted();
            const llmReflection = result.text?.trim();
            if (llmReflection && llmReflection.length > 3) {
              messages.push({ userId, message: llmReflection, domain: 'personal', modelGenerated: true });
            }
          } catch {
            signal.throwIfAborted();
            // Simple fallback
            messages.push({ userId, message: `晚间回顾 — ${contextParts.join(' - ')}`, domain: 'personal' });
          }
        } catch (err: any) {
          signal.throwIfAborted();
          console.warn(`[EveningWrapup] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });


  // Behavioral pattern analysis (every 6h) — for all users
  tasks.push({
    id: 'behavioral_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
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


  // Repair old or changed embedding spaces in bounded batches. Missing indexes
  // must not leave historical memories permanently dependent on exact keywords.
  tasks.push({ id: 'memory_index_backfill', cron: 'every_1h', quiet: true, lastRun: null,
    executionClass: 'maintenance', handler: async () => {
      for (const userId of getAllUserIds()) await backfillEmbeddings(userId, { limit: 40 });
      return null;
    } });


  // Memory tree auto-organize (every 6h) — LLM groups orphan leaves into topic branches
  tasks.push({
    id: 'memory_auto_organize',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async context => {
      const signal = context?.signal || new AbortController().signal;
      let totalBranches = 0;
      let totalAssigned = 0;
      for (const userId of getAllUserIds()) {
        signal.throwIfAborted();
        try {
          const result = await organizePersonalMemories(userId, async (prompt, requestSignal) => {
            const response = await makeLLMCall(
              [{ role: 'user', content: prompt }], [],
              { ...getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '', source: 'scheduler_memory_auto_organize' }),
                signal: AbortSignal.any([requestSignal, AbortSignal.timeout(60_000)]), maxTokens: 2048 },
              ...providerGetterArguments(getters),
            );
            return response.text || '';
          }, signal);
          totalBranches += result.branches;
          totalAssigned += result.assigned;
        } catch (error: any) {
          signal.throwIfAborted();
          console.warn(`[Scheduler] Auto-organize failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(error));
        }
      }
      signal.throwIfAborted();
      return totalBranches > 0
        ? `I've organized ${totalAssigned} memories into ${totalBranches} topic branches for easier recall.`
        : null;
    },
  });
  return tasks;
}
