import { apiJson } from '../services/apiClient';
import { mergePersonalLegalCaseRuntimeSnapshot } from './legalCaseStore';

async function requestLegalResult(url: string, body: Record<string, any>, toolName: string, caseId?: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const data = await apiJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  signal?.throwIfAborted();
  if (!data || !Object.keys(data).length) throw new Error(`${toolName} failed`);
  const text = data.text || data.response || data.reply || data.message || JSON.stringify(data);
  const caseUpdates = Array.isArray(data.caseUpdates) ? data.caseUpdates : [];
  caseUpdates.forEach(mergePersonalLegalCaseRuntimeSnapshot);
  if (caseId && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed', {
      detail: { caseId, toolName },
    }));
  }
  return { ...data, text, caseUpdates };
}

export async function runLegalRequest(url: string, body: Record<string, any>, toolName: string, caseId?: string, signal?: AbortSignal): Promise<string> {
  return (await requestLegalResult(url, body, toolName, caseId, signal)).text;
}

export interface LegalToolExecutionResult { text: string; receipt: Record<string, any>; artifacts: string[]; caseUpdates: Record<string, any>[]; verification?: Record<string, any> }
export async function runLegalToolExecution(toolName: string, args: Record<string, any>, signal?: AbortSignal): Promise<LegalToolExecutionResult> {
  const data = await requestLegalResult(`/api/legal/tool/${encodeURIComponent(toolName)}`, { args }, toolName, args.caseId, signal);
  return { text: data.text, receipt: data.receipt || {}, artifacts: data.artifacts || [], caseUpdates: data.caseUpdates, verification: data.verification };
}

export function runLegalTool(toolName: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
  return runLegalRequest(`/api/legal/tool/${encodeURIComponent(toolName)}`, { args }, toolName, args.caseId, signal);
}
