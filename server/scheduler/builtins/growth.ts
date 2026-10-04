import type { ScheduledTask, ScheduledDelivery } from "../../scheduler";
import type { ScheduledBuiltinContext } from "./context";
import { personalityRegistry } from "../../personality";
import { listMemoryRows } from "../../memory/repository";
import { loadEmotionalState } from "../../personality/state";
import { evolvePersonality, generateReviewPrompt } from "../../personality/evolution";
import { listUserInteractions, listConversationHeaders } from "../../conversation/history_repository";
import { makeLLMCall } from "../../llm/providers";
import { getUserPreferredLLMConfig } from "../../llm/user_preferences";
import { autoGenerateWorkflows } from "../../agents/workflows";
import { runHealthAudit } from "../../agents/health_audit";
import { isTestMemory, isDerivedLearningMemory, isMalformedBehavioralMemory, isOwnerInteractionEvidence } from "../../memory/provenance";
import { providerGetterArguments } from "../../llm/provider_getters";

export function createGrowthTasks(context: ScheduledBuiltinContext): ScheduledTask[] {
  const { scheduler, getAllUserIds, redactSchedulerDiagnostic, getters } = context;
  const tasks: ScheduledTask[] = [];


  // Personality evolution (every 6h, gated by new-memory threshold)
  // Lumi's personality grows toward the owner through accumulated interaction data.
  // No fixed 7-day cooldown — evolves whenever enough new owner_trait memories accumulate.
  tasks.push({
    id: 'personality_evolution',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          if (personalityRegistry.isEvolutionFrozen('lumi', userId)) continue;

          // Gate: only evolve if enough new owner_trait memories since last evolution
          const lastEvolvedAt = (config as any).lastEvolvedAt as string | undefined;
          const newMemoriesSince = lastEvolvedAt
            ? listMemoryRows({ userId, domain: 'personal', orgId: '' })
                .filter(m => m.perspective === 'owner_trait' && m.createdAt > lastEvolvedAt).length
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
            getters.getDeepSeek,
            getters.getGemini,
            getters.getOpenAI || (() => null),
            getters.getAnthropic || (() => null),
            getters.getQwen || (() => null),
            evolutionConfig,
            undefined,
            undefined,
            getters.getOllama,
            getters.getLmStudio,
            getters.getArk,
            getters.getXiaomi,
            getters.getKimi,
            getters.getGlm,
            getters.getRelay,
          );

          if (step) {
            personalityRegistry.applyEvolution('lumi', step, { userId });
            messages.push(
              `I've grown closer to understanding you. ${step.narrative}`
            );
            console.log(`[Scheduler] Personality evolution complete for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(step.version)}`);
          }
        } catch (err: any) {
          console.error(`[Scheduler] Personality evolution failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });


  // One review flow; each period keeps its schedule, scope, budget and memory metadata.
  for (const { depth, cron, days, maxTokens, topicLimit, label, period, dateLength, importance } of [
    { depth: 'weekly', cron: 'every_7d', days: 7, maxTokens: 400, topicLimit: 10,
      label: 'Weekly', period: 'week', dateLength: 10, importance: 0.95 },
    { depth: 'monthly', cron: '1 0 1 * *', days: 30, maxTokens: 600, topicLimit: 15,
      label: 'Monthly', period: 'month', dateLength: 7, importance: 0.97 },
    { depth: 'yearly', cron: '0 0 1 1 *', days: 365, maxTokens: 800, topicLimit: 20,
      label: 'Yearly', period: 'year', dateLength: 4, importance: 1.0 },
  ] as const) {
    const reviewId = `${depth}_review`;
    tasks.push({
      id: reviewId,
      cron,
      quiet: true,
      lastRun: null,
      executionClass: 'maintenance',
      handler: async () => {
        const userIds = getAllUserIds();
        const messages: string[] = [];
        for (const userId of userIds) {
          try {
            const config = personalityRegistry.getForUser('lumi', userId);
            if (!config) continue;
            const periodStart = new Date(Date.now() - days * 86400000).toISOString();

            const owner = { userId, domain: 'personal' as const, orgId: '' };
            const memories = listMemoryRows(owner);
            const periodMemories = memories.filter((m: any) => m.createdAt >= periodStart);
            const periodInteractions = listUserInteractions(userId, { ...owner, after: periodStart });
            const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
            const periodEvolutions = evolutionHistory.filter((e: any) => e.timestamp >= periodStart);

            const prompt = generateReviewPrompt({
              depth,
              personalityName: config.name,
              currentVersion: config.version,
              evolutionSteps: periodEvolutions,
              newMemoryCount: periodMemories.length,
              newInteractionCount: periodInteractions.length,
              topMemoryTopics: [...new Set<string>(periodMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, topicLimit),
              connectionScore: loadEmotionalState(userId).connection,
              totalFacts: memories.filter((m: any) => m.type === 'fact').length,
              totalPreferences: memories.filter((m: any) => m.type === 'preference').length,
              activeConversations: listConversationHeaders(owner).filter(c => (c.domain || 'personal') === 'personal' && c.status === 'active').length,
            });

            const result = await makeLLMCall(
              [{ role: 'user', content: prompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens, domain: 'personal', orgId: '', source: `scheduler_${reviewId}` }),
              ...providerGetterArguments(getters),
              );
            const narrative = result.text?.trim();
            if (narrative) {
              // Store as a special growth memory
              const { addMemory } = await import("../../memory");
              addMemory({
                userId, type: 'knowledge',
                content: `[${label} Review ${new Date().toISOString().slice(0, 10)}] ${narrative}`,
                keywords: [reviewId, `${period}_${new Date().toISOString().slice(0, dateLength)}`],
                confidence: 1.0,
                sourceInteractionId: `${reviewId}_scheduler`,
              } as any, { tier: 'growth', perspective: 'lumi_self', importance, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
              console.log(`[${label}Review] Generated for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(narrative).slice(0, 100)}`);
              messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
            }
          } catch (err: any) {
            console.error(`[${label}Review] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
          }
        }
        return messages.length > 0 ? messages.join('\n') : null;
      },
    });
  }


  // Auto workflow generation (every hour) — detects repeated tool patterns and creates named workflows
  tasks.push({
    id: 'auto_workflow_gen',
    cron: 'every_hour',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
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
        console.error('[Scheduler] auto_workflow_gen failed:', redactSchedulerDiagnostic(err));
      }
      return null;
    },
  });


  // System health audit (every 6 hours) — self-diagnose and notify if issues found
  tasks.push({
    id: 'health_audit',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
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
        console.error('[Scheduler] health_audit failed:', redactSchedulerDiagnostic(err));
      }
      return null;
    },
  });


  // ── Lumi Growth Journal (daily) — auto-generated summary of what Lumi learned ──
  tasks.push({
    id: 'growth_journal',
    cron: 'daily_9am',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const owner = { userId, domain: 'personal' as const, orgId: '' };
          const now = new Date();
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // Collect yesterday's stats
          const newMemories = listMemoryRows(owner).filter(m => m.createdAt && m.createdAt >= yesterday
              && !isTestMemory(m) && !isDerivedLearningMemory(m) && !isMalformedBehavioralMemory(m)
              && !m.sourceInteractionId?.startsWith('quarantine:'),
          );
          const interactions = listUserInteractions(userId, { ...owner, after: yesterday });
          const newInteractions = interactions.filter(i => isOwnerInteractionEvidence(i) && (!i.role || i.role === 'user'));
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
          const conversations = listConversationHeaders(owner).filter(c =>
            (c.domain || 'personal') === 'personal' && c.lastActiveAt && c.lastActiveAt >= yesterday);

          // Skill changes
          const newSkills = interactions.filter(i => i.mode === 'skill_gen' && isOwnerInteractionEvidence({ ...i, mode: '' }));

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
              getUserPreferredLLMConfig(userId, { maxTokens: 300, domain: 'personal', orgId: '', source: 'scheduler_growth_journal' }),
              ...providerGetterArguments(getters),
            );

            const generatedNarrative = narrativeResult.text?.trim();
            const narrative = generatedNarrative || `${summaryData.newMemories} 条新记忆，${summaryData.newInteractions} 次对话 — Lumi 在成长。`;

            // Store as a special memory
            const { addMemory } = await import("../../memory");
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

            console.log(`[GrowthJournal] Generated for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(narrative).slice(0, 100)}`);
            messages.push({
              userId,
              message: narrative.slice(0, 200),
              domain: 'personal',
              modelGenerated: Boolean(generatedNarrative),
            });
          } catch (llmErr: any) {
            console.warn(`[GrowthJournal] LLM generation failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(llmErr));
            // Fallback: simple stats summary
            const fallback = `${summaryData.date}: ${summaryData.newMemories} 条新记忆, ${summaryData.newInteractions} 次互动, ${summaryData.activeConversations} 个活跃对话。`;
            const { addMemory } = await import("../../memory");
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
          console.warn(`[GrowthJournal] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });
  return tasks;
}
