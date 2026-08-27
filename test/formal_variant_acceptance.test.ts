import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORMAL_VARIANT_ACCEPTANCE_KIND,
  FORMAL_VARIANT_ACCEPTANCE_SCHEMA_VERSION,
  FORMAL_VARIANT_EVIDENCE_KIND,
  FORMAL_VARIANT_IDS,
  buildFormalVariantAcceptanceManifest,
  manifestDigest,
  validateFormalVariantAcceptanceEvidence,
  validateFormalVariantAcceptanceManifest,
} from '../scripts/formal-variant-acceptance.mjs';

const CORE_SHA = 'a'.repeat(40);
const GENERATED_AT = '2026-08-27T06:00:00.000Z';
const COMPLETED_AT = '2026-08-27T07:00:00.000Z';

function bindings() {
  return FORMAL_VARIANT_IDS.map((variantId: string, index: number) => ({
    variantId,
    coreSha: CORE_SHA,
    variantSha: String(index + 1).repeat(40),
    dataRoot: `C:\\LumiFormal\\${variantId}\\Data`,
    webviewProfile: `C:\\LumiFormal\\${variantId}\\WebView2`,
  }));
}

function buildManifest() {
  return buildFormalVariantAcceptanceManifest({ bindings: bindings(), generatedAt: GENERATED_AT });
}

function joinPortable(root: string, ...segments: string[]) {
  return path.win32.isAbsolute(root)
    ? path.win32.join(root, ...segments)
    : path.posix.join(root, ...segments);
}

function completeEvidence(manifest: any) {
  return {
    schemaVersion: FORMAL_VARIANT_ACCEPTANCE_SCHEMA_VERSION,
    kind: FORMAL_VARIANT_EVIDENCE_KIND,
    manifestDigest: manifest.manifestDigest,
    scenarios: manifest.scenarios.map((scenario: any) => {
      const toolReceipts = scenario.requiredReceipts.flatMap((requirement: any) => (
        Array.from({ length: requirement.minimum }, (_, index) => ({
          toolName: requirement.toolName,
          receiptId: `${scenario.binding.variantId}:${requirement.toolName}:${index + 1}`,
          taskId: `${scenario.binding.variantId}:task`,
          requestId: `${scenario.binding.variantId}:step:${scenario.userSteps.length}`,
          persisted: true,
          outcome: 'succeeded',
          terminalVerification: { status: 'verified' },
        }))
      ));
      const receiptIds = toolReceipts.map((item: any) => item.receiptId);
      return {
        scenarioId: scenario.scenarioId,
        bindingFingerprint: scenario.binding.fingerprint,
        runtimeBinding: {
          variantId: scenario.binding.variantId,
          coreSha: scenario.binding.coreSha,
          variantSha: scenario.binding.variantSha,
          dataRoot: scenario.binding.dataRoot,
          webviewProfile: scenario.binding.webviewProfile,
        },
        completedAt: COMPLETED_AT,
        fixtures: scenario.fixtures.map((fixture: any) => ({
          id: fixture.id,
          path: joinPortable(
            scenario.binding.dataRoot,
            'formal-variant-acceptance',
            'fixtures',
            `${fixture.id}${fixture.acceptedExtensions[0]}`,
          ),
          sha256: 'b'.repeat(64),
          size: 1024,
        })),
        steps: scenario.userSteps.map((step: any, index: number) => ({
          id: step.id,
          status: 'completed',
          taskId: `${scenario.binding.variantId}:task`,
          requestId: `${scenario.binding.variantId}:step:${index + 1}`,
          userMessageId: `${scenario.binding.variantId}:user:${index + 1}`,
          assistantMessageId: `${scenario.binding.variantId}:assistant:${index + 1}`,
        })),
        toolReceipts,
        observedForbiddenSideEffects: [],
        artifacts: scenario.finalArtifacts.map((artifact: any) => artifact.kind === 'file'
          ? {
              id: artifact.id,
              kind: 'file',
              path: joinPortable(
                scenario.binding.dataRoot,
                'formal-variant-acceptance',
                'artifacts',
                `${artifact.id}${artifact.acceptedExtensions[0]}`,
              ),
              sha256: 'c'.repeat(64),
              size: 4096,
              receiptIds,
            }
          : {
              id: artifact.id,
              kind: 'durable_record',
              durableId: `${scenario.binding.variantId}:${artifact.id}:durable`,
              receiptIds,
            }),
        humanChecks: scenario.humanChecks.map((check: any) => ({
          id: check.id,
          status: 'passed',
          reviewerType: 'human',
          reviewer: 'formal-reviewer',
          checkedAt: COMPLETED_AT,
        })),
      };
    }),
  };
}

function expectBuildCode(mutator: (items: any[]) => any[], code: string) {
  let thrown: any;
  try {
    buildFormalVariantAcceptanceManifest({ bindings: mutator(bindings()), generatedAt: GENERATED_AT });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code });
}

