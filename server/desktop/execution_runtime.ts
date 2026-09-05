import crypto from 'node:crypto';
import type { CapabilityManifestEntry, ToolExecutionRecord } from '../tools/types';
import {
  recordDesktopAuthorizationBlock,
  recordDesktopExecutionReceipt,
  recordDesktopPlanCreated,
} from '../runtime/capability_metrics';
import {
  assessDesktopApplicationIdentity,
  desktopFingerprintMatchesRequestedTarget,
  verifyDesktopExecutionReceipt,
  type DesktopActionStep,
  type DesktopExecutionPlan,
  type DesktopExecutionReceipt,
  type DesktopStepReceipt,
  type ApplicationIdentityAssessment,
  type DesktopWindowFingerprint,
} from './execution_plan';

export interface DesktopRuntimeAuthorization {
  allowed: boolean;
  reason: string;
}

type WindowFingerprint = DesktopWindowFingerprint & {
  title: string;
  processName: string;
  processId?: number;
  nativeWindowHandle?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  dpiScale?: number;
  displayId?: string;
};

const CONTROL_TOOL_RE = /^(?:client_(?:get_state|action)|desktop_(?:open|show_lumi_window|window_control|active_window|list_apps|ui_|capture_screen|mouse_|keyboard_|run_command)|mouse_(?:move|click|drag)|keyboard_(?:type|press)|computer_use|run_command|powershell|shell_exec|terminal_exec|wechat_(?:read_recent_chat|send_message)|cad_(?:prepare_autocad_operations|draw_floorplan_in_autocad)|mcp_cad-drafting_autocad_|wps_create_document_with_text|desktop_ai_ask)/i;

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractWindowFingerprint(record: ToolExecutionRecord): WindowFingerprint | null {
  const parsed = parseObject(record.result);
  const active = parseObject(parsed.activeWindow || parsed.window || parsed.foregroundWindow || parsed);
  const title = String(active.title || active.windowTitle || '').trim();
  const processName = String(active.process_name || active.processName || active.executable || '').trim();
  const processId = Number(active.pid || active.processId || 0) || undefined;
  const nativeWindowHandle = Number(active.nativeWindowHandle || active.hwnd || active.window_id || active.windowId || 0) || undefined;
  const bounds = parseObject(active.bounds || active.rect || active.windowBounds);
  const numeric = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return title || processName ? {
    title,
    processName,
    executablePath: String(active.executable_path || active.executablePath || active.processPath || '').trim() || undefined,
    publisher: String(active.publisher || active.company_name || active.companyName || active.signatureSubject || '').trim() || undefined,
    productName: String(active.product_name || active.productName || '').trim() || undefined,
    productVersion: String(active.product_version || active.productVersion || active.fileVersion || '').trim() || undefined,
    windowClass: String(active.window_class || active.windowClass || active.className || '').trim() || undefined,
    signatureStatus: String(active.signature_status || active.signatureStatus || '').trim() || undefined,
    processId,
    nativeWindowHandle,
    x: numeric(bounds.x ?? active.x),
    y: numeric(bounds.y ?? active.y),
    width: numeric(bounds.width ?? active.width),
    height: numeric(bounds.height ?? active.height),
    dpiScale: numeric(active.dpiScale ?? active.scaleFactor ?? active.deviceScaleFactor),
    displayId: String(active.displayId || active.monitorId || '').trim() || undefined,
  } : null;
}

function fingerprintInvalidatesVisualPlan(before: WindowFingerprint | null, after: WindowFingerprint | null): boolean {
  if (!before || !after) return false;
  if (before.processId && after.processId && before.processId !== after.processId) return true;
  if (before.nativeWindowHandle && after.nativeWindowHandle && before.nativeWindowHandle !== after.nativeWindowHandle) return true;
  for (const key of ['x', 'y', 'width', 'height', 'dpiScale'] as const) {
    if (before[key] !== undefined && after[key] !== undefined && before[key] !== after[key]) return true;
  }
  for (const key of ['executablePath', 'publisher', 'productName', 'productVersion', 'windowClass', 'signatureStatus'] as const) {
    if (before[key] && after[key] && before[key] !== after[key]) return true;
  }
  return Boolean(before.displayId && after.displayId && before.displayId !== after.displayId);
}

type RuntimeCapabilityDescriptor = Pick<
  CapabilityManifestEntry,
  'lane' | 'operation' | 'sideEffects'
>;

function isSafeObservationCapability(capability?: RuntimeCapabilityDescriptor): boolean {
  return Boolean(
    capability
    && (capability.operation === 'observe' || capability.operation === 'test')
    && capability.sideEffects.every(effect => (
      effect.type === 'none'
      || effect.type === 'local_read'
      || effect.type === 'network_read'
    )),
  );
}

