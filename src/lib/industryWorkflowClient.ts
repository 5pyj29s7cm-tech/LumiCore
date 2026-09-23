import { getDesktopSessionProof } from '../services/authService';

const DESKTOP_SESSION_HEADER = 'x-lumi-desktop-session';

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
}): Promise<IndustryWorkflowStartResponse> {
  const response = await fetch('/api/industry/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Unable to start industry workflow (${response.status})`);
  return data as IndustryWorkflowStartResponse;
}

export async function verifyIndustryWorkflow(input: {
  taskId: string;
  resultText?: string;
  filePaths?: string[];
  workbenchInput?: Record<string, unknown>;
  source?: string;
}): Promise<Record<string, any>> {
  const response = await fetch(`/api/industry/workflows/${encodeURIComponent(input.taskId)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      resultText: input.resultText || '',
      filePaths: input.filePaths || [],
      source: input.source || 'industry_client',
      ...(input.workbenchInput ? { workbenchInput: input.workbenchInput } : {}),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Unable to verify industry workflow (${response.status})`);
  return data as Record<string, any>;
}

export async function executeIndustryWorkflow(input: {
  taskId: string;
  prompt: string;
  routeText?: string;
  sourceInput?: string;
  signal?: AbortSignal;
  onProgress?: (result: IndustryWorkflowExecutionResult) => void;
}): Promise<IndustryWorkflowExecutionResult> {
  const desktopSessionProof = getDesktopSessionProof();
  const response = await fetch('/api/chat?stream=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(desktopSessionProof ? { [DESKTOP_SESSION_HEADER]: desktopSessionProof } : {}),
    },
    credentials: 'include',
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
  let terminalReceived = false;
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let status = 'in_progress';
  let workflow: Record<string, unknown> | undefined;
  const applyEvent = (event: Record<string, unknown> | null) => {
    if (!event) return;
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

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.forEach(block => applyEvent(parseIndustryWorkflowStreamEvent(block)));
    if (done) break;
  }
  applyEvent(parseIndustryWorkflowStreamEvent(buffer));
  if (!terminalReceived) throw new Error('Workflow connection ended before a final receipt arrived.');
  return { text, status, workflow };
}

export async function executeFinanceDeliveryWorkflow(input: {
  taskId: string;
  financeInput: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<FinanceDeliveryExecutionResult> {
  const desktopSessionProof = getDesktopSessionProof();
  const response = await fetch(`/api/industry/workflows/${encodeURIComponent(input.taskId)}/finance-delivery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(desktopSessionProof ? { [DESKTOP_SESSION_HEADER]: desktopSessionProof } : {}),
    },
    credentials: 'include',
    signal: input.signal,
    body: JSON.stringify({ financeInput: input.financeInput }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Unable to execute Finance delivery (${response.status})`);
  return data as FinanceDeliveryExecutionResult;
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
