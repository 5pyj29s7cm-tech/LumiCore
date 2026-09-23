import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { flushDBOrThrow } from '../../../../../db_layer';
import type { ToolPolicy } from '../../../../personality/types';
import { getGeneratedOutputDir } from '../../../../config/data_path';
import {
  buildFinanceReportOutline,
  buildTaxChecklist,
  estimateTaxPosition,
  reviewStatementConsistency,
} from '../../../../skills/bundled/finance-office/logic';
import { createFinanceAuditReceipt } from '../../../../skills/bundled/finance-office/audit';
import type { ToolRegistry } from '../../../../tools/registry';
import { executeToolCall } from '../../../../tools/execution_engine';
import type { ToolContext, ToolExecutionRecord } from '../../../../tools/types';
import { getWorksheetNames, getWorksheetOrThrow, loadXlsxWorkbook } from '../../../../utils/spreadsheet';
import {
  removeWorkTakeoverTaskArtifacts,
  updateWorkTakeoverTask,
  type WorkTakeoverTask,
} from '../../../../work_takeover/tasks';
import {
  getIndustryWorkflowTask,
  settleIndustryWorkflowConversationTask,
  type IndustryWorkflowScope,
} from '../../../../industry/workflow_service';
import type { WorkTakeoverResultVerification } from '../../../../work_takeover/result_verifier';

const SUPPORTED_ENTRIES = new Set(['tax-filing', 'report-delivery']);
const SHARED_TOOLS = ['create_xlsx', 'read_xlsx', 'industry_workflow_complete'] as const;
const REQUIRED_TOOLS: Record<string, readonly [string, string]> = {
  'tax-filing': [
    'business_finance_tax_period_checklist',
    'business_finance_tax_position_estimator',
  ],
  'report-delivery': [
    'business_finance_statement_consistency_review',
    'business_finance_finance_report_outline',
  ],
};

type DeliveryInput = Record<string, unknown>;

type FinanceStateFlusher = () => Promise<void>;
let financeStateFlusher: FinanceStateFlusher = flushDBOrThrow;

export function setFinanceDeliveryStateFlusherForTests(flusher?: FinanceStateFlusher): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('The Finance delivery persistence test hook is only available in tests.');
  }
  financeStateFlusher = flusher || flushDBOrThrow;
}

export class FinanceDeliveryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FinanceDeliveryError';
  }
}

export interface FinanceDeliveryResult {
  ok: true;
  status: 'verified';
  persisted: true;
  reused: boolean;
  task: WorkTakeoverTask;
  verification: Record<string, unknown>;
  artifacts: Array<{ path: string; basename: string; size: number; sha256: string }>;
  toolReceipts: string[];
  externalActions: [];
}

interface FinanceDeliveryExecutionInput extends IndustryWorkflowScope {
  taskId: string;
  financeInput: DeliveryInput;
  registry: ToolRegistry;
  authRole?: string;
  orgRole?: string;
}

interface NormalizedDelivery {
  entryId: 'tax-filing' | 'report-delivery';
  canonicalInput: DeliveryInput;
  toolArguments: Array<{ name: string; arguments: Record<string, unknown> }>;
  period: string;
  sheets: (receipts: Record<string, unknown>[]) => Array<{
    name: string;
    headers: string[];
    data: unknown[][];
  }>;
}

interface InFlightDelivery {
  digest: string;
  promise: Promise<FinanceDeliveryResult>;
}

type ArtifactProof = { path: string; basename: string; size: number; sha256: string };

type DeliveryAttemptStatus = 'artifact_created' | 'readback_verified' | 'verified' | 'blocked';

const inFlightByTask = new Map<string, InFlightDelivery>();

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.keys(candidate as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const child = (candidate as Record<string, unknown>)[key];
        if (child !== undefined) result[key] = normalize(child);
        return result;
      }, {});
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(input: DeliveryInput, field: string, missing: string[], limit = 2_000): string {
  const value = typeof input[field] === 'string' ? input[field].trim() : '';
  if (!value) missing.push(field);
  if (value.length > limit) {
    throw new FinanceDeliveryError(422, 'FINANCE_DELIVERY_INVALID_INPUT', `${field} is too long.`, { field });
  }
  return value.slice(0, limit);
}

function optionalText(input: DeliveryInput, field: string, limit = 2_000): string | undefined {
  if (input[field] === undefined || input[field] === null || input[field] === '') return undefined;
  if (typeof input[field] !== 'string') {
    throw new FinanceDeliveryError(422, 'FINANCE_DELIVERY_INVALID_INPUT', `${field} must be text.`, { field });
  }
  const value = input[field].trim();
  if (value.length > limit) {
    throw new FinanceDeliveryError(422, 'FINANCE_DELIVERY_INVALID_INPUT', `${field} is too long.`, { field });
  }
  return value || undefined;
}

function decimalValue(input: DeliveryInput, field: string, missing: string[], required: boolean): string | number | undefined {
  const value = input[field];
  if (value === undefined || value === null || value === '') {
    if (required) missing.push(field);
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return value.trim();
  throw new FinanceDeliveryError(422, 'FINANCE_DELIVERY_INVALID_INPUT', `${field} must be a base-10 number.`, { field });
}

function optionalBoolean(input: DeliveryInput, field: string): boolean | undefined {
  if (input[field] === undefined) return undefined;
  if (typeof input[field] !== 'boolean') {
    throw new FinanceDeliveryError(422, 'FINANCE_DELIVERY_INVALID_INPUT', `${field} must be true or false.`, { field });
  }
  return input[field] as boolean;
}

function stringList(input: DeliveryInput, field: string, missing: string[]): string[] {
  const raw = input[field];
  const values = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : [])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 30);
  if (!values.length) missing.push(field);
  return values;
}

function failMissing(task: WorkTakeoverTask, missingFields: string[]): never {
  const fields = Array.from(new Set(missingFields));
  const reason = `Structured finance input is required before verified delivery: ${fields.join(', ')}.`;
  if (task.status === 'delivered' && task.metadata?.workTakeoverVerification?.passed === true) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_INPUT_CONFLICT', 'This delivered task cannot be replayed with incomplete or changed finance input. Start a new task.', {
      status: 'blocked',
      missingFields: fields,
    });
  }
  updateWorkTakeoverTask(task.userId, task.id, {
    status: 'blocked',
    blockedBy: [reason],
    metadata: {
      financeDeliveryLastAttempt: {
        status: 'needs_input',
        missingFields: fields,
        at: new Date().toISOString(),
      },
    },
    note: reason,
  });
  throw new FinanceDeliveryError(422, 'FINANCE_DELIVERY_NEEDS_INPUT', reason, {
    status: 'needs_input',
    missingFields: fields,
  });
}

