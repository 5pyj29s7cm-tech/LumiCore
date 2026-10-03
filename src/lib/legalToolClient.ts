import { apiJson } from '../services/apiClient';

export async function runLegalRequest(url: string, body: Record<string, any>, toolName: string, caseId?: string, signal?: AbortSignal): Promise<string> {
  const data = await apiJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  signal?.throwIfAborted();
  if (!data || !Object.keys(data).length) throw new Error(`${toolName} failed`);
  const text = data.text || data.response || data.reply || data.message || JSON.stringify(data);
  if (caseId && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed', {
      detail: { caseId, toolName },
    }));
  }
  return text;
}

export function runLegalTool(toolName: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
  return runLegalRequest(`/api/legal/tool/${encodeURIComponent(toolName)}`, { args }, toolName, args.caseId, signal);
}
