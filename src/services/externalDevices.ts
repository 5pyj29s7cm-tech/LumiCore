import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './apiClient';
import type { ExternalDevicesSnapshot, NetworkPrinterStatusRequest, NetworkPrinterStatusResult } from '../../shared/external_devices';

type Observation = { data: ExternalDevicesSnapshot | null; error: string; loading: boolean };
type Entry = { state: Observation; listeners: Set<(state: Observation) => void>; request?: AbortController };
const observations = new Map<string, Entry>();
const initial = (): Observation => ({ data: null, error: '', loading: true });

async function readJson(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status}${body?.error ? `: ${body.error}` : ''}`);
  return body;
}

function validSource(source: any, key: string): boolean {
  return source && typeof source.status === 'string' && Array.isArray(source.errors)
    && (Array.isArray(source[key]) || (source.ok === false && source.status === 'unavailable'));
}

function publish(entry: Entry, state: Observation) {
  entry.state = state;
  entry.listeners.forEach(listener => listener(state));
}

async function observe(entry: Entry) {
  if (entry.request) return;
  const request = new AbortController();
  entry.request = request;
  publish(entry, { ...entry.state, loading: true, error: '' });
  let timedOut = false;
  // USB and spooler owners can each use 15s. Leave room for their failure receipts and HTTP/JSON delivery.
  const timer = setTimeout(() => { timedOut = true; request.abort(); }, 30000);
  try {
    const body = await readJson(await apiFetch('/api/devices/external', { signal: request.signal }));
    if (typeof body?.observedAt !== 'string' || !validSource(body.usb, 'devices')
      || !validSource(body.printers, 'printers') || !validSource(body.lan, 'candidates')) {
      throw new Error('Invalid external device observation');
    }
    if (!request.signal.aborted) publish(entry, { data: body, error: '', loading: false });
  } catch (error) {
    if (!request.signal.aborted || timedOut) publish(entry, { ...entry.state, loading: false,
      error: timedOut ? 'External device observation timed out (30000ms)' : error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
    if (entry.request === request) entry.request = undefined;
  }
}

/** One observation per active account/domain scope. No interval or socket event triggers a LAN scan. */
export function useExternalDevices(scope: string | null) {
  const [current, setCurrent] = useState<{ scope: string | null; state: Observation }>({ scope, state: initial() });
  useEffect(() => {
    if (!scope) return;
    let entry = observations.get(scope);
    if (!entry) { entry = { state: initial(), listeners: new Set() }; observations.set(scope, entry); }
    const listener = (state: Observation) => setCurrent({ scope, state });
    entry.listeners.add(listener);
    listener(entry.state);
    const startIfNeeded = () => {
      if (!document.hidden && entry.listeners.size && !entry.request && !entry.state.data && !entry.state.error) void observe(entry);
    };
    // Wait until effects settle so StrictMode's discarded mount cannot start a second LAN observation.
    queueMicrotask(startIfNeeded);
    document.addEventListener('visibilitychange', startIfNeeded);
    return () => {
      document.removeEventListener('visibilitychange', startIfNeeded);
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        entry.request?.abort();
        if (observations.get(scope) === entry) observations.delete(scope);
      }
    };
  }, [scope]);
  const refresh = useCallback(() => {
    const entry = scope ? observations.get(scope) : undefined;
    if (entry) void observe(entry);
  }, [scope]);
  return { ...(current.scope === scope ? current.state : initial()), refresh };
}

export async function readExternalPrinterStatus(target: NetworkPrinterStatusRequest, signal: AbortSignal): Promise<NetworkPrinterStatusResult> {
  const body = await readJson(await apiFetch('/api/devices/external/printer-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target), signal,
  }));
  // Owner failures are observations too; keep their phase, error and IPP status intact.
  if (typeof body?.ok !== 'boolean' || typeof body.status !== 'string' || typeof body.observedAt !== 'string') {
    throw new Error('Invalid network printer status response');
  }
  return body;
}