function compactJson(value: unknown, limit = 30_000): string {
  return JSON.stringify(value, null, 2).slice(0, limit);
}

function normalizeTaxDelivery(task: WorkTakeoverTask, input: DeliveryInput): NormalizedDelivery {
  const missing: string[] = [];
  const period = requiredText(input, 'period', missing, 100);
  const jurisdiction = requiredText(input, 'jurisdiction', missing, 100);
  const taxpayerType = requiredText(input, 'taxpayerType', missing, 200);
  const dueDate = requiredText(input, 'dueDate', missing, 100);
  const currency = requiredText(input, 'currency', missing, 20).toUpperCase();
  const taxes = stringList(input, 'taxes', missing);
  const revenue = decimalValue(input, 'revenue', missing, true);
  const deductibleCost = decimalValue(input, 'deductibleCost', missing, true);
  const deductibleExpense = decimalValue(input, 'deductibleExpense', missing, true);
  const incomeTaxRate = decimalValue(input, 'incomeTaxRate', missing, true);
  const optionalNumbers = Object.fromEntries([
    'nonDeductibleExpense',
    'taxAdjustmentsDecrease',
    'vatOutputTax',
    'vatInputTax',
    'surchargeRate',
  ].map(field => [field, decimalValue(input, field, missing, false)]).filter(([, value]) => value !== undefined));
  if (missing.length) failMissing(task, missing);

  const checklistArguments = {
    period,
    jurisdiction,
    taxpayerType,
    dueDate,
    taxes,
    ...(optionalText(input, 'businessType', 300) ? { businessType: optionalText(input, 'businessType', 300) } : {}),
    ...(optionalBoolean(input, 'hasPayroll') === undefined ? {} : { hasPayroll: optionalBoolean(input, 'hasPayroll') }),
    ...(optionalBoolean(input, 'hasCrossBorder') === undefined ? {} : { hasCrossBorder: optionalBoolean(input, 'hasCrossBorder') }),
    ...(optionalBoolean(input, 'hasMarketplaceIncome') === undefined ? {} : { hasMarketplaceIncome: optionalBoolean(input, 'hasMarketplaceIncome') }),
  };
  const positionArguments = {
    revenue,
    deductibleCost,
    deductibleExpense,
    incomeTaxRate,
    currency,
    ...optionalNumbers,
  };
  const canonicalInput = { ...checklistArguments, ...positionArguments };
  return {
    entryId: 'tax-filing',
    canonicalInput,
    period,
    toolArguments: [
      { name: REQUIRED_TOOLS['tax-filing'][0], arguments: checklistArguments },
      { name: REQUIRED_TOOLS['tax-filing'][1], arguments: positionArguments },
    ],
    sheets: receipts => [
      {
        name: 'Filing checklist',
        headers: ['Period', 'Jurisdiction', 'Taxpayer', 'Verified tool receipt'],
        data: [[period, jurisdiction, taxpayerType, compactJson(receipts[0])]],
      },
      {
        name: 'Tax position',
        headers: ['Currency', 'Revenue', 'Verified tool receipt'],
        data: [[currency, revenue, compactJson(receipts[1])]],
      },
      {
        name: 'Review boundary',
        headers: ['Task', 'Request binding', 'External actions', 'Review state'],
        data: [[task.id, String(task.metadata?.industryWorkflow?.requestId || ''), 'Disabled: no login, filing, signing, payment, upload, or delivery', 'Accountable finance/tax review required']],
      },
    ],
  };
}

const STATEMENT_FIELDS = [
  'totalAssets', 'totalLiabilities', 'totalEquity',
  'cashBeginning', 'operatingCashFlow', 'investingCashFlow', 'financingCashFlow', 'foreignExchangeEffect', 'cashEnding',
  'retainedEarningsBeginning', 'netIncome', 'dividends', 'retainedEarningsAdjustments', 'retainedEarningsEnding',
  'pretaxIncome', 'incomeTaxExpense', 'reportedNetIncome', 'tolerance',
] as const;

function normalizeReportDelivery(task: WorkTakeoverTask, input: DeliveryInput): NormalizedDelivery {
  const missing: string[] = [];
  const period = requiredText(input, 'period', missing, 100);
  const currency = requiredText(input, 'currency', missing, 20).toUpperCase();
  const dataSummary = requiredText(input, 'dataSummary', missing, 12_000);
  const businessType = requiredText(input, 'businessType', missing, 300);
  const statementSource = Object.keys(objectValue(input.statement)).length ? objectValue(input.statement) : input;
  const statementArguments = Object.fromEntries(STATEMENT_FIELDS
    .map(field => [field, decimalValue(statementSource, field, missing, false)])
    .filter(([, value]) => value !== undefined));
  const completeGroups = [
    ['totalAssets', 'totalLiabilities', 'totalEquity'],
    ['cashBeginning', 'operatingCashFlow', 'investingCashFlow', 'financingCashFlow', 'foreignExchangeEffect', 'cashEnding'],
    ['retainedEarningsBeginning', 'netIncome', 'dividends', 'retainedEarningsAdjustments', 'retainedEarningsEnding'],
    ['pretaxIncome', 'incomeTaxExpense', 'reportedNetIncome'],
  ];
  if (!completeGroups.some(group => group.every(field => statementArguments[field] !== undefined))) {
    missing.push('statement.completeConsistencyGroup');
  }
  if (missing.length) failMissing(task, missing);

  const consistencyArguments = { ...statementArguments, currency };
  const outlineArguments = { period, businessType, dataSummary };
  const canonicalInput = { period, currency, businessType, dataSummary, statement: statementArguments };
  return {
    entryId: 'report-delivery',
    canonicalInput,
    period,
    toolArguments: [
      { name: REQUIRED_TOOLS['report-delivery'][0], arguments: consistencyArguments },
      { name: REQUIRED_TOOLS['report-delivery'][1], arguments: outlineArguments },
    ],
    sheets: receipts => [
      {
        name: 'Statement review',
        headers: ['Period', 'Currency', 'Verified tool receipt'],
        data: [[period, currency, compactJson(receipts[0])]],
      },
      {
        name: 'Report outline',
        headers: ['Business type', 'Source summary', 'Verified tool receipt'],
        data: [[businessType, dataSummary, compactJson(receipts[1])]],
      },
      {
        name: 'Review boundary',
        headers: ['Task', 'Request binding', 'External actions', 'Review state'],
        data: [[task.id, String(task.metadata?.industryWorkflow?.requestId || ''), 'Disabled: no reporting, signing, payment, upload, or external delivery', 'Accountable finance review required']],
      },
    ],
  };
}

