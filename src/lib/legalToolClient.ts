export async function runLegalTool(toolName: string, args: Record<string, any>): Promise<string> {
  const res = await fetch(`/api/legal/tool/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${toolName} failed`);
  return data.text || data.response || data.reply || data.message || JSON.stringify(data);
}
