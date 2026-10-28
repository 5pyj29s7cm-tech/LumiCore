import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Printer, Radio, RefreshCcw, Usb } from 'lucide-react';
import { GlassCard } from './SharedUI';
import { externalDevicesCopy } from '@/i18n/locales/externalDevices';
import { readExternalPrinterStatus, useExternalDevices } from '@/services/externalDevices';
import { groupLanServices, mainUsbDevices, printerProtocol, printerStatusTarget, type LanCandidate } from './externalDevicePresentation';
import type { ExternalDevicesSnapshot, NetworkPrinterStatusRequest, NetworkPrinterStatusResult } from '../../shared/external_devices';

type Copy = ReturnType<typeof externalDevicesCopy>;
type Source = ExternalDevicesSnapshot['usb'] | ExternalDevicesSnapshot['printers'] | ExternalDevicesSnapshot['lan'];
const fieldClass = 'text-xs text-white/60 break-words [overflow-wrap:anywhere]';
const rowClass = 'min-w-0 rounded-xl border border-white/10 p-4 space-y-3';

function Field({ label, value, copy }: { label: string; value: ReactNode; copy: Copy }) {
  return <div className={fieldClass}><span className="text-white/40">{label}: </span>{value === null || value === undefined || value === '' ? copy.unknown : String(value)}</div>;
}

function SourceWarning({ source, label, copy }: { source: Source; label: string; copy: Copy }) {
  if (['ok', 'completed'].includes(source.status) && !source.errors.length) return null;
  const status = source.status === 'partial' ? copy.partial : ['ok', 'completed'].includes(source.status) ? copy.statusWarning : copy.unavailable;
  return <p role="alert" className="text-xs text-amber-300 break-words">{label}: {status}{source.errors[0] ? ` · ${source.errors[0].message}` : ''}</p>;
}

function SourceNotes({ source, copy }: { source: Source; copy: Copy }) {
  return <div className="space-y-2 text-xs text-white/55">
    <p>{copy.status}: <span className="font-mono">{source.status}</span></p>
    <p>{copy.observed}: {'observedAt' in source ? source.observedAt : source.finishedAt}</p>
    {source.errors.map((error, index) => <p className="text-amber-300 break-words" key={index}>{error.code}: {error.message}</p>)}
    {'limitations' in source && source.limitations.map((limit, index) => <p key={index}>{limit}</p>)}
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
    const request = new AbortController(); active.current = request;
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
  return <div className="space-y-3">
    <button type="button" disabled={loading} onClick={() => void read()}
      className="inline-flex items-center gap-2 rounded-lg border border-celestial-saturn/30 bg-celestial-saturn/10 px-3 py-2 text-xs text-celestial-saturn disabled:opacity-50">
      {loading && <RefreshCcw size={12} className="animate-spin" />}{loading ? copy.readingStatus : copy.readStatus}
    </button>
    {error && <p role="alert" className="text-sm text-amber-300 break-words">{error}</p>}
    {result && <div className="space-y-2" aria-live="polite">
      <p className={`text-sm ${!result.ok || result.state === 'stopped' ? 'text-amber-300' : ['idle', 'processing'].includes(result.state) ? 'text-emerald-300' : 'text-white/55'}`}>{result.ok ? ({ idle: copy.idle, processing: copy.processing, stopped: copy.stopped }[result.state] ?? copy.stateUnknown) : copy.queryFailed}</p>
      {result.ok && <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-white/55">
        {typeof result.attributes['printer-is-accepting-jobs']?.[0] === 'boolean' && <span>{result.attributes['printer-is-accepting-jobs'][0] ? copy.accepting : copy.notAccepting}</span>}
        {typeof result.attributes['queued-job-count']?.[0] === 'number' && <span>{copy.jobs}: {result.attributes['queued-job-count'][0]}</span>}
      </div>}
      {!result.ok && result.error && <p role="alert" className="text-xs text-amber-300 break-words">{result.error}</p>}
      {!!result.warnings?.length && <p className="text-xs text-amber-200">{copy.statusWarning}</p>}
      <details className="text-xs text-white/55"><summary className="cursor-pointer">{copy.statusDetails}</summary><div className="mt-3 space-y-2">
        <p>{copy.readOnly}</p><Field label={copy.observed} value={result.observedAt} copy={copy} /><Field label={copy.status} value={result.status} copy={copy} />
        {result.ok && <Field label={copy.state} value={result.state} copy={copy} />}
        <Field label={copy.source} value={`${target.address}:${target.port}${target.resourcePath}`} copy={copy} />
        {result.ippStatusCode !== undefined && <Field label={copy.ippCode} value={result.ippStatusCode} copy={copy} />}
        {!result.ok && result.error && <p>{result.errorCode} · {result.phase}: {result.error}</p>}
        {result.warnings?.map(warning => <p className="text-amber-200" key={warning.code}>{warning.code}: {warning.message}</p>)}
        {result.ok && <dl className="space-y-1">{Object.entries(result.attributes).map(([name, values]) => <div key={name} className="break-words [overflow-wrap:anywhere]"><dt className="font-mono text-white/50">{name}</dt><dd>{values.map(value => String(value)).join(', ')}</dd></div>)}</dl>}
      </div></details>
    </div>}
  </div>;
}