function normalizeDelivery(task: WorkTakeoverTask, input: DeliveryInput): NormalizedDelivery {
  const metadata = objectValue(task.metadata?.industryWorkflow);
  const entryId = String(metadata.entryId || '');
  if (metadata.productLine !== 'finance' || !SUPPORTED_ENTRIES.has(entryId)) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_UNSUPPORTED_TASK', 'This deterministic delivery endpoint only accepts Finance tax-filing or report-delivery tasks.');
  }
  return entryId === 'tax-filing'
    ? normalizeTaxDelivery(task, input)
    : normalizeReportDelivery(task, input);
}

function parseRecord(record: ToolExecutionRecord): Record<string, unknown> {
  if (record.receipt && typeof record.receipt === 'object' && !Array.isArray(record.receipt)) {
    return record.receipt as Record<string, unknown>;
  }
  let payload: unknown = record.result;
  for (let depth = 0; depth < 3 && typeof payload === 'string'; depth += 1) {
    try { payload = JSON.parse(payload); } catch { break; }
  }
  return objectValue(payload);
}

function invalidDomainReceipt(toolName: string, reason: string): never {
  throw new FinanceDeliveryError(
    502,
    'FINANCE_DELIVERY_RECEIPT_INVALID',
    `Finance tool ${toolName} returned a receipt that failed the delivery contract.`,
    { toolName, reason },
  );
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function suppliedArgumentKeys(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([key, value]) => !key.startsWith('_')
      && value !== undefined
      && value !== null
      && value !== ''
      && (!Array.isArray(value) || value.length > 0))
    .map(([key]) => key)
    .sort();
}

function expectedFinanceDomainPayload(shortName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (shortName === 'tax_period_checklist') return buildTaxChecklist(args as Parameters<typeof buildTaxChecklist>[0]);
  if (shortName === 'tax_position_estimator') return estimateTaxPosition(args as Parameters<typeof estimateTaxPosition>[0]);
  if (shortName === 'statement_consistency_review') return reviewStatementConsistency(args as Parameters<typeof reviewStatementConsistency>[0]);
  if (shortName === 'finance_report_outline') return buildFinanceReportOutline(args as Parameters<typeof buildFinanceReportOutline>[0]);
  invalidDomainReceipt(`business_finance_${shortName}`, 'unexpected_finance_tool');
}

function validateFinanceDomainReceipt(
  record: ToolExecutionRecord,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const payload = parseRecord(record);
  const shortName = record.name.replace(/^business_finance_/, '');
  if (!Object.keys(payload).length) invalidDomainReceipt(record.name, 'empty_or_unparseable_payload');

  const audit = objectValue(payload.auditReceipt);
  const inputFields = Array.isArray(audit.inputFields) ? audit.inputFields.map(String).sort() : [];
  const expectedInputFields = suppliedArgumentKeys(args);
  const calculationPolicy = objectValue(audit.calculationPolicy);
  const generatedAt = new Date(String(audit.generatedAt || ''));
  const expectedAudit = Number.isNaN(generatedAt.getTime())
    ? null
    : createFinanceAuditReceipt(shortName, args, generatedAt);
  if (
    audit.tool !== shortName
    || audit.sourceBasis !== 'user_provided_inputs'
    || audit.reviewRequired !== true
    || audit.skillVersion !== '1.5.0'
    || !isNonEmptyText(audit.generatedAt)
    || Number.isNaN(Date.parse(String(audit.generatedAt)))
    || canonicalJson(inputFields) !== canonicalJson(expectedInputFields)
    || calculationPolicy.engine !== 'decimal.js'
    || calculationPolicy.monetaryScale !== 2
    || calculationPolicy.rounding !== 'ROUND_HALF_UP'
    || calculationPolicy.numericInput !== 'JSON number or base-10 decimal string'
    || !Array.isArray(audit.limitations)
    || audit.limitations.length !== 2
    || !audit.limitations.every(isNonEmptyText)
    || !expectedAudit
    || canonicalJson(audit) !== canonicalJson(expectedAudit)
  ) {
    invalidDomainReceipt(record.name, 'audit_binding_mismatch');
  }

  const domainPayload = { ...payload };
  delete domainPayload.auditReceipt;
  const expectedPayload = expectedFinanceDomainPayload(shortName, args);
  if (canonicalJson(domainPayload) !== canonicalJson(expectedPayload)) {
    invalidDomainReceipt(record.name, 'deterministic_domain_payload_mismatch');
  }
  return payload;
}

function requireVerified(record: ToolExecutionRecord): ToolExecutionRecord {
  if (record.error || record.terminalVerification?.status !== 'verified') {
    throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_TOOL_FAILED', `Required tool ${record.name} did not produce a verified receipt.`, {
      toolName: record.name,
      reason: record.error || record.terminalVerification?.reason || 'unverified',
    });
  }
  return record;
}

function deliveryMetadata(task: WorkTakeoverTask): Record<string, unknown> {
  return objectValue(task.metadata?.financeDeliveryExecution);
}

function sameLocalPath(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => path.resolve(String(value || '')).replace(/\\/g, '/').toLowerCase();
  return Boolean(left) && Boolean(right) && normalize(left) === normalize(right);
}

