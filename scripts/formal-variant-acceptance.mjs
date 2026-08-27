import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFormalStage9FileBackedProducerEvidence,
  formalStage9ProducerEvidenceExitCode,
} from './lib/formal-stage9-producer-evidence.mjs';

export const FORMAL_VARIANT_ACCEPTANCE_SCHEMA_VERSION = 1;
export const FORMAL_VARIANT_ACCEPTANCE_KIND = 'lumi.formal-variant-acceptance-manifest';
export const FORMAL_VARIANT_EVIDENCE_KIND = 'lumi.formal-variant-acceptance-evidence';

const SHA_RE = /^[a-f0-9]{40}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export class FormalVariantAcceptanceError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'FormalVariantAcceptanceError';
    this.code = code;
    this.details = details;
  }
}

const DEFINITIONS = [
  {
    variantId: 'designer-client',
    productLine: 'design',
    scenarioId: 'designer-assets-edit-export-verify',
    title: 'Designer: source assets to edited and verified export',
    workflowEntryId: 'visualization',
    objective: 'Use only the bound source assets and edit brief, produce a local visual revision, export it, and verify the exact artifact.',
    fixtures: [
      { id: 'source-assets', type: 'file', acceptedExtensions: ['.zip'], description: 'Owned reference images plus a source manifest.' },
      { id: 'edit-brief', type: 'file', acceptedExtensions: ['.json'], description: 'Exact requested changes, protected elements, output size, and acceptance criteria.' },
    ],
    userSteps: [
      { id: 'bind-project', instruction: 'Open the Visualization workflow in explicit standalone mode and bind the exact source-assets and edit-brief fixtures; do not attach or advance any project.' },
      { id: 'request-edit', instruction: 'Request only the edits listed in the fixture and require source files to remain unchanged.' },
      { id: 'review-draft', instruction: 'Inspect the draft, identify one concrete correction if needed, and keep the same workflow task.' },
      { id: 'approve-local-export', instruction: 'Approve local export only; do not approve publishing, upload, purchase, or client delivery.' },
      { id: 'verify-export', instruction: 'Ask Lumi to verify the exported file and return the persisted workflow receipt.' },
    ],
    allowedTools: [
      'industry_workflow_start',
      'interior_design_project_status',
      'mcp_design-studio-pack_interior_visual_direction',
      'read_file',
      'read_pdf',
      'ocr_image_file',
      'generate_image',
      'desktop_open',
      'industry_workflow_complete',
    ],
    forbiddenSideEffects: [
      { id: 'source-overwrite', description: 'No source fixture may be modified or overwritten.' },
      { id: 'external-delivery', description: 'No upload, publishing, messaging, or client delivery.' },
      { id: 'commercial-action', description: 'No purchase, license acceptance, quotation acceptance, or payment.' },
      { id: 'invented-constraints', description: 'No invented dimensions, material facts, or project constraints.' },
    ],
    requiredReceipts: [
      { toolName: 'mcp_design-studio-pack_interior_visual_direction', minimum: 1 },
      { toolName: 'generate_image', minimum: 1 },
      { toolName: 'industry_workflow_complete', minimum: 1 },
    ],
    finalArtifacts: [
      { id: 'edited-visual', kind: 'file', acceptedExtensions: ['.png', '.jpg', '.jpeg', '.webp'] },
      { id: 'visual-verification', kind: 'durable_record' },
    ],
    humanChecks: [
      { id: 'source-preserved', prompt: 'Confirm the source assets are byte-for-byte unchanged.' },
      { id: 'requested-edit-visible', prompt: 'Confirm every requested edit is visible and protected elements are unchanged.' },
      { id: 'export-opens', prompt: 'Open the exported image and inspect resolution, framing, and visible corruption.' },
      { id: 'no-external-action', prompt: 'Confirm no external upload, publication, purchase, or delivery occurred.' },
    ],
  },
  {
    variantId: 'ecommerce-client',
    productLine: 'ecommerce',
    scenarioId: 'ecommerce-product-content-confirm-prepublish',
    title: 'Ecommerce: product data to confirmed pre-publication packet',
    workflowEntryId: 'listing-automation',
    objective: 'Build a reviewable listing and content packet from exact product facts, confirm it, and stop after pre-publication checks.',
    fixtures: [
      { id: 'product-catalog', type: 'file', acceptedExtensions: ['.xlsx', '.csv'], description: 'SKU facts, inventory, cost, price ceiling, and compliance fields.' },
      { id: 'product-assets', type: 'file', acceptedExtensions: ['.zip'], description: 'Owned product media plus an asset manifest.' },
      { id: 'platform-policy', type: 'file', acceptedExtensions: ['.json', '.pdf'], description: 'Platform field, claim, category, and publication rules.' },
    ],
    userSteps: [
      { id: 'bind-product', instruction: 'Open Product management and bind the exact catalog, assets, and platform policy.' },
      { id: 'draft-content', instruction: 'Generate listing fields and content drafts without changing any store state.' },
      { id: 'review-facts', instruction: 'Review title, claims, SKU mapping, inventory, margin, returns, and compliance warnings.' },
      { id: 'confirm-draft', instruction: 'Explicitly confirm the reviewed draft packet, not publication.' },
      { id: 'run-prepublish-check', instruction: 'Run the pre-publication check and stop before listing, pricing, inventory, messaging, or advertising mutations.' },
    ],
    allowedTools: [
      'industry_workflow_start',
      'industry_ecommerce_listing_action_queue',
      'mcp_ecommerce-ops_product_listing_optimizer',
      'mcp_ecommerce-ops_inventory_restock_plan',
      'mcp_ecommerce-ops_after_sales_risk_report',
      'read_xlsx',
      'read_file',
      'industry_workflow_complete',
    ],
    forbiddenSideEffects: [
      { id: 'store-mutation', description: 'No listing, delisting, price, inventory, promotion, or advertising mutation.' },
      { id: 'publication', description: 'No content publication or external upload.' },
      { id: 'customer-action', description: 'No customer message, refund, compensation, or binding promise.' },
      { id: 'source-overwrite', description: 'No fixture or source asset overwrite.' },
    ],
    requiredReceipts: [
      { toolName: 'industry_ecommerce_listing_action_queue', minimum: 1 },
      { toolName: 'mcp_ecommerce-ops_product_listing_optimizer', minimum: 1 },
      { toolName: 'industry_workflow_complete', minimum: 1 },
    ],
    finalArtifacts: [
      { id: 'sku-action-queue', kind: 'durable_record' },
      { id: 'content-draft-packet', kind: 'durable_record' },
      { id: 'prepublish-check', kind: 'durable_record' },
    ],
    humanChecks: [
      { id: 'facts-match', prompt: 'Compare every SKU fact and claim against the supplied fixtures.' },
      { id: 'content-quality', prompt: 'Review language, prohibited claims, platform fields, and image-to-SKU mapping.' },
      { id: 'risks-visible', prompt: 'Confirm inventory, margin, returns, and compliance risks are explicit.' },
      { id: 'not-published', prompt: 'Confirm the store and public listing remain unchanged.' },
    ],
  },
  {
    variantId: 'finance-client',
    productLine: 'finance',
    scenarioId: 'finance-ledger-calculate-report-amount-verify',
    title: 'Finance: ledger data to amount-verified report',
    workflowEntryId: 'report-delivery',
    objective: 'Read the bound ledger fixture, run deterministic calculations, create a report, and verify exact monetary amounts and workbook evidence.',
    fixtures: [
      { id: 'trial-balance', type: 'file', acceptedExtensions: ['.xlsx', '.csv'], description: 'Period-bound trial balance with currency and entity identifiers.' },
      { id: 'control-totals', type: 'file', acceptedExtensions: ['.json'], description: 'Expected assets, liabilities, equity, totals, tolerance, and rounding policy.' },
    ],
    userSteps: [
      { id: 'bind-ledger', instruction: 'Open Report delivery and bind the exact trial balance and control totals.' },
      { id: 'confirm-basis', instruction: 'Confirm entity, period, currency, accounting basis, tolerance, and rounding policy.' },
      { id: 'calculate', instruction: 'Run the statement consistency calculation and preserve its audit receipt.' },
      { id: 'create-report', instruction: 'Create the local finance report workbook without posting, filing, paying, or externally delivering.' },
      { id: 'verify-amounts', instruction: 'Read back the workbook and verify exact amount cells, totals, currency, period, and artifact hash.' },
    ],
    allowedTools: [
      'industry_workflow_start',
      'mcp_finance-office_statement_consistency_review',
      'mcp_finance-office_finance_report_outline',
      'create_xlsx',
      'read_xlsx',
      'industry_workflow_complete',
    ],
    forbiddenSideEffects: [
      { id: 'ledger-mutation', description: 'No ledger posting, source workbook overwrite, or accounting-system mutation.' },
      { id: 'filing-or-reporting', description: 'No tax filing, regulatory reporting, signing, or submission.' },
      { id: 'money-movement', description: 'No payment, transfer, refund, or other money movement.' },
      { id: 'external-delivery', description: 'No email, upload, or external report delivery.' },
    ],
    requiredReceipts: [
      { toolName: 'mcp_finance-office_statement_consistency_review', minimum: 1 },
      { toolName: 'mcp_finance-office_finance_report_outline', minimum: 1 },
      { toolName: 'create_xlsx', minimum: 1 },
      { toolName: 'read_xlsx', minimum: 1 },
      { toolName: 'industry_workflow_complete', minimum: 1 },
    ],
    finalArtifacts: [
      { id: 'finance-report', kind: 'file', acceptedExtensions: ['.xlsx'] },
      { id: 'amount-verification', kind: 'durable_record' },
    ],
    humanChecks: [
      { id: 'control-totals-match', prompt: 'Compare all control totals and amount cells using the stated decimal and rounding policy.' },
      { id: 'balance-equation', prompt: 'Confirm assets equal liabilities plus equity within the declared tolerance.' },
      { id: 'period-currency', prompt: 'Confirm entity, period, currency, and source identifiers in the report.' },
      { id: 'workbook-opens', prompt: 'Open the workbook and inspect formulas, labels, formatting, and visible corruption.' },
      { id: 'no-financial-action', prompt: 'Confirm no posting, filing, payment, submission, or external delivery occurred.' },
    ],
  },
  {
    variantId: 'legal-client',
    productLine: 'legal',
    scenarioId: 'legal-contract-clauses-recommendations-citations',
    title: 'Legal: contract clauses to cited review recommendations',
    workflowEntryId: 'contract-review',
    objective: 'Review the exact contract, map material clauses and risks, propose non-binding revisions, and attach verifiable authority evidence.',
    fixtures: [
      { id: 'source-contract', type: 'file', acceptedExtensions: ['.docx', '.pdf'], description: 'Owned contract with stable clause numbering and governing-law metadata.' },
      { id: 'authority-scope', type: 'file', acceptedExtensions: ['.json'], description: 'Jurisdiction, effective date, party role, and permitted primary-source domains.' },
    ],
    userSteps: [
      { id: 'bind-contract', instruction: 'Open Contract review and bind the exact contract and authority scope.' },
      { id: 'extract-clauses', instruction: 'Extract clause identifiers and text without changing the source contract.' },
      { id: 'review-risks', instruction: 'Classify material risks, uncertainty, missing facts, and affected party position.' },
      { id: 'draft-recommendations', instruction: 'Prepare non-binding revision suggestions mapped to exact clause identifiers.' },
      { id: 'verify-citations', instruction: 'Attach primary authority evidence with URLs, dates, excerpts, and relevance, then persist the review receipt.' },
    ],
    allowedTools: [
      'industry_workflow_start',
      'read_docx',
      'read_pdf',
      'legal_review_contract',
      'legal_case_workflow_status',
      'legal_authority_source_status',
      'legal_external_source_status',
      'legal_search_statute',
      'legal_search_case',
      'legal_external_research_plan',
      'authority_research',
      'industry_workflow_complete',
    ],
    forbiddenSideEffects: [
      { id: 'source-overwrite', description: 'No source contract modification or overwrite.' },
      { id: 'formal-opinion', description: 'No representation that the draft is a final formal legal opinion.' },
      { id: 'filing-or-signing', description: 'No filing, signing, notarization, submission, or client delivery.' },
      { id: 'payment-or-contact', description: 'No payment, external message, or third-party contact.' },
    ],
    requiredReceipts: [
      { toolName: 'legal_review_contract', minimum: 1 },
      { toolName: 'authority_research', minimum: 1 },
      { toolName: 'industry_workflow_complete', minimum: 1 },
    ],
    finalArtifacts: [
      { id: 'contract-review-report', kind: 'durable_record' },
      { id: 'citation-evidence-packet', kind: 'durable_record' },
    ],
    humanChecks: [
      { id: 'clause-mapping', prompt: 'Confirm every risk and recommendation maps to an exact source clause.' },
      { id: 'recommendation-quality', prompt: 'Review party position, ambiguity, missing facts, alternatives, and non-binding language.' },
      { id: 'citation-validity', prompt: 'Open every citation and verify authority, jurisdiction, effective date, excerpt, and relevance.' },
      { id: 'lawyer-review-boundary', prompt: 'Confirm the result remains pending accountable lawyer review and no external action occurred.' },
    ],
  },
];

