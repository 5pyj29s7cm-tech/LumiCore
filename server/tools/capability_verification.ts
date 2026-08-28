import fs from 'fs';
import path from 'path';
import type {
  CapabilityManifestEntry,
  ToolExecutionRecord,
} from './types';
import {
  toolRecordHasTerminalPayload,
  toolRecordTerminalPayload,
  toolRecordTerminalText,
} from './receipt_payload';

const FAILED_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'denied',
  'error',
  'failed',
  'forbidden',
  'incomplete',
  'needs_confirmation',
  'not_found',
  'not_ready',
  'partial',
  'pending',
  'requires_confirmation',
  'requires_setup',
  'timed_out',
  'timeout',
  'unverified',
]);
const SUCCESS_STATUSES = new Set([
  'acknowledged',
  'completed',
  'created',
  'delivered',
  'done',
  'opened',
  'published',
  'sent',
  'success',
  'succeeded',
  'verified',
]);
const PATH_KEYS = /(?:path|file|filename|output|artifact|receipt)/i;
const RAW_ARTIFACT_PATH_RE = /(?:[A-Za-z]:\\|\/)[^\r\n"'<>|]+?\.[A-Za-z0-9]{1,12}(?=$|[\s,;)}\]])/g;

function collectValues(
  value: unknown,
  predicate: (key: string, item: unknown) => boolean,
  depth = 0,
): unknown[] {
  if (!value || typeof value !== 'object' || depth > 5) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => collectValues(item, predicate, depth + 1));
  }
  const output: unknown[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (predicate(key, item)) output.push(item);
    output.push(...collectValues(item, predicate, depth + 1));
  }
  return output;
}

function statusFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const value = payload as Record<string, any>;
  return String(
    value.status
      || value.verificationStatus
      || value.verification?.status
      || value.state,
  ).trim().toLowerCase();
}

function hasExplicitFailure(payload: unknown, acceptedStatuses = new Set<string>()): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, any>;
  const status = statusFromPayload(value);
  return value.ok === false
    || value.success === false
    || value.completed === false
    || value.verified === false
    || value.sent === false
    || value.submitted === false
    || value.targetMatched === false
    || Boolean(value.error || value.verification?.error)
    || (FAILED_STATUSES.has(status) && !acceptedStatuses.has(status));
}

function valueAtPath(payload: unknown, fieldPath: string): { found: boolean; value: unknown } {
  const segments = String(fieldPath || '').split('.').map(item => item.trim()).filter(Boolean);
  if (segments.length === 0) return { found: false, value: undefined };
  let current: unknown = payload;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false, value: undefined };
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return { found: false, value: undefined };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    try {
      return JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }
  return false;
}

function localArtifactExists(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate.trim() || /^https?:\/\//i.test(candidate)) return false;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  try {
    return fs.existsSync(resolved) && fs.statSync(resolved).size > 0;
  } catch {
    return false;
  }
}

function artifactExists(payload: unknown, rawResult: string): boolean {
  const declaredCandidates = collectValues(payload, (key, item) => (
    PATH_KEYS.test(key) && typeof item === 'string'
  )).map(value => String(value).trim());
  const rawCandidates = Array.from(rawResult.matchAll(RAW_ARTIFACT_PATH_RE), match => match[0].trim());
  const candidates = Array.from(new Set([...declaredCandidates, ...rawCandidates]));
  return candidates.some(localArtifactExists);
}

function hasProviderAcknowledgement(payload: unknown, rawResult: string): boolean {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, any>
    : null;
  const status = statusFromPayload(value);
  const structuredAck = Boolean(value && (
    value.sent === true
    || value.submitted === true
    || value.published === true
    || value.delivered === true
    || value.acknowledged === true
    || value.providerAck === true
    || SUCCESS_STATUSES.has(status)
  ));
  if (structuredAck) return true;
  // i18n-allow: provider receipt recognition; not user-visible copy.
  return /\b(?:sent|submitted|published|delivered|acknowledged)\s+(?:successfully|ok)\b|(?:发送|提交|发布|送达)(?:成功|完成)/iu.test(rawResult);
}

function hasStateVerification(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, any>;
  const status = statusFromPayload(value);
  return value.verified === true
    || (value.completed === true && status === 'completed')
    || value.targetMatched === true
    || value.resultVerified === true
    || value.verification?.status === 'verified'
    || value.verification?.status === 'not_applicable'
    || status === 'verified';
}

function hasMeasurement(payload: unknown, rawResult: string): boolean {
  if (payload && typeof payload === 'object') {
    const values = collectValues(payload, (_key, item) => typeof item === 'number');
    if (values.length > 0) return true;
    const value = payload as Record<string, any>;
    if (value.measured === true || value.measurement || value.metrics || value.samples) return true;
  }
  return /(?:^|[^\p{L}\p{N}])[-+]?\d+(?:\.\d+)?\s*(?:%|ms|s|mb|gb|kb|hz|fps|°c|celsius|bytes?)\b/iu.test(rawResult);
}