function taskBindsExecutionEvidence(
  task: WorkTakeoverTask,
  proof: ArtifactProof,
  recordIds: string[],
  expectedToolNames: string[],
  conversationTaskId: string,
  requestId: string,
): boolean {
  if (recordIds.length !== expectedToolNames.length || recordIds.some(id => !id)) return false;
  const workflow = objectValue(task.metadata?.industryWorkflow);
  if (workflow.conversationTaskId !== conversationTaskId || workflow.requestId !== requestId) return false;
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  if (!artifacts.some(artifact => sameLocalPath(artifact.path, proof.path))) return false;
  const runs = Array.isArray(task.metadata?.workTakeoverToolRuns)
    ? task.metadata.workTakeoverToolRuns.map(objectValue)
    : [];
  return recordIds.every((recordId, index) => {
    const run = runs.find(candidate => candidate.id === recordId);
    const envelope = objectValue(run?.envelope);
    const terminalVerification = objectValue(run?.terminalVerification);
    return Boolean(run)
      && run?.toolName === expectedToolNames[index]
      && run?.taskId === conversationTaskId
      && run?.requestId === requestId
      && envelope.taskId === conversationTaskId
      && envelope.requestId === requestId
      && terminalVerification.status === 'verified';
  });
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveGeneratedArtifactPath(filePath: string): string {
  try {
    const root = fs.realpathSync(getGeneratedOutputDir());
    const candidate = fs.realpathSync(path.resolve(filePath));
    if (!isPathInside(root, candidate)) {
      throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_ARTIFACT_OUTSIDE_ROOT', 'The generated artifact escaped the Lumi output directory.');
    }
    return candidate;
  } catch (reason) {
    if (reason instanceof FinanceDeliveryError) throw reason;
    throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_ARTIFACT_INVALID', 'The generated XLSX path could not be verified.');
  }
}

function artifactProof(filePath: string): ArtifactProof {
  try {
    const resolvedPath = resolveGeneratedArtifactPath(filePath);
    const extension = path.extname(resolvedPath).toLowerCase();
    const stat = fs.statSync(resolvedPath);
    const signature = Buffer.alloc(2);
    const descriptor = fs.openSync(resolvedPath, 'r');
    try { fs.readSync(descriptor, signature, 0, 2, 0); } finally { fs.closeSync(descriptor); }
    if (extension !== '.xlsx' || !stat.isFile() || stat.size < 16 || signature.toString('ascii') !== 'PK') {
      throw new Error('invalid XLSX signature or size');
    }
    return {
      path: resolvedPath,
      basename: path.basename(resolvedPath),
      size: stat.size,
      sha256: sha256(fs.readFileSync(resolvedPath)),
    };
  } catch (reason) {
    if (reason instanceof FinanceDeliveryError) throw reason;
    throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_ARTIFACT_INVALID', 'The generated XLSX failed the local file hard gate.');
  }
}

function assertStoredArtifactProof(stored: Record<string, unknown>, current: ArtifactProof): ArtifactProof {
  if (
    stored.path !== current.path
    || stored.basename !== current.basename
    || stored.size !== current.size
    || stored.sha256 !== current.sha256
  ) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_ARTIFACT_CHANGED', 'The persisted Finance workbook no longer matches its original size and SHA-256 proof.');
  }
  return current;
}

function removeGeneratedArtifact(filePath: string): boolean {
  try {
    const resolvedPath = resolveGeneratedArtifactPath(filePath);
    if (!fs.statSync(resolvedPath).isFile()) return false;
    fs.rmSync(resolvedPath, { force: true });
    return !fs.existsSync(resolvedPath);
  } catch {
    return false;
  }
}

function reusedResult(task: WorkTakeoverTask, digest: string): FinanceDeliveryResult | null {
  const metadata = deliveryMetadata(task);
  const previousDigest = String(metadata.inputDigest || '');
  if (task.status !== 'delivered' || task.metadata?.workTakeoverVerification?.passed !== true) return null;
  if (!previousDigest) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_PROOF_MISSING', 'This task is already delivered but has no deterministic Finance replay proof. Start a new task; it will not be executed again.');
  }
  if (previousDigest !== digest) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_INPUT_CONFLICT', 'This delivered task is bound to different structured finance input. Start a new task for changed figures.');
  }
  const artifacts = Array.isArray(metadata.artifacts)
    ? metadata.artifacts.map(item => objectValue(item)).filter(item => typeof item.path === 'string')
    : [];
  const verifiedArtifacts = artifacts.map(item => assertStoredArtifactProof(item, artifactProof(String(item.path))));
  if (!verifiedArtifacts.length) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_PROOF_MISSING', 'The persisted delivery file is no longer available. Start a new task; replay will not silently regenerate it.');
  }
  return {
    ok: true,
    status: 'verified',
    persisted: true,
    reused: true,
    task,
    verification: task.metadata.workTakeoverVerification,
    artifacts: verifiedArtifacts,
    toolReceipts: Array.isArray(metadata.toolReceipts) ? metadata.toolReceipts.map(String) : [],
    externalActions: [],
  };
}

function safeFilename(entryId: string, period: string, taskId: string): string {
  const safePeriod = period.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'period';
  return `finance-${entryId}-${sha256(taskId).slice(0, 16)}-${safePeriod}`;
}

function removeStaleTaskArtifacts(task: WorkTakeoverTask, normalized: NormalizedDelivery): string[] {
  if (task.status === 'delivered' && task.metadata?.workTakeoverVerification?.passed === true) return [];
  const outputRoot = getGeneratedOutputDir();
  const prefix = `finance-${normalized.entryId}-${sha256(task.id).slice(0, 16)}-`;
  const removed: string[] = [];
  try {
    for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.toLowerCase().endsWith('.xlsx')) continue;
      const artifactPath = path.join(outputRoot, entry.name);
      if (removeGeneratedArtifact(artifactPath)) removed.push(path.resolve(artifactPath));
    }
  } catch {
    // A later create call will surface output-directory failures through its own verified receipt.
  }
  return removed;
}

function buildWorkbookSheets(
  normalized: NormalizedDelivery,
  domainReceipts: Record<string, unknown>[],
  task: WorkTakeoverTask,
  requestId: string,
  digest: string,
): {
  sheets: Array<{ name: string; headers: string[]; data: unknown[][] }>;
  receiptDigests: string[];
} {
  const receiptDigests = domainReceipts.map(receipt => sha256(canonicalJson(receipt)));
  const receiptSheets = normalized.sheets(domainReceipts).map((sheet, index) => {
    const receiptDigest = receiptDigests[index];
    if (!receiptDigest || sheet.headers.at(-1) !== 'Verified tool receipt') return sheet;
    return {
      ...sheet,
      headers: ['Row SHA-256', ...sheet.headers.slice(0, -1), 'Receipt SHA-256', sheet.headers.at(-1)!],
      data: sheet.data.map(row => [
        sha256(canonicalJson(row.slice(0, -1))),
        ...row.slice(0, -1),
        receiptDigest,
        row.at(-1),
      ]),
    };
  });
  return {
    sheets: [
      ...receiptSheets,
      {
        name: 'Delivery proof',
        headers: ['Task ID', 'Request ID', 'Input SHA-256', 'Receipt SHA-256 values'],
        data: [[task.id, requestId, digest, receiptDigests.join(',')]],
      },
    ],
    receiptDigests,
  };
}

