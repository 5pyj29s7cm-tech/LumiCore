import { ToolRegistry } from '../registry';
import { getSleepCycleState, runDreamCycle } from '../../memory/dream';
import { getUserPreferredLLMConfig } from '../../llm/user_preferences';

function requireDreamGetters(context: any) {
  const getters = context?.llmGetters || {};
  if (!getters.getDeepSeek || !getters.getGemini) {
    throw new Error('Sleep cycle requires Lumi LLM services to be available.');
  }
  return getters;
}

function dreamScope(context: any): { domain: 'personal' | 'work'; orgId: string } {
  if (context?.domain === 'work' && context?.orgId) {
    return { domain: 'work', orgId: String(context.orgId) };
  }
  return { domain: 'personal', orgId: '' };
}

export function registerSleepTools(registry: ToolRegistry): void {
  registry.register({
    name: 'lumi_sleep_status',
    description: 'Read Lumi sleep/dream memory-maintenance status: last sleep cycle, dream count, last dream summary, and last report.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_args, context) => {
      const scope = dreamScope(context);
      return JSON.stringify(getSleepCycleState(context?.userId || 'anonymous', scope.domain, scope.orgId), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'lumi_sleep_cycle',
    description: [
      'Let Lumi rest and dream: run a safe internal memory consolidation pass.',
      'This organizes recent memories, marks uncertainty, creates a growth/dream memory, and reduces confusion without deleting original memories or mutating core identity.',
      'Use when the user asks Lumi to sleep, dream, rest, process memories, become less confused, or quietly整理记忆.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Run even if idle/night/cooldown gates would normally skip. Use only when the user explicitly asks Lumi to sleep/dream now.' },
        reason: { type: 'string', description: 'Short reason for auditability.' },
        minRecentMemories: { type: 'number', description: 'Minimum recent memories needed before dreaming, default 3.' },
        windowHours: { type: 'number', description: 'Recent memory window, default 36 hours.' },
        cooldownHours: { type: 'number', description: 'Cooldown before another non-forced dream, default 6 hours.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const { domain, orgId } = dreamScope(context);
      const pref = getUserPreferredLLMConfig(userId, { maxTokens: 900, domain, orgId });
      const report = await runDreamCycle(
        {
          userId,
          provider: pref.provider as any,
          model: pref.model,
          domain,
          orgId,
        },
        {
          force: Boolean(args.force),
          reason: String(args.reason || (args.force ? 'manual_sleep_request' : 'sleep_request')),
          domain,
          orgId,
          minRecentMemories: Number(args.minRecentMemories) || undefined,
          windowHours: Number(args.windowHours) || undefined,
          cooldownHours: Number(args.cooldownHours) || undefined,
        },
        requireDreamGetters(context),
      );
      return JSON.stringify(report, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
