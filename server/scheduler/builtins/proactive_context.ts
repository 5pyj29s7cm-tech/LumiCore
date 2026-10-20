import type { ScheduledTask } from "../../scheduler";
import type { ScheduledBuiltinContext } from "./context";
import { listMemoryRows } from "../../memory/repository";
import { listUserInteractions } from "../../conversation/history_repository";
import { makeLLMCall } from "../../llm/providers";
import { getUserPreferredLLMConfig } from "../../llm/user_preferences";
import { queryMemories } from "../../memory";
import { getRecentActivity } from "../../context/activity_stream";
import { detectSpatiotemporalPatterns } from "../../time/spatiotemporal";
import { providerGetterArguments } from "../../llm/provider_getters";

export function createProactiveContextTasks(context: ScheduledBuiltinContext): ScheduledTask[] {
  const { getAllUserIds, redactSchedulerDiagnostic, getters } = context;
  const tasks: ScheduledTask[] = [];


  // ── Proactive Lumi Scan (every 1h) — background anomaly/pattern detection ──
  tasks.push({
    id: 'proactive_lumi_scan',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async run => {
      const signal = run?.signal || new AbortController().signal;
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        signal.throwIfAborted();
        try {
          const owner = { userId, domain: 'personal' as const, orgId: '' };
          const now = new Date();
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
          const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // 1. Memory spike detection: unusually high memory creation rate
          const memories = listMemoryRows(owner);
          const recentMemories = memories.filter(m => m.createdAt >= oneHourAgo);
          const dayMemories = memories.filter(m => m.createdAt >= twentyFourHoursAgo);

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
          const userInteractions = listUserInteractions(userId, { ...owner, order: 'newest', limit: 1 });
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
                { ...getUserPreferredLLMConfig(userId, { maxTokens: 150, domain: 'personal', orgId: '', source: 'scheduler_proactive_lumi_scan' }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
                ...providerGetterArguments(getters),
              );
              signal.throwIfAborted();
              const checkIn = result.text?.trim();
              if (checkIn && checkIn.length > 3) {
                messages.push(`[${userId}] ${checkIn}`);

                const { addMemory } = await import("../../memory");
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
              signal.throwIfAborted();
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
                { ...getUserPreferredLLMConfig(userId, { maxTokens: 100, domain: 'personal', orgId: '', source: 'scheduler_predictive_assistant' }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
                ...providerGetterArguments(getters),
              );
              signal.throwIfAborted();
              const prediction = predictionResult.text?.trim();
              if (prediction && prediction.length > 5) {
                messages.push(`[${userId}] 🔮 ${prediction}`);

                const { addMemory } = await import("../../memory");
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
            signal.throwIfAborted();
            // Predictive assistant failure is non-critical
            console.warn(`[PredictiveAssistant] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(predErr));
          }
        } catch (err: any) {
          signal.throwIfAborted();
          console.warn(`[ProactiveScan] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });


  // ── "This Day in History" (daily) — find memories from this day in past years ──
  tasks.push({
    id: 'memory_this_day',
    cron: 'daily_9am',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
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
            const { addMemory } = await import("../../memory");
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
          console.warn(`[MemoryThisDay] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0
        ? `历史上的今天 — ${messages.join('\n')}`
        : null;
    },
  });


  // ── Spatiotemporal pattern analysis (every 6h) — detect location+time patterns ──
  tasks.push({
    id: 'spatiotemporal_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const patterns = detectSpatiotemporalPatterns(userId, 'personal', '');
          if (patterns.length > 0) {
            // Store new patterns as growth memories
            const { addMemory } = await import("../../memory");
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
          console.warn(`[SpatiotemporalAnalysis] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0
        ? `时空模式分析 — ${messages.join('\n')}`
        : null;
    },
  });
  return tasks;
}
