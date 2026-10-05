import { flushDBOrThrow } from '../../../../db_layer';
import { finalizeLumiResponse } from '../../../cognition/result_finalizer';
import type { ToolExecutionRecord } from '../../../tools/types';
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from '../../../desktop/execution_runtime';
import { finalizeLumiResponseForDelivery, type LumiResponseDeliveryInput } from '../../../cognition/response_delivery';
import type { DesktopRelay, DesktopRelayOptions } from '../../../socket/desktop_relay';
import type { IncomingMessage, MessageHandler } from '../../../messaging/types';
import type { personalityRegistry } from '../../../personality/registry';
import { parseNestedJson } from '../../../tools/receipt_payload';

export class MessagingReplyDurabilityError extends Error {
  readonly stage: 'accepted_turn' | 'terminal_reply';

  constructor(stage: 'accepted_turn' | 'terminal_reply', cause: unknown) {
    super(`Remote messaging ${stage} durability fence failed`, { cause });
    this.name = 'MessagingReplyDurabilityError';
    this.stage = stage;
  }
}

export function isMessagingReplyDurabilityError(error: unknown): error is MessagingReplyDurabilityError {
  return error instanceof MessagingReplyDurabilityError;
}

export async function flushMessagingStateOrThrow(
  stage: 'accepted_turn' | 'terminal_reply',
): Promise<void> {
  try {
    await flushDBOrThrow();
  } catch (error) {
    throw new MessagingReplyDurabilityError(stage, error);
  }
}

export type MessagingFinalization = ReturnType<typeof finalizeLumiResponse>;

export function currentMessagingFinalizationRecords(input: {
  toolRecords: ToolExecutionRecord[];
  taskId?: string;
  requestId: string;
}): ToolExecutionRecord[] {
  const taskId = String(input.taskId || '').trim();
  const requestId = String(input.requestId || '').trim();
  return input.toolRecords.filter(record => {
    const recordTaskIds = [record.taskId, record.envelope?.taskId]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    const recordRequestIds = [record.requestId, record.envelope?.requestId]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    if (taskId && (recordTaskIds.length === 0 || recordTaskIds.some(value => value !== taskId))) {
      return false;
    }
    return Boolean(
      requestId
      && recordRequestIds.length > 0
      && recordRequestIds.every(value => value === requestId),
    );
  });
}

export function withCurrentMessagingDesktopExecutionReceipt(
  records: ToolExecutionRecord[],
  tracker: ReturnType<typeof createDesktopExecutionTracker>,
  taskId: string | undefined,
  requestId: string,
): ToolExecutionRecord[] {
  return withDesktopExecutionReceipt(records, tracker).map(record => (
    record.name === 'desktop_execution_plan_receipt' && !record.requestId
      ? {
          ...record,
          taskId: record.taskId || taskId,
          requestId,
        }
      : record
  ));
}

export async function finalizeMessagingResponseForDelivery(input: LumiResponseDeliveryInput & {
  toolRecords: ToolExecutionRecord[];
  requestId: string;
}) {
  return finalizeLumiResponseForDelivery({ ...input, toolRecords: currentMessagingFinalizationRecords(input) });
}

export type MessagingDesktopLifecycle = Pick<DesktopRelayOptions, 'taskId' | 'requestId' | 'signal' | 'onLateResult'>;
export type MessagingDesktopRelay = ((toolName: string, args: Record<string, any>) => Promise<string>)
  & Partial<Pick<DesktopRelay, 'releaseControlLease'>>;

export interface MessagingRouteOptions {
  onMessage?: MessageHandler;
  llmGetters?: Record<string, () => any>;
  personalityRegistry?: Pick<typeof personalityRegistry, 'getForUser' | 'getDefault'>;
  queryMemories?: (opts: { userId: string; query: string; limit: number; minConfidence: number; domain?: string; orgId?: string }) => any[];
  loadEmotionalState?: (userId: string) => any;
  onConfigChanged?: () => void | Promise<void>;
  getConnectionStatus?: (platform: 'feishu' | 'wecom') => Record<string, any> | null;
  sendProactive?: (platform: 'feishu' | 'wecom', chatId: string, text: string) => Promise<string>;
  onConversationUpdated?: (update: MessagingConversationUpdate) => void;
  createScopedDesktopRelay?: (
    userId: string,
    source: string,
    domain: 'personal' | 'work',
    orgId: string,
    lifecycle?: MessagingDesktopLifecycle,
  ) => MessagingDesktopRelay;
  createPersonalDesktopRelay?: (userId: string, source: string, lifecycle?: MessagingDesktopLifecycle) => MessagingDesktopRelay;
}

