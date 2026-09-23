import { registerBusinessCalculationTools } from '../server/tools/definitions/business_calculation_tools';
import './helpers';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flushDBOrThrow } from '../db_layer';
import {
  issueDesktopSessionProof as issueBoundDesktopSessionProof,
  resetDesktopBootstrapStateForTests,
} from '../server/config/desktop_bootstrap';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { mountIndustryWorkflowRoutes } from '../server/routes/industry_workflow_routes';
import { setFinanceDeliveryStateFlusherForTests } from '../server/industry/finance_delivery';
import { ToolRegistry } from '../server/tools/registry';
import { capabilityContract, capabilityEvidence } from '../server/tools/capability_contracts';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerIndustryWorkflowTools } from '../server/tools/definitions/industry_workflow_tools';
import {
  buildFinanceReportOutline,
  buildTaxChecklist,
  estimateTaxPosition,
  reviewStatementConsistency,
} from '../server/skills/bundled/finance-office/logic';
import { withFinanceAuditReceipt } from '../server/skills/bundled/finance-office/audit';
import { updateWorkTakeoverTask } from '../server/work_takeover/tasks';
import { JWT_SECRET, makeApp } from './helpers';

const FINANCE_TOOLS = {
  'business_finance_tax_period_checklist': buildTaxChecklist,
  'business_finance_tax_position_estimator': estimateTaxPosition,
  'business_finance_statement_consistency_review': reviewStatementConsistency,
  'business_finance_finance_report_outline': buildFinanceReportOutline,
} as const;

const FINANCE_TEST_NATIVE_IDENTITY = {
  schemaVersion: 1 as const,
  clientKind: 'local_acceptance_harness' as const,
  pid: process.pid,
  startedAtUnixMs: Math.floor(Date.now() / 1_000) * 1_000,
  executablePath: process.execPath,
  executableSha256: null,
  binaryHashUnavailable: true,
  buildId: 'f'.repeat(40),
  buildIdSemantics: 'baseline_commit' as const,
  sourceFingerprint: 'e'.repeat(64),
  sourceDirty: false,
  appVersion: '3.1.0',
};

function issueDesktopSessionProof(uid: string) {
  return issueBoundDesktopSessionProof(uid, FINANCE_TEST_NATIVE_IDENTITY);
}

function registerFinanceFixture(registry: ToolRegistry, name: keyof typeof FINANCE_TOOLS): void {
  const logic = FINANCE_TOOLS[name];
  const shortName = name.replace('business_finance_', '');
  registry.register({
    name,
    description: `Real deterministic finance-office ${shortName} test adapter.`,
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async args => JSON.stringify(withFinanceAuditReceipt(shortName, args, (logic as any)(args))),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: `skill.finance-office.${shortName}`,
      family: 'finance-office',
      lane: 'industry',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'none', scope: 'deterministic calculation over fixture input', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['auditReceipt.tool', 'auditReceipt.sourceBasis'],
        requiredValues: { 'auditReceipt.sourceBasis': 'user_provided_inputs' },
        successSignals: ['structured finance audit receipt'],
        limitations: ['Test fixture input only.'],
      },
    }),
    evidence: capabilityEvidence({ id: `skill.finance-office.${shortName}`, operation: 'observe' }),
  });
}

function registerFinanceFixtures(registry: ToolRegistry): void {
  (Object.keys(FINANCE_TOOLS) as Array<keyof typeof FINANCE_TOOLS>)
    .forEach(name => registerFinanceFixture(registry, name));
}

