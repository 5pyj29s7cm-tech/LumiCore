import type { ToolExecutionRecord } from '../tools/types';
import {
  formatCnClientDiagnosticFacts,
  formatCnMissingClientDiagnosticReceipts,
  type ClientDiagnosticFacts,
} from '../regions/packs/cn/client_diagnostic_messages';

const CLIENT_DIAGNOSTIC_TOOL_RE = /^(?:client_get_state|client_health_check|client_self_repair|client_repair_skill|desktop_active_window|get_active_window_info|desktop_running_processes)$/i;

function parseJson(value: unknown): any {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return null;
  }
}

function clientDiagnosticIntent(text: string): boolean {
  return /(?:\u81ea\u68c0|\u5065\u5eb7\u68c0\u67e5|\u8eab\u4f53\u72b6\u51b5|\u662f\u5426\u901a\u7545|\u80fd\u4e0d\u80fd\u4fee\u590d|\u80fd\u5426\u4fee\u590d|self[ -]?check|health\s+check|runtime\s+health|diagnos)/iu.test(text || '');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function englishDiagnosticFacts(facts: ClientDiagnosticFacts): string {
  const scope = facts.scopeDomain === 'work'
    ? `organization work scope${facts.scopeOrgId ? ` (${facts.scopeOrgId})` : ''}`
    : 'personal scope';
  const lines = [
    'Self-check completed. This summary uses only tool receipts from the current turn.',
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
): string | null {
  const diagnosticRecords = records.filter(record => CLIENT_DIAGNOSTIC_TOOL_RE.test(String(record.name || '')));
  const hasClientDiagnosticRecord = diagnosticRecords.some(record => /^client_/i.test(String(record.name || '')));
  if (!clientDiagnosticIntent(taskText) && !hasClientDiagnosticRecord) return null;
  if (diagnosticRecords.length === 0) {
    return /[\u3400-\u9fff]/u.test(taskText || '')
      ? formatCnMissingClientDiagnosticReceipts()
      : 'No client diagnostic tool receipt was produced in this turn, so desktop, skill, and runtime status cannot be determined.';
  }

  const stateRecord = [...diagnosticRecords].reverse().find(record => /^client_get_state$/i.test(record.name) && !record.error);
  const healthRecord = [...diagnosticRecords].reverse().find(record => /^client_health_check$/i.test(record.name) && !record.error);
  const statePayload = parseJson(stateRecord?.result);
  const healthPayload = parseJson(healthRecord?.result);
  const health = statePayload?.health || healthPayload?.report || healthPayload || null;
  const state = statePayload?.state || null;
  const stateDigest = statePayload?.stateDigest || null;
  const scope = statePayload?.scope || healthPayload?.scope || {};
  const skillFindings = statePayload?.skillRuntimeFindings || healthPayload?.skillRuntimeFindings || [];
  const activeRecord = [...diagnosticRecords].reverse().find(record => /^(?:desktop_active_window|get_active_window_info)$/i.test(record.name) && !record.error);
  const processRecord = [...diagnosticRecords].reverse().find(record => /^desktop_running_processes$/i.test(record.name) && !record.error);
  const active = parseJson(activeRecord?.result);
  const processes = parseJson(processRecord?.result);
  const repairRecords = diagnosticRecords.filter(record => /^(?:client_self_repair|client_repair_skill)$/i.test(record.name));

  const facts: ClientDiagnosticFacts = {
    hasLiveState: Boolean(state),
    healthLevel: String(health?.level || 'unknown'),
    stateAgeSeconds: health?.stateAgeSeconds != null && Number.isFinite(Number(health.stateAgeSeconds))
      ? Number(health.stateAgeSeconds)
      : null,
    scopeDomain: String(scope?.domain || 'personal'),
    scopeOrgId: String(scope?.orgId || ''),
    stateDigest: stateDigest && typeof stateDigest === 'object' ? stateDigest : null,
    findings: unique((health?.findings || []).map((finding: any) => String(finding?.message || finding?.id || ''))),
    disconnectedSkills: unique((skillFindings || [])
      .filter((finding: any) => finding?.connected === false)
      .map((finding: any) => String(finding?.name || ''))),
    successfulChecks: unique(diagnosticRecords
      .filter(record => !record.error && String(record.result || '').trim())
      .map(record => String(record.name || ''))),
    failedChecks: unique(diagnosticRecords
      .filter(record => Boolean(record.error))
      .map(record => `${record.name}: ${record.error}`)),
    repairResults: unique(repairRecords.map(record => {
      if (record.error) return `${record.name}: ${record.error}`;
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
