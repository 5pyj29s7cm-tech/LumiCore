import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyCapabilityReceipt } from '../server/tools/capability_verification';
import type { CapabilityManifestEntry, CapabilityVerification } from '../server/tools/types';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function capability(
  strategy: CapabilityVerification['strategy'],
  required = true,
): CapabilityManifestEntry {
  return {
    toolName: `demo_${strategy}`,
    capabilityId: `demo.${strategy}`,
    family: 'demo',
    lane: strategy === 'provider_ack' ? 'messaging' : 'files',
    source: 'builtin',
    description: 'Verification test capability.',
    permission: 'public',
    configuredSecurityLevel: 'safe',
    effectiveSecurityLevel: 'safe',
    effectiveSecurityReason: 'test',
    executable: true,
    requiresConfirmation: false,
    operation: strategy === 'provider_ack' ? 'communicate' : 'create',
    modes: ['assistant'],
    risk: 'medium',
    sideEffects: [{ type: 'local_write', scope: 'test', reversible: true }],
    metadataSources: {
      operation: 'tool_definition',
      lane: 'tool_definition',
      risk: 'tool_definition',
      sideEffects: 'tool_definition',
      evidence: 'tool_definition',
      verification: 'tool_definition',
    },
    assurance: 'verified',
    hasEvidenceContract: true,
    evidence: {
      capability: `demo.${strategy}`,
      operation: strategy === 'provider_ack' ? 'communicate' : 'create',
      assurance: 'verified',
      limitations: [],
      declarationSource: 'tool_definition',
      explicit: true,
    },
    verification: {
      strategy,
      required,
      requiredFields: [],
      successSignals: [],
      limitations: [],
    },
    fallbacks: [],
    provenance: { kind: 'builtin', provider: 'lumi-core', trust: 'core' },
    trust: 'core',
    deprecated: false,
    modeSecurity: {},
    domains: [],
    intents: [],
    routingTerms: [],
    prerequisites: [],
    parameterNames: [],
  };
}

describe('capability terminal verification', () => {
  it('verifies artifact receipts only when the declared file exists and is non-empty', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-capability-'));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, 'result.txt');
    fs.writeFileSync(artifactPath, 'verified output');

    expect(verifyCapabilityReceipt(capability('artifact'), {
      result: JSON.stringify({ ok: true, outputPath: artifactPath }),
    }).status).toBe('verified');
    expect(verifyCapabilityReceipt(capability('artifact'), {
      result: JSON.stringify({ ok: true, outputPath: path.join(directory, 'missing.txt') }),
    }).status).toBe('unverified');
  });

  it('requires target acknowledgement for communication completion', () => {
    expect(verifyCapabilityReceipt(capability('provider_ack'), {
      result: JSON.stringify({ ok: true, draftCreated: true }),
    }).status).toBe('unverified');
    expect(verifyCapabilityReceipt(capability('provider_ack'), {
      result: JSON.stringify({ ok: true, sent: true }),
    }).status).toBe('verified');
  });

  it('does not let a user-reviewed adapter certify its own business outcome', () => {
    const contract = capability('provider_ack');
    contract.source = 'adapter';
    contract.provenance = { kind: 'adapter', provider: 'ext_untrusted_provider', trust: 'user-reviewed' };
    contract.trust = 'user-reviewed';
    expect(verifyCapabilityReceipt(contract, {
      result: JSON.stringify({
        ok: true,
        status: 'sent',
        sent: true,
        verified: true,
        verificationStatus: 'verified',
      }),
    })).toMatchObject({
      status: 'unverified',
      reason: expect.stringMatching(/host-owned corroboration/i),
    });
  });

  it('requires verified post-state for state-diff and visual strategies', () => {
    expect(verifyCapabilityReceipt(capability('state_diff'), {
      result: JSON.stringify({ ok: true, action: 'click' }),
    }).status).toBe('unverified');
    expect(verifyCapabilityReceipt(capability('state_diff'), {
      result: JSON.stringify({ ok: true, targetMatched: true }),
    }).status).toBe('verified');
    expect(verifyCapabilityReceipt(capability('visual'), {
      result: JSON.stringify({ ok: true, verification: { status: 'verified' } }),
    }).status).toBe('verified');
  });

  it('distinguishes measurement, explicit failure, and optional verification', () => {
    expect(verifyCapabilityReceipt(capability('measured'), {
      result: JSON.stringify({ ok: true, cpuPercent: 17.5 }),
    }).status).toBe('verified');
    expect(verifyCapabilityReceipt(capability('measured'), {
      result: JSON.stringify({ ok: true, note: 'no sample' }),
    }).status).toBe('unverified');
    expect(verifyCapabilityReceipt(capability('terminal_receipt'), {
      result: JSON.stringify({ ok: false, status: 'failed' }),
    }).status).toBe('failed');
    expect(verifyCapabilityReceipt(capability('none', false), {
      result: 'accepted',
    }).status).toBe('verified');
  });

  it('enforces capability-specific fields, values, artifacts, and success statuses', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-capability-contract-'));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, 'operations.json');
    fs.writeFileSync(artifactPath, '{}');
    const contract = capability('terminal_receipt');
    contract.verification = {
      strategy: 'terminal_receipt',
      required: true,
      requiredFields: ['ok', 'status', 'receipt.path'],
      requiredValues: { ok: true, 'receipt.ready': true },
      successStatuses: ['cancelled'],
      requiredArtifacts: ['receipt.path'],
      successSignals: [],
      limitations: [],
    };

    expect(verifyCapabilityReceipt(contract, {
      result: JSON.stringify({ ok: true, status: 'cancelled', receipt: { ready: true, path: artifactPath } }),
    }).status).toBe('verified');
    expect(verifyCapabilityReceipt(contract, {
      result: JSON.stringify({ ok: true, status: 'cancelled', receipt: { ready: false, path: artifactPath } }),
    }).status).toBe('unverified');
    expect(verifyCapabilityReceipt(contract, {
      result: JSON.stringify({ ok: true, status: 'done', receipt: { ready: true, path: artifactPath } }),
    }).status).toBe('unverified');
  });

  it('verifies a receipt-only nested JSON result instead of requiring display text', () => {
    const contract = capability('terminal_receipt');
    contract.verification = {
      strategy: 'terminal_receipt',
      required: true,
      requiredFields: ['ok', 'status', 'matchedCount', 'cancelledCount'],
      requiredValues: { ok: true },
      successStatuses: ['idle', 'cancelled'],
      successSignals: [],
      limitations: [],
    };

    expect(verifyCapabilityReceipt(contract, {
      result: '',
      receipt: JSON.stringify(JSON.stringify({
        ok: true,
        status: 'cancelled',
        matchedCount: 8,
        cancelledCount: 8,
      })),
    })).toMatchObject({ status: 'verified' });
  });
});