function isExternalCommitCapability(capability?: RuntimeCapabilityDescriptor): boolean {
  return Boolean(capability?.sideEffects.some(effect => (
    effect.type === 'external_state_change'
    || effect.type === 'external_communication'
  )));
}

function isDesktopRuntimeCapability(
  toolName: string,
  capability?: RuntimeCapabilityDescriptor,
): boolean {
  if (CONTROL_TOOL_RE.test(toolName)) return true;
  if (!capability) return false;
  return capability.sideEffects.some(effect => effect.type === 'desktop_control')
    || (
      ['client', 'desktop', 'cad', 'messaging', 'office'].includes(capability.lane)
      && !isSafeObservationCapability(capability)
    );
}

function isFocusOrOpenCapability(toolName: string): boolean {
  const segments = toolName.toLocaleLowerCase().split('_').filter(Boolean);
  return segments.includes('open')
    || segments.includes('focus')
    || segments.join('_') === 'desktop_show_lumi_window'
    || segments.join('_') === 'desktop_window_control';
}

/**
 * The compiled plan's tool list is a planner hint, not an authority list. A
 * newer model may choose a different registered adapter with the same runtime
 * semantics. Map that adapter onto the existing safety state machine without
 * expanding registry permissions or relaxing observation/identity gates.
 */
function stepForTool(
  plan: DesktopExecutionPlan,
  toolName: string,
  capability?: RuntimeCapabilityDescriptor,
): DesktopActionStep | undefined {
  const planned = plan.steps.find(step => step.allowedTools.includes(toolName));
  if (planned) return planned;
  if (!isDesktopRuntimeCapability(toolName, capability)) return undefined;
  if (isSafeObservationCapability(capability)) {
    return plan.steps.find(step => step.operation === 'observe')
      || plan.steps.find(step => step.operation === 'verify');
  }
  if (isFocusOrOpenCapability(toolName)) {
    return plan.steps.find(step => step.operation === 'focus_or_open');
  }
  if (isExternalCommitCapability(capability)) {
    return plan.steps.find(step => step.operation === 'commit')
      || plan.steps.find(step => step.operation === 'act');
  }
  return plan.steps.find(step => step.operation === 'act')
    || plan.steps.find(step => step.operation === 'commit');
}

function isObservationStep(step: DesktopActionStep | undefined): boolean {
  return step?.operation === 'observe' || step?.operation === 'verify';
}

export class DesktopExecutionTracker {
  private readonly stepReceipts = new Map<string, DesktopStepReceipt>();
  private lastObservationAt = 0;
  private lastFingerprint: WindowFingerprint | null = null;
  private applicationMatched = false;
  private observationConsumed = true;
  private pendingAction: { step: DesktopActionStep; recordVerified: boolean } | null = null;
  private observationRetries = 0;
  private receiptMetricRecorded = false;
  private replanRequiredReason: string | null = null;
  private lastIdentityAssessment: ApplicationIdentityAssessment | null = null;

  constructor(readonly plan: DesktopExecutionPlan) {
    recordDesktopPlanCreated();
  }

  private block(reason: string): DesktopRuntimeAuthorization {
    recordDesktopAuthorizationBlock(reason);
    return { allowed: false, reason };
  }

  authorize(
    toolName: string,
    capability?: RuntimeCapabilityDescriptor,
  ): DesktopRuntimeAuthorization {
    const explicitlyPlanned = this.plan.steps.some(step => step.allowedTools.includes(toolName));
    const step = stepForTool(this.plan, toolName, capability);
    if (!step) {
      return { allowed: true, reason: 'not_a_desktop_control_tool' };
    }
    if (isObservationStep(step) || step.operation === 'focus_or_open') {
      return {
        allowed: true,
        reason: explicitlyPlanned
          ? 'desktop_plan_step_authorized'
          : 'desktop_plan_membership_advisory',
      };
    }
    if (this.replanRequiredReason) {
      return this.block(this.replanRequiredReason);
    }
    const fresh = Date.now() - this.lastObservationAt <= this.plan.expectedWindow.maxObservationAgeMs;
    if (!this.applicationMatched) {
      return this.block('Desktop target application has not matched a fresh observation.');
    }
    if (!fresh || this.observationConsumed || !this.lastFingerprint) {
      return this.block('Desktop action requires a fresh, unused foreground-window fingerprint.');
    }
    if (
      (step.operation === 'commit' || isExternalCommitCapability(capability))
      && this.lastIdentityAssessment?.certification !== 'certified'
    ) {
      return this.block('External desktop commit requires a fully certified application identity observation.');
    }
    return {
      allowed: true,
      reason: explicitlyPlanned
        ? 'desktop_plan_step_authorized'
        : 'desktop_plan_membership_advisory',
    };
  }

