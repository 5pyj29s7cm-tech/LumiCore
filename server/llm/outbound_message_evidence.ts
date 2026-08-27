import crypto from 'node:crypto';
import { getEvidenceKeyMaterial } from '../evidence/evidence_identity';

export const PROVIDER_OUTBOUND_MESSAGES_EVIDENCE_KIND =
  'lumi.provider-outbound-messages-evidence' as const;

export interface ProviderOutboundMessageStructure {
  index: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  sourceMessageId: string | null;
  /** Installation-keyed HMAC-SHA-256 of the formatted provider message slot. */
  payloadSha256: string;
  /** Installation-keyed HMAC-SHA-256 of the formatted `content`/`parts` value. */
  contentSha256: string;
  contentKind: 'empty' | 'text' | 'multipart' | 'object' | 'other';
  textCharCount: number;
  imageCount: number;
  toolCallCount: number;
  toolResultCount: number;
}

export interface ProviderOutboundMessagesEvidence {
  schemaVersion: 1;
  kind: typeof PROVIDER_OUTBOUND_MESSAGES_EVIDENCE_KIND;
  source: 'provider_adapter_outbound_request';
  digestProtection: 'installation_hmac_sha256_v1';
  digestKeyId: string;
  provider: string;
  model: string;
  requestFormat: 'openai_compatible' | 'gemini' | 'anthropic';
  messagesSha256: string;
  toolDeclarationsSha256: string;
  providerRequestShapeSha256: string;
  messageCount: number;
  toolDeclarationCount: number;
  totalTextCharacters: number;
  totalImageCount: number;
  totalToolCallCount: number;
  totalToolResultCount: number;
  messages: ProviderOutboundMessageStructure[];
  attestationSha256: string;
}

const MAX_MESSAGE_COUNT = 4_096;
const MAX_TOOL_DECLARATION_COUNT = 4_096;
const MAX_VALUE_DEPTH = 96;
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024;
const MAX_VALUE_NODES = 250_000;
const MAX_TEXT_CODE_UNITS = 16 * 1024 * 1024;

interface TraversalBudget {
  nodes: number;
  textCodeUnits: number;
}

function assertPlainJsonContainer(value: object): void {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('provider_outbound_evidence_object_unsupported');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
        throw new Error('provider_outbound_evidence_property_unsupported');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('provider_outbound_evidence_property_unsupported');
      }
    }
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('provider_outbound_evidence_object_unsupported');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error('provider_outbound_evidence_property_unsupported');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('provider_outbound_evidence_property_unsupported');
    }
  }
}

function stableValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  budget: TraversalBudget = { nodes: 0, textCodeUnits: 0 },
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_VALUE_NODES) throw new Error('provider_outbound_evidence_node_count_exceeded');
  if (depth > MAX_VALUE_DEPTH) throw new Error('provider_outbound_evidence_depth_exceeded');
  if (typeof value === 'string') {
    budget.textCodeUnits += value.length;
    if (budget.textCodeUnits > MAX_TEXT_CODE_UNITS) {
      throw new Error('provider_outbound_evidence_text_size_exceeded');
    }
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('provider_outbound_evidence_value_unsupported');
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) throw new Error('provider_outbound_evidence_circular_value');
  assertPlainJsonContainer(value as object);
  seen.add(value as object);
  if (Array.isArray(value)) {
    const result = value.map(item => stableValue(item, seen, depth + 1, budget));
    seen.delete(value as object);
    return result;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  budget.textCodeUnits += keys.reduce((total, key) => total + key.length, 0);
  if (budget.textCodeUnits > MAX_TEXT_CODE_UNITS) {
    throw new Error('provider_outbound_evidence_text_size_exceeded');
  }
  const result = Object.fromEntries(keys
    .map(key => [key, stableValue(
      (value as Record<string, unknown>)[key],
      seen,
      depth + 1,
      budget,
    )]));
  seen.delete(value as object);
  return result;
}

function digest(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  if (typeof serialized !== 'string') throw new Error('provider_outbound_evidence_value_unsupported');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CANONICAL_BYTES) {
    throw new Error('provider_outbound_evidence_size_exceeded');
  }
  return crypto.createHmac('sha256', getEvidenceKeyMaterial().key)
    .update('lumi.provider-outbound.private-digest.v1\0', 'utf8')
    .update(serialized, 'utf8')
    .digest('hex');
}

