import { execFile } from 'node:child_process';

export const WINDOWS_PRINTER_POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const PRINTER_PROBE_TIMEOUT_MS = 15_000;
export const PRINTER_PROBE_MAX_BYTES = 1_048_576;

export interface PrinterExecOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
}
export type PrinterExecRunner = (
  executable: string,
  args: string[],
  options: PrinterExecOptions,
) => Promise<{ stdout: string; stderr?: string }>;
export interface PrinterInventoryOptions {
  platform?: NodeJS.Platform;
  execRunner?: PrinterExecRunner;
}
export interface PrinterProbeError {
  code: string;
  message: string;
  printerName?: string;
}
export interface WindowsPrinterJob {
  id: number | null;
  status: string | number | null;
  sizeBytes: number | null;
  totalPages: number | null;
  pagesPrinted: number | null;
}
export interface WindowsPrinterPort {
  name: string;
  description: string | null;
  monitor: string | null;
  hostAddress: string | null;
  printerHostAddress: string | null;
  deviceUrl: string | null;
  deviceUri: string | null;
  portNumber: number | null;
  protocol: string | number | null;
}
export interface WindowsPrinterDeviceNode {
  instanceId: string; className: string | null; friendlyName: string | null; status: string | null;
  parentInstanceId: string | null; containerId: string | null; isPresent: boolean | null;
  locationInfo: string | null; associationEndpointId: string | null; cachedAssociationEndpointAddress: string | null;
}
export interface WindowsPrinterIdentitySnapshot {
  source: 'windows_pnp_cached_metadata'; scope: 'windows_device_registration'; networkReachability: 'not_tested';
  observedAt: string; cacheUpdatedAt: null;
  status: 'observed' | 'partial' | 'unavailable'; nodes: WindowsPrinterDeviceNode[]; errors: PrinterProbeError[];
}
export interface WindowsPrinterQueueIdentity {
  status: 'associated' | 'ambiguous' | 'not_observed' | 'unavailable';
  matchSource: 'Win32_Printer.PNPDeviceID' | 'Get-PnpDevice.PrintQueue.FriendlyName' | null;
  instanceIds: string[];
}
export interface WindowsPrinter {
  name: string;
  isDefault: boolean | null;
  workOffline: boolean | null;
  cimPrinterStatus: number | null;
  queueStatus: string | null;
  detectedErrorState: number | null;
  portName: string | null;
  driverName: string | null;
  isLocal: boolean | null;
  isNetwork: boolean | null;
  isShared: boolean | null;
  queueType: string | null;
  jobCount: number | null;
  jobs: WindowsPrinterJob[];
  jobsError: string | null;
  pnpDeviceId?: string | null;
  pnpIdentity?: WindowsPrinterQueueIdentity;
}
interface PrinterProbeMetadata {
  supported: boolean;
  status: 'ok' | 'partial' | 'error' | 'unsupported';
  platform: string;
  observedAt: string;
  ports: WindowsPrinterPort[];
  errors: PrinterProbeError[];
  deviceIdentity?: WindowsPrinterIdentitySnapshot;
}
export interface PrinterInventoryResult extends PrinterProbeMetadata {
  printers: WindowsPrinter[];
}
export interface PrinterStatusResult extends PrinterProbeMetadata {
  printer: WindowsPrinter | null;
}