function ServiceDetails({ candidate, copy }: { candidate: LanCandidate; copy: Copy }) {
  return <div className="space-y-2 border-t border-white/10 pt-3 text-xs">
    <p className="font-mono break-all">{candidate.name}</p>
    <p className="font-mono break-all">{candidate.protocol} · {candidate.serviceType}</p>
    <p className="break-all">{candidate.addresses.join(', ') || copy.noAddress}{candidate.port ? `:${candidate.port}` : ''}{candidate.path || ''}</p>
    {candidate.host && <Field label="SRV" value={candidate.host} copy={copy} />}
    <Field label={copy.source} value={`${candidate.source.interfaceName} · ${candidate.source.localAddress} ← ${candidate.source.responderAddress}`} copy={copy} />
    {candidate.usn && <Field label="USN" value={candidate.usn} copy={copy} />}
    {candidate.location && <Field label="LOCATION" value={candidate.location} copy={copy} />}
    {printerProtocol(candidate) === 'ipps' && <p>{copy.tls}</p>}
    {candidate.txt && <dl>{Object.entries(candidate.txt).map(([name, value]) => <div key={name} className="break-all"><dt className="inline font-mono text-white/40">TXT {name}: </dt><dd className="inline">{value}</dd></div>)}</dl>}
  </div>;
}