function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function validateWorkbookReadback(
  record: ToolExecutionRecord,
  sheets: Array<{ name: string; headers: string[]; data: unknown[][] }>,
): void {
  const content = String(record.result || '');
  const sheetNames = sheets.map(sheet => sheet.name);
  const expectedSummary = `Workbook has ${sheetNames.length} sheet(s): ${sheetNames.join(', ')}`;
  const firstLine = content.split(/\r?\n/, 1)[0];
  let previousMarker = -1;
  const validSheets = sheets.every(sheet => {
    const marker = `=== ${sheet.name} ===\n`;
    const markerIndex = content.indexOf(marker);
    if (markerIndex <= previousMarker) return false;
    previousMarker = markerIndex;
    const block = content.slice(markerIndex + marker.length);
    const firstRow = sheet.data[0] || [];
    const hasLargeReceipt = sheet.headers.at(-1) === 'Verified tool receipt';
    const receiptBoundCells = firstRow.slice(0, -1);
    const boundCells = hasLargeReceipt
      ? receiptBoundCells.map(csvField).join(',').length <= 2_000
        ? receiptBoundCells
        : firstRow.slice(0, 1)
      : firstRow;
    const expectedRow = boundCells.map(csvField).join(',') + (hasLargeReceipt ? ',' : '');
    return block.startsWith(`${sheet.headers.map(csvField).join(',')}\n${expectedRow}`);
  });
  if (firstLine !== expectedSummary || !validSheets) {
    throw new FinanceDeliveryError(
      502,
      'FINANCE_DELIVERY_READBACK_FAILED',
      'The generated XLSX reopened, but its sheet and request-binding content did not match this delivery.',
    );
  }
}

async function validateWorkbookCells(
  filePath: string,
  sheets: Array<{ name: string; headers: string[]; data: unknown[][] }>,
): Promise<void> {
  try {
    const workbook = await loadXlsxWorkbook(filePath);
    if (canonicalJson(getWorksheetNames(workbook)) !== canonicalJson(sheets.map(sheet => sheet.name))) {
      throw new Error('sheet_names_mismatch');
    }
    for (const expectedSheet of sheets) {
      const worksheet = getWorksheetOrThrow(workbook, expectedSheet.name);
      const expectedRows = [expectedSheet.headers, ...expectedSheet.data];
      if (worksheet.actualRowCount !== expectedRows.length || worksheet.actualColumnCount !== expectedSheet.headers.length) {
        throw new Error(`sheet_dimensions_mismatch:${expectedSheet.name}`);
      }
      for (let rowIndex = 0; rowIndex < expectedRows.length; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < expectedSheet.headers.length; columnIndex += 1) {
          const actual = worksheet.getRow(rowIndex + 1).getCell(columnIndex + 1).value;
          const expected = expectedRows[rowIndex][columnIndex];
          if (canonicalJson(actual ?? '') !== canonicalJson(expected ?? '')) {
            throw new Error(`cell_mismatch:${expectedSheet.name}:${rowIndex + 1}:${columnIndex + 1}`);
          }
        }
      }
    }
  } catch (reason) {
    if (reason instanceof FinanceDeliveryError) throw reason;
    throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_READBACK_FAILED', 'The generated XLSX cells did not match the exact server-owned Finance workbook payload.');
  }
}

async function persistDeliveryAttempt(
  input: FinanceDeliveryExecutionInput,
  task: WorkTakeoverTask,
  status: DeliveryAttemptStatus,
  attempt: Record<string, unknown>,
): Promise<WorkTakeoverTask> {
  const updated = updateWorkTakeoverTask(input.userId, task.id, {
    metadata: {
      financeDeliveryLastAttempt: {
        status,
        entryId: attempt.entryId,
        inputDigest: attempt.inputDigest,
        conversationTaskId: attempt.conversationTaskId,
        requestId: attempt.requestId,
        ...attempt,
        at: new Date().toISOString(),
      },
    },
  });
  if (!updated) {
    throw new FinanceDeliveryError(500, 'FINANCE_DELIVERY_PERSISTENCE_FAILED', 'The Finance delivery attempt could not be persisted.');
  }
  await flushFinanceState(`attempt:${status}`);
  return updated;
}

function normalizeDeliveryFailure(reason: unknown, stage: string): FinanceDeliveryError {
  if (reason instanceof FinanceDeliveryError) return reason;
  return new FinanceDeliveryError(
    502,
    'FINANCE_DELIVERY_EXECUTION_FAILED',
    'The Finance delivery stopped before a verified result was persisted.',
    { stage },
  );
}

async function flushFinanceState(stage: string): Promise<void> {
  try {
    await financeStateFlusher();
  } catch {
    throw new FinanceDeliveryError(500, 'FINANCE_DELIVERY_PERSISTENCE_FAILED', `Finance delivery state did not durably flush at ${stage}.`);
  }
}

function blockedVerification(
  task: WorkTakeoverTask,
  digest: string,
  error: FinanceDeliveryError,
  stage: string,
  reason: string,
  checkedAt: string,
): WorkTakeoverResultVerification {
  return {
    verificationId: `finance_blocked_${sha256(`${task.id}:${digest}:${error.code}:${stage}`).slice(0, 24)}`,
    checkedAt,
    passed: false,
    status: 'blocked',
    summary: reason,
    detectedSurfaces: [],
    checks: [{
      id: 'finance_delivery_terminal_receipt',
      label: 'Deterministic Finance delivery terminal receipt',
      passed: false,
      detail: `${error.code} at ${stage}`,
    }],
    blockers: [reason],
  };
}

async function recordDeliveryInputFailure(
  input: FinanceDeliveryExecutionInput,
  task: WorkTakeoverTask,
  error: FinanceDeliveryError,
  digest: string,
): Promise<void> {
  const current = getIndustryWorkflowTask(input, task.id);
  if (!current || (current.status === 'delivered' && current.metadata?.workTakeoverVerification?.passed === true)) return;
  const checkedAt = new Date().toISOString();
  const attemptStatus = error.details.status === 'needs_input' ? 'needs_input' : 'blocked';
  const reason = attemptStatus === 'needs_input'
    ? error.message
    : `Finance delivery input validation failed (${error.code}); no tool was executed.`;
  const verification = blockedVerification(task, digest, error, 'input_validation', reason, checkedAt);
  const blocked = updateWorkTakeoverTask(input.userId, task.id, {
    status: 'blocked',
    blockedBy: Array.from(new Set([...(current.blockedBy || []), reason])),
    metadata: {
      workTakeoverVerification: verification,
      financeDeliveryLastAttempt: {
        status: attemptStatus,
        code: error.code,
        inputDigest: digest,
        conversationTaskId: String(current.metadata?.industryWorkflow?.conversationTaskId || ''),
        requestId: String(current.metadata?.industryWorkflow?.requestId || ''),
        missingFields: Array.isArray(error.details.missingFields) ? error.details.missingFields.map(String) : [],
        externalActions: [],
        at: checkedAt,
      },
    },
    note: reason,
  });
  if (blocked) {
    settleIndustryWorkflowConversationTask(blocked, verification);
    await flushFinanceState('input_failure');
  }
}

