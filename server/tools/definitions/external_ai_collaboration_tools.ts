import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { ToolRegistry } from '../registry';
import {
  collectExternalAiAnswers,
  executeExternalAiCollaboration,
  externalAiSessionStatus,
  planExternalAiRoute,
  reconcileExternalAiCollaboration,
} from '../../agents/external_ai_collaboration';

export function registerExternalAiCollaborationTools(registry: ToolRegistry): void {
  registry.register({
    name: 'external_ai_route_plan',
    description: 'Inspect the available route for each external AI target without sending data. Route priority is API, MCP, healthy configured CLI, structured browser adapter, then desktop visual control.',
    parameters: {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' }, description: 'External AI target ids or names.' },
      },
      required: ['targets'],
    },
    handler: async (args, context) => {
      const targets = Array.isArray(args.targets) ? args.targets.map(value => String(value || '').trim()).filter(Boolean) : [];
      return JSON.stringify({
        ok: true,
        status: 'planned',
        routePriority: ['api', 'mcp', 'cli', 'structured_browser', 'desktop_visual'],
        targets: targets.map(target => ({ target, route: planExternalAiRoute(target, context) })),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'external-ai.route.plan',
      family: 'external-ai',
      lane: 'agents',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'configured external AI adapters and agents', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'routePriority', 'targets'],
        requiredValues: { ok: true, status: 'planned' },
        successStatuses: ['planned'],
        failureStatuses: ['failed'],
        successSignals: ['route availability and unavailable reasons are returned without submission'],
        limitations: ['Availability inspection is not a provider health probe and sends no question.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'external-ai.route.plan',
      operation: 'observe',
      limitations: ['A planned route does not prove the target will answer.'],
    }),
  });

  registry.register({
    name: 'external_ai_collaborate',
    description: 'Send one task to one or more external AI targets using the stable API/MCP to CLI to structured-browser to desktop-visual priority. Every target is task-bound, idempotent, independently fault-isolated, and returned with source evidence.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question or work request for the external AI collaborators.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'One to eight target ids or names.' },
        sessionId: { type: 'string', description: 'Optional existing immutable collaboration session id.' },
        targetTimeoutMs: { type: 'number', description: 'Per-target timeout, 1000 to 120000 milliseconds. Timeout never triggers a lower-priority resend.' },
      },
      required: ['question', 'targets'],
    },
    handler: executeExternalAiCollaboration,
    reconcileExternalCommit: async (args, context) => reconcileExternalAiCollaboration(args, context),
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'external-ai.collaboration.execute',
      family: 'external-ai',
      lane: 'agents',
      operation: 'communicate',
      risk: 'high',
      sideEffects: [
        { type: 'external_communication', scope: 'selected external AI targets', reversible: false },
        { type: 'desktop_control', scope: 'desktop AI windows only when higher-priority adapters are unavailable', reversible: true },
        { type: 'process_execution', scope: 'healthy user-configured external AI CLI agents only', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['verified', 'verificationStatus', 'status', 'sessionId', 'taskId', 'routePriority', 'results', 'counts'],
        requiredValues: { verified: true, verificationStatus: 'verified' },
        successStatuses: ['answered', 'partial', 'waiting', 'blocked', 'failed'],
        failureStatuses: [],
        successSignals: ['persistent task/session binding', 'per-target route and response digest', 'uncertain submissions stop without fallback resend'],
        limitations: ['verified describes the orchestration receipt; each target result must still be read by its own status and evidence.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'external-ai.collaboration.execute',
      operation: 'communicate',
      subjectArgument: 'targets',
      limitations: ['Pending or unknown targets are never represented as answered.'],
    }),
  });

  registry.register({
    name: 'external_ai_collect_answers',
    description: 'Collect only previously submitted external AI answers for a persistent collaboration session. It never resends the question; late answers are archived with route and source evidence.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Persistent collaboration session id.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Optional subset of targets.' },
        waitMs: { type: 'number', description: 'Optional wait before read-only collection, maximum 60000 milliseconds.' },
      },
      required: ['sessionId'],
    },
    handler: collectExternalAiAnswers,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'external-ai.answers.collect',
      family: 'external-ai',
      lane: 'agents',
      operation: 'observe',
      risk: 'medium',
      sideEffects: [
        { type: 'network_read', scope: 'authorized external AI result adapters', reversible: true },
        { type: 'desktop_control', scope: 'visible answer collection for existing desktop submissions', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['status', 'sessionId', 'answers', 'dispatches', 'counts', 'completeness'],
        successStatuses: ['answered', 'partial', 'waiting', 'blocked', 'failed'],
        failureStatuses: [],
        successSignals: ['answers are linked to an existing dispatch and response digest'],
        limitations: ['Desktop-visible answers may be partial; collection never submits a new prompt.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'external-ai.answers.collect',
      operation: 'observe',
      subjectArgument: 'sessionId',
      limitations: ['Only archived answers with source evidence are attributable.'],
    }),
  });

  registry.register({
    name: 'external_ai_session_status',
    description: 'Read a persistent external AI collaboration session, including task binding, per-target route/status, archived answers, late-answer markers, and source evidence.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Persistent collaboration session id.' },
      },
      required: ['sessionId'],
    },
    handler: async (args, context) => externalAiSessionStatus(args, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'external-ai.session.status',
      family: 'external-ai',
      lane: 'agents',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'persistent external AI collaboration ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'sessionId', 'session', 'dispatches', 'answers', 'counts'],
        requiredValues: { ok: true },
        successStatuses: ['active', 'waiting', 'answered', 'partial', 'blocked', 'failed'],
        failureStatuses: [],
        successSignals: ['status is derived from the persistent dispatch and answer ledger'],
        limitations: ['Status does not infer content that no adapter or visible evidence returned.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'external-ai.session.status',
      operation: 'observe',
      subjectArgument: 'sessionId',
    }),
  });
}
