import type { ToolExecutionRecord } from '../tools/types';
import { isConfirmationBlockedToolRecord } from '../tools/confirmation_block';
import {
  formatCnClientDiagnosticFacts,
  formatCnMissingClientDiagnosticReceipts,
  type ClientDiagnosticFacts,
} from '../regions/packs/cn/client_diagnostic_messages';
import { isCurrentClientDiagnosticRequest } from './tool_intent';

export interface ClientDiagnosticToolCall {
  name: 'client_health_check' | 'client_get_state' | 'adapter_registry_list' | 'adapter_health_check';
  arguments: Record<string, any>;
}

const CLIENT_DIAGNOSTIC_MUTATION_RE =
  /(?:\u4fee\u590d|\u6062\u590d|\u5237\u65b0|\u91cd\u8bd5|\u91cd\u65b0\u8fde\u63a5|\u91cd\u542f|\brepair\b|\brecover\b|\brefresh\b|\bretry\b|\breconnect\b|\brestart\b)/iu;
const CLIENT_INTEGRATION_TARGET_RE =
  /(?:MCP|\u6280\u80fd|\u63d2\u4ef6|\u9002\u914d\u5668|\b(?:skill|plugin|adapter)\b)/iu;

/**
 * Pure, current-state checks should not depend on the model deciding whether
 * to call the two core diagnostic tools. Repair requests still stay in the
 * full self-repair loop because they may require confirmation or mutation.
 */
export function buildClientDiagnosticPlan(text: string): ClientDiagnosticToolCall[] {
  const normalized = String(text || '').trim();
  if (!isCurrentClientDiagnosticRequest(normalized)) return [];
  if (CLIENT_DIAGNOSTIC_MUTATION_RE.test(normalized)) return [];

  const plan: ClientDiagnosticToolCall[] = [
    { name: 'client_health_check', arguments: {} },
    { name: 'client_get_state', arguments: {} },
  ];
  if (CLIENT_INTEGRATION_TARGET_RE.test(normalized)) {
    plan.push(
      { name: 'adapter_registry_list', arguments: {} },
      { name: 'adapter_health_check', arguments: {} },
    );
  }
  return plan;
}

const SUBSTANTIVE_CLIENT_DIAGNOSTIC_TOOL_RE = /^(?:client_get_state|client_health_check|client_self_repair|client_repair_skill|adapter_registry_list|adapter_health_check|model_configuration_get|model_configuration_test|desktop_capability_status)$/i;
const SUPPORTING_CLIENT_DIAGNOSTIC_TOOL_RE = /^(?:desktop_active_window|get_active_window_info|desktop_running_processes|desktop_ui_snapshot|desktop_capture_screen)$/i;
const FAILED_DIAGNOSTIC_STATUS_RE = /^(?:error|failed|failure|blocked|denied|rejected|pending|not_verified|unverified|requires_confirmation|not_supported|unsupported|unavailable|timed_out|timeout)$/i;

export function isClientDiagnosticToolName(value: unknown): boolean {
  const name = String(value || '');
  return SUBSTANTIVE_CLIENT_DIAGNOSTIC_TOOL_RE.test(name)
    || SUPPORTING_CLIENT_DIAGNOSTIC_TOOL_RE.test(name);
}

function parseJson(value: unknown): any {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return null;
  }
}

function isSubstantiveClientDiagnosticToolName(value: unknown): boolean {
  return SUBSTANTIVE_CLIENT_DIAGNOSTIC_TOOL_RE.test(String(value || ''));
}

function diagnosticRecordFailure(record: ToolExecutionRecord): string {
  const explicitError = String(record.error || '').trim();
  if (explicitError) return explicitError;

  const raw = String(record.result || '').trim();
  if (!raw) return 'no result returned';
  if (isConfirmationBlockedToolRecord(record)) return 'user confirmation was not approved';

  const payload = parseJson(raw);
  if (!payload || typeof payload !== 'object') return '';
  const status = String(payload.status || payload.verification?.status || '').trim();
  const semanticFailure = payload.ok === false
    || payload.success === false
    || payload.verified === false
    || FAILED_DIAGNOSTIC_STATUS_RE.test(status);
  if (!semanticFailure) return '';

  return String(
    payload.error
    || payload.reason
    || payload.message
    || payload.verification?.message
    || status
    || 'diagnostic check failed',
  ).trim();
}

function isSuccessfulDiagnosticRecord(record: ToolExecutionRecord): boolean {
  return !diagnosticRecordFailure(record);
}

