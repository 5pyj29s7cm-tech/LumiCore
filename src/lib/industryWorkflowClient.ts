import { apiFetch, apiJson } from '../services/apiClient';

function postWorkflow<T = Record<string, any>>(path: string, body: unknown, signal?: AbortSignal) {
  return apiJson<T>('/api/industry/workflows' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}

export interface IndustryWorkflowTaskRef {
  id: string;
  status: string;
}

export interface IndustryWorkflowStartResponse {
  task: IndustryWorkflowTaskRef;
  conversationId: string;
  conversationTaskId: string;
  requestId: string;
  handoffPrompt: string;
  contract: {
    productLine: string;
    entryId: string;
    title: string;
    requiredArtifactLabels: string[];
    expectedContentTerms: string[];
    requiresFileArtifact: boolean;
  };
}

export interface IndustryWorkflowExecutionResult {
  text: string;
  status: string;
  workflow?: Record<string, unknown>;
}

export interface FinanceDeliveryExecutionResult {
  ok: true;
  status: 'verified';
  persisted: true;
  reused: boolean;
  task: IndustryWorkflowTaskRef & { result?: string };
  verification: Record<string, unknown>;
  artifacts: Array<{ path: string; basename: string; size: number; sha256: string }>;
  toolReceipts: string[];
  externalActions: [];
}

function parseIndustryWorkflowStreamEvent(block: string): Record<string, unknown> | null {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function startIndustryWorkflow(input: {
  entryId: string;
  sourceInput?: string;
  source?: string;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
}, signal?: AbortSignal): Promise<IndustryWorkflowStartResponse> {
  const data = await postWorkflow<IndustryWorkflowStartResponse>('', input, signal);
  if (typeof data?.task?.id !== 'string' || !data.task.id || typeof data.handoffPrompt !== 'string' || data.contract?.entryId !== input.entryId) throw new Error('Workflow start was not confirmed');
  return data;
}

export async function verifyIndustryWorkflow(input: {
  taskId: string;
  resultText?: string;
  filePaths?: string[];
  workbenchInput?: Record<string, unknown>;
  source?: string;
}, signal?: AbortSignal): Promise<Record<string, any>> {
  const data = await postWorkflow(`/${encodeURIComponent(input.taskId)}/verify`, {
    resultText: input.resultText || '',
    filePaths: input.filePaths || [],
    source: input.source || 'industry_client',
    ...(input.workbenchInput ? { workbenchInput: input.workbenchInput } : {}),
  }, signal);
  if (data?.task?.id !== input.taskId || !data.verification) throw new Error('Workflow verification was not confirmed');
  return data;
}

export async function executeIndustryWorkflow(input: {
  taskId: string;
  prompt: string;
  routeText?: string;
  sourceInput?: string;
  signal?: AbortSignal;
  onProgress?: (result: IndustryWorkflowExecutionResult) => void;
}): Promise<IndustryWorkflowExecutionResult> {
  const response = await apiFetch('/api/chat?stream=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: input.signal,
    body: JSON.stringify({
      industryWorkflowTaskId: input.taskId,
      industryWorkflowSourceInput: input.sourceInput || input.routeText || '',
      messages: [{ role: 'user', content: input.prompt }],
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Unable to execute industry workflow (${response.status})`);
  }
  if (!response.body) throw new Error('Industry workflow stream is unavailable.');

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  input.signal?.addEventListener('abort', cancel, { once: true });
  let terminalReceived = false;
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let status = 'in_progress';
  let workflow: Record<string, unknown> | undefined;
  const applyEvent = (event: Record<string, unknown> | null) => {
    input.signal?.throwIfAborted();
    if (!event || terminalReceived) return;
    if (event.failed || event.error) throw new Error(String(event.error || 'Workflow execution failed'));
    if (event.done === true) terminalReceived = true;
    if (typeof event.chunk === 'string') text += event.chunk;
    if (event.done === true && typeof event.text === 'string') text = event.text;
    if (event.industryWorkflow && typeof event.industryWorkflow === 'object' && !Array.isArray(event.industryWorkflow)) {
      workflow = event.industryWorkflow as Record<string, unknown>;
      if (typeof workflow.status === 'string') status = workflow.status;
    }
    input.onProgress?.({ text, status, workflow });
  };

  try {
    input.signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      input.signal?.throwIfAborted();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      blocks.forEach(block => applyEvent(parseIndustryWorkflowStreamEvent(block)));
      if (done || terminalReceived) break;
    }
    if (!terminalReceived) applyEvent(parseIndustryWorkflowStreamEvent(buffer));
    if (!terminalReceived) throw new Error('Workflow connection ended before a final receipt arrived.');
    return { text, status, workflow };
  } finally {
    input.signal?.removeEventListener('abort', cancel);
    cancel(); reader.releaseLock();
  }
}

export async function executeFinanceDeliveryWorkflow(input: {
  taskId: string;
  financeInput: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<FinanceDeliveryExecutionResult> {
  const data = await postWorkflow<FinanceDeliveryExecutionResult>(`/${encodeURIComponent(input.taskId)}/finance-delivery`, { financeInput: input.financeInput }, input.signal);
  if (data?.ok !== true || data.status !== 'verified' || data.persisted !== true || data.task?.id !== input.taskId || !Array.isArray(data.artifacts)) throw new Error('Finance delivery was not confirmed');
  return data;
}

export async function buildIndustryWorkflowIdempotencyKey(input: {
  entryId: string;
  sourceInput?: string;
  source?: string;
}): Promise<string> {
  const value = [input.source || 'industry_client', input.entryId, input.sourceInput || ''].join('\n');
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `industry:${input.entryId}:${hex}`;
  }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `industry:${input.entryId}:fallback-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
