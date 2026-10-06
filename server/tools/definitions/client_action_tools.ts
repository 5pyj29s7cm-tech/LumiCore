import type { ToolRegistry } from '../registry';
import { getClientActionExpectation, getClientState, getClientStateDigest, verifyClientActionResult } from '../../client/self_model';
import { isExplicitSensitiveClientActionRequest } from '../action_constitution';
import { sanitizeDiagnosticValue } from '../../client/diagnostic_sanitizer';
import { ACTIONS, ACTIONS_WITH_INTERNAL_REFRESH, delay, parseRelayOutput, waitForClientStateAfter } from './client_self_shared';

export function registerClientActionTools(registry: ToolRegistry): void {
  registry.register({
    name: 'client_action',
    description: [
      'Safely control Lumi client UI surfaces through the client action router.',
      'Use the explicit action from the complete personal-client interface registry, including personality, notifications, reminders, devices, token usage, terminal, profile, MCP settings, Voice Forge, skill generation, app launcher, knowledge, organization, meeting, and runtime surfaces.',
      'This does not use mouse/keyboard control and should be preferred over computer_use for Lumi client UI navigation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'Client action to perform.',
        },
        target: {
          type: 'string',
          description: 'Target surface id for close_client_surface.',
        },
        mode: {
          type: 'string',
          enum: ['meeting', 'assistant'],
          description: 'Legacy capture-state compatibility field. Use start_meeting_mode/end_meeting_mode for capture; Lumi has no operation mode selector.',
        },
        task: {
          type: 'string',
          description: 'Optional context text for routed client actions.',
        },
        payload: {
          type: 'object',
          description: 'Optional structured payload for a registered client action.',
        },
        resetNotes: {
          type: 'boolean',
          description: 'Optional meeting action flag to reset captured notes before starting meeting mode.',
        },
        legalCaseTitle: {
          type: 'string',
          description: 'Optional case title for legal meeting capture.',
        },
        enabled: {
          type: 'boolean',
          description: 'Desired boolean state, currently used by set_wallpaper_mode.',
        },
        section: {
          type: 'string',
          description: 'Optional section. For open_organization_workspace use dashboard, kb, chat, messaging, templates, review, members, audit, settings, branch, legal, spatial-design, or brand-design. For open_settings use general, neural/autonomy, ai-providers, external-connections, tools, reasoning-model, world-model, generation-model, retrieval-model, voice-model, security, hardware, voice, or computer. Legacy data-sources and applications requests open the matching tab in External Connections. Legacy app-tools, connections-tools, and MCP aliases route to tools; document-model aliases route to world-model; safety-model aliases route to security; model-routing/llm/world/generation/voice-service aliases route to their canonical settings sections.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set true only when the user explicitly confirmed a confirmation-sensitive action.',
        },
      },
      required: ['action'],
    },
    handler: async (args, context) => {
      if (!context?.desktopRelay) {
        throw new Error('Client actions require the Lumi desktop client relay.');
      }
      const userId = context?.userId || 'anonymous';
      const userConfirmed = Boolean(
        context.userConfirmed
        || isExplicitSensitiveClientActionRequest(args, context),
      );
      const payload = {
        action: args.action,
        target: args.target || '',
        mode: args.mode || '',
        task: args.task || '',
        payload: args.payload,
        resetNotes: Boolean(args.resetNotes),
        legalCaseTitle: args.legalCaseTitle || '',
        enabled: Boolean(args.enabled),
        section: args.section || '',
        confirmed: userConfirmed,
      };
      const before = getClientState(userId);
      const expectation = getClientActionExpectation(payload);
      const previousUpdatedAt = before?.updatedAt || 0;
      const rawRelayOutput = await context.desktopRelay('client_action', payload);
      const relayResult = parseRelayOutput(rawRelayOutput);
      let refreshResult: any = null;

      if (!ACTIONS_WITH_INTERNAL_REFRESH.has(String(args.action || ''))) {
        await delay(140);
        try {
          const rawRefresh = await context.desktopRelay('client_action', { action: 'refresh_client_state' });
          refreshResult = parseRelayOutput(rawRefresh);
        } catch (err: any) {
          refreshResult = { ok: false, error: err?.message || String(err) };
        }
      }

      const after = await waitForClientStateAfter(userId, previousUpdatedAt);
      const verification = verifyClientActionResult(payload, before, after, relayResult);
      return JSON.stringify(sanitizeDiagnosticValue({
        ok: verification.status === 'verified' || verification.status === 'not_applicable',
        action: payload.action,
        target: payload.target || expectation.target || '',
        mode: payload.mode || expectation.mode || '',
        section: payload.section || '',
        expectation,
        relayResult,
        refreshResult,
        verification,
        before: getClientStateDigest(before),
        after: getClientStateDigest(after),
        say: verification.message,
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'client.surface.action',
      family: 'client',
      lane: 'client',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{
        type: 'desktop_control',
        scope: 'Lumi client surface state only',
        reversible: true,
      }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['verification.status'],
        successSignals: ['verified client state or explicit not_applicable result'],
        limitations: ['A routed action without the refreshed client-state verification remains pending.'],
      },
      domains: ['client'],
      intents: ['navigate or change a registered Lumi client surface'],
    },
    evidence: {
      capability: 'client.surface.action',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'action',
      limitations: ['Sensitive meeting and wallpaper actions still follow their explicit intent boundary.'],
    },
  });
}
