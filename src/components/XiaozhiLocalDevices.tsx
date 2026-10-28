import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { GlassCard } from './SharedUI';
import { apiFetch } from '@/services/apiClient';
import { xiaozhiLocalDevicesCopy } from '@/i18n/locales/xiaozhiLocalDevices';
import type { XiaozhiPairingConfiguration, XiaozhiServiceSnapshot } from '../../server/devices/xiaozhi_service';
import type { LanDiscoveryInterface } from '../../server/devices/lan_discovery';

const BASE = '/api/devices/xiaozhi';
type Configuration = Omit<XiaozhiPairingConfiguration, 'mcpUrl'>;
type Panel = { id: string; configuration: Configuration | null; loading: boolean; error: string };
const buttonClass = 'rounded-lg border border-white/15 px-3 py-2 text-xs disabled:opacity-50';
const inputClass = 'w-full min-w-0 rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm';
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
class AdmissionError extends Error { constructor(readonly status: number, detail: string) { super(`HTTP ${status}${detail ? `: ${detail}` : ''}`); } }
function validSnapshot(value: XiaozhiServiceSnapshot): boolean {
  return !!value && Array.isArray(value.devices) && Array.isArray(value.errors) && !!value.listener
    && ['stopped', 'listening', 'error'].includes(value.listener.state)
    && value.errors.every(item => typeof item?.code === 'string' && typeof item.message === 'string')
    && value.devices.every(item => typeof item?.id === 'string' && typeof item.deviceId === 'string' && typeof item.connected === 'boolean'
      && ['pending', 'expired', 'active'].includes(item.state) && ['disconnected', 'initializing', 'registered', 'error'].includes(item.toolState)
      && Array.isArray(item.registeredToolNames) && (item.toolError === null || typeof item.toolError === 'string'));
}
function configurationFrom(value: Configuration): Configuration | null {
  return value && typeof value.id === 'string' && typeof value.expiresAt === 'string' && typeof value.otaUrl === 'string'
    ? { id: value.id, expiresAt: value.expiresAt, otaUrl: value.otaUrl } : null;
}

