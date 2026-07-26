import {
  LUMI_MODEL_ROLES,
  getLumiModelConfiguration,
  isLumiModelRole,
  testLumiModelConfiguration,
  updateLumiModelConfiguration,
  type LumiModelRole,
} from '../../llm/model_configuration';
import type { ToolContext } from '../types';
import type { ToolRegistry } from '../registry';
import { CN_TOOL_DISCOVERY_HINTS } from '../../regions/packs/cn/tool_discovery_hints';

function safeError(error: unknown): string {
  return String((error as any)?.message || error || 'Model configuration failed')
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

function parseRelayOutput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function refreshConnectedClient(context: ToolContext | undefined, roles: LumiModelRole[]) {
  if (!context?.desktopRelay) return { connected: false, refreshed: false };
  try {
    const raw = await context.desktopRelay('client_action', {
      action: 'refresh_model_configuration',
      payload: { roles },
    });
    return { connected: true, refreshed: true, result: parseRelayOutput(raw) };
  } catch (error) {
    return { connected: false, refreshed: false, error: safeError(error) };
  }
}

function requiredRole(value: unknown): LumiModelRole {
  if (!isLumiModelRole(value)) throw new Error(`Unsupported model role: ${String(value || '')}`);
  return value;
}

export function registerModelConfigurationTools(registry: ToolRegistry): void {
  registry.register({
    name: 'model_configuration_get',
    description: 'Read or list all or one Lumi model configuration. Use before answering which model is active or before changing a role. Model configuration belongs to the Lumi user and is shared across personal and organization domains; organizations do not own a separate model policy.',
    routingHints: [...CN_TOOL_DISCOVERY_HINTS.modelConfigurationRead],
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: LUMI_MODEL_ROLES,
          description: 'Optional role. Omit to read every role. Vision is visual perception; world is desktop action planning; image/video generation and embedding/rerank are independent subroles.',
        },
      },
      required: [],
    },
    handler: async (args, context) => {
      const role = args.role === undefined ? undefined : requiredRole(args.role);
      return JSON.stringify(getLumiModelConfiguration(context?.userId || 'anonymous', role), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'model.configuration',
      operation: 'observe',
      assurance: 'observed',
      subjectArgument: 'role',
    },
  });

  registry.register({
    name: 'model_configuration_update',
    description: 'Directly change one model role without using mouse or keyboard automation. Use only when the user explicitly asks Lumi to select, fill, switch, enable, disable, or replace a model/provider; never change configuration merely to complete another task or during autonomous learning. The update applies to the same Lumi in personal and organization domains. It preserves other role selections, refreshes the connected client, and tests the effective route by default. This tool never accepts or returns API keys.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: LUMI_MODEL_ROLES,
          description: 'Role to update: reasoning, vision, world, image_generation, video_generation, embedding, rerank, speech_recognition, or speech_synthesis.',
        },
        provider: {
          type: 'string',
          description: 'Provider id. Examples: reasoning=openai/deepseek/qwen/ollama; world=inherit_vision/openai/qwen; image=openai/qwen/siliconflow/auto; video=qwen/minimax/siliconflow/openai.',
        },
        model: {
          type: 'string',
          description: 'Exact model id. Speech roles select provider-managed models and therefore do not accept this field.',
        },
        fallbackProvider: {
          type: 'string',
          description: 'Embedding-only fallback provider. Use an empty string to disable fallback.',
        },
        fallbackModel: {
          type: 'string',
          description: 'Embedding-only fallback model id.',
        },
        enabled: {
          type: 'boolean',
          description: 'Rerank-only enabled state.',
        },
        topN: {
          type: 'number',
          description: 'Rerank-only number of candidates to retain, from 1 to 50.',
        },
        testAfterUpdate: {
          type: 'boolean',
          description: 'Run a live or adapter-level verification after saving. Defaults to true.',
        },
      },
      required: ['role'],
    },
    handler: async (args, context) => {
      const role = requiredRole(args.role);
      const updated = updateLumiModelConfiguration(context?.userId || 'anonymous', {
        role,
        provider: args.provider,
        model: args.model,
        fallbackProvider: args.fallbackProvider,
        fallbackModel: args.fallbackModel,
        enabled: args.enabled,
        topN: args.topN,
      });
      const client = await refreshConnectedClient(context, [role]);
      let test: Record<string, unknown> | null = null;
      if (args.testAfterUpdate !== false) {
        try {
          test = await testLumiModelConfiguration(
            context?.userId || 'anonymous',
            role,
            context?.llmGetters || {},
          );
        } catch (error) {
          test = { ok: false, error: safeError(error) };
        }
      }
      const verified = test?.ok === true;
      const verificationRequested = args.testAfterUpdate !== false;
      return JSON.stringify({
        ok: verificationRequested ? verified : true,
        saved: true,
        verified,
        status: verificationRequested
          ? (verified ? 'saved_and_verified' : 'saved_but_test_failed')
          : 'saved_unverified',
        scope: 'lumi',
        sharedAcrossPersonalAndOrganizationDomains: true,
        organizationOverridesSupported: false,
        updated,
        test,
        client,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'model.configuration.update',
      family: 'model_configuration',
      lane: 'client',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'Lumi model-role preferences', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['saved', 'status', 'updated'],
        requiredValues: { saved: true },
        successStatuses: ['saved_and_verified', 'saved_unverified'],
        successSignals: ['the selected role was persisted and the connected client refresh was attempted'],
        limitations: ['saved_unverified proves the configuration write, not provider reachability.'],
      },
    },
    evidence: {
      capability: 'model.configuration.update',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'role',
      limitations: ['Provider availability is separate from persistence of the selected route.'],
    },
  });

  registry.register({
    name: 'model_configuration_test',
    description: 'Test the current provider and model route for one Lumi role. Reasoning, vision, world, embedding, and enabled rerank use live model calls; generation verifies adapter and credential readiness without generating a paid artifact; voice verifies the active healthy adapter.',
    routingHints: [...CN_TOOL_DISCOVERY_HINTS.modelRouteTest],
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: LUMI_MODEL_ROLES,
          description: 'Model role to test.',
        },
      },
      required: ['role'],
    },
    handler: async (args, context) => {
      const role = requiredRole(args.role);
      try {
        const result = await testLumiModelConfiguration(
          context?.userId || 'anonymous',
          role,
          context?.llmGetters || {},
        );
        return JSON.stringify({ ok: true, role, result }, null, 2);
      } catch (error) {
        return JSON.stringify({ ok: false, role, error: safeError(error) }, null, 2);
      }
    },
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'model.live_route',
      operation: 'test',
      assurance: 'verified',
      subjectArgument: 'role',
    },
  });
}
