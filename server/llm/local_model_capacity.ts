/** Read the loaded runtime's capacity, never the model's theoretical maximum.
 * This observation does not load/reconfigure a model or change user selection.
 */
export async function loadedLocalContextTokens(
  provider: string,
  client: { baseURL?: string; apiKey?: string },
  model: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (provider !== 'lmstudio' || !client.baseURL) return undefined;
  try {
    const endpoint = new URL(client.baseURL);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return undefined;
    // Preserve a configured reverse-proxy prefix; do not guess other hosts.
    endpoint.pathname = endpoint.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/api/v0/models';
    endpoint.search = '';
    endpoint.hash = '';
    const response = await fetch(endpoint, {
      headers: client.apiKey ? { Authorization: `Bearer ${client.apiKey}` } : {},
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_500)]) : AbortSignal.timeout(1_500),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { data?: Array<{ id?: string; state?: string; loaded_context_length?: number }> };
    const loaded = payload.data?.find(entry => entry.id === model && entry.state === 'loaded');
    const capacity = loaded?.loaded_context_length;
    if (!Number.isSafeInteger(capacity) || capacity! < 2_048 || capacity! > 131_072) return undefined;
    const configured = Number(process.env.LUMI_LOCAL_MODEL_CONTEXT_TOKENS);
    return Number.isFinite(configured) && configured >= 2_048 ? Math.min(capacity!, configured) : capacity;
  } catch {
    // Optional metadata failure retains the existing conservative budget.
    // Inference still observes the caller's abort signal and model policy.
    return undefined;
  }
}