export function hasSuccessfulSubstantiveClientDiagnosticReceipt(
  records: ToolExecutionRecord[],
): boolean {
  return records.some(record => (
    isSubstantiveClientDiagnosticToolName(record.name)
    && isSuccessfulDiagnosticRecord(record)
  ));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function englishDiagnosticFacts(facts: ClientDiagnosticFacts): string {
  const scope = facts.scopeDomain === 'work'
    ? `organization work scope${facts.scopeOrgId ? ` (${facts.scopeOrgId})` : ''}`
    : 'personal scope';
  const lines = [
    facts.hasSuccessfulSubstantiveCheck
      ? 'Self-check completed. This summary uses only tool receipts from the current turn.'
      : 'Self-check did not complete. No substantive client diagnostic produced a successful receipt in this turn.',
    `Scope: ${scope}.`,
  ];
  if (facts.hasLiveState) {
    const digest = facts.stateDigest || {};
    const details = [
      digest.mode ? `mode=${digest.mode}` : '',
      digest.activeTab ? `surface=${digest.activeTab}` : '',
      digest.focusedWindow ? `focus=${digest.focusedWindow}` : '',
      facts.stateAgeSeconds != null ? `age=${facts.stateAgeSeconds}s` : '',
    ].filter(Boolean);
    lines.push(`Desktop client: live state received${details.length ? ` (${details.join(', ')})` : ''}.`);
  } else {
    lines.push('Desktop client: no live state was returned for the current scope.');
    lines.push('This indicates a scope/device routing miss only; it does not prove that remote messaging cannot reach the desktop or that the client is offline.');
  }
  lines.push(`Health level: ${facts.healthLevel || 'unknown'}.`);
  if (facts.activeWindow) lines.push(`Active window: ${facts.activeWindow}.`);
  if (facts.processCount != null) lines.push(`Processes read: ${facts.processCount}.`);
  if (facts.findings.length) lines.push(`Findings: ${facts.findings.join('; ')}.`);
  if (facts.failedChecks.length) lines.push(`Unavailable checks: ${facts.failedChecks.join('; ')}.`);
  if (facts.repairResults.length) lines.push(`Repair receipts: ${facts.repairResults.join('; ')}.`);
  if (facts.disconnectedSkills.length) lines.push(`Optional skills not connected: ${facts.disconnectedSkills.join(', ')}. A disconnected optional skill is not by itself a core failure.`);
  if (facts.successfulChecks.length) lines.push(`Checks with receipts: ${facts.successfulChecks.join(', ')}.`);
  return lines.join('\n');
}

export function formatClientDiagnosticResult(
  records: ToolExecutionRecord[],
  taskText: string,
  responseText = '',
): string | null {
  const diagnosticRecords = records.filter(record => isClientDiagnosticToolName(record.name));
  const substantiveRecords = diagnosticRecords.filter(record => (
    isSubstantiveClientDiagnosticToolName(record.name)
  ));
  // One incidental diagnostic record must not turn unrelated work into a
  // self-check report. A complete, successful state+health snapshot produced
  // in this turn is different: it is stronger than ambiguous model prose and
  // must own the final answer so the model cannot invent an outage or repair.
  const hasSuccessfulCoreSnapshot = (
    diagnosticRecords.some(record => /^client_get_state$/i.test(record.name) && isSuccessfulDiagnosticRecord(record))
    && diagnosticRecords.some(record => /^client_health_check$/i.test(record.name) && isSuccessfulDiagnosticRecord(record))
  );
  const confirmationOfRecordedDiagnostic = /^(?:\u786e\u8ba4|\u786e\u5b9a|\u662f|\u597d|\u597d\u7684|\u53ef\u4ee5|\u7ee7\u7eed|confirm|yes|ok|okay)[\u3002\uFF01\uFF1F.!?]*$/iu.test(String(taskText || '').trim())
    && diagnosticRecords.some(record => /^client_/i.test(String(record.name || '')))
    && /(?:client_get_state|client_health_check|client_self_repair|client_repair_skill)/i.test(responseText);
  if (!isCurrentClientDiagnosticRequest(taskText) && !confirmationOfRecordedDiagnostic && !hasSuccessfulCoreSnapshot) return null;
  // A window title, UIA tree, process list, or screenshot can supplement a
  // client self-check, but cannot establish one by itself.
  if (substantiveRecords.length === 0) {
    return /[\u3400-\u9fff]/u.test(taskText || '')
      ? formatCnMissingClientDiagnosticReceipts()
      : 'No client diagnostic tool receipt was produced in this turn, so desktop, skill, and runtime status cannot be determined.';
  }

  const stateRecord = [...diagnosticRecords].reverse().find(record => /^client_get_state$/i.test(record.name) && isSuccessfulDiagnosticRecord(record));
  const healthRecord = [...diagnosticRecords].reverse().find(record => /^client_health_check$/i.test(record.name) && isSuccessfulDiagnosticRecord(record));
  const statePayload = parseJson(stateRecord?.result);
  const healthPayload = parseJson(healthRecord?.result);
  const health = statePayload?.health || healthPayload?.report || healthPayload || null;
  const state = statePayload?.state || null;
  const stateDigest = statePayload?.stateDigest || null;
  const scope = statePayload?.scope || healthPayload?.scope || {};
  const skillFindings = statePayload?.skillRuntimeFindings || healthPayload?.skillRuntimeFindings || [];
  const activeRecord = [...diagnosticRecords].reverse().find(record => /^(?:desktop_active_window|get_active_window_info)$/i.test(record.name) && isSuccessfulDiagnosticRecord(record));
  const processRecord = [...diagnosticRecords].reverse().find(record => /^desktop_running_processes$/i.test(record.name) && isSuccessfulDiagnosticRecord(record));
  const capabilityRecord = [...diagnosticRecords].reverse().find(record => /^desktop_capability_status$/i.test(record.name) && isSuccessfulDiagnosticRecord(record));
  const active = parseJson(activeRecord?.result);
  const processes = parseJson(processRecord?.result);
  const desktopCapability = parseJson(capabilityRecord?.result);
  const repairRecords = diagnosticRecords.filter(record => /^(?:client_self_repair|client_repair_skill)$/i.test(record.name));
  const capabilityFindings = desktopCapability && typeof desktopCapability === 'object'
    ? unique([
      `nativeDesktop=${desktopCapability.app_discovery_available && desktopCapability.app_launch_available ? 'available' : 'partial'}`,
      desktopCapability.accessibility_permission ? `accessibility=${desktopCapability.accessibility_permission}` : '',
      desktopCapability.screen_recording_permission ? `screenRecording=${desktopCapability.screen_recording_permission}` : '',
    ])
    : [];

  const facts: ClientDiagnosticFacts = {
    hasSuccessfulSubstantiveCheck: hasSuccessfulSubstantiveClientDiagnosticReceipt(diagnosticRecords),
    hasLiveState: Boolean(state),
    healthLevel: String(health?.level || 'unknown'),
    stateAgeSeconds: health?.stateAgeSeconds != null && Number.isFinite(Number(health.stateAgeSeconds))
      ? Number(health.stateAgeSeconds)
      : null,
    scopeDomain: String(scope?.domain || 'personal'),
    scopeOrgId: String(scope?.orgId || ''),
    stateDigest: stateDigest && typeof stateDigest === 'object' ? stateDigest : null,
    findings: unique([
      ...(health?.findings || []).map((finding: any) => String(finding?.message || finding?.id || '')),
      ...capabilityFindings,
    ]),
    disconnectedSkills: unique((skillFindings || [])
      .filter((finding: any) => finding?.connected === false)
      .map((finding: any) => String(finding?.name || ''))),
    successfulChecks: unique(diagnosticRecords
      .filter(record => isSuccessfulDiagnosticRecord(record))
      .map(record => String(record.name || ''))),
    failedChecks: unique(diagnosticRecords
      .map(record => ({ record, failure: diagnosticRecordFailure(record) }))
      .filter(item => Boolean(item.failure))
      .map(item => `${item.record.name}: ${item.failure}`)),
    repairResults: unique(repairRecords.map(record => {
      const failure = diagnosticRecordFailure(record);
      if (failure) return `${record.name}: ${failure}`;
      const payload = parseJson(record.result);
      return `${record.name}: ${String(payload?.say || payload?.status || 'completed')}`;
    })),
    activeWindow: String(active?.title || active?.window_title || ''),
    processCount: Array.isArray(processes)
      ? processes.length
      : Array.isArray(processes?.processes) ? processes.processes.length : null,
  };

  return /[\u3400-\u9fff]/u.test(taskText || '')
    ? formatCnClientDiagnosticFacts(facts)
    : englishDiagnosticFacts(facts);
}