async function recordDeliveryFailure(
  input: FinanceDeliveryExecutionInput,
  task: WorkTakeoverTask,
  normalized: NormalizedDelivery,
  digest: string,
  stage: string,
  error: FinanceDeliveryError,
  removedArtifacts: number,
): Promise<void> {
  const current = getIndustryWorkflowTask(input, task.id);
  if (!current || (current.status === 'delivered' && current.metadata?.workTakeoverVerification?.passed === true)) return;
  const reason = `Finance delivery stopped at ${stage} (${error.code}); no verified delivery was claimed.`;
  const checkedAt = new Date().toISOString();
  const verification = blockedVerification(task, digest, error, stage, reason, checkedAt);
  const blocked = updateWorkTakeoverTask(input.userId, task.id, {
    status: 'blocked',
    blockedBy: Array.from(new Set([...(current.blockedBy || []), reason])),
    metadata: {
      workTakeoverVerification: verification,
      financeDeliveryLastAttempt: {
        status: 'blocked',
        entryId: normalized.entryId,
        inputDigest: digest,
        conversationTaskId: String(current.metadata?.industryWorkflow?.conversationTaskId || ''),
        requestId: String(current.metadata?.industryWorkflow?.requestId || ''),
        code: error.code,
        stage,
        orphanArtifactsRemoved: removedArtifacts,
        externalActions: [],
        at: checkedAt,
      },
    },
    note: reason,
  });
  if (blocked) {
    settleIndustryWorkflowConversationTask(blocked, verification);
    await flushFinanceState('execution_failure');
  }
}

async function recoverDeliveredAttempt(
  input: FinanceDeliveryExecutionInput,
  task: WorkTakeoverTask,
  normalized: NormalizedDelivery,
  digest: string,
): Promise<FinanceDeliveryResult | null> {
  if (task.status !== 'delivered' || task.metadata?.workTakeoverVerification?.passed !== true) return null;
  if (String(deliveryMetadata(task).inputDigest || '')) {
    const reused = reusedResult(task, digest);
    if (!reused) return null;
    // A previous final flush may have failed after the in-memory task reached
    // delivered. Re-cross the strict durability boundary before claiming that
    // a replayed result is persisted.
    await flushFinanceState('verified_replay');
    return reused;
  }

  const attempt = objectValue(task.metadata?.financeDeliveryLastAttempt);
  const attemptDigest = String(attempt.inputDigest || '');
  if (attemptDigest && attemptDigest !== digest) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_INPUT_CONFLICT', 'This delivered task is bound to different structured finance input. Start a new task for changed figures.');
  }
  const workflow = objectValue(task.metadata?.industryWorkflow);
  const requiredTools = [...REQUIRED_TOOLS[normalized.entryId]];
  const attemptTools = Array.isArray(attempt.toolReceipts) ? attempt.toolReceipts.map(String) : [];
  const executionRecordIds = Array.isArray(attempt.executionRecordIds) ? attempt.executionRecordIds.map(String) : [];
  const provisionalArtifact = objectValue(attempt.provisionalArtifact);
  if (
    attempt.status !== 'readback_verified'
    || attemptDigest !== digest
    || attempt.entryId !== normalized.entryId
    || attempt.conversationTaskId !== workflow.conversationTaskId
    || attempt.requestId !== workflow.requestId
    || canonicalJson(attemptTools) !== canonicalJson(requiredTools)
    || !isNonEmptyText(provisionalArtifact.path)
  ) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_PROOF_MISSING', 'This task is already delivered but its deterministic Finance recovery proof is incomplete. It will not be executed again.');
  }
  const proof = assertStoredArtifactProof(
    provisionalArtifact,
    artifactProof(String(provisionalArtifact.path)),
  );
  if (!taskBindsExecutionEvidence(
    task,
    proof,
    executionRecordIds,
    [...requiredTools, 'create_xlsx', 'read_xlsx'],
    String(workflow.conversationTaskId || ''),
    String(workflow.requestId || ''),
  )) {
    throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_PROOF_MISSING', 'The delivered task is not bound to the persisted Finance readback records and artifact. It will not be replayed.');
  }
  const persisted = updateWorkTakeoverTask(input.userId, task.id, {
    metadata: {
      financeDeliveryExecution: {
        version: 1,
        status: 'verified',
        recovered: true,
        entryId: normalized.entryId,
        inputDigest: digest,
        conversationTaskId: workflow.conversationTaskId,
        requestId: workflow.requestId,
        toolReceipts: requiredTools,
        executionRecordIds,
        receiptDigests: Array.isArray(attempt.receiptDigests) ? attempt.receiptDigests.map(String) : [],
        artifacts: [proof],
        verificationId: objectValue(task.metadata?.workTakeoverVerification).verificationId,
        externalActions: [],
        completedAt: new Date().toISOString(),
      },
      financeDeliveryLastAttempt: {
        ...attempt,
        status: 'verified',
        recovered: true,
        at: new Date().toISOString(),
      },
    },
    note: 'Recovered deterministic Finance delivery metadata from the persisted readback proof; no tool was replayed.',
  });
  if (!persisted) {
    throw new FinanceDeliveryError(500, 'FINANCE_DELIVERY_PERSISTENCE_FAILED', 'The recovered Finance delivery proof could not be persisted.');
  }
  await flushFinanceState('recovery');
  return reusedResult(persisted, digest);
}

