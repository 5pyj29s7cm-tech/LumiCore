// i18n-allow-file: Chinese strings are reviewed input-recognition aliases and
// are never rendered as user-visible interface copy.
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import {
  getCurrentIndustryCapabilityProfile,
  matchCurrentIndustryWorkflow,
} from '../../regions/packs/cn/industry_capability_profile';
import {
  getIndustryGuidancePreference,
  inferIndustryGuidanceLevel,
  inferIndustryGuidanceMode,
  setIndustryGuidancePreference,
  type IndustryGuidanceScope,
} from '../../industry/user_guidance';

type CurrentIndustryContextResolver = (
  context?: ToolContext,
) => Record<string, unknown> | null;

function scope(context?: ToolContext): IndustryGuidanceScope {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain === 'work' ? 'work' : 'personal',
    orgId: context?.domain === 'work' ? String(context?.orgId || '') : '',
  };
}

export function registerIndustryGuidanceTools(
  registry: ToolRegistry,
  resolveCurrentContext?: CurrentIndustryContextResolver,
): void {
  registry.register({
    name: 'industry_user_guide',
    description: 'Teach the user how to use this exact Lumi industry edition. Reads the active store, case, entity, or design project when available, returns no more than three next steps, and never starts or completes business work.',
    routingHints: [
      'how to use this edition',
      'teach me',
      'guide me',
      'getting started',
      '\u600e\u4e48\u7528', '\u6559\u6211', '\u5e26\u6211\u505a', '\u4ece\u54ea\u5f00\u59cb', '\u4e0b\u4e00\u6b65\u600e\u4e48\u505a', // i18n-allow: Reviewed input aliases.
    ],
    parameters: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The user learning question. Omit when trusted turn context already contains it.' },
        entryId: { type: 'string', description: 'Optional exact edition workspace to explain.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const profile = getCurrentIndustryCapabilityProfile();
      if (!profile) throw new Error('This runtime has no industry capability profile.');
      const request = String(
        context?.routedTaskText || context?.actionIntent || args.request || '',
      ).trim();
      const storedPreference = getIndustryGuidancePreference(scope(context));
      const effectivePreference = {
        level: inferIndustryGuidanceLevel(request, storedPreference.level),
        mode: inferIndustryGuidanceMode(request, storedPreference.mode),
      };
      const requestedEntryId = String(args.entryId || '').trim();
      const entry = requestedEntryId
        ? profile.entries.find(candidate => candidate.entryId === requestedEntryId)
        : matchCurrentIndustryWorkflow(request)?.entry;
      if (requestedEntryId && !entry) {
        throw new Error(`Industry entry is not available in this edition: ${requestedEntryId}`);
      }
      const activeContext = resolveCurrentContext?.(context) || null;
      const focus = entry || profile.entries[0] || null;
      const steps = (focus?.contract.nextActions || []).slice(0, 3);
      return JSON.stringify({
        ok: true,
        status: 'guided',
        edition: {
          variantId: profile.variantId,
          displayName: profile.displayName,
          productLine: profile.productLine,
          positioning: profile.positioning,
        },
        storedPreference,
        effectivePreference,
        activeContext,
        focus: focus ? {
          entryId: focus.entryId,
          displayName: focus.displayName,
          summary: focus.summary,
          automationLevel: focus.automationLevel,
        } : null,
        steps,
        availableWorkspaces: profile.entries.map(candidate => ({
          entryId: candidate.entryId,
          displayName: candidate.displayName,
          summary: candidate.summary,
        })),
        responseContract: {
          maximumSteps: 3,
          explainOnly: effectivePreference.mode === 'explain',
          guidedExecutionLimit: effectivePreference.mode === 'guided'
            ? 'one explicitly requested, reversible local step before re-checking with the user'
            : 'none',
          askOneQuestionWhenContextMissing: true,
          neverTreatGuidanceAsCompletionEvidence: true,
          externalCommitRequiresExactConfirmation: true,
          prohibitedTeachingSideEffects: [
            'external send or publish',
            'filing or submission',
            'payment or signing',
            'price or listing mutation',
          ],
        },
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.user-guide.observe',
      family: 'industry',
      lane: 'industry',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'edition profile, scoped guidance preference, and active business context', reversible: true }],
      verification: {
        strategy: 'measured',
        required: true,
        requiredFields: ['ok', 'status', 'edition.variantId', 'effectivePreference.mode', 'responseContract.maximumSteps'],
        requiredValues: { ok: true, 'responseContract.maximumSteps': 3 },
        successStatuses: ['guided'],
        successSignals: ['server-owned edition guide returned'],
        limitations: ['This receipt teaches usage and is never evidence that business work was completed.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'industry.user-guide.observe',
      operation: 'observe',
      subjectArgument: 'entryId',
      limitations: ['Read-only guidance; never proves execution or delivery.'],
    }),
  });

  registry.register({
    name: 'industry_guidance_preference_set',
    description: 'Remember an explicit user preference for beginner, skilled, or professional guidance and explain, guided, or delegate mode. Use only when the user explicitly asks Lumi to remember or use that default.',
    routingHints: [
      'remember guidance preference',
      'default guidance mode',
      '\u8bb0\u4f4f\u6211\u662f\u65b0\u624b', '\u4ee5\u540e\u8fb9\u6559\u8fb9\u505a', '\u9ed8\u8ba4\u53ea\u8bb2\u89e3', // i18n-allow: Reviewed input aliases.
    ],
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['beginner', 'skilled', 'professional'] },
        mode: { type: 'string', enum: ['explain', 'guided', 'delegate'] },
        familiarEntryId: { type: 'string', description: 'Optional exact workspace the user says they already know.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const profile = getCurrentIndustryCapabilityProfile();
      if (!profile) throw new Error('This runtime has no industry capability profile.');
      const level = String(args.level || '').trim();
      const mode = String(args.mode || '').trim();
      const familiarEntryId = String(args.familiarEntryId || '').trim();
      if (!level && !mode && !familiarEntryId) {
        throw new Error('At least one explicit guidance preference is required.');
      }
      if (level && !['beginner', 'skilled', 'professional'].includes(level)) {
        throw new Error('Unsupported guidance level.');
      }
      if (mode && !['explain', 'guided', 'delegate'].includes(mode)) {
        throw new Error('Unsupported guidance mode.');
      }
      if (familiarEntryId && !profile.entries.some(entry => entry.entryId === familiarEntryId)) {
        throw new Error(`Industry entry is not available in this edition: ${familiarEntryId}`);
      }
      const preference = setIndustryGuidancePreference(scope(context), {
        ...(level ? { level: level as 'beginner' | 'skilled' | 'professional' } : {}),
        ...(mode ? { mode: mode as 'explain' | 'guided' | 'delegate' } : {}),
        ...(familiarEntryId ? { familiarEntryId } : {}),
      });
      return JSON.stringify({
        ok: true,
        status: 'saved',
        persisted: true,
        variantId: profile.variantId,
        preference,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.user-guide.preference',
      family: 'industry',
      lane: 'industry',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'user and workspace scoped industry guidance preference', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'variantId', 'preference.level', 'preference.mode'],
        requiredValues: { ok: true, persisted: true },
        successStatuses: ['saved'],
        successSignals: ['scoped guidance preference persisted'],
        limitations: ['Changes teaching style only; it never grants permission for business side effects.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'industry.user-guide.preference',
      operation: 'mutate',
      subjectArgument: 'mode',
      limitations: ['Teaching preference does not bypass confirmations or professional review.'],
    }),
  });
}
