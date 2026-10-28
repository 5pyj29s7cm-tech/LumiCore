import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Printer, Radio, RefreshCcw, Usb } from 'lucide-react';
import { GlassCard } from './SharedUI';
import { externalDevicesCopy } from '@/i18n/locales/externalDevices';
import { readExternalPrinterStatus, useExternalDevices } from '@/services/externalDevices';
import type { ExternalDevicesSnapshot, NetworkPrinterStatusRequest, NetworkPrinterStatusResult } from '../../shared/external_devices';

type Copy = ReturnType<typeof externalDevicesCopy>;
type Source = ExternalDevicesSnapshot['usb'] | ExternalDevicesSnapshot['printers'] | ExternalDevicesSnapshot['lan'];
const fieldClass = 'text-xs text-white/60 break-words [overflow-wrap:anywhere]';

function Field({ label, value, copy }: { label: string; value: ReactNode; copy: Copy }) {
  return <div className={fieldClass}><span className="text-white/40">{label}: </span>{value === null || value === undefined || value === '' ? copy.unknown : String(value)}</div>;
}

function SourceNotes({ source, copy }: { source: Source; copy: Copy }) {
  return <div className="space-y-2 text-xs text-white/55">
    <p>{copy.status}: <span className="font-mono">{source.status}</span></p>
    <p>{copy.observed}: {'observedAt' in source ? source.observedAt : source.finishedAt}</p>
    {source.errors.map((error, index) => <p role="alert" className="text-amber-300 break-words" key={index}>{error.code}: {error.message}</p>)}
    {'limitations' in source && source.limitations.length > 0 && <details>
      <summary className="cursor-pointer">{copy.limitations}</summary>
      <ul className="list-disc pl-5 mt-2 space-y-1">{source.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
    </details>}
  </div>;
}

function PrinterStatus({ target, copy }: { target: NetworkPrinterStatusRequest; copy: Copy }) {
  const [result, setResult] = useState<NetworkPrinterStatusResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const read = async () => {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setLoading(true); setError(''); setResult(null);
    const timer = setTimeout(() => request.abort(new Error('Printer status request timed out (15000ms)')), 15000);
    try {
      const receipt = await readExternalPrinterStatus(target, request.signal);
      if (!request.signal.aborted) setResult(receipt);
    } catch (failure) {
      if (active.current === request && !request.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      else if (active.current === request && request.signal.reason instanceof Error && request.signal.reason.message.includes('15000ms')) setError(request.signal.reason.message);
    } finally {
      clearTimeout(timer);
      if (active.current === request) { active.current = null; setLoading(false); }
    }
  };
  return <div className="space-y-2 border-t border-white/10 pt-3">
    <button type="button" disabled={loading} onClick={() => void read()}
      className="inline-flex items-center gap-2 rounded-lg border border-celestial-saturn/30 bg-celestial-saturn/10 px-3 py-2 text-xs text-celestial-saturn disabled:opacity-50">
      {loading && <RefreshCcw size={12} className="animate-spin" />}{loading ? copy.readingStatus : copy.readStatus}
      <span className="font-mono">{target.address}:{target.port}</span>
    </button>
    <p className="text-xs text-white/40">{copy.readOnly}</p>
    {error && <p role="alert" className="text-sm text-amber-300 break-words">{error}</p>}
    {result && <div className="space-y-2" aria-live="polite">
      <p className={`text-sm ${result.ok ? 'text-emerald-300' : 'text-amber-300'}`}>{result.ok ? `${copy.state}: ${result.state}` : `${copy.queryFailed}: ${result.status}`}</p>
      <Field label={copy.observed} value={result.observedAt} copy={copy} />
      {result.ippStatusCode !== undefined && <Field label={copy.ippCode} value={result.ippStatusCode} copy={copy} />}
      {!result.ok && result.error && <p role="alert" className="text-xs text-amber-300 break-words">{result.errorCode} · {result.phase}: {result.error}</p>}
      {result.warnings?.map(warning => <p className="text-xs text-amber-200" key={warning.code}>{warning.code}: {warning.message}</p>)}
      {result.ok && <details><summary className="text-xs cursor-pointer">{copy.attributes}</summary>
        <dl className="mt-2 space-y-1">{Object.entries(result.attributes).map(([name, values]) => <div key={name} className="text-xs break-words [overflow-wrap:anywhere]"><dt className="font-mono text-white/50">{name}</dt><dd>{values.map(value => String(value)).join(', ')}</dd></div>)}</dl>
      </details>}
    </div>}
  </div>;
}

export function ExternalDeviceCenter({ scope, lang }: { scope: string; lang: 'zh' | 'en' }) {
  const copy = externalDevicesCopy(lang);
  const { data, loading, error, refresh } = useExternalDevices(scope);
  return <GlassCard className="p-4 sm:p-6 space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><h3 className="text-xl font-bold">{copy.title}</h3><p className="text-xs text-white/50 max-w-2xl">{copy.description}</p></div>
      <button type="button" onClick={refresh} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs disabled:opacity-50">
        <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} />{loading ? copy.refreshing : copy.refresh}
      </button>
    </div>
    {data && <p className="text-xs text-white/50">{copy.observed}: <time dateTime={data.observedAt}>{data.observedAt}</time>{(loading || error) && ` · ${copy.previous}`}</p>}
    {error && <p role="alert" className="text-sm text-amber-300 break-words">{error}</p>}
    {data && <div className="space-y-8">
      <section aria-label={copy.usb} className="space-y-3">
        <h4 className="font-semibold flex items-center gap-2"><Usb size={17} />{copy.usb}</h4><p className="text-xs text-white/45">{copy.usbHint}</p>
        <SourceNotes source={data.usb} copy={copy} />
        {'devices' in data.usb && <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{data.usb.devices.map(device => <article key={device.instanceId} className="min-w-0 rounded-xl border border-white/10 bg-white/[.025] p-4 space-y-2">
          <h5 className="text-sm font-semibold break-words">{device.name || device.instanceId}</h5>
          <p className="text-xs text-white/50">{copy.present} · {copy.noControl}</p>
          <Field label={copy.port} value={device.portName} copy={copy} /><Field label={copy.registryPort} value={device.registryPortName} copy={copy} /><Field label={copy.serialPort} value={device.serialPortName} copy={copy} />
          <Field label={copy.source} value={device.portNameSource} copy={copy} /><Field label={copy.status} value={device.status} copy={copy} />
          <Field label={copy.problem} value={device.problemCode} copy={copy} /><Field label={copy.configError} value={device.configManagerErrorCode} copy={copy} />
          <Field label={copy.driver} value={[device.driver.provider, device.driver.version, device.driver.infName, device.driver.isSigned === null ? null : device.driver.isSigned ? copy.signed : copy.unsigned].filter(value => value !== null).join(' · ')} copy={copy} />
          <p className="text-[11px] text-white/35 font-mono break-all">{device.instanceId}</p>
        </article>)}{data.usb.devices.length === 0 && data.usb.status === 'ok' && <p className="text-xs text-white/45">{copy.empty}</p>}</div>}
      </section>
      <section aria-label={copy.lan} className="space-y-3">
        <h4 className="font-semibold flex items-center gap-2"><Radio size={17} />{copy.lan}</h4><p className="text-xs text-white/45">{copy.lanHint}</p>
        <SourceNotes source={data.lan} copy={copy} />
        {'candidates' in data.lan && <>
          {data.lan.truncated && <p className="text-xs text-amber-300">{copy.truncated}</p>}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{data.lan.candidates.map(candidate => {
            const service = candidate.serviceType.toLowerCase().replace(/\.$/, '');
            const ipp = candidate.protocol === 'mdns' && service === '_ipp._tcp.local';
            const ipps = candidate.protocol === 'mdns' && service === '_ipps._tcp.local';
            const validPath = typeof candidate.path === 'string' && candidate.path.startsWith('/') && !candidate.path.startsWith('//');
            const target = ipp && Number.isInteger(candidate.port) && candidate.port! > 0 && candidate.port! <= 65535 && validPath;
            return <article key={candidate.id} className="min-w-0 rounded-xl border border-white/10 bg-white/[.025] p-4 space-y-2">
              <h5 className="text-sm font-semibold break-words">{candidate.name}</h5>
              <p className="text-xs text-white/50 font-mono break-all">{candidate.protocol} · {candidate.serviceType}</p>
              <p className="text-xs text-white/60 break-all">{candidate.addresses.join(', ') || copy.noAddress}{candidate.port ? `:${candidate.port}` : ''}{candidate.path || ''}</p>
              {candidate.host && <Field label="SRV" value={candidate.host} copy={copy} />}
              <Field label={copy.source} value={`${candidate.source.interfaceName} · ${candidate.source.localAddress} ← ${candidate.source.responderAddress}`} copy={copy} />
              {candidate.usn && <Field label="USN" value={candidate.usn} copy={copy} />}
              {candidate.location && <Field label="LOCATION" value={candidate.location} copy={copy} />}
              {candidate.txt && <details><summary className="text-xs text-white/50 cursor-pointer">TXT</summary><dl className="mt-1 space-y-1">{Object.entries(candidate.txt).map(([name, value]) => <div key={name} className="text-xs break-all"><dt className="inline font-mono text-white/40">{name}: </dt><dd className="inline">{value}</dd></div>)}</dl></details>}
              {target && candidate.addresses.length > 0 ? candidate.addresses.map(address => <PrinterStatus key={`${address}:${candidate.port}:${candidate.path}`} target={{ address, port: candidate.port!, resourcePath: candidate.path! }} copy={copy} />)
                : <p className="text-xs text-white/50">{ipps ? copy.tls : ipp ? !candidate.addresses.length ? copy.noAddress : copy.noTarget : copy.noControl}</p>}
            </article>;
          })}{data.lan.candidates.length === 0 && data.lan.status === 'completed' && <p className="text-xs text-white/45">{copy.empty}</p>}</div>
        </>}
      </section>
      <section aria-label={copy.queues} className="space-y-3">
        <h4 className="font-semibold flex items-center gap-2"><Printer size={17} />{copy.queues}</h4><p className="text-xs text-white/45">{copy.queuesHint}</p>
        <SourceNotes source={data.printers} copy={copy} />
        {'printers' in data.printers && <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{data.printers.printers.map((printer, index) => <article key={`${printer.name}:${index}`} className="min-w-0 rounded-xl border border-white/10 bg-white/[.025] p-4 space-y-2">
          <h5 className="text-sm font-semibold break-words">{printer.name}</h5><Field label={copy.port} value={printer.portName} copy={copy} /><Field label={copy.driver} value={printer.driverName} copy={copy} />
          <Field label={copy.queueFlags} value={`${printer.queueStatus ?? copy.unknown} / ${printer.workOffline === null ? copy.unknown : String(printer.workOffline)}`} copy={copy} />
          <Field label={copy.configError} value={printer.detectedErrorState} copy={copy} /><Field label={copy.jobs} value={printer.jobCount} copy={copy} />
          {printer.jobsError && <p role="alert" className="text-xs text-amber-300">{printer.jobsError}</p>}
        </article>)}{data.printers.printers.length === 0 && data.printers.status === 'ok' && <p className="text-xs text-white/45">{copy.empty}</p>}</div>}
      </section>
    </div>}
  </GlassCard>;
}
