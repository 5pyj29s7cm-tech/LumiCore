import type { ToolExecutionRecord } from './types';

const CANONICAL_TOOL_EXECUTION_RECORD = Symbol('lumi.canonical_tool_execution_record');
const canonicalRecordDigests = new WeakMap<ToolExecutionRecord, string>();
const canonicalInputDigests = new WeakMap<ToolExecutionRecord, ToolExecutionInputDigests>();

export interface ToolExecutionInputDigests {
  argumentsDigest: string;
  targetDigest: string;
}

function canonicalRecordDigest(record: ToolExecutionRecord): string {
  try { return JSON.stringify(record); } catch { return ''; }
}

export function isCanonicalToolExecutionRecord(record: ToolExecutionRecord): boolean {
  return (record as ToolExecutionRecord & { [CANONICAL_TOOL_EXECUTION_RECORD]?: true })[CANONICAL_TOOL_EXECUTION_RECORD] === true
    && canonicalRecordDigests.get(record) === canonicalRecordDigest(record);
}

export function getCanonicalToolExecutionInputDigests(record: ToolExecutionRecord): ToolExecutionInputDigests | undefined {
  if (!isCanonicalToolExecutionRecord(record)) return undefined;
  const digests = canonicalInputDigests.get(record);
  return digests ? { ...digests } : undefined;
}

export function brandCanonicalToolExecutionRecord(
  record: ToolExecutionRecord,
  inputDigests: ToolExecutionInputDigests,
): ToolExecutionRecord {
  Object.defineProperty(record, CANONICAL_TOOL_EXECUTION_RECORD, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  canonicalRecordDigests.set(record, canonicalRecordDigest(record));
  canonicalInputDigests.set(record, { ...inputDigests });
  return record;
}