function evidenceAttestation(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  if (typeof serialized !== 'string') throw new Error('provider_outbound_evidence_value_unsupported');
  return crypto.createHmac('sha256', getEvidenceKeyMaterial().key)
    .update('lumi.provider-outbound.attestation.v1\0', 'utf8')
    .update(serialized, 'utf8')
    .digest('hex');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function safeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

const EVIDENCE_KEYS = [
  'schemaVersion', 'kind', 'source', 'digestProtection', 'digestKeyId', 'provider', 'model',
  'requestFormat', 'messagesSha256', 'toolDeclarationsSha256',
  'providerRequestShapeSha256', 'messageCount', 'toolDeclarationCount',
  'totalTextCharacters', 'totalImageCount', 'totalToolCallCount',
  'totalToolResultCount', 'messages', 'attestationSha256',
] as const;

const MESSAGE_KEYS = [
  'index', 'role', 'sourceMessageId', 'payloadSha256', 'contentSha256',
  'contentKind', 'textCharCount', 'imageCount', 'toolCallCount', 'toolResultCount',
] as const;

function compact(value: unknown, limit = 120): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function inspectContent(
  value: unknown,
): Omit<ProviderOutboundMessageStructure,
  'index' | 'role' | 'sourceMessageId' | 'payloadSha256' | 'contentSha256'> {
  let textCharCount = 0;
  let imageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  const visited = new WeakSet<object>();
  const visit = (item: unknown, key = ''): void => {
    if (typeof item === 'string') {
      if (/^(?:text|content|system|prompt|partial_json)$/u.test(key)) {
        textCharCount += item.length;
      }
      return;
    }
    if (!item || typeof item !== 'object') return;
    if (visited.has(item as object)) return;
    visited.add(item as object);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    const record = item as Record<string, unknown>;
    const type = compact(record.type, 40).toLowerCase();
    if (type === 'image_url' || type === 'image' || type === 'inline_data') imageCount += 1;
    if (type === 'tool_use' || type === 'function_call') toolCallCount += 1;
    if (type === 'tool_result' || type === 'function_response') toolResultCount += 1;
    if (Object.hasOwn(record, 'functionCall')) toolCallCount += 1;
    if (Object.hasOwn(record, 'functionResponse')) toolResultCount += 1;
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(value, 'content');
  const contentKind = value === null || value === undefined || value === ''
    ? 'empty'
    : typeof value === 'string'
      ? 'text'
      : Array.isArray(value)
        ? 'multipart'
        : typeof value === 'object'
          ? 'object'
          : 'other';
  return { contentKind, textCharCount, imageCount, toolCallCount, toolResultCount };
}

function containsToolResult(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some(item => containsToolResult(item, seen));
  const record = value as Record<string, unknown>;
  const type = compact(record.type, 40).toLowerCase();
  if (type === 'tool_result' || type === 'function_response'
    || Object.hasOwn(record, 'functionResponse')) return true;
  return Object.values(record).some(item => containsToolResult(item, seen));
}

function normalizedProviderRole(record: Record<string, unknown>, content: unknown) {
  const raw = compact(record.role || record.type, 40).toLowerCase();
  if (raw === 'system') return 'system' as const;
  if (raw === 'assistant' || raw === 'model') return 'assistant' as const;
  if (raw === 'tool' || raw === 'function') return 'tool' as const;
  if (raw === 'user') return containsToolResult(content) ? 'tool' as const : 'user' as const;
  throw new Error('provider_outbound_evidence_role_invalid');
}

function messageStructure(message: unknown, index: number): ProviderOutboundMessageStructure {
  const record = message && typeof message === 'object' && !Array.isArray(message)
    ? message as Record<string, unknown>
    : null;
  if (!record) throw new Error('provider_outbound_evidence_message_invalid');
  const content = Object.hasOwn(record, 'content')
    ? record.content
    : Object.hasOwn(record, 'parts')
      ? record.parts
      : null;
  const inspected = inspectContent(content);
  const declaredToolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls.length
    : Array.isArray(record.toolCalls)
      ? record.toolCalls.length
      : 0;
  const role = normalizedProviderRole(record, content);
  return {
    index,
    role,
    sourceMessageId: null,
    payloadSha256: digest(message),
    contentSha256: digest(content),
    ...inspected,
    toolCallCount: inspected.toolCallCount + declaredToolCalls,
    toolResultCount: inspected.toolResultCount + (record.tool_call_id ? 1 : 0),
  };
}

export function buildProviderOutboundMessagesEvidence(input: {
  provider: unknown;
  model: unknown;
  requestFormat: ProviderOutboundMessagesEvidence['requestFormat'];
  messages: unknown;
  toolDeclarations?: unknown;
  system?: unknown;
  /** Durable accepted-user transcript id; never read from caller-authored evidence. */
  sourceMessageId?: unknown;
  /** Exact adapter slot for that transcript; null means the source was omitted. */
  sourceMessageIndex?: unknown;
}): ProviderOutboundMessagesEvidence {
  const provider = compact(input.provider, 120);
  const model = compact(input.model, 240);
  if (!provider || !model) throw new Error('provider_outbound_evidence_identity_required');
  if (!['openai_compatible', 'gemini', 'anthropic'].includes(input.requestFormat)) {
    throw new Error('provider_outbound_evidence_request_format_invalid');
  }
  const messageValues = Array.isArray(input.messages) ? input.messages : [];
  const tools = Array.isArray(input.toolDeclarations) ? input.toolDeclarations : [];
  if (messageValues.length > MAX_MESSAGE_COUNT) {
    throw new Error('provider_outbound_evidence_message_count_exceeded');
  }
  if (tools.length > MAX_TOOL_DECLARATION_COUNT) {
    throw new Error('provider_outbound_evidence_tool_count_exceeded');
  }
  // Validate the complete adapter-owned request shape before recursively
  // inspecting individual slots. This rejects cycles, exotic toJSON/class
  // semantics, excessive nesting, and oversized payloads before persistence.
  digest({ system: input.system ?? null, messages: messageValues, toolDeclarations: tools });
  const messages = messageValues.map((message, index) => messageStructure(message, index));
  if (input.system !== undefined && input.system !== null && input.system !== '') {
    messages.unshift({
      index: 0,
      role: 'system',
      sourceMessageId: null,
      payloadSha256: digest({ role: 'system', content: input.system }),
      contentSha256: digest(input.system),
      ...inspectContent(input.system),
    });
    for (let index = 1; index < messages.length; index += 1) messages[index].index = index;
  }
  const sourceMessageId = compact(input.sourceMessageId, 200);
  if (sourceMessageId) {
    if (!Object.hasOwn(input, 'sourceMessageIndex') || input.sourceMessageIndex === null) {
      throw new Error('provider_outbound_evidence_source_index_required');
    }
    if (!Number.isSafeInteger(input.sourceMessageIndex)
      || Number(input.sourceMessageIndex) < 0
      || Number(input.sourceMessageIndex) >= messageValues.length) {
      throw new Error('provider_outbound_evidence_source_index_invalid');
    }
    const evidenceIndex = Number(input.sourceMessageIndex)
      + (input.system !== undefined && input.system !== null && input.system !== '' ? 1 : 0);
    if (messages[evidenceIndex]?.role !== 'user') {
      throw new Error('provider_outbound_evidence_source_slot_not_user');
    }
    messages[evidenceIndex].sourceMessageId = sourceMessageId;
  }
  const totals = messages.reduce((result, message) => ({
    totalTextCharacters: result.totalTextCharacters + message.textCharCount,
    totalImageCount: result.totalImageCount + message.imageCount,
    totalToolCallCount: result.totalToolCallCount + message.toolCallCount,
    totalToolResultCount: result.totalToolResultCount + message.toolResultCount,
  }), {
    totalTextCharacters: 0,
    totalImageCount: 0,
    totalToolCallCount: 0,
    totalToolResultCount: 0,
  });
  const unsigned: Omit<ProviderOutboundMessagesEvidence, 'attestationSha256'> = {
    schemaVersion: 1,
    kind: PROVIDER_OUTBOUND_MESSAGES_EVIDENCE_KIND,
    source: 'provider_adapter_outbound_request',
    digestProtection: 'installation_hmac_sha256_v1',
    digestKeyId: getEvidenceKeyMaterial().keyId,
    provider,
    model,
    requestFormat: input.requestFormat,
    messagesSha256: digest({ system: input.system ?? null, messages: messageValues }),
    toolDeclarationsSha256: digest(tools),
    providerRequestShapeSha256: digest({
      system: input.system ?? null,
      messages: messageValues,
      toolDeclarations: tools,
    }),
    messageCount: messages.length,
    toolDeclarationCount: tools.length,
    ...totals,
    messages,
  };
  return {
    ...unsigned,
    attestationSha256: evidenceAttestation(unsigned),
  };
}

export function normalizeProviderOutboundMessagesEvidence(
  value: unknown,
): ProviderOutboundMessagesEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as ProviderOutboundMessagesEvidence;
  if (!exactKeys(candidate as unknown as Record<string, unknown>, EVIDENCE_KEYS)
    || candidate.schemaVersion !== 1
    || candidate.kind !== PROVIDER_OUTBOUND_MESSAGES_EVIDENCE_KIND
    || candidate.source !== 'provider_adapter_outbound_request'
    || candidate.digestProtection !== 'installation_hmac_sha256_v1'
    || !/^[a-f0-9]{64}$/u.test(String(candidate.digestKeyId || ''))
    || !['openai_compatible', 'gemini', 'anthropic'].includes(candidate.requestFormat)
    || typeof candidate.provider !== 'string'
    || candidate.provider !== compact(candidate.provider, 120)
    || typeof candidate.model !== 'string'
    || candidate.model !== compact(candidate.model, 240)
    || ![candidate.messagesSha256, candidate.toolDeclarationsSha256, candidate.providerRequestShapeSha256]
      .every(item => /^[a-f0-9]{64}$/u.test(String(item || '')))
    || !/^[a-f0-9]{64}$/u.test(String(candidate.attestationSha256 || ''))
    || !safeCount(candidate.messageCount, MAX_MESSAGE_COUNT)
    || !safeCount(candidate.toolDeclarationCount, MAX_TOOL_DECLARATION_COUNT)
    || !safeCount(candidate.totalTextCharacters, MAX_CANONICAL_BYTES)
    || !safeCount(candidate.totalImageCount, MAX_MESSAGE_COUNT * 1_024)
    || !safeCount(candidate.totalToolCallCount, MAX_MESSAGE_COUNT * MAX_TOOL_DECLARATION_COUNT)
    || !safeCount(candidate.totalToolResultCount, MAX_MESSAGE_COUNT * MAX_TOOL_DECLARATION_COUNT)
    || !Array.isArray(candidate.messages)
    || candidate.messages.length !== candidate.messageCount) return null;
  try {
    if (candidate.digestKeyId !== getEvidenceKeyMaterial().keyId) return null;
  } catch {
    return null;
  }
  const messages = candidate.messages.map((message, index) => {
    const sourceMessageId = message?.sourceMessageId;
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || !exactKeys(message as unknown as Record<string, unknown>, MESSAGE_KEYS)
      || !['empty', 'text', 'multipart', 'object', 'other'].includes(message.contentKind)
      || !['system', 'user', 'assistant', 'tool'].includes(message.role)
      || message.index !== index
      || (sourceMessageId !== null
        && (typeof sourceMessageId !== 'string'
          || !sourceMessageId
          || compact(sourceMessageId, 200) !== sourceMessageId))
      || !/^[a-f0-9]{64}$/u.test(String(message.payloadSha256 || ''))
      || !/^[a-f0-9]{64}$/u.test(String(message.contentSha256 || ''))
      || ![message.textCharCount, message.imageCount, message.toolCallCount, message.toolResultCount]
        .every(item => safeCount(item, MAX_CANONICAL_BYTES))) return null;
    return {
      index: message.index,
      role: message.role,
      sourceMessageId: message.sourceMessageId,
      payloadSha256: message.payloadSha256,
      contentSha256: message.contentSha256,
      contentKind: message.contentKind,
      textCharCount: message.textCharCount,
      imageCount: message.imageCount,
      toolCallCount: message.toolCallCount,
      toolResultCount: message.toolResultCount,
    };
  });
  if (messages.some(message => message === null)) return null;
  const normalizedMessages = messages as ProviderOutboundMessageStructure[];
  let sourceMessageIndex = -1;
  for (let index = 0; index < normalizedMessages.length; index += 1) {
    const message = normalizedMessages[index];
    if (message.sourceMessageId !== null) {
      if (sourceMessageIndex >= 0 || message.role !== 'user') return null;
      sourceMessageIndex = index;
    }
  }
  const totals = messages.reduce((result, message) => ({
    totalTextCharacters: result.totalTextCharacters + message!.textCharCount,
    totalImageCount: result.totalImageCount + message!.imageCount,
    totalToolCallCount: result.totalToolCallCount + message!.toolCallCount,
    totalToolResultCount: result.totalToolResultCount + message!.toolResultCount,
  }), {
    totalTextCharacters: 0,
    totalImageCount: 0,
    totalToolCallCount: 0,
    totalToolResultCount: 0,
  });
  if (Object.entries(totals).some(([key, total]) => total !== Number(candidate[key as keyof typeof candidate]))) {
    return null;
  }
  const unsigned: Omit<ProviderOutboundMessagesEvidence, 'attestationSha256'> = {
    schemaVersion: 1,
    kind: PROVIDER_OUTBOUND_MESSAGES_EVIDENCE_KIND,
    source: 'provider_adapter_outbound_request',
    digestProtection: 'installation_hmac_sha256_v1',
    digestKeyId: candidate.digestKeyId,
    provider: candidate.provider,
    model: candidate.model,
    requestFormat: candidate.requestFormat,
    messagesSha256: candidate.messagesSha256,
    toolDeclarationsSha256: candidate.toolDeclarationsSha256,
    providerRequestShapeSha256: candidate.providerRequestShapeSha256,
    messageCount: candidate.messageCount,
    toolDeclarationCount: candidate.toolDeclarationCount,
    totalTextCharacters: candidate.totalTextCharacters,
    totalImageCount: candidate.totalImageCount,
    totalToolCallCount: candidate.totalToolCallCount,
    totalToolResultCount: candidate.totalToolResultCount,
    messages: normalizedMessages,
  };
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(evidenceAttestation(unsigned), 'hex');
    actual = Buffer.from(candidate.attestationSha256, 'hex');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return { ...unsigned, attestationSha256: candidate.attestationSha256 };
}
