import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '../services/apiClient';

export function useLocalModelConfig(provider: 'ollama' | 'lmstudio', defaultUrl: string, probeOnMount = false) {
  const [config, setConfig] = useState({ url: defaultUrl, models: [] as string[], detected: false, checking: true, saved: false, error: '' });
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (url?: string, probe = false) => {
    request.current?.abort();
    const owner = new AbortController();
    request.current = owner;
    setConfig(current => ({ ...current, checking: true, detected: false, saved: false, error: '' }));
    try {
      const data = await apiJson(`/api/${provider}/config`, {
        signal: owner.signal,
        ...(probe ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: url }) } : {}),
      });
      if (owner.signal.aborted) return;
      const models = Array.isArray(data.models)
        ? data.models.filter((model: unknown): model is string => typeof model === 'string' && Boolean(model) && !/(?:embed|whisper|rerank|re-rank|bge[-_])/i.test(model)) : [];
      setConfig({ url: data.baseUrl || url || defaultUrl, models, detected: Boolean(data.detected && models.length), checking: false, saved: probe && url !== undefined, error: data.lastError || '' });
    } catch (error) {
      if (!owner.signal.aborted) setConfig(current => ({ ...current, models: [], detected: false, checking: false, error: error instanceof Error ? error.message : 'Local model detection failed' }));
    }
  }, [provider, defaultUrl]);
  useEffect(() => {
    void load(undefined, probeOnMount);
    return () => request.current?.abort();
  }, [load, probeOnMount]);
  return {
    ...config,
    status: config.checking ? 'checking' : config.detected ? 'available' : 'not-found',
    detect: () => load(config.url, true),
    setUrl: (url: string) => {
      request.current?.abort();
      setConfig({ url, models: [], detected: false, checking: false, saved: false, error: '' });
    },
  };
}