describe('formal variant acceptance manifest', () => {
  it('defines all four executable scenarios without claiming a business result', () => {
    const manifest = buildManifest();
    expect(manifest).toMatchObject({
      schemaVersion: FORMAL_VARIANT_ACCEPTANCE_SCHEMA_VERSION,
      kind: FORMAL_VARIANT_ACCEPTANCE_KIND,
      generatedAt: GENERATED_AT,
      executionPolicy: {
        mode: 'orchestration_and_validation_only',
        launchClient: false,
        synthesizeBusinessResults: false,
        allVariantsRequired: true,
        defaultOutcome: 'unverified',
      },
    });
    expect(manifest.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.scenarios.map((item: any) => item.binding.variantId)).toEqual(FORMAL_VARIANT_IDS);
    expect(manifest.scenarios.every((item: any) => (
      item.status === 'planned'
      && item.result === null
      && item.fixtures.length >= 2
      && item.userSteps.length >= 5
      && item.allowedTools.length > 0
      && item.forbiddenSideEffects.length > 0
      && item.requiredReceipts.length > 0
      && item.finalArtifacts.length > 0
      && item.humanChecks.length > 0
    ))).toBe(true);
    expect(validateFormalVariantAcceptanceManifest(manifest)).toEqual({ ok: true, errors: [] });
  });

  it('covers the exact domain closure and safety boundary for each variant', () => {
    const manifest = buildManifest();
    const scenarios = Object.fromEntries(manifest.scenarios.map((item: any) => [item.binding.variantId, item]));
    expect(scenarios['designer-client']).toMatchObject({
      workflow: { entryId: 'visualization', executionMode: 'standalone' },
      finalArtifacts: expect.arrayContaining([expect.objectContaining({ id: 'edited-visual', kind: 'file' })]),
    });
    expect(scenarios['designer-client'].requiredReceipts.map((item: any) => item.toolName)).toContain('generate_image');
    expect(scenarios['ecommerce-client']).toMatchObject({
      workflow: { entryId: 'listing-automation' },
      finalArtifacts: expect.arrayContaining([expect.objectContaining({ id: 'prepublish-check' })]),
    });
    expect(scenarios['ecommerce-client'].forbiddenSideEffects.map((item: any) => item.id)).toContain('publication');
    expect(scenarios['finance-client']).toMatchObject({
      workflow: { entryId: 'report-delivery' },
      finalArtifacts: expect.arrayContaining([expect.objectContaining({ id: 'finance-report', kind: 'file' })]),
    });
    expect(scenarios['finance-client'].requiredReceipts.map((item: any) => item.toolName)).toEqual(expect.arrayContaining([
      'mcp_finance-office_statement_consistency_review',
      'create_xlsx',
      'read_xlsx',
    ]));
    expect(scenarios['legal-client']).toMatchObject({
      workflow: { entryId: 'contract-review' },
      finalArtifacts: expect.arrayContaining([expect.objectContaining({ id: 'citation-evidence-packet' })]),
    });
    expect(scenarios['legal-client'].requiredReceipts.map((item: any) => item.toolName)).toContain('authority_research');
  });

  it('binds every scenario to exact Core, variant, formal data-root, and WebView identities', () => {
    const manifest = buildManifest();
    for (const scenario of manifest.scenarios) {
      expect(scenario.binding).toMatchObject({
        coreSha: CORE_SHA,
        variantSha: expect.stringMatching(/^[a-f0-9]{40}$/),
        dataRoot: expect.stringMatching(/^[A-Z]:\\/i),
        webviewProfile: expect.stringMatching(/^[A-Z]:\\/i),
        dataRootMode: 'formal_persistent',
        webviewProfileMode: 'formal_persistent',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(scenario.binding.dataRoot).not.toBe(scenario.binding.webviewProfile);
    }
  });

  it('fails closed when any required binding is missing, ambiguous, relative, or stale', () => {
    expectBuildCode(items => items.slice(0, 3), 'variant_binding_count_invalid');
    expectBuildCode(items => items.map((item, index) => index === 0 ? { ...item, coreSha: '' } : item), 'core_sha_invalid');
    expectBuildCode(items => items.map((item, index) => index === 0 ? { ...item, variantSha: '' } : item), 'variant_sha_invalid');
    expectBuildCode(items => items.map((item, index) => index === 0 ? { ...item, dataRoot: 'relative-data' } : item), 'formal_data_root_invalid');
    expectBuildCode(items => items.map((item, index) => index === 0 ? { ...item, webviewProfile: '' } : item), 'formal_webview_profile_invalid');
    expectBuildCode(items => items.map((item, index) => index === 0 ? { ...item, dataRoot: 'C:\\Formal\\..\\Other' } : item), 'formal_data_root_invalid');
    expectBuildCode(items => items.map((item, index) => index === 0 ? { ...item, dataRoot: '/home/alice\\Data' } : item), 'formal_data_root_invalid');
    expectBuildCode(items => items.map((item, index) => index === 1 ? { ...item, coreSha: 'f'.repeat(40) } : item), 'core_sha_not_shared');
    expectBuildCode(items => items.map((item, index) => index === 1 ? { ...item, dataRoot: items[0].dataRoot } : item), 'formal_data_root_not_unique');
    expectBuildCode(items => items.map((item, index) => index === 1 ? { ...item, webviewProfile: items[0].webviewProfile } : item), 'formal_webview_profile_not_unique');
  });

  it('rejects a redigested manifest that expands tools or changes the runtime binding', () => {
    const expanded = structuredClone(buildManifest());
    expanded.scenarios[0].allowedTools.push('run_command');
    expanded.manifestDigest = manifestDigest(expanded);
    expect(validateFormalVariantAcceptanceManifest(expanded)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['designer-client:allowed_tools_invalid']),
    });

    const rebound = structuredClone(buildManifest());
    rebound.scenarios[0].binding.variantSha = 'f'.repeat(40);
    rebound.manifestDigest = manifestDigest(rebound);
    expect(validateFormalVariantAcceptanceManifest(rebound)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['designer-client:binding_fingerprint_invalid']),
    });
  });

  it('accepts only complete runtime receipts, bounded artifacts, and human checks', () => {
    const manifest = buildManifest();
    const evidence = completeEvidence(manifest);
    expect(validateFormalVariantAcceptanceEvidence(manifest, evidence)).toEqual({
      ok: true,
      packageComplete: true,
      filesystemVerified: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      errors: [],
    });
  });

  it('does not turn an incomplete or unsafe run into a successful result', () => {
    const manifest = buildManifest();
    expect(validateFormalVariantAcceptanceEvidence(manifest, {})).toEqual({
      ok: false,
      packageComplete: false,
      filesystemVerified: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      errors: ['evidence_envelope_invalid'],
    });

    const evidence = completeEvidence(manifest);
    const finance = evidence.scenarios.find((item: any) => item.scenarioId.includes('finance'));
    finance.toolReceipts = finance.toolReceipts.filter((item: any) => item.toolName !== 'read_xlsx');
    finance.observedForbiddenSideEffects.push('external_delivery');
    finance.artifacts.find((item: any) => item.kind === 'file').path = 'C:\\Outside\\report.xlsx';
    finance.humanChecks[0].reviewerType = 'ai';
    finance.runtimeBinding.variantSha = 'f'.repeat(40);
    expect(validateFormalVariantAcceptanceEvidence(manifest, evidence)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'finance-client:runtime_binding_variantSha_mismatch',
        'finance-client:receipt_read_xlsx_missing',
        'finance-client:forbidden_side_effect_observed',
        'finance-client:artifact_finance-report_missing',
        'finance-client:human_check_control-totals-match_incomplete',
      ]),
    });
  });

  it('does not trust caller-supplied file hashes when filesystem verification is requested', () => {
    const manifest = buildManifest();
    const result = validateFormalVariantAcceptanceEvidence(
      manifest,
      completeEvidence(manifest),
      { verifyFilesystem: true },
    );
    expect(result).toMatchObject({
      ok: false,
      packageComplete: false,
      filesystemVerified: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      'designer-client:fixture_source-assets_file_not_verified',
      'designer-client:artifact_edited-visual_file_not_verified',
      'finance-client:artifact_finance-report_file_not_verified',
    ]));
  });

  it('rejects unexpected tools, unknown artifact receipts, and a manifest mismatch', () => {
    const manifest = buildManifest();
    const evidence = completeEvidence(manifest);
    const designer = evidence.scenarios[0];
    designer.toolReceipts.push({
      toolName: 'desktop_run_command',
      receiptId: 'unexpected',
      taskId: 'task',
      requestId: 'request',
      persisted: true,
      terminalVerification: { status: 'verified' },
    });
    designer.artifacts[0].receiptIds = ['unknown-receipt'];
    evidence.manifestDigest = 'f'.repeat(64);
    expect(validateFormalVariantAcceptanceEvidence(manifest, evidence)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'evidence_manifest_digest_mismatch',
        'designer-client:unexpected_tool_receipt',
        'designer-client:artifact_edited-visual_missing',
      ]),
    });
  });

  it('remains a pure orchestration module and does not import client launch transports', () => {
    const source = fs.readFileSync(path.resolve('scripts/formal-variant-acceptance.mjs'), 'utf8');
    expect(source).not.toMatch(/node:child_process|socket\.io-client|bootstrapDesktopTestSession/);
    expect(source).toContain("launchClient: false");
    expect(source).toContain("synthesizeBusinessResults: false");
  });
});
