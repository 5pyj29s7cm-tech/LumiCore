import {
  externalAiHistoryStatus,
  listExternalAiHistorySources,
  queryExternalAiHistory,
  registerExternalAiHistorySource,
  revokeExternalAiHistorySource,
  syncExternalAiHistory,
} from '../../agents/external_ai_history_sync';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { ToolRegistry } from '../registry';

const SOURCE_KINDS = ['connector', 'export', 'authorized_session', 'desktop_visible'];
const HISTORY_SCOPES = ['conversation_list', 'message_metadata', 'message_content', 'attachment_metadata', 'attachment_content'];

export function registerExternalAiHistoryTools(registry: ToolRegistry): void {
  registry.register({
    name: 'external_ai_history_source_register',
    description: 'Register an immutable, explicitly authorized external AI chat-history source. Supports a read-only connector, a local JSON export, an authorized session adapter, or the currently visible desktop viewport. Credentials are never accepted or stored.',
    parameters: {
      type: 'object',
      properties: {
        sourceKind: { type: 'string', enum: SOURCE_KINDS, description: 'Authorized source mechanism.' },
        targetId: { type: 'string', description: 'Exact external AI provider or app identity.' },
        scopes: { type: 'array', items: { type: 'string', enum: HISTORY_SCOPES }, description: 'Explicit least-privilege read scopes.' },
        allowAllConversations: { type: 'boolean', description: 'Explicitly authorize all conversations exposed by this source.' },
        allowedConversationIds: { type: 'array', items: { type: 'string' }, description: 'Exact allowed conversation ids when all-conversation access is not authorized.' },
        connectorToolName: { type: 'string', description: 'Exact read-only MCP/adapter tool; required for connector and authorized_session.' },
        exportPath: { type: 'string', description: 'Exact local JSON export file path; required for export.' },
        sessionProfileId: { type: 'string', description: 'Existing credential-store/session profile reference; no cookies or credentials.' },
        allowCloudVision: { type: 'boolean', description: 'For desktop_visible only, permit the selected cloud vision model if no local vision model is healthy.' },
        since: { type: 'string', description: 'Optional ISO lower time bound.' },
        until: { type: 'string', description: 'Optional ISO upper time bound.' },
        expiresAt: { type: 'string', description: 'Optional future ISO authorization expiry.' },
      },
      required: ['sourceKind', 'targetId', 'scopes'],
    },
    handler: async (args, context) => registerExternalAiHistorySource(args, context),
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'external-ai.history.source.register',
      family: 'external-ai-history',
      lane: 'agents',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent external AI history authorization ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'sourceId', 'authorizationDigest', 'source'],
        requiredValues: { ok: true },
        successStatuses: ['registered', 'already_registered'],
        failureStatuses: ['failed'],
        successSignals: ['immutable source binding and authorization digest'],
        limitations: ['Registration authorizes reads only within the stored source and scope; it does not prove that history is available.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'external-ai.history.source.register',
      operation: 'create',
      subjectArgument: 'targetId',
      limitations: ['No credentials, tokens, cookies, or passwords are accepted by this tool.'],
    }),
  });

  registry.register({
    name: 'external_ai_history_source_list',
    description: 'List external AI history source authorizations in the current personal or organization scope, including revocation/expiry state and last synchronization metadata.',
    parameters: { type: 'object', properties: {} },
    handler: async (args, context) => listExternalAiHistorySources(args, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'external-ai.history.source.list', family: 'external-ai-history', lane: 'agents', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'external AI history authorization ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'sources', 'count'],
        requiredValues: { ok: true, status: 'listed' }, successStatuses: ['listed'], failureStatuses: ['failed'],
        successSignals: ['sources are isolated by user, domain, and organization'], limitations: [],
      },
    }),
    evidence: capabilityEvidence({ id: 'external-ai.history.source.list', operation: 'observe' }),
  });

  registry.register({
    name: 'external_ai_history_source_revoke',
    description: 'Revoke an external AI history source authorization. Existing locally archived records remain attributable, but no future synchronization is allowed.',
    parameters: {
      type: 'object',
      properties: { sourceId: { type: 'string', description: 'Persistent history source id.' } },
      required: ['sourceId'],
    },
    handler: async (args, context) => revokeExternalAiHistorySource(args, context),
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'external-ai.history.source.revoke', family: 'external-ai-history', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'selected external AI history authorization', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'sourceId'],
        requiredValues: { ok: true, status: 'revoked' }, successStatuses: ['revoked'], failureStatuses: ['failed'],
        successSignals: ['source status is persistently revoked'], limitations: ['Previously synchronized local records are not deleted.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'external-ai.history.source.revoke', operation: 'mutate', subjectArgument: 'sourceId' }),
  });

  registry.register({
    name: 'external_ai_history_sync',
    description: 'Synchronize an already authorized external AI history source using bounded pages, durable cursors, stable message ids, incremental deduplication, attachment scope checks, and source evidence. Desktop-visible reads capture only the current foreground viewport, prefer local vision, never scroll or submit, and are marked incomplete.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Previously confirmed source authorization id.' },
        jobId: { type: 'string', description: 'Optional interrupted/partial job id to resume from its durable cursor.' },
        pageSize: { type: 'number', description: 'Bounded records per page, 1 to 200.' },
        maxPages: { type: 'number', description: 'Bounded pages for this run, 1 to 50.' },
        restart: { type: 'boolean', description: 'Start a completed job again only when explicitly true.' },
      },
      required: ['sourceId'],
    },
    handler: syncExternalAiHistory,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'external-ai.history.sync', family: 'external-ai-history', lane: 'agents', operation: 'observe', risk: 'medium',
      sideEffects: [
        { type: 'network_read', scope: 'exact authorized external AI history connector/session', reversible: true },
        { type: 'local_read', scope: 'exact authorized JSON export or synchronized history ledger', reversible: true },
        { type: 'local_state_change', scope: 'history cursor, deduplicated archive, and source receipts', reversible: true },
        { type: 'desktop_control', scope: 'single screenshot of the already-visible authorized AI window only', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['verified', 'verificationStatus', 'status', 'sourceId', 'jobId', 'authorizationDigest', 'counts', 'pageCount', 'completeness', 'limitations'],
        requiredValues: { verified: true, verificationStatus: 'verified' },
        successStatuses: ['completed', 'partial', 'blocked', 'failed'], failureStatuses: [],
        successSignals: ['checkpoint persisted after each page', 'stable source/message identity and content digest'],
        limitations: ['A verified sync receipt does not upgrade partial, unknown, or desktop-visible completeness to complete.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'external-ai.history.sync', operation: 'observe', subjectArgument: 'sourceId',
      limitations: ['Synchronization never expands the confirmed authorization scope or submits a prompt.'],
    }),
  });

  registry.register({
    name: 'external_ai_history_status',
    description: 'Read persistent authorization, sync jobs, checkpoints, and archive counts for one external AI history source.',
    parameters: {
      type: 'object', properties: {
        sourceId: { type: 'string' }, jobId: { type: 'string', description: 'Optional job filter.' },
      }, required: ['sourceId'],
    },
    handler: async (args, context) => externalAiHistoryStatus(args, context),
    permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({
      id: 'external-ai.history.status', family: 'external-ai-history', lane: 'agents', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'external AI history ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'source', 'jobs', 'counts'],
        requiredValues: { ok: true }, successStatuses: ['active', 'revoked', 'expired'], failureStatuses: ['failed'],
        successSignals: ['status is derived from persistent authorization and sync ledgers'], limitations: [],
      },
    }),
    evidence: capabilityEvidence({ id: 'external-ai.history.status', operation: 'observe', subjectArgument: 'sourceId' }),
  });

  registry.register({
    name: 'external_ai_history_query',
    description: 'Query only locally synchronized external AI history in the current user/domain scope, preserving conversation, message, attachment, and source evidence.',
    parameters: {
      type: 'object', properties: {
        sourceId: { type: 'string' }, externalConversationId: { type: 'string' },
        query: { type: 'string', description: 'Optional local case-insensitive text filter.' },
        limit: { type: 'number', description: 'Maximum messages, 1 to 200.' },
      }, required: ['sourceId'],
    },
    handler: async (args, context) => queryExternalAiHistory(args, context),
    permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({
      id: 'external-ai.history.query', family: 'external-ai-history', lane: 'agents', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'authorized synchronized external AI history', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'sourceId', 'conversations', 'messages', 'attachments', 'count', 'completeness', 'limitations'],
        requiredValues: { ok: true, status: 'queried' }, successStatuses: ['queried'], failureStatuses: ['failed'],
        successSignals: ['every result retains source evidence'], limitations: ['Only previously synchronized records are queried.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'external-ai.history.query', operation: 'observe', subjectArgument: 'sourceId' }),
  });
}