export function verifyCapabilityReceipt(
  capability: CapabilityManifestEntry | undefined,
  record: Pick<ToolExecutionRecord, 'result' | 'receipt' | 'error'>,
): NonNullable<ToolExecutionRecord['terminalVerification']> {
  const strategy = capability?.verification.strategy || 'terminal_receipt';
  if (record.error) {
    return {
      status: 'failed',
      strategy,
      reason: record.error,
    };
  }
  if (!toolRecordHasTerminalPayload(record)) {
    return {
      status: 'failed',
      strategy,
      reason: 'The tool returned no terminal receipt.',
    };
  }
  const payload = toolRecordTerminalPayload(record);
  const result = toolRecordTerminalText(record);
  const verification = capability?.verification;
  const acceptedStatuses = new Set((verification?.successStatuses || []).map(item => item.toLowerCase()));
  const status = statusFromPayload(payload);
  if (verification?.failureStatuses?.map(item => item.toLowerCase()).includes(status)) {
    return {
      status: 'failed',
      strategy,
      reason: `The terminal receipt reported ${status || 'failure'}.`,
    };
  }
  if (hasExplicitFailure(payload, acceptedStatuses)) {
    return {
      status: 'failed',
      strategy,
      reason: `The terminal receipt reported ${status || 'failure'}.`,
    };
  }

  const missingFields = (verification?.requiredFields || []).filter(field => !valueAtPath(payload, field).found);
  if (missingFields.length > 0) {
    return {
      status: 'unverified',
      strategy,
      reason: `The terminal receipt is missing required field(s): ${missingFields.join(', ')}.`,
    };
  }
  const mismatchedValues = Object.entries(verification?.requiredValues || {}).filter(([field, expected]) => {
    const actual = valueAtPath(payload, field);
    return !actual.found || !valuesEqual(actual.value, expected);
  });
  if (mismatchedValues.length > 0) {
    return {
      status: 'unverified',
      strategy,
      reason: `The terminal receipt does not satisfy required value(s): ${mismatchedValues.map(([field]) => field).join(', ')}.`,
    };
  }
  if (verification?.successStatuses?.length && !acceptedStatuses.has(status)) {
    return {
      status: 'unverified',
      strategy,
      reason: `The terminal receipt status "${status || 'missing'}" is not an accepted success status.`,
    };
  }
  const missingArtifacts = (verification?.requiredArtifacts || []).filter(field => {
    const value = valueAtPath(payload, field);
    return !value.found || !localArtifactExists(value.value);
  });
  if (missingArtifacts.length > 0) {
    return {
      status: 'unverified',
      strategy,
      reason: `The terminal receipt does not prove required artifact(s): ${missingArtifacts.join(', ')}.`,
    };
  }
  const invalidArtifactCollections = (verification?.requiredArtifactCollections || []).filter(field => {
    const located = valueAtPath(payload, field);
    if (!located.found || !Array.isArray(located.value) || located.value.length === 0) return true;
    return located.value.some(item => (
      !localArtifactExists(
        item && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>).path
          : item,
      )
    ));
  });
  if (invalidArtifactCollections.length > 0) {
    return {
      status: 'unverified',
      strategy,
      reason: `The terminal receipt does not prove every artifact in collection(s): ${invalidArtifactCollections.join(', ')}.`,
    };
  }

  if (strategy === 'artifact') {
    return artifactExists(payload, result)
      ? { status: 'verified', strategy, reason: 'The declared artifact exists and is non-empty.' }
      : { status: 'unverified', strategy, reason: 'No existing non-empty artifact path was found in the receipt.' };
  }
  if (strategy === 'provider_ack') {
    return hasProviderAcknowledgement(payload, result) || acceptedStatuses.has(status)
      ? { status: 'verified', strategy, reason: 'The provider/target acknowledged the external action.' }
      : { status: 'unverified', strategy, reason: 'The receipt did not contain a provider or target acknowledgement.' };
  }
  if (strategy === 'state_diff') {
    return hasStateVerification(payload) || acceptedStatuses.has(status)
      ? { status: 'verified', strategy, reason: 'The receipt contains verified post-action state.' }
      : { status: 'unverified', strategy, reason: 'The receipt contains no verified post-action state.' };
  }
  if (strategy === 'visual') {
    return hasStateVerification(payload) || artifactExists(payload, result)
      ? { status: 'verified', strategy, reason: 'The receipt contains visual or post-state verification.' }
      : { status: 'unverified', strategy, reason: 'The receipt contains no visual verification.' };
  }
  if (strategy === 'measured') {
    return hasMeasurement(payload, result)
      ? { status: 'verified', strategy, reason: 'The receipt contains a measured value.' }
      : { status: 'unverified', strategy, reason: 'The receipt contains no measured value.' };
  }
  if (strategy === 'none') {
    return capability?.verification.required
      ? { status: 'unverified', strategy, reason: 'The capability requires verification but declares no verification strategy.' }
      : { status: 'verified', strategy, reason: 'The capability explicitly declares that terminal verification is not required.' };
  }
  return {
    status: 'verified',
    strategy,
    reason: capability?.verification.limitations[0]
      || 'A non-empty terminal receipt was returned.',
  };
}