export interface MessagingConversationUpdate {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  conversationId: string;
  agentId: string;
  source: string;
  messageId: string;
}

export interface IncomingMessageTransport {
  enrich: (message: IncomingMessage) => Promise<IncomingMessage>;
  reply: (message: IncomingMessage, text: string) => Promise<string | void>;
}

function parsePersistedToolRecords(value: unknown): any[] {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return [];
    }
  }
  return Array.isArray(current) ? current : [];
}

function isFileReceiptToolName(name: string): boolean {
  return /(?:^|_)(?:file|files|filesystem|directory|directories|folder|folders|path)(?:_|$)/i.test(name)
    || /(?:list|search|find|scan|read|open|get).*(?:file|directory|folder)/i.test(name)
    || /^(?:create|generate|export|save|write|convert)_(?:docx?|pdf|pptx?|xlsx?|txt|markdown|md|csv|rtf|wps|et|dps)(?:_|$)/i.test(name);
}

function exactRemoteFileFacts(payload: unknown, allowGenericName: boolean): string[] {
  const parsed = payload && typeof payload === 'object' ? payload as Record<string, any> : null;
  const candidates = Array.isArray(payload)
    ? payload
    : parsed
      ? [
          parsed,
          ...['file', 'artifact', 'document', 'output', 'createdFile', 'savedFile']
            .flatMap(key => parsed[key] && typeof parsed[key] === 'object' && !Array.isArray(parsed[key])
              ? [parsed[key]]
              : []),
          ...['files', 'entries', 'items', 'children', 'results', 'artifacts', 'outputs']
            .flatMap(key => Array.isArray(parsed[key]) ? parsed[key] : []),
        ]
      : [];
  const facts: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const fileName = String(
      candidate.fileName
      || candidate.filename
      || (allowGenericName ? candidate.name : '')
      || '',
    ).trim();
    const exactPath = String(
      candidate.fullPath
      || candidate.filePath
      || candidate.outputPath
      || candidate.targetPath
      || candidate.savedPath
      || candidate.createdPath
      || candidate.artifactPath
      || candidate.downloadPath
      || candidate.path
      || '',
    ).trim();
    if (!fileName && !exactPath) continue;
    const fact = [
      fileName ? `name=${JSON.stringify(fileName)}` : '',
      exactPath ? `path=${JSON.stringify(exactPath)}` : '',
    ].filter(Boolean).join(', ');
    if (fact && !facts.includes(fact)) facts.push(fact);
    if (facts.length >= 12) break;
  }
  return facts;
}

type RemoteFileFactSource = 'terminal receipt' | 'execution envelope' | 'terminal result' | 'tool arguments';