  record(record: ToolExecutionRecord): void {
    const step = stepForTool(this.plan, record.name, record.capability);
    if (!step) return;
    const verified = !record.error && record.terminalVerification?.status === 'verified';
    const evidence = [`tool:${record.name}`, `result_sha256:${digest(record.result || record.error || '')}`];

    if (isObservationStep(step)) {
      const fingerprint = extractWindowFingerprint(record);
      const fingerprintInvalidated = fingerprintInvalidatesVisualPlan(this.lastFingerprint, fingerprint);
      const identityAssessment = this.plan.application.family === 'lumi'
        ? null
        : assessDesktopApplicationIdentity(fingerprint, this.plan.application);
      const matched = this.plan.application.family === 'lumi'
        ? record.name === 'client_get_state' && verified
        : this.plan.application.family === 'unknown'
          ? desktopFingerprintMatchesRequestedTarget(
              fingerprint,
              this.plan.expectedWindow.requestedTarget,
            )
          : Boolean(identityAssessment?.matched);
      if (fingerprint) {
        this.lastFingerprint = fingerprint;
        this.lastIdentityAssessment = identityAssessment;
        this.lastObservationAt = Date.now();
        this.applicationMatched = matched;
        this.observationConsumed = false;
      }
      const fingerprintDigest = fingerprint ? digest(fingerprint) : undefined;
      const identityEvidence = identityAssessment
        ? [
            `identity_certification:${identityAssessment.certification}`,
            `identity_signals:${identityAssessment.matchedSignals.join(',') || 'none'}`,
            `identity_missing:${identityAssessment.missingSignals.join(',') || 'none'}`,
            `identity_conflicts:${identityAssessment.conflictingSignals.join(',') || 'none'}`,
          ]
        : [];
      evidence.push(...identityEvidence);
      const completingFocusOrOpen = this.pendingAction?.step.operation === 'focus_or_open';
      if (this.pendingAction) {
        const pending = this.pendingAction;
        const expectedFocusChange = pending.step.operation === 'focus_or_open' && matched;
        const invalidatedAfterAction = fingerprintInvalidated && !expectedFocusChange;
        this.replanRequiredReason = invalidatedAfterAction
          ? 'Desktop window/display fingerprint changed; the compiled UI/vision plan is invalid and must be rebuilt.'
          : null;
        this.stepReceipts.set(pending.step.stepId, {
          stepId: pending.step.stepId,
          status: pending.recordVerified && matched && !invalidatedAfterAction ? 'verified' : pending.recordVerified ? 'blocked' : 'failed',
          layer: pending.step.layer,
          applicationMatched: matched,
          ...(fingerprintDigest ? { windowFingerprintAfter: fingerprintDigest } : {}),
          evidence,
          ...(!matched
            ? { error: 'foreground_application_mismatch_after_action' }
            : invalidatedAfterAction ? { error: 'foreground_window_or_display_changed_after_action' } : {}),
        });
        this.pendingAction = null;
      } else if (fingerprintInvalidated) {
        this.replanRequiredReason = 'Desktop window/display fingerprint changed; the compiled UI/vision plan is invalid and must be rebuilt.';
        this.observationConsumed = true;
      }
      const receiptStep = completingFocusOrOpen && matched
        ? 'verify-result'
        : this.stepReceipts.has('observe-target') && matched
          ? 'verify-result'
          : 'observe-target';
      const receiptPlanStep = this.plan.steps.find(candidate => candidate.stepId === receiptStep)!;
      const acceptedPreOpenObservation = receiptStep === 'observe-target'
        && this.plan.verification.profile === 'open'
        && verified;
      this.stepReceipts.set(receiptStep, {
        stepId: receiptStep,
        status: verified && (matched || acceptedPreOpenObservation) && !this.replanRequiredReason
          ? 'verified'
          : record.error ? 'failed' : 'blocked',
        layer: receiptPlanStep.layer,
        applicationMatched: matched,
        ...(fingerprintDigest ? {
          windowFingerprintBefore: fingerprintDigest,
          windowFingerprintAfter: fingerprintDigest,
        } : {}),
        evidence,
        ...(!matched && !acceptedPreOpenObservation
          ? { error: 'foreground_application_mismatch' }
          : this.replanRequiredReason ? { error: 'desktop_plan_rebuild_required' } : {}),
      });
      // A safe local open/focus may be the first desktop call. Its matching
      // post-open observation proves both that the desktop was observed and
      // that the exact target became foreground; do not require an otherwise
      // redundant third observation just to fill the pre-observe slot.
      if (receiptStep === 'verify-result' && !this.stepReceipts.has('observe-target')) {
        const observeStep = this.plan.steps.find(candidate => candidate.stepId === 'observe-target')!;
        this.stepReceipts.set('observe-target', {
          stepId: 'observe-target',
          status: verified && matched ? 'verified' : 'blocked',
          layer: observeStep.layer,
          applicationMatched: matched,
          ...(fingerprintDigest ? {
            windowFingerprintBefore: fingerprintDigest,
            windowFingerprintAfter: fingerprintDigest,
          } : {}),
          evidence,
          ...(!matched ? { error: 'post_open_target_mismatch' } : {}),
        });
      }
      if (receiptStep === 'observe-target' && ['read', 'status', 'explain'].includes(this.plan.operation)) {
        const verifyStep = this.plan.steps.find(candidate => candidate.stepId === 'verify-result')!;
        this.stepReceipts.set('verify-result', {
          stepId: 'verify-result',
          status: verified && matched ? 'verified' : 'blocked',
          layer: verifyStep.layer,
          applicationMatched: matched,
          ...(fingerprintDigest ? {
            windowFingerprintBefore: fingerprintDigest,
            windowFingerprintAfter: fingerprintDigest,
          } : {}),
          evidence,
          ...(!matched ? { error: 'read_observation_target_mismatch' } : {}),
        });
      }
      if (!matched && this.observationRetries < this.plan.recovery.maxObservationRetries) {
        this.observationRetries++;
      }
      return;
    }

