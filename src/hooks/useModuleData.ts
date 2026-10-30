import { useRecoverableRead } from './useRecoverableRead';

export function useModuleData<T>(endpoint: string, initialData: T | null = null) {
  const state = useRecoverableRead<T>(endpoint, async signal => {
    const res = await fetch(endpoint, { signal });
    if (!res.ok) throw new Error(`Failed to fetch from ${endpoint}`);
    const data = await res.json();
    if (!data || typeof data !== 'object' || (endpoint === '/api/modules/docs' && data.sections !== undefined && !Array.isArray(data.sections))) throw new Error('Invalid module response');
    return data;
  });
  return { ...state, data: state.data ?? initialData, error: state.error ? new Error(state.error) : null, retry: state.refresh };
}
