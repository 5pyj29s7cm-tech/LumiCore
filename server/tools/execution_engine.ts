import type { ToolContext, ToolExecutionRecord } from './types';
import type { ToolRegistry } from './registry';
import { verifyCapabilityReceipt } from './capability_verification';
import { decodeToolResult } from './result_envelope';

const SECRET_ARGUMENT_RE =
  /password|passphrase|passkey|secret|token|api.?key|credential|otp|captcha|verification.?code/i;

function sanitizeReceiptValue(value: unknown, depth = 0): any {
  if (depth > 5) return '[nested data omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeReceiptValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 4_000) return `${value.slice(0, 4_000)}...`;
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 80)
      .map(([key, item]) => [
        key,
        SECRET_ARGUMENT_RE.test(key)
          ? '[redacted]'
          : sanitizeReceiptValue(item, depth + 1),
      ]),
  );
}

export interface ToolExecutionPreflightResult {
  allowed: boolean;
  arguments?: Record<string, any>;
  reason?: string;
}

export interface ExecuteToolCallInput {
  registry: ToolRegistry;
  name: string;
  arguments?: Record<string, any>;
  id?: string;
  context?: ToolContext;
  /**
   * Optional domain guard. It may normalize arguments or block execution, but
   * the actual permission/risk decision always remains in ToolRegistry.
   */
  preflight?: (
    name: string,
    args: Record<string, any>,
  ) => ToolExecutionPreflightResult;
}

/**
 * Canonical terminal tool-call path. Every caller receives the same receipt
 * shape, argument redaction, evidence envelope, cancellation behavior, and
 * registry permission enforcement.
 */
export async function executeToolCall(
  input: ExecuteToolCallInput,
): Promise<ToolExecutionRecord> {
  const requestedArguments = input.arguments || {};
  const preflight = input.preflight?.(input.name, requestedArguments)
    || { allowed: true, arguments: requestedArguments };
  const executionArguments = preflight.arguments || requestedArguments;
  const receiptArguments = sanitizeReceiptValue(executionArguments) as Record<string, any>;
  const capabilityGetter = (input.registry as any)?.getCapabilityManifestEntry;
  const capability = typeof capabilityGetter === 'function'
    ? capabilityGetter.call(input.registry, input.name, input.context?.toolPolicy)
    : undefined;
  const evidenceBuilder = (input.registry as any)?.buildEvidenceRecord;
  const record: ToolExecutionRecord = {
    id: input.id,
    name: input.name,
    arguments: receiptArguments,
    result: '',
    evidence: typeof evidenceBuilder === 'function'
      ? evidenceBuilder.call(input.registry, input.name, executionArguments)
      : undefined,
    capability: capability
      ? {
          capabilityId: capability.capabilityId,
          lane: capability.lane,
          operation: capability.operation,
          risk: capability.risk,
          sideEffects: capability.sideEffects,
          verification: capability.verification,
        }
      : undefined,
  };

  if (!preflight.allowed) {
    record.error = preflight.reason || 'Tool execution was blocked by preflight validation.';
    record.terminalVerification = verifyCapabilityReceipt(capability, record);
    return record;
  }
  if (input.context?.isCancelled?.()) {
    record.error = 'Task was cancelled before the tool started.';
    record.terminalVerification = verifyCapabilityReceipt(capability, record);
    return record;
  }

  try {
    input.context?.onToolStart?.({
      id: input.id,
      name: input.name,
      arguments: receiptArguments,
    });
  } catch {
    // Observability callbacks must never change execution outcome.
  }

  try {
    const rawResult = await input.registry.execute(
      input.name,
      executionArguments,
      input.context,
    );
    const decoded = decodeToolResult(rawResult);
    record.result = decoded.content;
    if (decoded.receipt !== undefined) record.receipt = decoded.receipt;
  } catch (error: any) {
    record.error = String(error?.message || error || 'Tool execution failed.');
  }
  record.terminalVerification = verifyCapabilityReceipt(capability, record);
  return record;
}

/**
 * Compatibility adapter for modules whose public contract returns a string or
 * throws. Execution still passes through the canonical receipt-producing path.
 */
export async function executeToolCallOrThrow(
  input: ExecuteToolCallInput,
): Promise<string> {
  const record = await executeToolCall(input);
  const verificationFailure = record.terminalVerification?.status !== 'verified'
    ? record.terminalVerification?.reason || 'The tool did not produce verified terminal evidence.'
    : '';
  if (record.error || verificationFailure) {
    const error = new Error(record.error || verificationFailure) as Error & { toolRecord?: ToolExecutionRecord };
    error.toolRecord = record;
    throw error;
  }
  return record.result;
}