export function ExternalDeviceCenter({ scope, lang }: { scope: string; lang: 'zh' | 'en' }) {
  const copy = externalDevicesCopy(lang);
  const { data, loading, error, refresh } = useExternalDevices(scope);
  const usb = mainUsbDevices(data?.usb), lan = groupLanServices(data?.lan);
  return <GlassCard className="p-4 sm:p-6 space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><h3 className="text-xl font-bold">{copy.title}</h3><p className="text-xs text-white/50">{copy.description}</p></div>
      <button type="button" onClick={refresh} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs disabled:opacity-50">
        <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} />{loading ? copy.refreshing : copy.refresh}
      </button>
    </div>
    {data && (loading || error) && <p className="text-xs text-amber-200">{copy.previous}</p>}
    {error && <p role="alert" className="text-sm text-amber-300 break-words">{error}</p>}
    {data && <>
      <section aria-label={copy.usb} className="space-y-3">
        <h4 className="text-sm font-semibold flex items-center gap-2"><Usb size={16} />{copy.usb}<span className="text-white/40 font-normal">{'devices' in data.usb && ['ok', 'partial'].includes(data.usb.status) ? usb.length : '—'}</span></h4>
        <SourceWarning source={data.usb} label={copy.usb} copy={copy} />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{usb.map(device => {
          const problem = (device.problemCode !== null && device.problemCode !== 0) || (device.configManagerErrorCode !== null && device.configManagerErrorCode !== 0)
            || device.status?.toLowerCase() === 'error' || device.cimStatus?.toLowerCase() === 'error';
          return <article key={device.instanceId} className={rowClass}>
            <h5 className="text-sm font-semibold break-words">{device.name || device.instanceId}</h5>
            <p className={`text-xs ${problem ? 'text-amber-300' : 'text-white/55'}`}>{problem ? copy.needsAttention : copy.present} · {copy.noControl}</p>
            <details className="text-xs text-white/50"><summary className="cursor-pointer">{copy.details}</summary><div className="mt-3 space-y-2">
              <p>{copy.usbHint}</p><Field label={copy.port} value={device.portName} copy={copy} /><Field label={copy.registryPort} value={device.registryPortName} copy={copy} /><Field label={copy.serialPort} value={device.serialPortName} copy={copy} />
              <Field label={copy.source} value={device.portNameSource} copy={copy} /><Field label={copy.status} value={device.status} copy={copy} />
              <Field label={copy.problem} value={device.problemCode} copy={copy} /><Field label={copy.configError} value={device.configManagerErrorCode} copy={copy} />
              <Field label={copy.driver} value={[device.driver.provider, device.driver.version, device.driver.infName, device.driver.isSigned === null ? null : device.driver.isSigned ? copy.signed : copy.unsigned].filter(value => value !== null).join(' · ')} copy={copy} />
              <p className="font-mono break-all">{device.instanceId}</p>
            </div></details>
          </article>;
        })}{!usb.length && data.usb.status === 'ok' && <p className="text-xs text-white/45">{copy.emptyUsb}</p>}</div>
      </section>
      <section aria-label={copy.lan} className="space-y-3">
        <h4 className="text-sm font-semibold flex items-center gap-2"><Radio size={16} />{copy.lan}<span className="text-white/40 font-normal">{'candidates' in data.lan && ['completed', 'partial'].includes(data.lan.status) ? lan.length : '—'}</span></h4>
        <SourceWarning source={data.lan} label={copy.lan} copy={copy} />
        {'truncated' in data.lan && data.lan.truncated && <p className="text-xs text-amber-300">{copy.truncated}</p>}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{lan.map(group => {
          const target = printerStatusTarget(group);
          const unresolved = !target && group.services.some(service => printerProtocol(service) === 'ipp' && !service.addresses.length);
          return <article key={group.key} className={rowClass}>
            <h5 className="text-sm font-semibold break-words">{group.name}</h5>
            <p className="text-xs text-white/55">{unresolved ? copy.addressUnresolved : copy.discovered}{!target && ` · ${copy.noControl}`}</p>
            {target && <PrinterStatus key={JSON.stringify(target)} target={target} copy={copy} />}
            <details className="text-xs text-white/50"><summary className="cursor-pointer">{copy.details}</summary><div className="mt-3 space-y-3">
              <p>{copy.lanHint}</p>{group.services.length > 1 && <p>{copy.groupedServices}</p>}
              {group.services.map(service => <ServiceDetails candidate={service} copy={copy} key={service.id} />)}
            </div></details>
          </article>;
        })}{!lan.length && data.lan.status === 'completed' && <p className="text-xs text-white/45">{copy.empty}</p>}</div>
      </section>
      <SourceWarning source={data.printers} label={copy.queues} copy={copy} />
      <div className="border-t border-white/10 pt-4 space-y-4 text-xs text-white/50">
        <details><summary className="cursor-pointer flex items-center gap-2"><Printer size={14} />{copy.printDetails}</summary>
          <section aria-label={copy.queues} className="mt-4 space-y-3">
            <p>{copy.queuesHint}</p><SourceNotes source={data.printers} copy={copy} />
            {'printers' in data.printers && data.printers.printers.map((printer, index) => <article key={`${printer.name}:${index}`} className={rowClass}>
              <h5 className="font-semibold break-words">{printer.name}</h5><Field label={copy.port} value={printer.portName} copy={copy} /><Field label={copy.driver} value={printer.driverName} copy={copy} />
              <Field label={copy.queueFlags} value={`${printer.queueStatus ?? copy.unknown} / ${printer.workOffline === null ? copy.unknown : String(printer.workOffline)}`} copy={copy} />
              <Field label={copy.detectedError} value={printer.detectedErrorState} copy={copy} /><Field label={copy.jobs} value={printer.jobCount} copy={copy} />
              {printer.jobsError && <p className="text-amber-300">{printer.jobsError}</p>}
            </article>)}
          </section>
        </details>
        <details><summary className="cursor-pointer">{copy.observationDetails}</summary><div className="mt-4 space-y-4">
          <Field label={copy.observed} value={data.observedAt} copy={copy} />
          <div><h5 className="mb-2 font-semibold">{copy.usb}</h5><SourceNotes source={data.usb} copy={copy} /></div>
          <div><h5 className="mb-2 font-semibold">{copy.lan}</h5><SourceNotes source={data.lan} copy={copy} /></div>
          {'devices' in data.usb && data.usb.devices.some(device => device.instanceEnumerator.toUpperCase() !== 'USB') && <div className="space-y-2">
            <h5 className="font-semibold">{copy.otherPorts}</h5>
            {data.usb.devices.filter(device => device.instanceEnumerator.toUpperCase() !== 'USB').map(device => <div key={device.instanceId} className="space-y-1">
              <p>{device.name} · {device.portName ?? copy.unknown}</p><Field label={copy.source} value={device.instanceId} copy={copy} />
              <Field label={copy.status} value={device.status} copy={copy} /><Field label={copy.problem} value={device.problemCode} copy={copy} /><Field label={copy.configError} value={device.configManagerErrorCode} copy={copy} />
            </div>)}
          </div>}
        </div></details>
      </div>
    </>}
  </GlassCard>;
}