describe('deterministic Finance delivery E2E', () => {
  let baseUrl = '';
  let cleanup = () => {};
  let registry: ToolRegistry;
  const generatedFiles = new Set<string>();
  const ownerId = `finance_delivery_owner_${Date.now()}`;
  const ownerToken = jwt.sign({ uid: ownerId, username: ownerId, role: 'user' }, JWT_SECRET);
  const authHeaders = () => ({
    Authorization: `Bearer ${ownerToken}`,
    'Content-Type': 'application/json',
  });

  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    registry = new ToolRegistry();
    registerDocumentTools(registry);
    registerIndustryWorkflowTools(registry);
    registerBusinessCalculationTools(registry);
    mountIndustryWorkflowRoutes(app.apiRouter, registry);
  });

  afterAll(() => {
    setFinanceDeliveryStateFlusherForTests();
    resetDesktopBootstrapStateForTests();
    generatedFiles.forEach(filePath => {
      try { fs.rmSync(filePath, { force: true }); } catch {}
    });
    cleanup();
  });

  async function start(entryId: 'tax-filing' | 'report-delivery', sourceInput: string) {
    const response = await fetch(`${baseUrl}/api/industry/workflows`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ entryId, sourceInput, source: 'finance_delivery_e2e' }),
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<any>;
  }

  async function deliver(taskId: string, financeInput: Record<string, unknown>, proof?: string) {
    return fetch(`${baseUrl}/api/industry/workflows/${encodeURIComponent(taskId)}/finance-delivery`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        ...(proof ? { 'x-lumi-desktop-session': proof } : {}),
      },
      body: JSON.stringify({ financeInput }),
    });
  }

  async function task(taskId: string) {
    const response = await fetch(`${baseUrl}/api/industry/workflows/${encodeURIComponent(taskId)}`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    return (await response.json() as any).task;
  }

  const validTaxInput = () => ({
    period: '2026-Q2',
    jurisdiction: 'CN',
    taxpayerType: 'general VAT taxpayer',
    dueDate: '2026-07-15',
    taxes: ['VAT', 'corporate income tax prepayment'],
    businessType: 'software services',
    currency: 'CNY',
    revenue: '1200000.00',
    deductibleCost: '480000.00',
    deductibleExpense: '210000.00',
    incomeTaxRate: '0.25',
    vatOutputTax: '72000.00',
    vatInputTax: '35000.00',
    surchargeRate: '0.12',
    hasPayroll: true,
    hasCrossBorder: false,
    hasMarketplaceIncome: false,
  });

  const validReportInput = () => ({
    period: '2026-07',
    currency: 'CNY',
    businessType: 'software services',
    dataSummary: 'Fixture source: July trial balance TB-2026-07; assets 1,000,000; liabilities 400,000; equity 600,000.',
    statement: {
      totalAssets: '1000000.00',
      totalLiabilities: '400000.00',
      totalEquity: '600000.00',
      tolerance: '0.01',
    },
  });

  it.each([
    {
      entryId: 'tax-filing' as const,
      financeInput: {
        period: '2026-Q2',
        jurisdiction: 'CN',
        taxpayerType: 'general VAT taxpayer',
        dueDate: '2026-07-15',
        taxes: ['VAT', 'corporate income tax prepayment'],
        businessType: 'software services',
        currency: 'CNY',
        revenue: '1200000.00',
        deductibleCost: '480000.00',
        deductibleExpense: '210000.00',
        incomeTaxRate: '0.25',
        vatOutputTax: '72000.00',
        vatInputTax: '35000.00',
        surchargeRate: '0.12',
        hasPayroll: true,
        hasCrossBorder: false,
        hasMarketplaceIncome: false,
      },
      requiredTools: [
        'business_finance_tax_period_checklist',
        'business_finance_tax_position_estimator',
      ],
    },
    {
      entryId: 'report-delivery' as const,
      financeInput: {
        period: '2026-07',
        currency: 'CNY',
        businessType: 'software services',
        dataSummary: 'Fixture source: July trial balance TB-2026-07; assets 1,000,000; liabilities 400,000; equity 600,000.',
        statement: {
          totalAssets: '1000000.00',
          totalLiabilities: '400000.00',
          totalEquity: '600000.00',
          tolerance: '0.01',
        },
      },
      requiredTools: [
        'business_finance_statement_consistency_review',
        'business_finance_finance_report_outline',
      ],
    },
  ])('runs $entryId from REST task binding through real XLSX and persisted verification exactly once', async ({ entryId, financeInput, requiredTools }) => {
    const started = await start(entryId, JSON.stringify(financeInput));
    const proof = issueDesktopSessionProof(ownerId).proof;
    const response = await deliver(started.task.id, financeInput, proof);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ ok: true, status: 'verified', persisted: true, reused: false, externalActions: [] });
    expect(body.task.status).toBe('delivered');
    expect(body.verification.passed).toBe(true);
    expect(body.toolReceipts).toEqual(requiredTools);
    expect(body.artifacts).toHaveLength(1);
    const filePath = String(body.artifacts[0].path);
    generatedFiles.add(filePath);
    expect(filePath.toLowerCase().endsWith('.xlsx')).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath).subarray(0, 2).toString('ascii')).toBe('PK');
    expect(body.artifacts[0].size).toBeGreaterThan(256);
    expect(body.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const workflow = body.task.metadata.industryWorkflow;
    const runs = body.task.metadata.workTakeoverToolRuns;
    expect(workflow.requestId).toBe(started.requestId);
    expect(workflow.conversationTaskId).toBe(started.conversationTaskId);
    expect(runs.map((run: any) => run.toolName)).toEqual([...requiredTools, 'create_xlsx', 'read_xlsx']);
    runs.forEach((run: any) => {
      expect(run.terminalVerification.status).toBe('verified');
      expect(run.taskId).toBe(started.conversationTaskId);
      expect(run.requestId).toBe(started.requestId);
      expect(run.envelope.taskId).toBe(started.conversationTaskId);
      expect(run.envelope.requestId).toBe(started.requestId);
    });
    expect(body.task.metadata.financeDeliveryExecution).toMatchObject({
      status: 'verified',
      requestId: started.requestId,
      conversationTaskId: started.conversationTaskId,
      externalActions: [],
    });

    const countsBeforeReplay = {
      runs: runs.length,
      artifacts: body.task.artifacts.length,
      events: body.task.events.length,
    };
    const replayResponse = await deliver(started.task.id, financeInput, proof);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as any;
    expect(replay).toMatchObject({ ok: true, status: 'verified', persisted: true, reused: true });
    expect(replay.artifacts[0].path).toBe(filePath);
    expect(replay.task.metadata.workTakeoverToolRuns).toHaveLength(countsBeforeReplay.runs);
    expect(replay.task.artifacts).toHaveLength(countsBeforeReplay.artifacts);
    expect(replay.task.events).toHaveLength(countsBeforeReplay.events);
  });

  it('requires login-bound loopback desktop proof and blocks missing structured figures without creating a file', async () => {
    const financeInput = {
      period: '2026-Q2',
      jurisdiction: 'CN',
    };
    const started = await start('tax-filing', JSON.stringify(financeInput));
    expect((await deliver(started.task.id, financeInput)).status).toBe(403);
    expect((await deliver(started.task.id, financeInput, 'invalid-desktop-proof-that-is-long-enough-to-parse-123456')).status).toBe(403);

    const proof = issueDesktopSessionProof(ownerId).proof;
    const response = await deliver(started.task.id, financeInput, proof);
    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body).toMatchObject({ ok: false, status: 'needs_input', code: 'FINANCE_DELIVERY_NEEDS_INPUT' });
    expect(body.missingFields).toEqual(expect.arrayContaining([
      'taxpayerType', 'dueDate', 'currency', 'taxes', 'revenue', 'deductibleCost', 'deductibleExpense', 'incomeTaxRate',
    ]));

    const taskResponse = await fetch(`${baseUrl}/api/industry/workflows/${encodeURIComponent(started.task.id)}`, {
      headers: authHeaders(),
    });
    const task = (await taskResponse.json() as any).task;
    expect(task.status).toBe('blocked');
    expect(task.metadata.financeDeliveryLastAttempt.status).toBe('needs_input');
    expect(task.metadata.workTakeoverToolRuns || []).toHaveLength(0);
    expect(task.artifacts.every((artifact: any) => !artifact.path)).toBe(true);
  });

  it('persists invalid numeric input as a blocked attempt without starting a tool', async () => {
    const financeInput = { ...validTaxInput(), revenue: 'not-a-number' };
    const started = await start('tax-filing', JSON.stringify(financeInput));
    const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'FINANCE_DELIVERY_INVALID_INPUT',
    });
    const blocked = await task(started.task.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.metadata.financeDeliveryLastAttempt).toMatchObject({
      status: 'blocked',
      code: 'FINANCE_DELIVERY_INVALID_INPUT',
    });
    expect(blocked.metadata.workTakeoverToolRuns || []).toHaveLength(0);
    expect(blocked.metadata.workTakeoverVerification).toMatchObject({ passed: false, status: 'blocked' });
  });

  it('rejects changed figures on the same delivered task instead of silently regenerating an artifact', async () => {
    const financeInput = {
      period: '2026-07',
      currency: 'CNY',
      businessType: 'services',
      dataSummary: 'Fixture source TB-A: assets 100, liabilities 40, equity 60.',
      statement: { totalAssets: 100, totalLiabilities: 40, totalEquity: 60 },
    };
    const started = await start('report-delivery', JSON.stringify(financeInput));
    const proof = issueDesktopSessionProof(ownerId).proof;
    const first = await deliver(started.task.id, financeInput, proof);
    expect(first.status).toBe(200);
    const delivered = await first.json() as any;
    generatedFiles.add(delivered.artifacts[0].path);

    const changed = await deliver(started.task.id, {
      ...financeInput,
      statement: { totalAssets: 101, totalLiabilities: 40, totalEquity: 61 },
    }, proof);
    expect(changed.status).toBe(409);
    expect((await changed.json() as any).code).toBe('FINANCE_DELIVERY_INPUT_CONFLICT');
  });

  it('rejects a terminal-verified but malformed production Finance receipt and persists the blocker', async () => {
    const toolName = 'business_finance_tax_period_checklist' as const;
    const original = registry.get(toolName);
    if (!original) throw new Error(`Missing fixture tool ${toolName}`);
    registry.unregister(toolName);
    registry.register({
      ...original,
      handler: async args => JSON.stringify({
        ...withFinanceAuditReceipt('tax_period_checklist', args, buildTaxChecklist(args)),
        checklist: ['semantically incomplete but non-empty'],
      }),
      capability: capabilityContract({
        id: 'test.finance-office.weak-terminal-receipt',
        family: 'finance-office',
        lane: 'industry',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'none', scope: 'malformed receipt fixture', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: [],
          successSignals: ['any non-empty terminal receipt'],
          limitations: ['Models the weak production package contract.'],
        },
      }),
    });
    try {
      const financeInput = validTaxInput();
      const started = await start('tax-filing', JSON.stringify(financeInput));
      const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: 'FINANCE_DELIVERY_RECEIPT_INVALID',
      });
      const blocked = await task(started.task.id);
      expect(blocked.status).toBe('blocked');
      expect(blocked.metadata.financeDeliveryLastAttempt).toMatchObject({
        status: 'blocked',
        code: 'FINANCE_DELIVERY_RECEIPT_INVALID',
        stage: 'domain_receipts',
        orphanArtifactsRemoved: 0,
      });
      expect(blocked.metadata.workTakeoverVerification).toMatchObject({ passed: false, status: 'blocked' });
      expect(blocked.artifacts.every((artifact: any) => !artifact.path)).toBe(true);
    } finally {
      registry.unregister(toolName);
      registry.register(original);
    }
  });

  it('rejects false-positive XLSX readback, removes the orphan workbook, and records the failed stage', async () => {
    const original = registry.get('read_xlsx');
    if (!original) throw new Error('Missing read_xlsx fixture tool');
    const outputDir = getGeneratedOutputDir();
    const xlsxFiles = () => fs.readdirSync(outputDir).filter(name => name.toLowerCase().endsWith('.xlsx')).sort();
    const before = xlsxFiles();
    registry.unregister('read_xlsx');
    registry.register({
      ...original,
      handler: async () => 'Workbook read successfully, but no sheet content was returned.',
    });
    try {
      const financeInput = validReportInput();
      const started = await start('report-delivery', JSON.stringify(financeInput));
      const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: 'FINANCE_DELIVERY_READBACK_FAILED',
      });
      expect(xlsxFiles()).toEqual(before);
      const blocked = await task(started.task.id);
      expect(blocked.status).toBe('blocked');
      expect(blocked.metadata.financeDeliveryLastAttempt).toMatchObject({
        status: 'blocked',
        code: 'FINANCE_DELIVERY_READBACK_FAILED',
        stage: 'workbook_readback',
        orphanArtifactsRemoved: 1,
      });
      expect(blocked.metadata.workTakeoverVerification).toMatchObject({ passed: false, status: 'blocked' });
    } finally {
      registry.unregister('read_xlsx');
      registry.register(original);
    }
  });

  it('rejects a readback with the right proof sheet but corrupted business cells', async () => {
    const original = registry.get('read_xlsx');
    if (!original) throw new Error('Missing read_xlsx fixture tool');
    const outputDir = getGeneratedOutputDir();
    const before = fs.readdirSync(outputDir).filter(name => name.toLowerCase().endsWith('.xlsx')).sort();
    registry.unregister('read_xlsx');
    registry.register({
      ...original,
      handler: async (args, context) => {
        const actual = String(await original.handler(args, context));
        return actual.replace('2026-07,CNY,', '2099-01,USD,');
      },
    });
    try {
      const financeInput = validReportInput();
      const started = await start('report-delivery', JSON.stringify(financeInput));
      const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: 'FINANCE_DELIVERY_READBACK_FAILED' });
      expect(fs.readdirSync(outputDir).filter(name => name.toLowerCase().endsWith('.xlsx')).sort()).toEqual(before);
    } finally {
      registry.unregister('read_xlsx');
      registry.register(original);
    }
  });

  it('rejects a reused completion receipt, then recovers only because the task binds the exact artifact and records', async () => {
    const original = registry.get('industry_workflow_complete');
    if (!original) throw new Error('Missing industry_workflow_complete fixture tool');
    registry.unregister('industry_workflow_complete');
    registry.register({
      ...original,
      handler: async (args, context) => {
        const actual = JSON.parse(String(await original.handler(args, context)));
        return JSON.stringify({ ...actual, reused: true });
      },
    });
    const financeInput = validReportInput();
    const started = await start('report-delivery', JSON.stringify(financeInput));
    const proof = issueDesktopSessionProof(ownerId).proof;
    try {
      const response = await deliver(started.task.id, financeInput, proof);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: 'FINANCE_DELIVERY_VERIFICATION_FAILED' });
      const delivered = await task(started.task.id);
      expect(delivered.status).toBe('delivered');
      expect(delivered.metadata.financeDeliveryExecution).toBeUndefined();
      expect(delivered.metadata.financeDeliveryLastAttempt.status).toBe('readback_verified');
      const artifactPath = delivered.artifacts.find((artifact: any) => artifact.path)?.path;
      expect(artifactPath).toBeTruthy();
      generatedFiles.add(artifactPath);
    } finally {
      registry.unregister('industry_workflow_complete');
      registry.register(original);
    }

    const replayResponse = await deliver(started.task.id, financeInput, proof);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as any;
    expect(replay).toMatchObject({ ok: true, reused: true, status: 'verified' });
    expect(replay.task.metadata.financeDeliveryExecution).toMatchObject({ recovered: true });
  });

  it('removes both the physical workbook and task artifact reference when completion fails after recording it', async () => {
    const original = registry.get('industry_workflow_complete');
    if (!original) throw new Error('Missing industry_workflow_complete fixture tool');
    const outputDir = getGeneratedOutputDir();
    const before = fs.readdirSync(outputDir).filter(name => name.toLowerCase().endsWith('.xlsx')).sort();
    registry.unregister('industry_workflow_complete');
    registry.register({
      ...original,
      handler: async (args, context) => {
        const workbookRecord = (context?.getCurrentToolRecords?.() || []).find(record => record.name === 'create_xlsx');
        const workbookPath = JSON.parse(String(workbookRecord?.result || '{}')).path;
        const blocked = updateWorkTakeoverTask(ownerId, String(args.taskId || ''), {
          status: 'blocked',
          artifact: {
            type: 'file',
            label: 'Failed Finance workbook fixture',
            path: workbookPath,
            status: 'needs_review',
          },
        });
        return JSON.stringify({
          ok: false,
          status: 'blocked',
          persisted: true,
          task: blocked,
          verification: { passed: false, status: 'blocked' },
        });
      },
    });
    try {
      const financeInput = validTaxInput();
      const started = await start('tax-filing', JSON.stringify(financeInput));
      const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
      expect(response.status).toBe(502);
      const body = await response.json() as any;
      expect(body.code).toBe('FINANCE_DELIVERY_TOOL_FAILED');
      expect(fs.readdirSync(outputDir).filter(name => name.toLowerCase().endsWith('.xlsx')).sort()).toEqual(before);
      const blocked = await task(started.task.id);
      expect(blocked.status).toBe('blocked');
      expect(blocked.artifacts.some((artifact: any) => artifact.path)).toBe(false);
      expect(blocked.metadata.financeDeliveryLastAttempt.orphanArtifactsRemoved).toBe(1);
    } finally {
      registry.unregister('industry_workflow_complete');
      registry.register(original);
    }
  });

  it('accepts Decimal.js half-up boundary values without a Number rounding false rejection', async () => {
    const financeInput = {
      ...validTaxInput(),
      revenue: '1.005',
      deductibleCost: '0',
      deductibleExpense: '0',
      vatOutputTax: '',
      vatInputTax: '',
      surchargeRate: '',
    };
    const started = await start('tax-filing', JSON.stringify(financeInput));
    const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    generatedFiles.add(body.artifacts[0].path);
    expect(body.status).toBe('verified');
  });

  it('verifies a long source summary through the bound row hash without depending on truncated readback text', async () => {
    const financeInput = {
      ...validReportInput(),
      dataSummary: `Long-form trial-balance source note: ${'source-basis-'.repeat(600)}`,
    };
    const started = await start('report-delivery', JSON.stringify(financeInput));
    const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    generatedFiles.add(body.artifacts[0].path);
    expect(body.status).toBe('verified');
  });

  it('refuses replay after a valid XLSX is changed from its persisted SHA-256 proof', async () => {
    const financeInput = validReportInput();
    const started = await start('report-delivery', JSON.stringify(financeInput));
    const proof = issueDesktopSessionProof(ownerId).proof;
    const firstResponse = await deliver(started.task.id, financeInput, proof);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as any;
    const artifactPath = first.artifacts[0].path;
    generatedFiles.add(artifactPath);
    fs.appendFileSync(artifactPath, Buffer.from('post-verification-tamper'));

    const replayResponse = await deliver(started.task.id, financeInput, proof);
    expect(replayResponse.status).toBe(409);
    expect(await replayResponse.json()).toMatchObject({ code: 'FINANCE_DELIVERY_ARTIFACT_CHANGED' });
  });

  it('recovers a crash-window delivered task from persisted readback proof without replaying tools', async () => {
    const financeInput = validReportInput();
    const started = await start('report-delivery', JSON.stringify(financeInput));
    const proof = issueDesktopSessionProof(ownerId).proof;
    const firstResponse = await deliver(started.task.id, financeInput, proof);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as any;
    generatedFiles.add(first.artifacts[0].path);
    const execution = first.task.metadata.financeDeliveryExecution;
    const runCount = first.task.metadata.workTakeoverToolRuns.length;
    const artifactCount = first.task.artifacts.length;
    updateWorkTakeoverTask(ownerId, started.task.id, {
      metadata: {
        financeDeliveryExecution: undefined,
        financeDeliveryLastAttempt: {
          status: 'readback_verified',
          entryId: 'report-delivery',
          inputDigest: execution.inputDigest,
          conversationTaskId: execution.conversationTaskId,
          requestId: execution.requestId,
          toolReceipts: execution.toolReceipts,
          executionRecordIds: execution.executionRecordIds,
          receiptDigests: execution.receiptDigests,
          provisionalArtifact: execution.artifacts[0],
          externalActions: [],
        },
      },
    });

    const replayResponse = await deliver(started.task.id, financeInput, proof);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as any;
    expect(replay).toMatchObject({ ok: true, status: 'verified', persisted: true, reused: true });
    expect(replay.task.metadata.financeDeliveryExecution).toMatchObject({ status: 'verified', recovered: true });
    expect(replay.task.metadata.workTakeoverToolRuns).toHaveLength(runCount);
    expect(replay.task.artifacts).toHaveLength(artifactCount);
  });

  it('removes a task-owned workbook left before crash metadata and records recovery before retry', async () => {
    const financeInput = validTaxInput();
    const started = await start('tax-filing', JSON.stringify(financeInput));
    const taskHash = crypto.createHash('sha256').update(started.task.id).digest('hex').slice(0, 16);
    const stalePath = path.join(getGeneratedOutputDir(), `finance-tax-filing-${taskHash}-2025-Q4_1.xlsx`);
    fs.writeFileSync(stalePath, 'PK stale crash-window artifact');
    expect(fs.existsSync(stalePath)).toBe(true);

    const response = await deliver(started.task.id, financeInput, issueDesktopSessionProof(ownerId).proof);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    generatedFiles.add(body.artifacts[0].path);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(body.task.metadata.financeDeliveryRecovery).toMatchObject({
      status: 'stale_artifacts_removed',
      count: 1,
    });
  });

  it('coalesces simultaneous same-input delivery requests into one artifact and one evidence chain', async () => {
    const financeInput = validTaxInput();
    const started = await start('tax-filing', JSON.stringify(financeInput));
    const proof = issueDesktopSessionProof(ownerId).proof;
    const [leftResponse, rightResponse] = await Promise.all([
      deliver(started.task.id, financeInput, proof),
      deliver(started.task.id, financeInput, proof),
    ]);
    expect(leftResponse.status).toBe(200);
    expect(rightResponse.status).toBe(200);
    const [left, right] = await Promise.all([leftResponse.json(), rightResponse.json()]) as any[];
    expect(left.artifacts[0].path).toBe(right.artifacts[0].path);
    generatedFiles.add(left.artifacts[0].path);
    expect(left.task.metadata.workTakeoverToolRuns).toHaveLength(4);
    expect(left.task.artifacts.filter((artifact: any) => artifact.path)).toHaveLength(1);
  });

  it('never reports a replay as persisted while the strict durability boundary is failing', async () => {
    const financeInput = validReportInput();
    const started = await start('report-delivery', JSON.stringify(financeInput));
    const proof = issueDesktopSessionProof(ownerId).proof;
    let flushCount = 0;
    setFinanceDeliveryStateFlusherForTests(async () => {
      flushCount += 1;
      if (flushCount >= 3) throw new Error('simulated persistent storage failure');
      await flushDBOrThrow();
    });

    try {
      const firstResponse = await deliver(started.task.id, financeInput, proof);
      expect(firstResponse.status).toBe(500);
      expect(await firstResponse.json()).toMatchObject({
        ok: false,
        code: 'FINANCE_DELIVERY_PERSISTENCE_FAILED',
      });
      const deliveredOnlyInMemory = await task(started.task.id);
      expect(deliveredOnlyInMemory).toMatchObject({
        status: 'delivered',
        metadata: {
          workTakeoverVerification: { passed: true },
          financeDeliveryExecution: { status: 'verified' },
        },
      });
      const runCount = deliveredOnlyInMemory.metadata.workTakeoverToolRuns.length;
      const artifactPath = deliveredOnlyInMemory.artifacts.find((artifact: any) => artifact.path)?.path;
      expect(flushCount).toBe(3);

      const replayWhileFailing = await deliver(started.task.id, financeInput, proof);
      expect(replayWhileFailing.status).toBe(500);
      expect(await replayWhileFailing.json()).toMatchObject({
        ok: false,
        code: 'FINANCE_DELIVERY_PERSISTENCE_FAILED',
      });
      const stillUnclaimed = await task(started.task.id);
      expect(stillUnclaimed.metadata.workTakeoverToolRuns).toHaveLength(runCount);
      expect(stillUnclaimed.artifacts.find((artifact: any) => artifact.path)?.path).toBe(artifactPath);
      expect(flushCount).toBe(4);
    } finally {
      setFinanceDeliveryStateFlusherForTests();
    }

    const recoveredReplay = await deliver(started.task.id, financeInput, proof);
    expect(recoveredReplay.status).toBe(200);
    const recovered = await recoveredReplay.json() as any;
    generatedFiles.add(recovered.artifacts[0].path);
    expect(recovered).toMatchObject({ ok: true, status: 'verified', persisted: true, reused: true });
  });
});