    const beforeFingerprint = this.lastFingerprint ? digest(this.lastFingerprint) : undefined;
    if (!verified) {
      this.stepReceipts.set(step.stepId, {
        stepId: step.stepId,
        status: record.envelope?.status === 'unknown_outcome' ? 'unknown' : 'failed',
        layer: step.layer,
        applicationMatched: this.applicationMatched,
        ...(beforeFingerprint ? { windowFingerprintBefore: beforeFingerprint } : {}),
        evidence,
        error: record.error || record.terminalVerification?.reason || 'desktop_action_unverified',
      });
      return;
    }
    this.pendingAction = { step, recordVerified: true };
    this.observationConsumed = true;
    this.stepReceipts.set(step.stepId, {
      stepId: step.stepId,
      status: 'blocked',
      layer: step.layer,
      applicationMatched: this.applicationMatched,
      ...(beforeFingerprint ? { windowFingerprintBefore: beforeFingerprint } : {}),
      evidence,
      error: 'waiting_for_fresh_post_action_observation',
    });
  }

  receipt(): DesktopExecutionReceipt {
    return verifyDesktopExecutionReceipt(this.plan, {
      planId: this.plan.planId,
      taskId: this.plan.taskId,
      applicationMatched: this.applicationMatched,
      ...(this.lastIdentityAssessment ? {
        applicationCertification: this.lastIdentityAssessment.certification,
        ...(this.lastIdentityAssessment.observedVersion
          ? { applicationVersion: this.lastIdentityAssessment.observedVersion }
          : {}),
      } : {}),
      steps: [...this.stepReceipts.values()],
      evidence: [`desktop_plan:${this.plan.planId}`],
    });
  }

  toToolExecutionRecord(): ToolExecutionRecord | null {
    if (this.stepReceipts.size === 0) return null;
    const receipt = this.receipt();
    if (!this.receiptMetricRecorded) {
      recordDesktopExecutionReceipt(receipt);
      this.receiptMetricRecorded = true;
    }
    const verified = receipt.completionVerified;
    return {
      id: `desktop-plan-${this.plan.planId}`,
      taskId: this.plan.taskId,
      name: 'desktop_execution_plan_receipt',
      arguments: { planId: this.plan.planId, applicationId: this.plan.application.id },
      result: JSON.stringify(receipt),
      ...(verified ? {} : { error: `Desktop execution ended as ${receipt.finalState}.` }),
      terminalVerification: {
        status: verified ? 'verified' : 'failed',
        strategy: 'terminal_receipt',
        reason: verified
          ? 'Desktop plan, application identity, required steps and post-action evidence verified.'
          : `Desktop plan receipt is ${receipt.finalState}.`,
        evidence: receipt.evidence,
      },
    } as ToolExecutionRecord;
  }
}

export function createDesktopExecutionTracker(
  plan: DesktopExecutionPlan | null | undefined,
): DesktopExecutionTracker | undefined {
  return plan ? new DesktopExecutionTracker(plan) : undefined;
}

export function withDesktopExecutionReceipt(
  records: ToolExecutionRecord[],
  tracker: DesktopExecutionTracker | undefined,
): ToolExecutionRecord[] {
  const receipt = tracker?.toToolExecutionRecord();
  if (!receipt) return records;
  const existingIndex = records.findIndex(record => record.id === receipt.id);
  if (existingIndex >= 0) {
    const updated = [...records];
    updated[existingIndex] = receipt;
    return updated;
  }
  return [...records, receipt];
}
