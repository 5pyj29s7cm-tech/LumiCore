import type { WechatWorkCategory } from '../work_takeover/wechat_intake';

// i18n-allow-file: These multilingual tokens are machine evidence terms used
// by the server-side verifier. They are never rendered as user-facing copy.

export type IndustryProductLine = 'ecommerce' | 'design' | 'legal' | 'finance';

export interface IndustryWorkflowContract {
  productLine: IndustryProductLine;
  entryId: string;
  title: string;
  category: WechatWorkCategory;
  recommendedWorkflow: string;
  nextActions: string[];
  requiredArtifactLabels: string[];
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  expectedContentTerms: string[];
  confirmationBoundaries: string[];
  requiresFileArtifact: boolean;
  acceptedFileExtensions: string[];
  /** Preferred executable capabilities for this exact outcome workspace. */
  executionTools?: string[];
  /** Canonical verified tool receipts that must exist before delivery. */
  requiredToolReceipts?: string[];
  requiredToolEvidence?: string[];
  draftRequired?: boolean;
  minMatchedContentTerms?: number;
}

const ECOMMERCE_CONTRACTS: IndustryWorkflowContract[] = [
  {
    productLine: 'ecommerce',
    entryId: 'today-operations',
    title: 'Today operations',
    category: 'store',
    recommendedWorkflow: 'Import current-period records, calculate the operating snapshot, identify anomalies, prepare an action list, and archive the reviewed snapshot.',
    nextActions: ['Confirm platform and reporting period', 'Read sales, order, campaign, inventory, after-sales, and review records', 'Calculate the operating snapshot and anomalies', 'Archive sources, calculation basis, and action list'],
    requiredArtifactLabels: ['Operating snapshot'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['revenue', 'order', 'margin', 'inventory', 'risk', '\u9500\u552e\u989d', '\u8ba2\u5355', '\u5229\u6da6', '\u5e93\u5b58', '\u5f02\u5e38'],
    confirmationBoundaries: ['External store changes, messages, publishing, price changes, and advertising spend require accountable approval and provider receipts.'],
    requiresFileArtifact: false,
    acceptedFileExtensions: [],
    executionTools: [
      'industry_ecommerce_today_snapshot',
      'business_ecommerce_ecommerce_order_profit',
      'business_ecommerce_campaign_roi_analyzer',
      'business_ecommerce_after_sales_risk_report',
      'read_xlsx',
      'read_file',
    ],
    requiredToolReceipts: ['industry_ecommerce_today_snapshot'],
    minMatchedContentTerms: 2,
  },
  {
    productLine: 'ecommerce',
    entryId: 'trend-discovery',
    title: 'Trend discovery',
    category: 'account',
    recommendedWorkflow: 'Collect dated market signals, separate facts from inference, rank opportunities, and archive a bounded validation plan.',
    nextActions: ['Confirm category, platform, audience, and budget ceiling', 'Collect source-dated demand and competition signals', 'Rank opportunities with confidence and counter-evidence', 'Archive candidates and small-test plan'],
    requiredArtifactLabels: ['Trend opportunity report'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['source', 'signal', 'demand', 'competition', 'confidence', 'validation', '\u6765\u6e90', '\u9700\u6c42', '\u7ade\u4e89', '\u7f6e\u4fe1', '\u9a8c\u8bc1'],
    confirmationBoundaries: ['Product selection, advertising spend, procurement, and content publishing require accountable approval.'],
    requiresFileArtifact: false,
    acceptedFileExtensions: [],
    executionTools: ['industry_ecommerce_trend_discovery', 'web_search', 'url_fetch'],
    requiredToolReceipts: ['industry_ecommerce_trend_discovery'],
    minMatchedContentTerms: 2,
  },
  {
    productLine: 'ecommerce',
    entryId: 'store-data',
    title: 'Store data',
    category: 'store',
    recommendedWorkflow: 'Normalize store reports, retain source and period, calculate operating metrics, identify data gaps, and archive the diagnosis.',
    nextActions: ['Confirm platform, currency, timezone, and period', 'Import and map store reports', 'Calculate metrics and reconcile gaps', 'Archive sources, mappings, metrics, and risks'],
    requiredArtifactLabels: ['Store data diagnosis'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['source', 'period', 'revenue', 'refund', 'inventory', 'mapping', '\u6765\u6e90', '\u671f\u95f4', '\u9500\u552e\u989d', '\u9000\u6b3e', '\u5e93\u5b58'],
    confirmationBoundaries: ['Read-only analysis may run automatically; any store mutation or external submission requires approval and a platform receipt.'],
    requiresFileArtifact: false,
    acceptedFileExtensions: [],
    executionTools: [
      'industry_ecommerce_store_data_snapshot',
      'read_xlsx',
      'read_file',
      'business_ecommerce_ecommerce_snapshot_analyzer',
      'business_ecommerce_platform_settlement_reconcile',
      'business_ecommerce_review_source_normalizer',
      'business_ecommerce_review_insight_analyzer',
    ],
    requiredToolReceipts: ['industry_ecommerce_store_data_snapshot'],
    minMatchedContentTerms: 2,
  },
  {
    productLine: 'ecommerce',
    entryId: 'listing-automation',
    title: 'Product management',
    category: 'store',
    recommendedWorkflow: 'Verify product facts and rules, prepare an auditable SKU action queue, and stop before any store mutation.',
    nextActions: ['Confirm SKU scope and business rules', 'Verify inventory, margin, returns, compliance, and required fields', 'Prepare the reviewed action queue and copy drafts', 'Request approval before any listing, delisting, price, or publish action'],
    requiredArtifactLabels: ['SKU action queue'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['SKU', 'inventory', 'margin', 'return', 'risk', 'approval', '\u5e93\u5b58', '\u6bdb\u5229', '\u9000\u6b3e', '\u98ce\u9669', '\u5ba1\u6279'],
    confirmationBoundaries: ['Listing, delisting, price changes, and publishing require item-level approval and provider receipts.'],
    requiresFileArtifact: false,
    acceptedFileExtensions: [],
    executionTools: [
      'industry_ecommerce_listing_action_queue',
      'business_ecommerce_product_listing_optimizer',
      'business_ecommerce_inventory_restock_plan',
      'business_ecommerce_after_sales_risk_report',
      'read_xlsx',
      'read_file',
    ],
    requiredToolReceipts: ['industry_ecommerce_listing_action_queue'],
    minMatchedContentTerms: 2,
  },
  {
    productLine: 'ecommerce',
    entryId: 'ai-customer-service',
    title: 'Content and customer service',
    category: 'account',
    recommendedWorkflow: 'Classify the content or service request, verify policy and customer facts, prepare reviewable drafts, and stop before sending or publishing.',
    nextActions: ['Classify content, presales, after-sales, or escalation work', 'Verify order, product, policy, privacy, and tone constraints', 'Prepare drafts and escalation recommendations', 'Request approval before sending, publishing, refunding, or promising an outcome'],
    requiredArtifactLabels: ['Content or service draft'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['customer', 'content', 'policy', 'draft', 'risk', 'escalation', '\u5ba2\u6237', '\u5185\u5bb9', '\u89c4\u5219', '\u8349\u7a3f', '\u98ce\u9669', '\u5347\u7ea7'],
    confirmationBoundaries: ['Customer messages, content publishing, refunds, compensation, and binding promises require approval and provider receipts.'],
    requiresFileArtifact: false,
    acceptedFileExtensions: [],
    executionTools: [
      'industry_ecommerce_customer_service_drafts',
      'business_ecommerce_review_source_normalizer',
      'business_ecommerce_review_insight_analyzer',
      'read_xlsx',
      'read_file',
    ],
    requiredToolReceipts: ['industry_ecommerce_customer_service_drafts'],
    draftRequired: true,
    minMatchedContentTerms: 2,
  },
];

const DESIGN_CONTRACTS: IndustryWorkflowContract[] = [
  {
    productLine: 'design', entryId: 'project', title: 'Design project', category: 'design_delivery',
    recommendedWorkflow: 'Bind the request to one design project, verify the brief and source assets, prepare the scheme, and archive the reviewed result under that project.',
    nextActions: ['Confirm project, brief, stage, and constraints', 'Read project assets without guessing missing dimensions', 'Prepare concept, layout, risks, and implementation plan', 'Archive the reviewed scheme under the source project'],
    requiredArtifactLabels: ['Project scheme'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['concept', 'layout', 'risk', 'implementation', 'brief', '\u6982\u5ff5', '\u5e03\u5c40', '\u98ce\u9669', '\u5b9e\u65bd', '\u9700\u6c42'],
    confirmationBoundaries: ['Site dimensions, structural changes, MEP conditions, final quotations, contracts, and external delivery require professional review and approval.'],
    requiresFileArtifact: false, acceptedFileExtensions: [], minMatchedContentTerms: 2,
  },
  {
    productLine: 'design', entryId: 'cad', title: 'CAD scheme', category: 'design_delivery',
    recommendedWorkflow: 'Reuse the bound project and source geometry, generate an executable CAD deliverable, verify geometry and file existence, and archive the receipt.',
    nextActions: ['Confirm source drawing and fixed conditions', 'Extract or read verified geometry', 'Generate CAD geometry without guessing dimensions', 'Verify geometry receipt and archive the CAD file under the project'],
    requiredArtifactLabels: ['Verified CAD deliverable'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['CAD', 'geometry', 'dimension', 'layer', 'verification', '\u51e0\u4f55', '\u5c3a\u5bf8', '\u56fe\u5c42', '\u9a8c\u8bc1'],
    confirmationBoundaries: ['Unverified dimensions, structural or MEP assumptions, overwriting source drawings, and external delivery require professional approval.'],
    requiresFileArtifact: true, acceptedFileExtensions: ['.dxf', '.dwg', '.cad', '.svg', '.pdf'], minMatchedContentTerms: 1,
  },
  {
    productLine: 'design', entryId: 'visualization', title: 'Visualization', category: 'design_delivery',
    recommendedWorkflow: 'Bind the visual brief to the project, generate real image artifacts, verify the files, and archive prompts, sources, and selected outputs.',
    nextActions: ['Confirm room, camera, style, material, and lighting constraints', 'Read project references and distinguish facts from creative choices', 'Generate image artifacts', 'Verify file existence and archive selected images under the project'],
    requiredArtifactLabels: ['Verified visualization'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['camera', 'lighting', 'material', 'render', 'image', '\u6784\u56fe', '\u706f\u5149', '\u6750\u8d28', '\u6e32\u67d3', '\u56fe\u7247'],
    confirmationBoundaries: ['Client-facing claims, licensed assets, final selections, and external delivery require review and approval.'],
    requiresFileArtifact: true, acceptedFileExtensions: ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.pdf'], minMatchedContentTerms: 1,
  },
  {
    productLine: 'design', entryId: 'presentation', title: 'Proposal presentation', category: 'design_delivery',
    recommendedWorkflow: 'Build a real presentation from the bound project, render and inspect it, verify the file, and archive the approved version.',
    nextActions: ['Confirm audience, purpose, format, and project stage', 'Build the proposal storyline from verified project facts', 'Generate a real presentation file', 'Render or open-check the presentation and archive its path and review notes'],
    requiredArtifactLabels: ['Verified proposal presentation'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['proposal', 'storyline', 'layout', 'material', 'implementation', 'PPT', '\u63d0\u6848', '\u7248\u5f0f', '\u6750\u6599', '\u5b9e\u65bd'],
    confirmationBoundaries: ['Commercial terms, final quotations, licensed assets, and client delivery require approval.'],
    requiresFileArtifact: true, acceptedFileExtensions: ['.pptx', '.pdf'], minMatchedContentTerms: 1,
  },
  {
    productLine: 'design', entryId: 'handoff', title: 'Delivery center', category: 'design_delivery',
    recommendedWorkflow: 'Assemble project deliverables, verify required files and review gates, produce a manifest, and archive the handoff package.',
    nextActions: ['Confirm delivery scope, recipients, and version', 'Collect required drawings, schedules, visuals, and notes', 'Run completeness and file checks', 'Archive the manifest and stop before external delivery'],
    requiredArtifactLabels: ['Verified handoff package'],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
    expectedContentTerms: ['drawing', 'schedule', 'version', 'checklist', 'handoff', '\u56fe\u7eb8', '\u6e05\u5355', '\u7248\u672c', '\u6838\u9a8c', '\u4ea4\u4ed8'],
    confirmationBoundaries: ['Final professional sign-off, commercial acceptance, and external delivery require accountable approval and delivery receipts.'],
    requiresFileArtifact: true, acceptedFileExtensions: ['.zip', '.pdf', '.pptx', '.docx', '.xlsx', '.dxf', '.dwg'], minMatchedContentTerms: 1,
  },
];

const LEGAL_CONTRACTS: IndustryWorkflowContract[] = [
  ['workspace', 'Case workspace', 'Case archive', false],
  ['packet', 'Document generation', 'Reviewed legal document', true],
  ['contract-review', 'Contract review', 'Contract review report', false],
  ['research', 'Law and similar cases', 'Authority research record', false],
  ['asset-trace', 'Asset clues', 'Asset clue report', false],
  ['verify', 'Delivery verification', 'Legal delivery verification', false],
  ['bid', 'Bid production', 'Verified bid document', true],
].map(([entryId, title, artifact, requiresFileArtifact]) => ({
  productLine: 'legal' as const,
  entryId: String(entryId),
  title: String(title),
  category: 'legal_case' as const,
  recommendedWorkflow: 'Bind work to the current case, preserve source and authority provenance, require lawyer review, and archive materials and verification under the same case.',
  nextActions: ['Bind or create the current case', 'Read and classify source materials', 'Run the selected legal workflow with citations and uncertainty labels', 'Archive the result and lawyer-review state under the case'],
  requiredArtifactLabels: [String(artifact)],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  expectedContentTerms: ['case', 'fact', 'evidence', 'authority', 'risk', 'review', '\u6848\u4ef6', '\u4e8b\u5b9e', '\u8bc1\u636e', '\u6cd5\u5f8b\u4f9d\u636e', '\u98ce\u9669', '\u5f8b\u5e08\u590d\u6838'],
  confirmationBoundaries: ['Filing, signing, payment, formal legal opinions, client delivery, and any external submission require licensed lawyer approval and external receipts.'],
  requiresFileArtifact: Boolean(requiresFileArtifact),
  acceptedFileExtensions: requiresFileArtifact ? ['.docx', '.pdf', '.xlsx', '.zip'] : [],
  minMatchedContentTerms: 2,
}));

const FINANCE_CONTRACTS: IndustryWorkflowContract[] = [
  // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  ['business-dashboard', 'Business dashboard', 'Management operating report', false, ['revenue', 'margin', 'expense', 'cash', 'variance', '\u6536\u5165', '\u5229\u6da6', '\u8d39\u7528', '\u73b0\u91d1', '\u5dee\u5f02'], ['business_finance_finance_report_outline', 'business_finance_financial_ratio_analysis']],
  // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  ['invoice-tax', 'Invoice and tax management', 'Invoice and tax review', false, ['invoice', 'tax', 'duplicate', 'rate', 'exception', '\u53d1\u7968', '\u7a0e', '\u91cd\u590d', '\u7a0e\u7387', '\u5f02\u5e38'], ['business_finance_vat_invoice_review', 'business_finance_tax_position_estimator']],
  // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  ['accounting', 'Accounting', 'Accounting reconciliation', false, ['ledger', 'reconciliation', 'receivable', 'payable', 'difference', '\u8d26\u7c3f', '\u6838\u5bf9', '\u5e94\u6536', '\u5e94\u4ed8', '\u5dee\u5f02'], ['business_finance_ledger_reconciliation', 'business_finance_ar_ap_aging']],
  // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  ['tax-filing', 'Tax filing preparation', 'Review-ready tax filing packet', true, ['jurisdiction', 'taxpayer', 'period', 'filing', 'review', '\u8f96\u533a', '\u7eb3\u7a0e\u4eba', '\u671f\u95f4', '\u7533\u62a5', '\u590d\u6838'], ['business_finance_tax_period_checklist', 'business_finance_tax_position_estimator']],
  // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  ['cash-risk', 'Cash and risk', 'Cash risk forecast', false, ['cash', 'forecast', 'receivable', 'payable', 'scenario', 'risk', '\u73b0\u91d1', '\u9884\u6d4b', '\u5e94\u6536', '\u5e94\u4ed8', '\u60c5\u666f', '\u98ce\u9669'], ['business_finance_cashflow_forecast', 'business_finance_ar_ap_aging']],
  // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  ['report-delivery', 'Report delivery', 'Verified finance report package', true, ['statement', 'period', 'currency', 'source', 'difference', 'review', '\u62a5\u8868', '\u671f\u95f4', '\u5e01\u79cd', '\u6765\u6e90', '\u5dee\u5f02', '\u590d\u6838'], ['business_finance_statement_consistency_review', 'business_finance_finance_report_outline']],
].map(([entryId, title, artifact, requiresFileArtifact, expectedContentTerms, requiredToolEvidence]) => ({
  productLine: 'finance' as const,
  entryId: String(entryId),
  title: String(title),
  category: 'general_work' as const,
  recommendedWorkflow: 'Confirm entity, jurisdiction, period, currency, and accounting basis; run auditable finance tools; preserve sources and calculations; and archive a review-ready result.',
  nextActions: ['Confirm entity, jurisdiction, period, currency, and accounting basis', 'Collect and classify source records', 'Run the selected finance and tax checks with audit receipts', 'Archive sources, calculations, exceptions, and reviewer state'],
  requiredArtifactLabels: [String(artifact)],
    // i18n-allow: Multilingual machine evidence terms; never rendered as UI copy.
  expectedContentTerms: expectedContentTerms as string[],
  confirmationBoundaries: ['Filing, reporting, signing, payment, money movement, ledger posting, and external delivery require accountable professional approval and external receipts.'],
  requiresFileArtifact: Boolean(requiresFileArtifact),
  acceptedFileExtensions: requiresFileArtifact ? ['.xlsx', '.docx', '.pdf', '.zip'] : [],
  minMatchedContentTerms: 2,
  requiredToolEvidence: requiredToolEvidence as string[],
}));

const CONTRACTS = [...ECOMMERCE_CONTRACTS, ...DESIGN_CONTRACTS, ...LEGAL_CONTRACTS, ...FINANCE_CONTRACTS];

export function normalizeIndustryProductLine(value: unknown): IndustryProductLine | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'designer') return 'design';
  return ['ecommerce', 'design', 'legal', 'finance'].includes(normalized)
    ? normalized as IndustryProductLine
    : null;
}

export function getIndustryWorkflowContracts(productLine: unknown): IndustryWorkflowContract[] {
  const normalized = normalizeIndustryProductLine(productLine);
  return normalized ? CONTRACTS.filter(contract => contract.productLine === normalized) : [];
}

export function getIndustryWorkflowContract(productLine: unknown, entryId: unknown): IndustryWorkflowContract | null {
  const normalized = normalizeIndustryProductLine(productLine);
  const normalizedEntryId = String(entryId || '').trim();
  return normalized
    ? CONTRACTS.find(contract => contract.productLine === normalized && contract.entryId === normalizedEntryId) || null
    : null;
}