async function executeDelivery(
  input: FinanceDeliveryExecutionInput,
  task: WorkTakeoverTask,
  normalized: NormalizedDelivery,
  digest: string,
): Promise<FinanceDeliveryResult> {
  const workflow = objectValue(task.metadata?.industryWorkflow);
  const conversationTaskId = String(workflow.conversationTaskId || '').trim();
  const requestId = String(workflow.requestId || '').trim();
  const conversationId = String(workflow.conversationId || '').trim();
  const allowedTools = [...REQUIRED_TOOLS[normalized.entryId], ...SHARED_TOOLS];
  const allowedSet = new Set<string>(allowedTools);
  const toolPolicy: ToolPolicy = {
    allowedTools,
    requireConfirmation: [],
    forbiddenTools: [],
    maxIterations: allowedTools.length,
  };
  const records: ToolExecutionRecord[] = [];
  const baseContext: ToolContext = {
    userId: input.userId,
    authenticated: true,
    authRole: input.authRole,
    orgRole: input.orgRole,
    localExecution: true,
    executionBoundary: 'trusted_local',
    domain: input.domain,
    orgId: input.orgId,
    taskId: conversationTaskId,
    requestId,
    conversationId,
    source: 'finance_delivery_rest',
    actionIntent: `Create the requested local ${normalized.entryId} review workbook for task ${task.id}; do not perform any external action.`,
    routedTaskText: `Continue exact industry workflow ${task.id}.`,
    allowLocalFileWrites: true,
    localWriteIntentReason: 'The authenticated local desktop user requested this finance deliverable.',
    toolPolicy,
    industryWorkflowTaskId: task.id,
    industryWorkflowEntryId: normalized.entryId,
    industryWorkflowProductLine: 'finance',
    industryWorkflowRequiredToolReceipts: [...REQUIRED_TOOLS[normalized.entryId]],
  };
  const execute = async (name: string, args: Record<string, unknown>, suffix: string) => {
    if (!allowedSet.has(name)) {
      throw new FinanceDeliveryError(500, 'FINANCE_DELIVERY_TOOL_BOUNDARY', `Tool ${name} is outside the finance delivery allowlist.`);
    }
    const record = requireVerified(await executeToolCall({
      registry: input.registry,
      name,
      arguments: args,
      id: `finance_delivery_${sha256(`${task.id}:${requestId}:${digest}:${suffix}`).slice(0, 32)}`,
      context: {
        ...baseContext,
        idempotencyKey: `finance-delivery:${task.id}:${requestId}:${digest}:${suffix}`,
        // Every deterministic step is a fresh execution context. Carry the
        // server-owned receipt chain explicitly so Core's target-anchor guard
        // can bind read_xlsx to the workbook just created by create_xlsx.
        priorToolRecords: records.slice(),
        getCurrentToolRecords: () => records.slice(),
      },
      preflight: (toolName, arguments_) => allowedSet.has(toolName)
        ? { allowed: true, arguments: arguments_ }
        : { allowed: false, reason: 'Finance delivery may only execute its fixed local tool chain.' },
    }));
    records.push(record);
    return record;
  };

  let stage = 'task_binding';
  let createdProof: ArtifactProof | null = null;
  try {
    if (!conversationTaskId || !requestId) {
      throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_TASK_UNBOUND', 'The workflow has no server-owned task/request correlation.');
    }
    stage = 'domain_receipts';
    const domainReceipts: Record<string, unknown>[] = [];
    for (let index = 0; index < normalized.toolArguments.length; index += 1) {
      const call = normalized.toolArguments[index];
      const record = await execute(call.name, call.arguments, `domain-${index + 1}`);
      domainReceipts.push(validateFinanceDomainReceipt(record, call.arguments));
    }

    const workbook = buildWorkbookSheets(normalized, domainReceipts, task, requestId, digest);
    const sheetNames = workbook.sheets.map(sheet => sheet.name);
    stage = 'workbook_create';
    const workbookRecord = await execute('create_xlsx', {
      filename: safeFilename(normalized.entryId, normalized.period, task.id),
      sheets: workbook.sheets,
    }, 'workbook');
    const workbookReceipt = parseRecord(workbookRecord);
    if (
      workbookReceipt.ok !== true
      || workbookReceipt.status !== 'created'
      || !isNonEmptyText(workbookReceipt.path)
      || Number(workbookReceipt.sheetCount) !== workbook.sheets.length
      || !isFiniteNumber(workbookReceipt.size)
    ) {
      throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_ARTIFACT_INVALID', 'The XLSX creator returned an incomplete artifact receipt.');
    }

    stage = 'artifact_hard_gate';
    const proof = artifactProof(String(workbookReceipt.path));
    createdProof = proof;
    if (Number(workbookReceipt.size) !== proof.size) {
      throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_ARTIFACT_INVALID', 'The XLSX creator size receipt did not match the generated file.');
    }
    stage = 'workbook_cell_validation';
    await validateWorkbookCells(proof.path, workbook.sheets);
    const toolReceipts = [...REQUIRED_TOOLS[normalized.entryId]];
    await persistDeliveryAttempt(input, task, 'artifact_created', {
      entryId: normalized.entryId,
      inputDigest: digest,
      conversationTaskId,
      requestId,
      toolReceipts,
      executionRecordIds: records.map(record => String(record.id || '')).filter(Boolean),
      receiptDigests: workbook.receiptDigests,
      expectedSheetNames: sheetNames,
      provisionalArtifact: proof,
      externalActions: [],
    });

    stage = 'workbook_readback';
    const readbackRecord = await execute('read_xlsx', { filePath: proof.path }, 'workbook-readback');
    validateWorkbookReadback(
      readbackRecord,
      workbook.sheets,
    );
    assertStoredArtifactProof(proof, artifactProof(proof.path));
    await persistDeliveryAttempt(input, task, 'readback_verified', {
      entryId: normalized.entryId,
      inputDigest: digest,
      conversationTaskId,
      requestId,
      toolReceipts,
      executionRecordIds: records.map(record => String(record.id || '')).filter(Boolean),
      receiptDigests: workbook.receiptDigests,
      expectedSheetNames: sheetNames,
      provisionalArtifact: proof,
      readbackSha256: sha256(String(readbackRecord.result || '')),
      externalActions: [],
    });

    stage = 'workflow_complete';
    const evidenceRecordIds = records.map(record => String(record.id || '')).filter(Boolean);
    const expectedEvidenceTools = [...toolReceipts, 'create_xlsx', 'read_xlsx'];
    const completionRecord = await execute('industry_workflow_complete', { taskId: task.id }, 'complete');
    const completion = parseRecord(completionRecord);
    const completedTask = objectValue(completion.task) as unknown as WorkTakeoverTask;
    const completionVerification = objectValue(completion.verification);
    const persistedVerification = objectValue(completedTask?.metadata?.workTakeoverVerification);
    if (
      completion.ok !== true
      || completion.status !== 'verified'
      || completion.persisted !== true
      || completion.reused === true
      || completionVerification.passed !== true
      || !isNonEmptyText(completionVerification.verificationId)
      || completionVerification.verificationId !== persistedVerification.verificationId
      || completedTask?.id !== task.id
      || completedTask?.userId !== input.userId
      || completedTask?.status !== 'delivered'
      || !taskBindsExecutionEvidence(
        completedTask,
        proof,
        evidenceRecordIds,
        expectedEvidenceTools,
        conversationTaskId,
        requestId,
      )
    ) {
      throw new FinanceDeliveryError(502, 'FINANCE_DELIVERY_VERIFICATION_FAILED', 'The industry workflow did not persist a verified receipt bound to this exact Finance execution.', {
        status: completion.status,
      });
    }
    assertStoredArtifactProof(proof, artifactProof(proof.path));

    stage = 'final_metadata';
    const persisted = updateWorkTakeoverTask(input.userId, task.id, {
      metadata: {
        financeDeliveryExecution: {
          version: 1,
          status: 'verified',
          entryId: normalized.entryId,
          inputDigest: digest,
          conversationTaskId,
          requestId,
          toolReceipts,
          executionRecordIds: evidenceRecordIds,
          receiptDigests: workbook.receiptDigests,
          readbackSha256: sha256(String(readbackRecord.result || '')),
          artifacts: [proof],
          verificationId: completionVerification.verificationId,
          externalActions: [],
          completedAt: new Date().toISOString(),
        },
        financeDeliveryLastAttempt: {
          status: 'verified',
          entryId: normalized.entryId,
          inputDigest: digest,
          conversationTaskId,
          requestId,
          toolReceipts,
          receiptDigests: workbook.receiptDigests,
          artifact: proof,
          externalActions: [],
          at: new Date().toISOString(),
        },
      },
      note: 'Deterministic Finance delivery persisted after two bound finance-office receipts, XLSX content readback, and industry workflow verification.',
    });
    if (!persisted || String(deliveryMetadata(persisted).inputDigest || '') !== digest) {
      throw new FinanceDeliveryError(500, 'FINANCE_DELIVERY_PERSISTENCE_FAILED', 'The verified Finance delivery metadata could not be persisted.');
    }
    await flushFinanceState('verified_delivery');
    return {
      ok: true,
      status: 'verified',
      persisted: true,
      reused: false,
      task: persisted,
      verification: completionVerification,
      artifacts: [proof],
      toolReceipts,
      externalActions: [],
    };
  } catch (reason) {
    const error = normalizeDeliveryFailure(reason, stage);
    const current = getIndustryWorkflowTask(input, task.id) || task;
    const evidenceRecords = records.filter(record => record.name !== 'industry_workflow_complete');
    const deliveredByThisExecution = Boolean(createdProof)
      && current.status === 'delivered'
      && current.metadata?.workTakeoverVerification?.passed === true
      && taskBindsExecutionEvidence(
        current,
        createdProof!,
        evidenceRecords.map(record => String(record.id || '')).filter(Boolean),
        evidenceRecords.map(record => record.name),
        conversationTaskId,
        requestId,
      );
    const removedPaths = deliveredByThisExecution
      ? []
      : removeStaleTaskArtifacts(current, normalized);
    if (!deliveredByThisExecution && createdProof && fs.existsSync(createdProof.path) && removeGeneratedArtifact(createdProof.path)) {
      removedPaths.push(createdProof.path);
    }
    const uniqueRemovedPaths = Array.from(new Set(removedPaths));
    if (uniqueRemovedPaths.length > 0) {
      removeWorkTakeoverTaskArtifacts(input.userId, task.id, uniqueRemovedPaths);
      await flushFinanceState('failed_artifact_cleanup');
    }
    await recordDeliveryFailure(input, task, normalized, digest, stage, error, uniqueRemovedPaths.length);
    throw error;
  }
}