export const FORMAL_VARIANT_IDS = Object.freeze(DEFINITIONS.map(item => item.variantId));

function text(value) {
  return String(value ?? '').trim();
}

function assertCondition(condition, code, details = {}) {
  if (!condition) throw new FormalVariantAcceptanceError(code, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function portablePathFlavor(value) {
  const clean = text(value);
  if (!clean || clean.includes('\0') || /^file:/i.test(clean)) return null;
  if (/^[A-Za-z]:[\\/]/u.test(clean)) return 'win32';
  if (clean.startsWith('/') && !clean.includes('\\')) return 'posix';
  return null;
}

function normalizedPortablePath(value) {
  const clean = text(value);
  const flavor = portablePathFlavor(clean);
  if (!flavor) return null;
  const segments = clean.split(/[\\/]/);
  if (segments.includes('..')) return null;
  const api = flavor === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(clean);
  const root = api.parse(normalized).root;
  if (!normalized || normalized === root) return null;
  return {
    flavor,
    normalized,
    identity: (flavor === 'win32' ? normalized.toLowerCase() : normalized).replace(/[\\/]+/g, '/'),
  };
}

function isPathInsidePortable(rootValue, candidateValue) {
  const root = normalizedPortablePath(rootValue);
  const candidate = normalizedPortablePath(candidateValue);
  if (!root || !candidate || root.flavor !== candidate.flavor) return false;
  const api = root.flavor === 'win32' ? path.win32 : path.posix;
  const relative = api.relative(
    root.flavor === 'win32' ? root.normalized.toLowerCase() : root.normalized,
    candidate.flavor === 'win32' ? candidate.normalized.toLowerCase() : candidate.normalized,
  );
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative)
  );
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function stableManifestJson(value) {
  return JSON.stringify(stableValue(value));
}

export function manifestDigest(value) {
  const copy = structuredClone(value);
  if (isPlainObject(copy)) delete copy.manifestDigest;
  return crypto.createHash('sha256').update(stableManifestJson(copy), 'utf8').digest('hex');
}

function normalizeBinding(raw, expectedVariantId) {
  assertCondition(isPlainObject(raw), 'variant_binding_invalid', { expectedVariantId });
  const variantId = text(raw.variantId);
  const coreSha = text(raw.coreSha).toLowerCase();
  const variantSha = text(raw.variantSha).toLowerCase();
  const dataRoot = normalizedPortablePath(raw.dataRoot);
  const webviewProfile = normalizedPortablePath(raw.webviewProfile);
  assertCondition(variantId === expectedVariantId, 'variant_id_mismatch', { expectedVariantId, variantId });
  assertCondition(SHA_RE.test(coreSha), 'core_sha_invalid', { variantId });
  assertCondition(SHA_RE.test(variantSha), 'variant_sha_invalid', { variantId });
  assertCondition(Boolean(dataRoot), 'formal_data_root_invalid', { variantId });
  assertCondition(Boolean(webviewProfile), 'formal_webview_profile_invalid', { variantId });
  assertCondition(dataRoot.identity !== webviewProfile.identity, 'formal_runtime_paths_not_distinct', { variantId });
  const identity = {
    variantId,
    coreSha,
    variantSha,
    dataRoot: dataRoot.normalized,
    webviewProfile: webviewProfile.normalized,
  };
  return {
    ...identity,
    dataRootMode: 'formal_persistent',
    webviewProfileMode: 'formal_persistent',
    fingerprint: crypto.createHash('sha256').update(stableManifestJson(identity), 'utf8').digest('hex'),
  };
}

function uniqueNonEmpty(values) {
  const normalized = values.map(text).filter(Boolean);
  return normalized.length === values.length && new Set(normalized).size === normalized.length;
}

function sameOrderedValues(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function scenarioFromDefinition(definition, binding) {
  return {
    scenarioId: definition.scenarioId,
    title: definition.title,
    status: 'planned',
    result: null,
    binding,
    workflow: {
      productLine: definition.productLine,
      entryId: definition.workflowEntryId,
      objective: definition.objective,
      ...(definition.variantId === 'designer-client' ? { executionMode: 'standalone' } : {}),
    },
    fixtures: definition.fixtures.map(item => ({
      ...item,
      required: true,
      integrityEvidence: ['absolute_path_inside_data_root', 'sha256', 'size'],
    })),
    userSteps: definition.userSteps.map((item, index) => ({
      ...item,
      order: index + 1,
      required: true,
      completionEvidence: ['persisted_user_message', 'persisted_assistant_message', 'request_id', 'task_id'],
    })),
    allowedTools: [...definition.allowedTools],
    forbiddenSideEffects: definition.forbiddenSideEffects.map(item => ({
      ...item,
      requiredObservation: 'absent',
    })),
    requiredReceipts: definition.requiredReceipts.map(item => ({
      ...item,
      persisted: true,
      terminalVerification: 'verified',
    })),
    finalArtifacts: definition.finalArtifacts.map(item => ({
      ...item,
      required: true,
      pathBoundary: item.kind === 'file' ? 'dataRoot' : undefined,
      evidence: item.kind === 'file'
        ? ['absolute_path_inside_data_root', 'sha256', 'size', 'receipt_ids']
        : ['durable_id', 'receipt_ids'],
    })),
    humanChecks: definition.humanChecks.map(item => ({ ...item, required: true })),
  };
}

export function buildFormalVariantAcceptanceManifest(input) {
  const bindings = Array.isArray(input?.bindings) ? input.bindings : [];
  const generatedAt = text(input?.generatedAt || new Date().toISOString());
  assertCondition(!Number.isNaN(Date.parse(generatedAt)), 'manifest_generated_at_invalid');
  assertCondition(bindings.length === DEFINITIONS.length, 'variant_binding_count_invalid');
  const byId = new Map();
  for (const raw of bindings) {
    const id = text(raw?.variantId);
    assertCondition(FORMAL_VARIANT_IDS.includes(id), 'variant_binding_unknown', { variantId: id });
    assertCondition(!byId.has(id), 'variant_binding_duplicate', { variantId: id });
    byId.set(id, raw);
  }
  const normalizedBindings = DEFINITIONS.map(definition => normalizeBinding(byId.get(definition.variantId), definition.variantId));
  assertCondition(new Set(normalizedBindings.map(item => item.coreSha)).size === 1, 'core_sha_not_shared');
  assertCondition(uniqueNonEmpty(normalizedBindings.map(item => normalizedPortablePath(item.dataRoot)?.identity || '')), 'formal_data_root_not_unique');
  assertCondition(uniqueNonEmpty(normalizedBindings.map(item => normalizedPortablePath(item.webviewProfile)?.identity || '')), 'formal_webview_profile_not_unique');
  const manifest = {
    schemaVersion: FORMAL_VARIANT_ACCEPTANCE_SCHEMA_VERSION,
    kind: FORMAL_VARIANT_ACCEPTANCE_KIND,
    generatedAt,
    executionPolicy: {
      mode: 'orchestration_and_validation_only',
      launchClient: false,
      synthesizeBusinessResults: false,
      allVariantsRequired: true,
      defaultOutcome: 'unverified',
    },
    scenarios: DEFINITIONS.map((definition, index) => scenarioFromDefinition(definition, normalizedBindings[index])),
  };
  return { ...manifest, manifestDigest: manifestDigest(manifest) };
}

function validateManifestStructure(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return ['manifest_invalid'];
  if (manifest.schemaVersion !== FORMAL_VARIANT_ACCEPTANCE_SCHEMA_VERSION) errors.push('manifest_schema_invalid');
  if (manifest.kind !== FORMAL_VARIANT_ACCEPTANCE_KIND) errors.push('manifest_kind_invalid');
  if (!SHA256_RE.test(text(manifest.manifestDigest))) errors.push('manifest_digest_missing');
  else if (manifest.manifestDigest !== manifestDigest(manifest)) errors.push('manifest_digest_mismatch');
  const expectedExecutionPolicy = {
    mode: 'orchestration_and_validation_only',
    launchClient: false,
    synthesizeBusinessResults: false,
    allVariantsRequired: true,
    defaultOutcome: 'unverified',
  };
  if (stableManifestJson(manifest.executionPolicy) !== stableManifestJson(expectedExecutionPolicy)) {
    errors.push('manifest_execution_policy_invalid');
  }
  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : [];
  if (scenarios.length !== DEFINITIONS.length) errors.push('manifest_scenario_count_invalid');
  for (const definition of DEFINITIONS) {
    const scenario = scenarios.find(item => item?.scenarioId === definition.scenarioId);
    if (!scenario) {
      errors.push(`${definition.variantId}:scenario_missing`);
      continue;
    }
    try {
      const normalized = normalizeBinding(scenario.binding, definition.variantId);
      if (scenario.binding?.fingerprint !== normalized.fingerprint
        || scenario.binding?.dataRootMode !== 'formal_persistent'
        || scenario.binding?.webviewProfileMode !== 'formal_persistent') {
        errors.push(`${definition.variantId}:binding_fingerprint_invalid`);
      }
      if (stableManifestJson(scenario) !== stableManifestJson(scenarioFromDefinition(definition, normalized))) {
        errors.push(`${definition.variantId}:scenario_definition_changed`);
      }
    } catch (error) {
      errors.push(`${definition.variantId}:${error.code || 'binding_invalid'}`);
    }
    if (scenario.status !== 'planned' || scenario.result !== null) errors.push(`${definition.variantId}:scenario_not_planned`);
    if (scenario.workflow?.entryId !== definition.workflowEntryId) errors.push(`${definition.variantId}:workflow_mismatch`);
    for (const key of ['fixtures', 'userSteps', 'allowedTools', 'forbiddenSideEffects', 'requiredReceipts', 'finalArtifacts', 'humanChecks']) {
      if (!Array.isArray(scenario[key]) || scenario[key].length === 0) errors.push(`${definition.variantId}:${key}_missing`);
    }
    const allowedTools = new Set(Array.isArray(scenario.allowedTools) ? scenario.allowedTools : []);
    if (!uniqueNonEmpty(scenario.allowedTools || [])
      || !sameOrderedValues(scenario.allowedTools, definition.allowedTools)) {
      errors.push(`${definition.variantId}:allowed_tools_invalid`);
    }
    if (!sameOrderedValues(
      (scenario.requiredReceipts || []).map(item => `${item?.toolName}:${item?.minimum}`),
      definition.requiredReceipts.map(item => `${item.toolName}:${item.minimum}`),
    )) errors.push(`${definition.variantId}:required_receipts_changed`);
    for (const [key, expected] of [
      ['fixtures', definition.fixtures],
      ['userSteps', definition.userSteps],
      ['forbiddenSideEffects', definition.forbiddenSideEffects],
      ['finalArtifacts', definition.finalArtifacts],
      ['humanChecks', definition.humanChecks],
    ]) {
      if (!sameOrderedValues(
        (scenario[key] || []).map(item => item?.id),
        expected.map(item => item.id),
      )) errors.push(`${definition.variantId}:${key}_changed`);
    }
    for (const receipt of scenario.requiredReceipts || []) {
      if (!allowedTools.has(receipt?.toolName)) errors.push(`${definition.variantId}:required_receipt_tool_not_allowed`);
      if (receipt?.terminalVerification !== 'verified' || receipt?.persisted !== true) {
        errors.push(`${definition.variantId}:required_receipt_contract_invalid`);
      }
    }
  }
  const coreShas = scenarios.map(item => text(item?.binding?.coreSha)).filter(Boolean);
  if (new Set(coreShas).size !== 1) errors.push('manifest_core_sha_not_shared');
  const dataRoots = scenarios.map(item => normalizedPortablePath(item?.binding?.dataRoot)?.identity || '');
  const profiles = scenarios.map(item => normalizedPortablePath(item?.binding?.webviewProfile)?.identity || '');
  if (!uniqueNonEmpty(dataRoots)) errors.push('manifest_data_roots_not_unique');
  if (!uniqueNonEmpty(profiles)) errors.push('manifest_webview_profiles_not_unique');
  return [...new Set(errors)];
}

export function validateFormalVariantAcceptanceManifest(manifest) {
  const errors = validateManifestStructure(manifest);
  return { ok: errors.length === 0, errors };
}

function validIsoDate(value) {
  return Boolean(text(value)) && !Number.isNaN(Date.parse(text(value)));
}

function sha256FileSync(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function verifyBoundFile(record, dataRoot) {
  const candidate = normalizedPortablePath(record?.path);
  const root = normalizedPortablePath(dataRoot);
  const hostFlavor = process.platform === 'win32' ? 'win32' : 'posix';
  if (!candidate || !root || candidate.flavor !== hostFlavor || root.flavor !== hostFlavor) return false;
  try {
    const canonicalRoot = fs.realpathSync.native(root.normalized);
    const canonicalCandidate = fs.realpathSync.native(candidate.normalized);
    const hostApi = hostFlavor === 'win32' ? path.win32 : path.posix;
    const relative = hostApi.relative(canonicalRoot, canonicalCandidate);
    if (relative === '..' || relative.startsWith(`..${hostApi.sep}`) || hostApi.isAbsolute(relative)) return false;
    const metadata = fs.lstatSync(candidate.normalized);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== Number(record?.size)) return false;
    return sha256FileSync(candidate.normalized) === text(record?.sha256).toLowerCase();
  } catch {
    return false;
  }
}

function validateScenarioEvidence(scenario, evidence, options = {}) {
  const prefix = scenario.binding.variantId;
  const errors = [];
  if (!isPlainObject(evidence)) return [`${prefix}:evidence_missing`];
  if (text(evidence.bindingFingerprint) !== scenario.binding.fingerprint) errors.push(`${prefix}:binding_fingerprint_mismatch`);
  for (const key of ['variantId', 'coreSha', 'variantSha', 'dataRoot', 'webviewProfile']) {
    if (text(evidence.runtimeBinding?.[key]) !== text(scenario.binding[key])) {
      errors.push(`${prefix}:runtime_binding_${key}_mismatch`);
    }
  }
  if (!validIsoDate(evidence.completedAt)) errors.push(`${prefix}:completed_at_invalid`);

  const fixtureEvidence = Array.isArray(evidence.fixtures) ? evidence.fixtures : [];
  for (const fixture of scenario.fixtures) {
    const actual = fixtureEvidence.find(item => item?.id === fixture.id);
    const extension = path.extname(text(actual?.path)).toLowerCase();
    if (!actual
      || !isPathInsidePortable(scenario.binding.dataRoot, actual.path)
      || !fixture.acceptedExtensions.includes(extension)
      || !SHA256_RE.test(text(actual.sha256))
      || !(Number(actual.size) > 0)) {
      errors.push(`${prefix}:fixture_${fixture.id}_invalid`);
    } else if (options.verifyFilesystem === true && !verifyBoundFile(actual, scenario.binding.dataRoot)) {
      errors.push(`${prefix}:fixture_${fixture.id}_file_not_verified`);
    }
  }

  const stepEvidence = Array.isArray(evidence.steps) ? evidence.steps : [];
  for (const step of scenario.userSteps) {
    const actual = stepEvidence.find(item => item?.id === step.id);
    if (!actual
      || actual.status !== 'completed'
      || !text(actual.taskId)
      || !text(actual.requestId)
      || !text(actual.userMessageId)
      || !text(actual.assistantMessageId)) {
      errors.push(`${prefix}:step_${step.id}_incomplete`);
    }
  }
  const stepTaskIds = stepEvidence.map(item => text(item?.taskId)).filter(Boolean);
  if (new Set(stepTaskIds).size !== 1) errors.push(`${prefix}:task_identity_changed`);
  const stepRequestIds = new Set(stepEvidence.map(item => text(item?.requestId)).filter(Boolean));

  const receipts = Array.isArray(evidence.toolReceipts) ? evidence.toolReceipts : [];
  const allowedTools = new Set(scenario.allowedTools);
  if (receipts.some(receipt => !allowedTools.has(text(receipt?.toolName)))) errors.push(`${prefix}:unexpected_tool_receipt`);
  if (receipts.some(receipt => (
    receipt?.persisted !== true
    || receipt?.terminalVerification?.status !== 'verified'
    || !['succeeded', 'completed', 'verified_success'].includes(text(receipt?.outcome || receipt?.status))
    || !text(receipt?.receiptId)
    || !text(receipt?.taskId)
    || !stepTaskIds.includes(text(receipt?.taskId))
    || !stepRequestIds.has(text(receipt?.requestId))
  ))) errors.push(`${prefix}:unverified_tool_receipt`);
  for (const requirement of scenario.requiredReceipts) {
    const matching = receipts.filter(receipt => (
      receipt?.toolName === requirement.toolName
      && receipt?.persisted === true
      && receipt?.terminalVerification?.status === 'verified'
      && ['succeeded', 'completed', 'verified_success'].includes(text(receipt?.outcome || receipt?.status))
      && text(receipt?.receiptId)
      && text(receipt?.taskId)
      && text(receipt?.requestId)
    ));
    if (matching.length < requirement.minimum) errors.push(`${prefix}:receipt_${requirement.toolName}_missing`);
  }

  if (!Array.isArray(evidence.observedForbiddenSideEffects)) errors.push(`${prefix}:forbidden_side_effect_observation_missing`);
  else if (evidence.observedForbiddenSideEffects.length > 0) errors.push(`${prefix}:forbidden_side_effect_observed`);

  const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : [];
  const knownReceiptIds = new Set(receipts.map(item => text(item?.receiptId)).filter(Boolean));
  for (const artifact of scenario.finalArtifacts) {
    const actual = artifacts.find(item => item?.id === artifact.id && item?.kind === artifact.kind);
    const receiptIds = Array.isArray(actual?.receiptIds) ? actual.receiptIds.map(text).filter(Boolean) : [];
    if (!actual || receiptIds.length === 0 || receiptIds.some(id => !knownReceiptIds.has(id))) {
      errors.push(`${prefix}:artifact_${artifact.id}_missing`);
      continue;
    }
    if (artifact.kind === 'file') {
      const extension = path.extname(text(actual.path)).toLowerCase();
      if (!isPathInsidePortable(scenario.binding.dataRoot, actual.path)
        || !artifact.acceptedExtensions.includes(extension)
        || !SHA256_RE.test(text(actual.sha256))
        || !(Number(actual.size) > 0)) {
        errors.push(`${prefix}:artifact_${artifact.id}_invalid`);
      } else if (options.verifyFilesystem === true && !verifyBoundFile(actual, scenario.binding.dataRoot)) {
        errors.push(`${prefix}:artifact_${artifact.id}_file_not_verified`);
      }
    } else if (!text(actual.durableId)) {
      errors.push(`${prefix}:artifact_${artifact.id}_invalid`);
    }
  }

  const checks = Array.isArray(evidence.humanChecks) ? evidence.humanChecks : [];
  for (const check of scenario.humanChecks) {
    const actual = checks.find(item => item?.id === check.id);
    if (!actual
      || actual.status !== 'passed'
      || actual.reviewerType !== 'human'
      || !text(actual.reviewer)
      || !validIsoDate(actual.checkedAt)) {
      errors.push(`${prefix}:human_check_${check.id}_incomplete`);
    }
  }
  return errors;
}

function evidenceValidationResult(errors, filesystemVerified) {
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    packageComplete: uniqueErrors.length === 0,
    filesystemVerified: filesystemVerified === true,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    errors: uniqueErrors,
  };
}

export function validateFormalVariantAcceptanceEvidence(manifest, evidence, options = {}) {
  const manifestErrors = validateManifestStructure(manifest);
  if (manifestErrors.length) {
    return evidenceValidationResult(
      manifestErrors.map(code => `manifest:${code}`),
      options.verifyFilesystem,
    );
  }
  const errors = [];
  if (!isPlainObject(evidence)
    || evidence.schemaVersion !== FORMAL_VARIANT_ACCEPTANCE_SCHEMA_VERSION
    || evidence.kind !== FORMAL_VARIANT_EVIDENCE_KIND) {
    return evidenceValidationResult(['evidence_envelope_invalid'], options.verifyFilesystem);
  }
  if (text(evidence.manifestDigest) !== manifest.manifestDigest) errors.push('evidence_manifest_digest_mismatch');
  const scenarios = Array.isArray(evidence.scenarios) ? evidence.scenarios : [];
  if (scenarios.length !== manifest.scenarios.length) errors.push('evidence_scenario_count_invalid');
  for (const scenario of manifest.scenarios) {
    const actual = scenarios.find(item => item?.scenarioId === scenario.scenarioId);
    errors.push(...validateScenarioEvidence(scenario, actual, options));
  }
  return evidenceValidationResult(errors, options.verifyFilesystem);
}

function parseArgs(argv) {
  const command = text(argv[0]);
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assertCondition(/^--(?:bindings|manifest|evidence|output)$/.test(flag) && value, 'cli_arguments_invalid');
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function readJsonFile(filePath, code) {
  const absolute = path.resolve(text(filePath));
  assertCondition(text(filePath) && path.isAbsolute(filePath), code);
  const stat = fs.statSync(absolute);
  assertCondition(stat.isFile() && stat.size > 0 && stat.size <= 2_000_000, code);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function emitJson(value, outputPath) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }
  assertCondition(path.isAbsolute(outputPath), 'absolute_output_path_required');
  assertCondition(!fs.existsSync(outputPath), 'output_already_exists');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
}

export function formalVariantEvidenceCliExitCode(result) {
  return formalStage9ProducerEvidenceExitCode(result);
}

export async function createVariantFormalStage9ProducerEvidence(options = {}) {
  return createFormalStage9FileBackedProducerEvidence({
    ...options,
    producer: 'variants',
    payload: options.payload || options.result,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'manifest') {
    const raw = readJsonFile(options.bindings, 'bindings_file_invalid');
    const manifest = buildFormalVariantAcceptanceManifest({
      bindings: Array.isArray(raw) ? raw : raw.bindings,
      generatedAt: raw.generatedAt,
    });
    emitJson(manifest, options.output);
    // A manifest is a complete planning artifact, not an acceptance decision.
    process.exitCode = 2;
    return;
  }
  if (command === 'validate') {
    const manifest = readJsonFile(options.manifest, 'manifest_file_invalid');
    const evidence = readJsonFile(options.evidence, 'evidence_file_invalid');
    const result = validateFormalVariantAcceptanceEvidence(manifest, evidence, { verifyFilesystem: true });
    emitJson(result, options.output);
    // This command validates an evidence package; it deliberately cannot
    // adjudicate four real client sessions from caller-supplied JSON alone.
    process.exitCode = formalVariantEvidenceCliExitCode(result);
    return;
  }
  throw new FormalVariantAcceptanceError('usage: manifest --bindings <absolute-json> [--output <new-json>] | validate --manifest <absolute-json> --evidence <absolute-json> [--output <new-json>]');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`[formal-variant-acceptance] ${error.code || error.message}\n`);
    process.exitCode = 1;
  });
}