function structuredRemoteReceipt(value: unknown): unknown {
  const parsed = parseNestedJson(value);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function remoteToolRecordCorrelationMatchesMessage(record: any, message: any): boolean {
  const envelope = record?.envelope && typeof record.envelope === 'object' && !Array.isArray(record.envelope)
    ? record.envelope as Record<string, any>
    : null;
  const name = String(record?.name || '').trim();
  if (envelope?.toolName && String(envelope.toolName).trim() !== name) return false;

  const taskIds = [record?.taskId, envelope?.taskId]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (new Set(taskIds).size > 1) return false;

  const requestIds = [record?.requestId, envelope?.requestId]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (new Set(requestIds).size > 1) return false;
  const messageRequestId = String(message?.requestId || '').trim();
  if (messageRequestId && requestIds.length > 0 && requestIds.some(value => value !== messageRequestId)) {
    return false;
  }
  return true;
}

function trustedRemoteFileFacts(
  record: any,
  message: any,
  allowGenericName: boolean,
): { facts: string[]; source: RemoteFileFactSource } | null {
  if (!remoteToolRecordCorrelationMatchesMessage(record, message)) return null;
  if (record?.adapterStarted === false || record?.error) return null;
  if (record?.terminalVerification && record.terminalVerification.status !== 'verified') return null;

  const envelope = record?.envelope && typeof record.envelope === 'object' && !Array.isArray(record.envelope)
    ? record.envelope as Record<string, any>
    : null;
  if (envelope && (
    envelope.status !== 'verified_success'
    || (envelope.verification?.status && envelope.verification.status !== 'verified')
  )) return null;

  const sources: Array<{ source: RemoteFileFactSource; payload: unknown }> = [
    { source: 'terminal receipt', payload: structuredRemoteReceipt(record?.receipt) },
    { source: 'execution envelope', payload: structuredRemoteReceipt(envelope?.result) },
    ...(envelope?.targetIdentity
      ? [{ source: 'execution envelope' as const, payload: { path: envelope.targetIdentity } }]
      : []),
    { source: 'terminal result', payload: structuredRemoteReceipt(record?.result) },
    { source: 'tool arguments', payload: structuredRemoteReceipt(record?.arguments) },
  ];
  for (const source of sources) {
    const facts = exactRemoteFileFacts(source.payload, allowGenericName);
    if (facts.length > 0) return { facts, source: source.source };
  }
  return null;
}

function summarizeRemoteToolRecord(record: any, message?: any): string {
  const name = String(record?.name || '').trim();
  if (!name) return '';
  // A persisted tool blob cannot supply context for a different message/task.
  // Reject the whole record before even low-risk chronology is summarized.
  if (!remoteToolRecordCorrelationMatchesMessage(record, message)) return '';
  if (record?.error) return `${name}: failed`;

  let payload: unknown = null;
  try {
    const parsed = typeof record?.result === 'string' ? JSON.parse(record.result) : record?.result;
    if (parsed && typeof parsed === 'object') payload = parsed;
  } catch {}

  const exactFiles = trustedRemoteFileFacts(record, message, isFileReceiptToolName(name));
  const exactFileSummary = exactFiles
    ? `exact file identities from ${exactFiles.source}; ${exactFiles.facts.join('; ')}`
    : '';

  const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, any>
    : null;
  const facts: string[] = [];
  const allowedKeys = [
    'sent',
    'read',
    'ok',
    'success',
    'verified',
    'status',
    'verificationStatus',
    'verificationMethod',
    'completionMarkerExists',
    'messageId',
    'contact',
    'method',
  ];
  for (const key of allowedKeys) {
    const value = payloadRecord?.[key];
    if (value === undefined || value === null || value === '') continue;
    facts.push(`${key}=${JSON.stringify(value).slice(0, 180)}`);
  }
  if (facts.length === 0 && /"sent"\s*:\s*true|sent:\s*true/i.test(String(record?.result || ''))) {
    facts.push('sent=true');
  }
  if (facts.length > 0) {
    return `${name}: ${[exactFileSummary, facts.join(', ')].filter(Boolean).join('; ')}`;
  }

  const rawResult = String(record?.result || '').trim();
  const explicitlyFailed =
    payloadRecord?.ok === false
    || payloadRecord?.success === false
    || /^(?:blocked|cancelled|canceled|error|failed|partial|pending|queued|requires_setup|submitted_unverified|timeout|timed_out)$/i.test(String(payloadRecord?.status || ''))
    || /(?:^|\b)(?:failed|error|blocked|timed?\s*out|not\s+completed|manual_required)(?:\b|$)|(?:失败|错误|受阻|超时|未完成|需要人工|需要确认)/iu.test(rawResult);
  if (explicitlyFailed) return `${name}: failed or incomplete`;

  if (exactFileSummary) return `${name}: ${exactFileSummary}`;

  // A tool record without an error is not, by itself, completion evidence.
  // Keep unknown/plain results available as chronology without teaching the
  // next model turn that the external action definitely succeeded.
  return `${name}: result recorded (completion unverified)`;
}

export function buildRemoteRuntimeEvidenceContext(messages: any[]): string {
  const lines = messages
    .slice(-12)
    .flatMap(message => parsePersistedToolRecords(message?.toolCalls)
      .map(record => summarizeRemoteToolRecord(record, message)))
    .filter(Boolean)
    .slice(-10);
  if (lines.length === 0) return '';
  return [
    'Authoritative runtime evidence persisted from recent turns:',
    ...lines.map(line => `- ${line}`),
    'Use this evidence when explaining prior outcomes. Do not replace a successful provider acknowledgement with a guess based on the visible assistant wording.',
    'File names and paths in this evidence are immutable identifiers. Copy them exactly; do not remove punctuation, underscores, spaces, extensions, or directory components.',
  ].join('\n');
}
