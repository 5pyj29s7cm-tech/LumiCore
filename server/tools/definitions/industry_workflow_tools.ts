import { ToolRegistry } from '../registry';
import { readBusinessLegacyArchive } from '../../industry/legacy_archive';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { getCurrentIndustryCapabilityProfile, matchCurrentIndustryWorkflow } from '../../industry/business_catalog';
import {
  getIndustryWorkflowTask,
  listIndustryWorkflowTasks,
  recordIndustryWorkflowExecution,
  startIndustryWorkflow,
  startOrReuseIndustryWorkflow,
} from '../../industry/workflow_service';
import type { ToolContext } from '../types';
import {
  bindIndustryWorkspaceContext,
  getActiveIndustryWorkspaceContext,
  listIndustryWorkspaceContexts,
  selectIndustryWorkspaceContext,
  workflowWorkspaceContext,
} from '../../industry/workspace_context';
import { executeEcommerceTodaySnapshot } from '../../industry/ecommerce_today_snapshot';
import { executeEcommerceStoreDataSnapshot } from '../../industry/ecommerce_store_data_snapshot';
import { executeEcommerceListingActionQueue } from '../../industry/ecommerce_listing_action_queue';
import { executeEcommerceCustomerServiceDrafts } from '../../industry/ecommerce_customer_service_drafts';
import { executeEcommerceTrendDiscovery } from '../../industry/ecommerce_trend_discovery';
import { assertBoundedTrendResearchEvidence } from '../../industry/research_constraints';

// i18n-allow: The multilingual routing hints below are internal tool-selection
// aliases for Chinese industry requests; they are never rendered as UI copy.

function scope(context?: ToolContext) {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain === 'work' ? 'work' as const : 'personal' as const,
    orgId: context?.domain === 'work' ? String(context?.orgId || '') : '',
  };
}