// Only queue metadata, job counters and OS device-identity metadata leave
// PowerShell. No document name, job owner or document content is selected. Caller input is
// never inserted into this script (status lookup filters the returned names).
const PRINTER_INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$cim = @(); $queueRows = @(); $queues = @(); $ports = @(); $errors = @()
try {
  $cim = @(Get-CimInstance -ClassName Win32_Printer | Select-Object Name,Default,WorkOffline,PrinterStatus,DetectedErrorState,PortName,DriverName,Local,Network,Shared,PNPDeviceID)
} catch { $errors += [pscustomobject]@{ Code='cim_query_failed'; Message=$_.Exception.Message } }
try { $queueRows = @(Get-Printer) }
catch { $errors += [pscustomobject]@{ Code='queue_query_failed'; Message=$_.Exception.Message } }
$queues = @($queueRows | ForEach-Object {
  $q = $_; $jobs = @(); $jobsError = $null; $jobCount = $null
  try {
    $jobs = @(Get-PrintJob -PrinterName $q.Name -ErrorAction Stop | Select-Object ID,JobStatus,Size,TotalPages,PagesPrinted)
    $jobCount = $jobs.Count
  } catch { $jobsError = $_.Exception.Message }
  [pscustomobject]@{
    Name=$q.Name; PrinterStatus=[string]$q.PrinterStatus; PortName=$q.PortName
    DriverName=$q.DriverName; Type=[string]$q.Type; Shared=$q.Shared
    JobCount=$jobCount; Jobs=$jobs; JobsError=$jobsError
  }
})
try {
  $ports = @(Get-PrinterPort | Select-Object Name,Description,PortMonitor,PrinterHostAddress,DeviceURL,DeviceURI,HostAddress,PortNumber,Protocol)
} catch { $errors += [pscustomobject]@{ Code='port_query_failed'; Message=$_.Exception.Message } }
$pnpDevices = @(); $pnpErrors = @()
try {
  $pending = [System.Collections.Generic.Queue[string]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  @(Get-PnpDevice -Class Printer,PrintQueue -PresentOnly -ErrorAction Stop) | ForEach-Object { $pending.Enqueue([string]$_.InstanceId) }
  $keys = @('DEVPKEY_Device_ContainerId','DEVPKEY_Device_Parent','DEVPKEY_Device_LocationInfo','DEVPKEY_Device_IsPresent','{3B2CE006-5E61-4FDE-BAB8-9B8AAC9B26DF} 8','{A35996AB-11CF-4935-8B61-A6761081ECDF} 12')
  while ($pending.Count -gt 0) {
    $id = $pending.Dequeue()
    if (-not $seen.Add($id)) { continue }
    try {
      $d = Get-PnpDevice -InstanceId $id -ErrorAction Stop
      $props = @{}
      @(Get-PnpDeviceProperty -InstanceId $id -KeyName $keys -ErrorAction SilentlyContinue) | ForEach-Object { $props[$_.KeyName] = $_.Data }
      $parent = $props['DEVPKEY_Device_Parent']
      $pnpDevices += [pscustomobject]@{
        InstanceId=$id; Class=$d.Class; FriendlyName=$d.FriendlyName; Status=[string]$d.Status
        ContainerId=$props['DEVPKEY_Device_ContainerId']; ParentInstanceId=$parent
        IsPresent=$props['DEVPKEY_Device_IsPresent']; LocationInfo=$props['DEVPKEY_Device_LocationInfo']
        AssociationEndpointId=$props['{3B2CE006-5E61-4FDE-BAB8-9B8AAC9B26DF} 8']
        AssociationEndpointAddress=$props['{A35996AB-11CF-4935-8B61-A6761081ECDF} 12']
      }
      if ($parent -is [string] -and $parent -and -not $seen.Contains($parent)) { $pending.Enqueue($parent) }
    } catch { $pnpErrors += [pscustomobject]@{ Code='pnp_node_query_failed'; Message=$_.Exception.Message } }
  }
} catch { $pnpErrors += [pscustomobject]@{ Code='pnp_query_failed'; Message=$_.Exception.Message } }
[pscustomobject]@{ CimPrinters=$cim; Queues=$queues; Ports=$ports; Errors=$errors; PnpDevices=$pnpDevices; PnpErrors=$pnpErrors } | ConvertTo-Json -Depth 6 -Compress
`;

const defaultRunner: PrinterExecRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr }));
    else resolve({ stdout, stderr });
  });
});

type Row = Record<string, unknown>;
function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function rows(value: unknown): Row[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  if (!items.every(record)) throw new Error('Expected printer metadata objects.');
  return items;
}
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function counter(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
function rawStatus(value: unknown): string | number | null {
  return textOrNull(value) ?? numberOrNull(value);
}
function shortMessage(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, 500);
}
function endpoint(value: unknown): string | null {
  const raw = textOrNull(value);
  if (!raw) return null;
  // Port endpoints are interface metadata, not an opportunity to return URL
  // passwords or token-bearing queries from a driver configuration.
  try {
    const url = new URL(raw);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}
function identitySnapshot(raw: Row, observedAt: string): WindowsPrinterIdentitySnapshot {
  const errors = rows(raw.PnpErrors).map(error => ({ code: shortMessage(error.Code, 'pnp_query_failed'),
    message: shortMessage(error.Message, 'Windows printer identity metadata could not be read.') }));
  const available = Object.hasOwn(raw, 'PnpDevices');
  const nodes = rows(raw.PnpDevices).map(node => {
    const instanceId = textOrNull(node.InstanceId);
    if (!instanceId) throw new Error('A printer PnP node is missing its instance ID.');
    const location = textOrNull(node.LocationInfo);
    return { instanceId, className: textOrNull(node.Class), friendlyName: textOrNull(node.FriendlyName),
      status: textOrNull(node.Status), parentInstanceId: textOrNull(node.ParentInstanceId),
      containerId: textOrNull(node.ContainerId), isPresent: booleanOrNull(node.IsPresent),
      locationInfo: location && /^https?:/iu.test(location) ? endpoint(location) : location,
      associationEndpointId: textOrNull(node.AssociationEndpointId), cachedAssociationEndpointAddress: endpoint(node.AssociationEndpointAddress) };
  });
  return { source: 'windows_pnp_cached_metadata', scope: 'windows_device_registration', networkReachability: 'not_tested', observedAt, cacheUpdatedAt: null,
    status: !available || (!nodes.length && errors.length > 0) ? 'unavailable' : errors.length ? 'partial' : 'observed', nodes, errors };
}

function queueIdentity(name: string, pnpDeviceId: string | null, identity: WindowsPrinterIdentitySnapshot): WindowsPrinterQueueIdentity {
  if (identity.status === 'unavailable') return { status: 'unavailable', matchSource: null, instanceIds: [] };
  const nodes = identity.nodes.filter(node => pnpDeviceId
    ? node.instanceId.toLowerCase() === pnpDeviceId.toLowerCase()
    : node.className?.toLowerCase() === 'printqueue' && node.friendlyName?.toLowerCase() === name.toLowerCase());
  return { status: nodes.length > 1 ? 'ambiguous' : nodes.length === 1 ? 'associated' : 'not_observed',
    matchSource: pnpDeviceId ? 'Win32_Printer.PNPDeviceID' : 'Get-PnpDevice.PrintQueue.FriendlyName', instanceIds: nodes.map(node => node.instanceId) };
}

function emptyResult(platform: string): PrinterInventoryResult {
  return {
    supported: platform === 'win32',
    status: platform === 'win32' ? 'error' : 'unsupported',
    platform, observedAt: new Date().toISOString(), printers: [], ports: [], errors: [],
  };
}
function executionError(error: unknown): PrinterProbeError {
  const value = record(error) ? error : {};
  if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { code: 'probe_output_limit', message: 'Windows printer query exceeded the output limit.' };
  }
  if (value.killed === true || value.code === 'ETIMEDOUT') {
    return { code: 'probe_timeout', message: 'Windows printer query timed out.' };
  }
  const code = typeof value.code === 'string' || typeof value.code === 'number' ? String(value.code) : 'unknown';
  return {
    code: 'probe_failed',
    message: shortMessage(value.stderr, 'Windows printer query failed (code ' + code + ').'),
  };
}

/** Read the Windows spooler's installed queues; this does not test a physical device's reachability. */
export async function readPrinterInventory(options: PrinterInventoryOptions = {}): Promise<PrinterInventoryResult> {
  const platform = options.platform ?? process.platform;
  const result = emptyResult(platform);
  if (!result.supported) return result;
  let stdout: string;
  let stderr: string | undefined;
  try {
    const output = await (options.execRunner ?? defaultRunner)(
      WINDOWS_PRINTER_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRINTER_INVENTORY_SCRIPT],
      { encoding: 'utf8', timeout: PRINTER_PROBE_TIMEOUT_MS, maxBuffer: PRINTER_PROBE_MAX_BYTES, windowsHide: true },
    );
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    result.errors.push(executionError(error));
    return result;
  }
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > PRINTER_PROBE_MAX_BYTES
    || (typeof stderr === 'string' && Buffer.byteLength(stderr, 'utf8') > PRINTER_PROBE_MAX_BYTES)) {
    result.errors.push({ code: 'probe_output_limit', message: 'Windows printer query exceeded the output limit.' });
    return result;
  }
  try {
    const raw: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    if (!record(raw) || !('CimPrinters' in raw) || !('Queues' in raw) || !('Ports' in raw)) {
      throw new Error('Missing Windows printer metadata sections.');
    }
    const cimRows = rows(raw.CimPrinters);
    const queueRows = rows(raw.Queues);
    const names = new Map<string, { name: string; cim?: Row; queue?: Row }>();
    for (const [source, sourceRows] of [['cim', cimRows], ['queue', queueRows]] as const) {
      for (const row of sourceRows) {
        const name = textOrNull(row.Name);
        if (!name) throw new Error('A printer queue is missing its name.');
        const key = name.toLowerCase();
        const entry = names.get(key) ?? { name };
        entry[source] = row;
        names.set(key, entry);
      }
    }
    result.errors = rows(raw.Errors).map(error => ({
      code: shortMessage(error.Code, 'query_failed'),
      message: shortMessage(error.Message, 'Windows printer metadata could not be read.'),
    }));
    result.deviceIdentity = identitySnapshot(raw, result.observedAt);
    result.printers = [...names.values()].map(({ name, cim = {}, queue = {} }) => {
      const jobsError = textOrNull(queue.JobsError);
      if (jobsError) result.errors.push({ code: 'jobs_query_failed', printerName: name, message: shortMessage(jobsError, 'Job metadata unavailable.') });
      return {
        name,
        isDefault: booleanOrNull(cim.Default), workOffline: booleanOrNull(cim.WorkOffline),
        cimPrinterStatus: numberOrNull(cim.PrinterStatus), queueStatus: textOrNull(queue.PrinterStatus),
        detectedErrorState: numberOrNull(cim.DetectedErrorState),
        portName: textOrNull(cim.PortName) ?? textOrNull(queue.PortName),
        driverName: textOrNull(cim.DriverName) ?? textOrNull(queue.DriverName),
        isLocal: booleanOrNull(cim.Local), isNetwork: booleanOrNull(cim.Network),
        isShared: booleanOrNull(cim.Shared) ?? booleanOrNull(queue.Shared), queueType: textOrNull(queue.Type),
        pnpDeviceId: textOrNull(cim.PNPDeviceID),
        pnpIdentity: queueIdentity(name, textOrNull(cim.PNPDeviceID), result.deviceIdentity!),
        jobCount: jobsError ? null : counter(queue.JobCount), jobsError,
        jobs: jobsError ? [] : rows(queue.Jobs).map(job => ({
          id: counter(job.ID), status: rawStatus(job.JobStatus), sizeBytes: counter(job.Size),
          totalPages: counter(job.TotalPages), pagesPrinted: counter(job.PagesPrinted),
        })),
      };
    });
    result.ports = rows(raw.Ports).map(port => {
      const name = textOrNull(port.Name);
      if (!name) throw new Error('A printer port is missing its name.');
      return {
        name, description: textOrNull(port.Description), monitor: textOrNull(port.PortMonitor),
        hostAddress: textOrNull(port.HostAddress), printerHostAddress: textOrNull(port.PrinterHostAddress),
        deviceUrl: endpoint(port.DeviceURL), deviceUri: endpoint(port.DeviceURI),
        portNumber: counter(port.PortNumber), protocol: rawStatus(port.Protocol),
      };
    });
    if (stderr?.trim()) result.errors.push({ code: 'probe_warning', message: shortMessage(stderr, 'Windows printer query reported a warning.') });
    result.status = result.errors.length ? 'partial' : 'ok';
    return result;
  } catch {
    result.printers = []; result.ports = [];
    result.errors = [{ code: 'invalid_probe_output', message: 'Windows printer query returned invalid metadata.' }];
    return result;
  }
}

/** Exact installed-queue lookup; no printer name is passed to a shell command. */
export async function readPrinterStatus(
  printerName: string,
  options: PrinterInventoryOptions = {},
): Promise<PrinterStatusResult> {
  if (typeof printerName !== 'string' || !printerName.trim() || printerName.length > 1_024 || /[\u0000-\u001f\u007f]/.test(printerName)) {
    const { printers: _printers, ...metadata } = emptyResult(options.platform ?? process.platform);
    return { ...metadata, printer: null, errors: [{ code: 'invalid_printer_name', message: 'An installed printer queue name is required.' }] };
  }
  const { printers, ...metadata } = await readPrinterInventory(options);
  const printer = printers.find(item => item.name.toLowerCase() === printerName.toLowerCase()) ?? null;
  if (!printer && (metadata.status === 'ok' || metadata.status === 'partial')) {
    metadata.status = 'error';
    metadata.errors.push({ code: 'printer_not_found', message: 'The named printer queue was not present in this Windows snapshot.' });
  }
  return { ...metadata, printer };
}