export async function executeFinanceDeliveryWorkflow(
  input: FinanceDeliveryExecutionInput,
): Promise<FinanceDeliveryResult> {
  const task = getIndustryWorkflowTask(input, input.taskId);
  if (!task) throw new FinanceDeliveryError(404, 'FINANCE_DELIVERY_TASK_NOT_FOUND', 'Industry workflow task not found.');
  const financeInput = objectValue(input.financeInput);
  let normalized: NormalizedDelivery;
  try {
    normalized = normalizeDelivery(task, financeInput);
  } catch (reason) {
    const error = normalizeDeliveryFailure(reason, 'input_validation');
    const rejectedInputDigest = sha256(canonicalJson({
      taskId: task.id,
      requestId: task.metadata?.industryWorkflow?.requestId,
      input: financeInput,
    }));
    await recordDeliveryInputFailure(input, task, error, rejectedInputDigest);
    throw error;
  }
  const digest = sha256(canonicalJson({
    taskId: task.id,
    requestId: task.metadata?.industryWorkflow?.requestId,
    entryId: normalized.entryId,
    input: normalized.canonicalInput,
  }));
  const recovered = await recoverDeliveredAttempt(input, task, normalized, digest);
  if (recovered) return recovered;

  const pending = inFlightByTask.get(task.id);
  if (pending) {
    if (pending.digest !== digest) {
      throw new FinanceDeliveryError(409, 'FINANCE_DELIVERY_IN_FLIGHT_CONFLICT', 'This task already has a different finance delivery execution in progress.');
    }
    return pending.promise;
  }
  const promise = (async () => {
    const staleArtifactPaths = removeStaleTaskArtifacts(task, normalized);
    if (staleArtifactPaths.length > 0) {
      removeWorkTakeoverTaskArtifacts(input.userId, task.id, staleArtifactPaths);
      updateWorkTakeoverTask(input.userId, task.id, {
        metadata: {
          financeDeliveryRecovery: {
            status: 'stale_artifacts_removed',
            count: staleArtifactPaths.length,
            inputDigest: digest,
            at: new Date().toISOString(),
          },
        },
        note: `Removed ${staleArtifactPaths.length} stale task-owned Finance workbook(s) before retry.`,
      });
      await flushFinanceState('stale_artifact_recovery');
    }
    return executeDelivery(input, task, normalized, digest);
  })();
  inFlightByTask.set(task.id, { digest, promise });
  try {
    return await promise;
  } finally {
    const current = inFlightByTask.get(task.id);
    if (current?.promise === promise) inFlightByTask.delete(task.id);
  }
}