export function registerIndustryWorkflowTools(registry: ToolRegistry): void {
  registry.register({
    name: 'business_archive_get',
    description: 'Search the signed-in user\'s imported Commerce or Finance history. Historical/test records are references, never current store facts or authorization to resume old actions.',
    parameters: { type: 'object', properties: { line: { type: 'string', enum: ['ecommerce', 'finance'] }, query: { type: 'string' } }, required: ['line'] },
    handler: async (args, context) => {
      if (context?.domain === 'work') throw new Error('Personal edition history is unavailable in an organization context');
      const archive = readBusinessLegacyArchive(context?.userId || '', args.line);
      const query = String(args.query || '').trim().toLowerCase();
      const matches = (rows: any[]) => rows.filter(row => !query || JSON.stringify(row).toLowerCase().includes(query)).slice(-10);
      return JSON.stringify({ ok: true, historical: true, importedAt: archive?.importedAt, tasks: matches(archive?.tasks || []).map(task => ({ id: task.id, title: task.title, status: task.status, result: String(task.result || '').slice(0, 5000), source: task.source })), interactions: matches(archive?.tables.interactions || []).map(row => ({ id: row.id, conversationId: row.conversationId, role: row.role, message: String(row.message || row.content || '').slice(0, 4000), createdAt: row.createdAt })) });
    }, permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({ id: 'business.archive.read', family: 'industry', lane: 'industry', operation: 'observe', risk: 'low', sideEffects: [{ type: 'local_read', scope: 'owner-scoped imported history', reversible: true }], verification: { strategy: 'measured', required: true, requiredFields: ['ok', 'historical', 'tasks'], requiredValues: { ok: true, historical: true }, successSignals: ['scoped local archive read'], limitations: ['Historical references are not current business facts.'] } }),
    evidence: capabilityEvidence({ id: 'business.archive.read', operation: 'observe' }),
  });


  registry.register({
    name: 'industry_ecommerce_today_snapshot',
    description: 'In the Lumi business workspace: calculate and persist a source-bound daily operating snapshot from explicitly labelled inline revenue, order, ad, refund, after-sales, and SKU inventory facts. Missing cost fields remain missing; this tool never connects to or mutates a store.',
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['today operations snapshot', '\u4eca\u65e5\u7ecf\u8425\u5feb\u7167', '\u7ecf\u8425\u65e5\u62a5\u8ba1\u7b97'],
    parameters: {
      type: 'object',
      properties: {
        sourceBound: { type: 'boolean', description: 'Must be true; the exact source is read from the current server-bound turn.' },
      },
      required: ['sourceBound'],
    },
    handler: async (args, context) => {

      if (args.sourceBound !== true) throw new Error('A server-bound source is required.');
      return JSON.stringify(executeEcommerceTodaySnapshot(context), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.ecommerce.today-snapshot', family: 'industry', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent source-bound operating snapshot and task receipt', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'taskId', 'sourceBound', 'externalMutation', 'snapshot.revenue', 'snapshot.orders'],
        requiredValues: { ok: true, persisted: true, sourceBound: true, externalMutation: false },
        successStatuses: ['verified'],
        successSignals: ['source-bound calculated snapshot and persistent verification receipt'],
        limitations: ['Uses only labelled inline facts; missing cost fields are reported and no external store is accessed.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.ecommerce.today-snapshot', operation: 'create', limitations: ['Local verified analysis only; no external store mutation.'] }),
  });
  registry.register({
    name: 'industry_ecommerce_store_data_snapshot',
    description: 'In the Lumi business workspace: calculate and persist a source-bound store-data diagnosis from explicitly labelled inline platform, period, revenue, order, ad, refund, and per-SKU inventory/daily-sales facts. It never reads a prior workspace or external store.',
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['store data diagnosis', 'inline store metrics', '\u5e97\u94fa\u6570\u636e\u8bca\u65ad', '\u5185\u8054\u5e97\u94fa\u6307\u6807'],
    parameters: {
      type: 'object',
      properties: {
        sourceBound: { type: 'boolean', description: 'Must be true; the exact inline source is read from the current server-bound turn.' },
      },
      required: ['sourceBound'],
    },
    handler: async (args, context) => {

      if (args.sourceBound !== true) throw new Error('A server-bound inline source is required.');
      return JSON.stringify(executeEcommerceStoreDataSnapshot(context), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.ecommerce.store-data-snapshot', family: 'industry', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent source-bound store-data diagnosis and task receipt', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'taskId', 'sourceBound', 'externalMutation', 'snapshot.averageOrderValue', 'snapshot.roas', 'snapshot.inventory'],
        requiredValues: { ok: true, persisted: true, sourceBound: true, externalMutation: false },
        successStatuses: ['verified'],
        successSignals: ['source-bound store metrics, field mappings, formulas, risks, and persistent verification receipt'],
        limitations: ['Uses only labelled inline facts; missing fields remain missing and no old workspace or external platform is read.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.ecommerce.store-data-snapshot', operation: 'create', limitations: ['Local verified inline-data analysis only; no external store access or mutation.'] }),
  });
  registry.register({
    name: 'industry_ecommerce_listing_action_queue',
    description: 'In the Lumi business workspace: calculate and persist a review-only SKU action queue from explicitly labelled inline price, cost, fee, inventory, sales, lead-time, refund, and reason facts. It never lists, delists, reprices, publishes, purchases, or mutates inventory.',
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['reviewable sku action queue', 'inline product management', '\u5546\u54c1\u7ba1\u7406\u52a8\u4f5c\u961f\u5217', '\u5185\u8054 SKU \u5ba1\u6838'],
    parameters: {
      type: 'object',
      properties: {
        sourceBound: { type: 'boolean', description: 'Must be true; exact SKU facts come from the current server-bound turn.' },
      },
      required: ['sourceBound'],
    },
    handler: async (args, context) => {

      if (args.sourceBound !== true) throw new Error('A server-bound inline SKU source is required.');
      return JSON.stringify(executeEcommerceListingActionQueue(context), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.ecommerce.listing-action-queue', family: 'industry', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent review-only SKU action queue and task receipt', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'taskId', 'sourceBound', 'externalMutation', 'actionQueueOnly', 'snapshot.unitContributionProfit', 'snapshot.refundRate'],
        requiredValues: { ok: true, persisted: true, sourceBound: true, externalMutation: false, actionQueueOnly: true },
        successStatuses: ['verified'],
        successSignals: ['source-bound SKU calculations, review queue, evidence gaps, approval boundaries, and persistent receipt'],
        limitations: ['Draft and review only; every store mutation or external communication remains item-level approval-gated.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.ecommerce.listing-action-queue', operation: 'create', limitations: ['Local review-only queue; no listing, pricing, publishing, procurement, inventory, or customer action.'] }),
  });
  registry.register({
    name: 'industry_ecommerce_customer_service_drafts',
    description: 'In the Lumi business workspace: classify a masked customer-service case and persist non-committal reply and FAQ drafts from exact inline policy facts. It never sends, publishes, refunds, compensates, or exposes unmasked personal data.',
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['masked customer service drafts', 'non-committal faq draft', '\u8131\u654f\u5ba2\u670d\u8349\u7a3f', '\u5185\u5bb9\u4e0e\u5ba2\u670d\u5ba1\u6838'],
    parameters: {
      type: 'object',
      properties: {
        sourceBound: { type: 'boolean', description: 'Must be true; masked facts and policy come from the current server-bound turn.' },
      },
      required: ['sourceBound'],
    },
    handler: async (args, context) => {

      if (args.sourceBound !== true) throw new Error('A server-bound masked source is required.');
      return JSON.stringify(executeEcommerceCustomerServiceDrafts(context), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.ecommerce.customer-service-drafts', family: 'industry', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent masked customer-service and FAQ draft receipt', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'taskId', 'sourceBound', 'externalMutation', 'draftOnly', 'privacyVerified', 'snapshot.replyDraft', 'snapshot.faqDraft'],
        requiredValues: { ok: true, persisted: true, sourceBound: true, externalMutation: false, draftOnly: true, privacyVerified: true },
        successStatuses: ['verified'],
        successSignals: ['masked classification, conditional policy validation, non-committal drafts, escalation rules, approval boundaries, and persistent receipt'],
        limitations: ['Draft only; sending, publishing, refunding, freight allocation, compensation, and exceptions require accountable approval.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.ecommerce.customer-service-drafts', operation: 'create', limitations: ['Masked local drafts only; no messaging, publishing, refund, freight, or compensation action.'] }),
  });
  registry.register({
    name: 'industry_ecommerce_trend_discovery',
    description: 'In the Lumi business workspace: run a bounded public-source trend discovery workflow from the exact server-bound user request. It persists a task and returns either dated, publicly fetchable URL receipts or an explicit blocker; it never logs in, purchases, advertises, or publishes.',
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['bounded trend discovery', 'ecommerce trend radar', '\u7206\u6b3e\u96f7\u8fbe', '\u516c\u5f00\u6765\u6e90\u8d8b\u52bf'],
    parameters: {
      type: 'object',
      properties: {
        sourceBound: { type: 'boolean', description: 'Must be true; constraints and business fields come from the exact current server-bound turn.' },
      },
      required: ['sourceBound'],
    },
    handler: async (args, context) => {

      if (args.sourceBound !== true) throw new Error('A server-bound source is required.');
      return JSON.stringify(await executeEcommerceTrendDiscovery(context), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.ecommerce.trend-discovery', family: 'industry', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent bounded public-source trend task and receipts', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['status', 'persisted', 'taskId', 'sourceCount', 'sourceLimit', 'externalMutation'],
        requiredValues: { persisted: true, externalMutation: false },
        successStatuses: ['verified', 'blocked'],
        successSignals: ['dated publicly fetchable source receipts or explicit no-source blocker'],
        limitations: ['Public read-only research only; no login, purchase, advertising, or publishing.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.ecommerce.trend-discovery', operation: 'create', limitations: ['Bounded public-source research; business actions remain confirmation-gated.'] }),
  });
  registry.register({
    name: 'industry_capability_profile_get',
    description: 'Read the authoritative identity, outcome workspaces, automatic preparation actions, professional-review boundaries, and optional extensions for this exact Lumi industry edition.',
    // i18n-allow: Reviewed Chinese input-recognition aliases; not user-visible copy.
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['this Lumi edition', 'industry capabilities', 'what can you do', '你是什么版本', '你能做什么', '自动流程', '半自动流程'],
    parameters: {
      type: 'object',
      properties: { request: { type: 'string', description: 'Optional natural-language industry request to classify without starting work.' } },
      required: [],
    },
    handler: async (args) => {
      const profile = getCurrentIndustryCapabilityProfile();
      if (!profile) throw new Error('This runtime has no industry capability profile.');
      const match = args.request ? matchCurrentIndustryWorkflow(args.request) : null;
      return JSON.stringify({
        ok: true, status: 'observed', profile,
        match: match ? { entryId: match.entry.entryId, displayName: match.entry.displayName, score: match.score, matchedTerms: match.matchedTerms } : null,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.capability-profile.observe', family: 'industry', lane: 'industry', operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'none', scope: 'industry capability profile', reversible: true }],
      verification: {
        strategy: 'measured', required: true,
        requiredFields: ['ok', 'status', 'profile.variantId', 'profile.productLine', 'profile.entries'],
        requiredValues: { ok: true }, successStatuses: ['observed'],
        successSignals: ['server-owned profile returned'],
        limitations: ['Describes registered edition workflows; external connectors still require runtime health checks.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.capability-profile.observe', operation: 'observe', subjectArgument: 'request', limitations: ['Does not execute an industry workflow.'] }),
  });

  registry.register({
    name: 'industry_workspace_status',
    description: 'Read the active persistent business workspace for the current user and organization: store/account for e-commerce, case for legal, or entity/tax period for finance. Use before interpreting phrases such as this store, this case, this company, current period, or continue the previous work.',
    // i18n-allow: Reviewed Chinese industry workspace input-recognition phrases; not user-visible copy.
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['current store', 'current case', 'current company', 'current tax period', '当前店铺', '当前案件', '当前企业', '当前账期', '这家店', '这个案件'],
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => {
      const activeScope = scope(context);
      return JSON.stringify({
        ok: true,
        status: 'observed',
        active: getActiveIndustryWorkspaceContext(activeScope),
        available: listIndustryWorkspaceContexts(activeScope),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.workspace.observe', family: 'industry', lane: 'industry', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'business-scoped persistent business workspace', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'available'], requiredValues: { ok: true }, successStatuses: ['observed'], successSignals: ['server-owned active workspace state'], limitations: ['An unbound workspace must not be guessed from model memory.'] },
    }),
    evidence: capabilityEvidence({ id: 'industry.workspace.observe', operation: 'observe', limitations: ['Reads local workspace identity only.'] }),
  });

  registry.register({
    name: 'industry_workspace_bind',
    description: 'Create, update, or select the persistent business workspace used by voice, chat, and industry tasks. Fields are edition-filtered: e-commerce store/platform/account/period, legal case identity, or finance entity/taxpayer/jurisdiction/accounting period.',
    // i18n-allow: Reviewed Chinese industry workspace input-recognition phrases; not user-visible copy.
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['bind store', 'select store', 'bind case', 'select case', 'bind company', 'select company', '绑定店铺', '切换店铺', '设为当前案件', '绑定企业', '切换账期'],
    parameters: {
      type: 'object',
      properties: {
        productLine: { type: 'string', enum: ['ecommerce', 'finance'], description: 'Business module owning this store or company.' },
        id: { type: 'string', description: 'Existing industry_subject_* id to select.' },
        name: { type: 'string', description: 'Human-readable store, case, or entity name.' },
        platform: { type: 'string' }, storeId: { type: 'string' }, accountLabel: { type: 'string' }, reportingPeriod: { type: 'string' }, timezone: { type: 'string' },
        caseId: { type: 'string' }, caseName: { type: 'string' }, caseNumber: { type: 'string' }, clientName: { type: 'string' }, court: { type: 'string' }, stage: { type: 'string' },
        entityName: { type: 'string' }, taxpayerId: { type: 'string' }, jurisdiction: { type: 'string' }, taxpayerType: { type: 'string' }, accountingPeriod: { type: 'string' }, currency: { type: 'string' }, accountingBasis: { type: 'string' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const activeScope = scope(context);
      const id = String(args.id || '').trim();
      const workspace = id
        ? selectIndustryWorkspaceContext(activeScope, id)
        : bindIndustryWorkspaceContext(activeScope, { productLine: args.productLine, name: args.name, attributes: args });
      return JSON.stringify({ ok: true, status: id ? 'selected' : 'bound', persisted: true, active: workspace }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.workspace.bind', family: 'industry', lane: 'industry', operation: 'mutate', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'business-scoped active business workspace selection', reversible: true }],
      verification: { strategy: 'state_diff', required: true, requiredFields: ['ok', 'status', 'persisted', 'active.id', 'active.productLine'], requiredValues: { ok: true, persisted: true }, successStatuses: ['bound', 'selected'], successSignals: ['persisted active workspace returned'], limitations: ['Does not log in to or mutate an external business system.'] },
    }),
    evidence: capabilityEvidence({ id: 'industry.workspace.bind', operation: 'mutate', subjectArgument: 'name', limitations: ['Binds local business identity only.'] }),
  });

  registry.register({
    name: 'industry_workflow_start',
    description: 'Start exactly one persistent, business-scoped industry outcome workflow from a natural-language request. Returns the existing task on an idempotent retry. Continue it with real domain tools and verify before claiming completion.',
    // i18n-allow: Reviewed Chinese industry-workspace aliases; not user-visible copy.
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['industry workflow', 'outcome workspace', '今日经营', '爆款雷达', '店铺数据', '商品管理', '内容与客服', '设计项目', 'CAD 方案', '效果图', '提案 PPT', '交付中心', '案件工作台', '文书生成', '合同审查', '法条与类案', '财产线索', '交付核验', '标书制作', '经营看板', '票税管理', '账务处理', '税务申报', '资金与风险', '报表交付'],
    parameters: {
      type: 'object',
      properties: {
        entryId: { type: 'string', description: 'Exact entry id from industry_capability_profile_get.' },
      },
      required: ['entryId'],
    },
    localIdempotencyReplay: 'durable_handler',
    handler: async (args, context) => {
      const activeScope = scope(context);
      const profile = getCurrentIndustryCapabilityProfile();
      const entryId = String(args.entryId || '').trim();
      const entry = profile?.entries.find(candidate => candidate.entryId === entryId);
      if (!profile || !entry) throw new Error(`Industry entry is not available in this edition: ${entryId}`);
      const namedTaskId = String(context?.routedTaskText || '').match(/\bwt_task_[a-zA-Z0-9_-]+\b/)?.[0] || '';
      const namedTask = namedTaskId ? getIndustryWorkflowTask(activeScope, namedTaskId) : null;
      if (namedTask?.metadata?.industryWorkflow?.entryId === entryId) {
        const metadata = namedTask.metadata.industryWorkflow;
        return JSON.stringify({
          ok: true, status: 'reused', persisted: true,
          entry: { entryId, displayName: entry.displayName }, task: namedTask,
          conversationId: metadata.conversationId,
          conversationTaskId: metadata.conversationTaskId,
          requestId: metadata.requestId,
          handoffPrompt: `Continue existing industry task ${namedTask.id}; do not create a duplicate.`,
          activeTaskCount: listIndustryWorkflowTasks(activeScope, 200).filter(task => ['queued', 'in_progress', 'waiting_confirmation', 'blocked'].includes(task.status)).length,
        }, null, 2);
      }
      const idempotencyKey = String(context?.idempotencyKey || context?.requestId || '').trim();
      const started = startOrReuseIndustryWorkflow({
        ...activeScope,
        entryId,
        sourceInput: String(context?.actionIntent || ''),
        source: context?.source || 'industry_natural_language',
        context: { source: context?.source || 'industry_natural_language' },
        idempotencyKey: idempotencyKey ? `industry-start:${idempotencyKey}:${entryId}` : undefined,
        conversationId: context?.conversationId,
        conversationTaskId: context?.taskId,
        requestId: context?.requestId,
      }, context?.industryWorkflowTaskId);
      return JSON.stringify({
        ok: true, status: started.reused ? 'reused' : 'created', persisted: true,
        entry: { entryId, displayName: entry.displayName }, task: started.task,
        conversationId: started.conversationId, conversationTaskId: started.conversationTaskId,
        requestId: started.requestId, handoffPrompt: started.handoffPrompt,
        activeTaskCount: listIndustryWorkflowTasks(activeScope, 200).filter(task => ['queued', 'in_progress', 'waiting_confirmation', 'blocked'].includes(task.status)).length,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.workflow.start', family: 'industry', lane: 'industry', operation: 'create',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent industry workflow and linked action ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'task.id', 'conversationTaskId', 'entry.entryId'],
        requiredValues: { ok: true, persisted: true }, successStatuses: ['created', 'reused'],
        successSignals: ['persistent scoped task returned'],
        limitations: ['Starts and binds the workflow; it is not proof that the requested business result is complete.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.workflow.start', operation: 'create', subjectArgument: 'entryId', limitations: ['A later verified industry receipt is required for completion.'] }),
  });

  registry.register({
    name: 'industry_workflow_complete',
    description: 'Archive and verify the active business-scoped industry workflow from real tool receipts produced earlier in this exact tool loop. Model text alone is rejected. Returns verified delivery or a concrete blocker.',
    // i18n-allow: Reviewed Chinese industry-verification aliases; not user-visible copy.
    // i18n-allow: Domain tool selection aliases; never rendered as user-facing copy.
    routingHints: ['complete industry workflow', 'verify industry result', 'archive outcome', '验收行业任务', '归档行业结果'],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The wt_task_* id returned by industry_workflow_start.' },
        resultSummary: {
          type: 'string',
          description: 'Optional evidence-grounded result summary to archive with the verified current-loop receipts. For research, include dated sources, facts versus inference, demand, competition, confidence, counter-evidence, and validation plan.',
        },
      },
      required: ['taskId'],
    },
    handler: async (args, context) => {
      const activeScope = scope(context);
      const taskId = String(args.taskId || '').trim();
      const task = getIndustryWorkflowTask(activeScope, taskId);
      if (!task) throw new Error('Industry workflow task was not found in the active user scope.');
      const previousVerification = task.metadata?.workTakeoverVerification;
      if (task.status === 'delivered' && previousVerification?.passed === true) {
        return JSON.stringify({
          ok: true, status: 'verified', persisted: true, reused: true,
          task, verification: previousVerification,
        }, null, 2);
      }
      const excluded = new Set([
        'industry_capability_profile_get',
        'industry_user_guide',
        'industry_guidance_preference_set',
        'industry_workflow_start',
        'industry_workflow_complete',
        'work_takeover_task_get',
      ]);
      const evidenceRecords = (context?.getCurrentToolRecords?.() || []).filter(record => (
        !excluded.has(record.name)
        && !record.error
        && record.terminalVerification?.status === 'verified'
        && String(record.result || '').trim()
      ));
      if (!evidenceRecords.length) {
        throw new Error('No verified domain-tool receipt exists in this execution loop. Run the real industry capability before verification.');
      }
      const receiptText = evidenceRecords.map(record => String(record.result || '')).join('\n\n').slice(0, 12_000);
      const resultSummary = String(args.resultSummary || '').trim().slice(0, 8_000);
      if (task.metadata?.industryWorkflow?.entryId === 'trend-discovery') {
        assertBoundedTrendResearchEvidence({
          sourceInput: context?.industryWorkflowSourceInput || context?.actionIntent || '',
          resultSummary,
          evidenceRecords,
        });
      }
      const archivedResult = resultSummary
        ? `${resultSummary}\n\nVerified current-loop receipts:\n${receiptText}`
        : receiptText;
      const recorded = recordIndustryWorkflowExecution({
        ...activeScope,
        taskId,
        resultText: archivedResult,
        toolRecords: evidenceRecords,
        source: context?.source || 'industry_natural_language',
      });
      return JSON.stringify({
        ok: recorded.verification.passed,
        status: recorded.verification.passed ? 'verified' : recorded.verification.status,
        persisted: true,
        task: recorded.task,
        verification: recorded.verification,
        archivedFilePaths: recorded.archivedFilePaths,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.workflow.complete', family: 'industry', lane: 'industry', operation: 'test', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'industry workflow archive, verification and linked action ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'task.id', 'verification.passed'],
        requiredValues: { ok: true, persisted: true, 'verification.passed': true },
        successStatuses: ['verified'], failureStatuses: ['blocked', 'needs_review'],
        successSignals: ['server-side industry verifier passed over current-loop receipts'],
        limitations: ['Verifies the scoped local result; it does not imply any unrequested external side effect.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.workflow.complete', operation: 'test', subjectArgument: 'taskId', limitations: ['Requires earlier verified domain-tool receipts from the same execution loop.'] }),
  });
}