/** Owner-scoped management only; the periodic GET reads existing state and never performs LAN discovery. */
export function XiaozhiLocalDevices({ scope, lang }: { scope: string; lang: 'zh' | 'en' }) {
  return <ScopedLocalDevices key={scope} lang={lang} />;
}
function ScopedLocalDevices({ lang }: { lang: 'zh' | 'en' }) {
  const copy = xiaozhiLocalDevicesCopy(lang), fieldId = useId();
  const [snapshot, setSnapshot] = useState<XiaozhiServiceSnapshot | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false), [interfaces, setInterfaces] = useState<LanDiscoveryInterface[]>([]);
  const [interfaceLoading, setInterfaceLoading] = useState(false), [formError, setFormError] = useState('');
  const [deviceId, setDeviceId] = useState(''), [clientId, setClientId] = useState(''), [localAddress, setLocalAddress] = useState('');
  const [working, setWorking] = useState(false), [panel, setPanel] = useState<Panel | null>(null);
  const requests = useRef(new Set<AbortController>()), panelRequest = useRef<AbortController | null>(null);
  const interfaceRequest = useRef<AbortController | null>(null), refresh = useRef<() => void>(() => {});
  const alive = useRef(false);
  const perform = useCallback(<T,>(path: string, init: RequestInit = {}) => {
    const controller = new AbortController(); requests.current.add(controller);
    const timer = setTimeout(() => controller.abort(new Error(copy.timeout)), 30000);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    const promise = (async (): Promise<T> => {
      try {
        const response = await apiFetch(path, { ...init, cache: 'no-store', signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!response.ok) throw new AdmissionError(response.status, typeof body?.error === 'string' ? body.error : '');
        return body as T;
      } finally { clearTimeout(timer); requests.current.delete(controller); }
    })();
    return { controller, promise };
  }, [copy.timeout]);

  useEffect(() => {
    alive.current = true;
    let disposed = false, current: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (disposed || document.hidden || current) return;
      clearTimeout(timer); setLoading(true); setError('');
      const operation = perform<XiaozhiServiceSnapshot>(BASE); current = operation.controller;
      let denied = false;
      try {
        const body = await operation.promise;
        if (!validSnapshot(body)) throw new Error(copy.invalidSnapshot);
        if (!disposed && !operation.controller.signal.aborted) setSnapshot(body);
      } catch (failure) {
        denied = failure instanceof AdmissionError && [401, 403].includes(failure.status);
        if (!disposed && !cancelled(failure)) setError(message(failure));
      } finally {
        if (current !== operation.controller) return;
        current = null;
        if (!disposed) { setLoading(false); if (!document.hidden && !denied) timer = setTimeout(() => void read(), 5000); }
      }
    };
    refresh.current = () => void read();
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        requests.current.forEach(controller => controller.abort()); current = null;
        setPanel(null); setLoading(false); setWorking(false); setInterfaceLoading(false);
      } else void read();
    };
    queueMicrotask(() => { if (!disposed) void read(); });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true; alive.current = false; clearTimeout(timer); refresh.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
      requests.current.forEach(controller => controller.abort()); requests.current.clear();
    };
  }, [perform, copy.invalidSnapshot]);

  const readInterfaces = async () => {
    interfaceRequest.current?.abort(); setInterfaceLoading(true); setFormError('');
    const operation = perform<{ interfaces: LanDiscoveryInterface[] }>(BASE + '/interfaces'); interfaceRequest.current = operation.controller;
    try {
      const body = await operation.promise;
      if (!Array.isArray(body?.interfaces) || !body.interfaces.every(item => typeof item?.name === 'string' && typeof item.address === 'string' && typeof item.netmask === 'string')) throw new Error(copy.invalidInterfaces);
      if (!operation.controller.signal.aborted && alive.current) {
        setInterfaces(body.interfaces); setLocalAddress(body.interfaces.length === 1 ? body.interfaces[0].address : '');
        if (!body.interfaces.length) setFormError(copy.noInterfaces);
      }
    } catch (failure) { if (alive.current && !cancelled(failure)) setFormError(message(failure)); }
    finally { if (alive.current && interfaceRequest.current === operation.controller) { setInterfaceLoading(false); interfaceRequest.current = null; } }
  };
  const closePanel = () => { panelRequest.current?.abort(); panelRequest.current = null; setPanel(null); };
  const configure = async (id: string) => {
    closePanel(); setFormOpen(false); setPanel({ id, configuration: null, loading: true, error: '' });
    const operation = perform<Configuration>(`${BASE}/pairings/${encodeURIComponent(id)}/configuration`); panelRequest.current = operation.controller;
    try {
      const configuration = configurationFrom(await operation.promise); if (!configuration || configuration.id !== id) throw new Error(copy.invalidConfiguration);
      if (!operation.controller.signal.aborted && alive.current) setPanel({ id, configuration, loading: false, error: '' });
    } catch (failure) { if (alive.current && !cancelled(failure)) setPanel(current => current?.id === id ? { ...current, loading: false, error: message(failure) } : current); }
  };
  const create = async () => {
    if (working || !deviceId.trim() || !localAddress) return;
    setWorking(true); setFormError('');
    const operation = perform<Configuration>(BASE + '/pairings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId.trim(), localAddress, ...(clientId.trim() ? { clientId: clientId.trim() } : {}) }) });
    try {
      const configuration = configurationFrom(await operation.promise); if (!configuration) throw new Error(copy.invalidConfiguration);
      if (alive.current && !operation.controller.signal.aborted) { setFormOpen(false); setPanel({ id: configuration.id, configuration, loading: false, error: '' }); refresh.current(); }
    } catch (failure) { if (alive.current && !cancelled(failure)) setFormError(`${message(failure)} ${copy.checkAfterWrite}`); }
    finally { if (alive.current) setWorking(false); }
  };
  const revoke = async (id: string) => {
    if (working) return; setWorking(true); setPanel(current => current ? { ...current, error: '' } : current);
    const operation = perform<{ ok: boolean }>(`${BASE}/pairings/${encodeURIComponent(id)}`, { method: 'DELETE' });
    try {
      const body = await operation.promise; if (body?.ok !== true) throw new Error(copy.invalidConfiguration);
      if (alive.current && !operation.controller.signal.aborted) { closePanel(); refresh.current(); }
    } catch (failure) { if (alive.current && !cancelled(failure)) setPanel(current => current?.id === id ? { ...current, error: message(failure) } : current); }
    finally { if (alive.current) setWorking(false); }
  };
  const devices = snapshot?.devices ?? [], diagnostics = snapshot?.errors ?? [];
  const openForm = () => { closePanel(); setFormOpen(true); void readInterfaces(); };
  return <GlassCard className="p-4 space-y-3">
    {(devices.length > 0 || formOpen || panel || error || diagnostics.length > 0) && <h3 className="text-base font-semibold">{copy.title}</h3>}
    {loading && !snapshot && <p className="text-xs text-white/50">{copy.loading}</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-xs text-amber-300 break-words">{error}</p>
      {snapshot && <p className="text-xs text-white/45">{copy.previous}</p>}<button type="button" className={buttonClass} onClick={() => refresh.current()}>{copy.retry}</button></div>}
    {diagnostics.length > 0 && <p role="alert" className="text-xs text-amber-300 break-words">{diagnostics.map(item => item.message).join(' · ')}</p>}
    {!diagnostics.length && snapshot?.listener.state === 'error' && <p role="alert" className="text-xs text-amber-300">{copy.listenerError}</p>}
    {devices.map(device => <article key={device.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-3">
      <div className="min-w-0 space-y-1"><h4 className="text-sm font-semibold break-all">{device.deviceId}</h4>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs"><span className={device.connected ? 'text-emerald-300' : 'text-white/50'}>{device.connected ? copy.connected : copy.disconnected}</span>
          <span className={device.connected && device.toolState === 'registered' && device.toolCount > 0 ? 'text-emerald-300' : device.toolState === 'error' ? 'text-amber-300' : 'text-white/50'}>
            {device.connected && device.toolState === 'registered' && device.toolCount > 0 ? copy.ready : device.toolState === 'initializing' ? copy.initializing : device.toolState === 'error' ? copy.toolError : copy.notReady}</span></p></div>
      <button type="button" className={buttonClass} onClick={() => void configure(device.id)} disabled={working}>{copy.configure}</button>
    </article>)}
    {snapshot && !error && !formOpen && !panel
      && <button type="button" className={`${buttonClass} text-celestial-saturn`} onClick={openForm}>{copy.connect}</button>}
    {formOpen && <form className="max-w-xl space-y-3 border-t border-white/10 pt-4" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className="block text-xs text-white/60" htmlFor={`${fieldId}-device`}>{copy.deviceId}</label>
      <input id={`${fieldId}-device`} className={inputClass} value={deviceId} onChange={event => setDeviceId(event.target.value)} maxLength={256} required />
      <p className="text-xs text-white/45">{copy.identityHint}</p>
      <label className="block text-xs text-white/60" htmlFor={`${fieldId}-interface`}>{copy.interface}</label>
      <select id={`${fieldId}-interface`} className={inputClass} value={localAddress} onChange={event => setLocalAddress(event.target.value)} disabled={interfaceLoading} required>
        <option value="">{copy.chooseInterface}</option>{interfaces.map(item => <option key={item.address} value={item.address}>{item.name} · {item.address}</option>)}
      </select>
      {interfaceLoading && <p className="text-xs text-white/45">{copy.readingInterfaces}</p>}
      <details className="text-xs text-white/50"><summary className="cursor-pointer">{copy.clientId}</summary>
        <label className="mt-3 block" htmlFor={`${fieldId}-client`}>{copy.clientId}</label><input id={`${fieldId}-client`} className={inputClass} value={clientId} onChange={event => setClientId(event.target.value)} maxLength={256} /></details>
      {formError && <p role="alert" className="text-xs text-amber-300 break-words">{formError}</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" className={buttonClass} disabled={working || interfaceLoading || !deviceId.trim() || !localAddress}>{working ? copy.working : copy.generate}</button>
        {!interfaces.length && !interfaceLoading && <button type="button" className={buttonClass} onClick={() => void readInterfaces()}>{copy.retryInterfaces}</button>}
        <button type="button" className={buttonClass} onClick={() => { interfaceRequest.current?.abort(); setFormOpen(false); }} disabled={working}>{copy.cancel}</button></div>
    </form>}
    {panel && <section aria-label={copy.configure} className="space-y-3 border-t border-white/10 pt-4 text-xs text-white/60">
      {panel.loading && <p>{copy.loading}</p>}{panel.error && <p role="alert" className="text-amber-300 break-words">{panel.error}</p>}
      {devices.filter(device => device.id === panel.id && device.state === 'expired').map(device => <p key={device.id} className="text-amber-200">{copy.expired}</p>)}
      {panel.configuration && <><label className="block" htmlFor={`${fieldId}-ota`}>{copy.otaUrl}</label>
        <textarea id={`${fieldId}-ota`} className={`${inputClass} font-mono text-xs`} rows={3} readOnly value={panel.configuration.otaUrl} />
        <p>{copy.privateUrl}</p><p>{copy.expires}: {panel.configuration.expiresAt}</p>
        <p>{copy.configurationHelp}</p><p className="text-amber-200">{copy.limitations}</p><p>{copy.wake}</p></>}
      {devices.filter(device => device.id === panel.id).map(device => <details key={device.id}><summary className="cursor-pointer">{copy.diagnostics}</summary><div className="mt-3 space-y-2 break-words">
        <p>{device.state === 'pending' ? copy.pending : device.state === 'active' ? copy.active : copy.expired}</p>
        <p>{device.localAddress} · {device.observedAt}</p><p>{copy.tools}: {device.toolCount}</p>
        {device.toolError && <p className="text-amber-300">{device.toolError}</p>}{device.registeredToolNames.map(name => <p key={name} className="font-mono">{name}</p>)}
      </div></details>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} onClick={closePanel}>{copy.close}</button>
        <button type="button" className={`${buttonClass} text-amber-200`} disabled={working} onClick={() => void revoke(panel.id)}>{working ? copy.working : copy.revoke}</button></div>
    </section>}
  </GlassCard>;
}
