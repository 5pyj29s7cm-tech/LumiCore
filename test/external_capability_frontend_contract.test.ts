import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiClient';
import {
  canUseExternalCapabilitiesForSurface,
  createExternalCapabilityExecutionCorrelation,
  deactivateExternalCapability,
  executeExternalCapabilityAction,
  getDesktopExternalCapabilities,
  normalizeExternalCapabilitiesPayload,
  normalizeExternalCapabilityReview,
} from '../src/services/externalCapabilities';
import { externalCapabilityCopy } from '../src/i18n/locales/externalCapabilities';

vi.mock('../src/services/apiClient', () => ({ apiFetch: vi.fn() }));

describe('external capability frontend contract', () => {
  it('normalizes the activated server projection without inventing readiness', () => {
    const [capability] = normalizeExternalCapabilitiesPayload({
      capabilities: [{
        id: 'aivid-comic-drama',
        version: '1.0.0',
        name: 'Aivid',
        description: 'Reviewed customer tool',
        stage: 'connected',
        availability: 'unavailable',
        unavailableReason: 'Live verification has not passed.',
        presentation: { icon: 'film', placements: ['desktop', 'skill_center'], launchActionId: 'launch' },
        runtimeRefs: [{ id: 'aivid-runtime', kind: 'signed_extension', provider: 'aivid' }],
        guidance: {
          whenToUse: ['Prepare a comic drama.'],
          whenNotToUse: ['Do not claim publishing without a receipt.'],
          triggerHints: ['comic drama'],
          steps: ['Open the reviewed workspace.', 'Create a draft.'],
          completionRules: ['A verified artifact exists.'],
        },
        actions: [{
          id: 'launch',
          label: 'Open Aivid',
          capabilityId: 'aivid.launch',
          toolName: 'aivid_launch',
          executionMode: 'assisted',
          requiresConfirmation: false,
          availability: 'ready',
          verification: { status: 'verified', verifiedRuns: 3 },
        }],
      }],
    });

    expect(capability).toMatchObject({
      id: 'aivid-comic-drama',
      stage: 'connected',
      availability: 'unavailable',
      runtimeRefs: [{ id: 'aivid-runtime', kind: 'signed_extension', provider: 'aivid' }],
    });
    expect(capability.actions[0]).toMatchObject({
      id: 'launch',
      availability: 'ready',
      verification: { status: 'verified', verifiedRuns: 3 },
    });
    expect(capability.guidance.steps).toEqual(['Open the reviewed workspace.', 'Create a draft.']);
  });

  it('binds the review nonce to the same proposal and exposes only review summaries', () => {
    const proposal = {
      schemaVersion: 1,
      id: 'customer-tool',
      version: '2.0.0',
      name: 'Customer Tool',
      description: 'One reviewed workflow',
      presentation: { icon: 'box', placements: ['skill_center'] },
      guidance: {
        whenToUse: ['Use for the customer workflow.'],
        whenNotToUse: [],
        triggerHints: ['customer workflow'],
        steps: ['Open the customer workspace.'],
        completionRules: ['A verified receipt exists.'],
      },
      documents: [{ kind: 'manual', label: 'Usage guide', ref: 'https://example.com/guide', sha256: 'a'.repeat(64) }],
      runtimeRefs: [{ id: 'customer-runtime', kind: 'mcp', provider: 'customer' }],
      credentialRefs: ['LOCAL_REFERENCE'],
      actions: [{
        id: 'launch',
        label: 'Launch',
        description: 'Open the reviewed tool.',
        executionMode: 'manual',
        runtimeRef: 'customer-runtime',
        tool: { name: 'customer_launch', capabilityId: 'customer.launch', fixedArguments: {}, userArgumentNames: [] },
      }],
      acceptance: { requiredActionIds: ['launch'], minimumVerifiedRuns: 1 },
    };
    const review = normalizeExternalCapabilityReview({
      reviewNonce: 'one-time-review',
      expiresAt: '2026-09-01T12:00:00.000Z',
      packageDigest: 'digest',
      review: {
        id: 'customer-tool',
        version: '2.0.0',
        name: 'Customer Tool',
        runtimeRefs: [{ id: 'customer-runtime', kind: 'mcp', provider: 'customer' }],
        documents: [{ kind: 'manual', label: 'Usage guide', sha256: 'a'.repeat(64) }],
        permissions: [{ actionId: 'launch', permission: 'desktop-control', risk: 'low' }],
        resolvedActions: [{
          actionId: 'launch',
          toolName: 'customer_launch',
          capabilityId: 'customer.launch',
          source: 'mcp',
          provider: 'customer',
          executable: true,
          requiresConfirmation: false,
        }],
        warnings: ['Live verification is still required.'],
      },
    }, proposal);

    expect(review.reviewNonce).toBe('one-time-review');
    expect(review.proposal).toBe(proposal);
    expect(review.documents).toEqual(['Usage guide']);
    expect(review.permissions).toEqual(['desktop-control [low]']);
    expect(review.actions[0]).toMatchObject({ id: 'launch', toolName: 'customer_launch', executable: true });
  });

  it('creates desktop launchers only from the shared desktop placement and launch action', () => {
    const capabilities = normalizeExternalCapabilitiesPayload({ capabilities: [
      {
        id: 'desktop-tool', name: 'Desktop Tool', stage: 'automatic', availability: 'ready',
        presentation: { placements: ['desktop'], launchActionId: 'launch' }, runtimeRefs: [{ id: 'desktop-runtime', kind: 'mcp' }],
        actions: [{ id: 'launch', capabilityId: 'desktop.launch', availability: 'ready', verification: { status: 'verified', verifiedRuns: 2 } }],
      },
      {
        id: 'hall-only', name: 'Hall only', stage: 'verified', availability: 'ready',
        presentation: { placements: ['skill_center'], launchActionId: 'launch' }, runtimeRefs: [{ id: 'hall-runtime', kind: 'skill' }],
        actions: [{ id: 'launch', capabilityId: 'hall.launch', availability: 'ready', verification: { status: 'verified' } }],
      },
      {
        id: 'no-launch', name: 'No launch', stage: 'verified', availability: 'ready',
        presentation: { placements: ['desktop'] }, runtimeRefs: [{ id: 'inspect-runtime', kind: 'skill' }],
        actions: [{ id: 'inspect', capabilityId: 'desktop.inspect', availability: 'ready', verification: { status: 'verified' } }],
      },
      {
        id: 'unavailable-desktop', name: 'Unavailable desktop', stage: 'configured', availability: 'unavailable',
        presentation: { placements: ['desktop'], launchActionId: 'launch' }, runtimeRefs: [{ id: 'offline-runtime', kind: 'mcp' }],
        actions: [{ id: 'launch', capabilityId: 'offline.launch', availability: 'ready', verification: { status: 'never' } }],
      },
      {
        id: 'unavailable-action', name: 'Unavailable action', stage: 'connected', availability: 'ready',
        presentation: { placements: ['desktop'], launchActionId: 'launch' }, runtimeRefs: [{ id: 'action-runtime', kind: 'mcp' }],
        actions: [{ id: 'launch', capabilityId: 'action.launch', availability: 'unavailable', verification: { status: 'never' } }],
      },
    ] });

    const desktop = getDesktopExternalCapabilities(capabilities);
    expect(desktop).toHaveLength(1);
    expect(desktop[0].capability.id).toBe('desktop-tool');
    expect(desktop[0].action.id).toBe('launch');
    expect(desktop[0].action.verification.verifiedRuns).toBe(2);
  });

  it('permits capability loading only for a signed-in native personal surface', () => {
    expect(canUseExternalCapabilitiesForSurface({ isTauri: true, workDomain: 'personal', userId: 'admin-uid' })).toBe(true);
    expect(canUseExternalCapabilitiesForSurface({ isTauri: false, workDomain: 'personal', userId: 'admin-uid' })).toBe(false);
    expect(canUseExternalCapabilitiesForSurface({ isTauri: true, workDomain: 'work', userId: 'admin-uid' })).toBe(false);
    expect(canUseExternalCapabilitiesForSurface({ isTauri: true, workDomain: 'personal', userId: '' })).toBe(false);
  });

  it('does not describe a launch receipt as proof that the target page became active', () => {
    expect(externalCapabilityCopy('en').launchCompleted('Aivid')).not.toMatch(/verified/i);
    expect(externalCapabilityCopy('zh').launchCompleted('Aivid')).not.toContain('已验证');
  });

  it('sends caller-owned stable correlation keys with every capability action request', async () => {
    const correlation = createExternalCapabilityExecutionCorrelation();
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        execution: {
          receiptId: 'receipt-1',
          status: 'verified_success',
          toolName: 'external_capability_action_test',
        },
      }),
    } as Response);

    await executeExternalCapabilityAction('customer-tool', 'launch', {}, correlation);
    const [, init] = vi.mocked(apiFetch).mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body || '{}'))).toMatchObject({
      arguments: {},
      requestId: correlation.requestId,
      idempotencyKey: correlation.idempotencyKey,
    });
    expect(correlation.requestId).toMatch(/^[A-Za-z0-9._:-]{8,180}$/);
    expect(correlation.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,256}$/);
  });

  it('uses the owner-scoped deactivation endpoint without projecting client-owned state', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ capabilityId: 'customer-tool', status: 'inactive' }),
    } as Response);

    await expect(deactivateExternalCapability('customer-tool')).resolves.toMatchObject({
      capabilityId: 'customer-tool',
      status: 'inactive',
    });
    const [path, init] = vi.mocked(apiFetch).mock.calls.at(-1)!;
    expect(path).toBe('/api/external-capabilities/customer-tool/deactivate');
    expect(init).toMatchObject({ method: 'POST' });
    expect(externalCapabilityCopy('en').deactivationConfirm('Customer Tool')).toMatch(/desktop launcher/i);
    expect(externalCapabilityCopy('zh').deactivationConfirm('客户工具')).toContain('桌面启动入口');
  });
});
