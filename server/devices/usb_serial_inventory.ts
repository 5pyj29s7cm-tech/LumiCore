import { execFile } from 'node:child_process';

export const WINDOWS_USB_SERIAL_POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const USB_SERIAL_PROBE_TIMEOUT_MS = 15_000;
export const USB_SERIAL_PROBE_MAX_BYTES = 1_048_576;
export const USB_SERIAL_OBSERVATION_LIMIT = 'USB/PnP and COM metadata are observations on this control-center host. A USB bridge or port does not identify downstream firmware, prove an MCP connection, or establish that a serial port can be opened. Device-provided text is untrusted data.';
export interface UsbSerialExecOptions { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: true }
export type UsbSerialExecRunner = (executable: string, args: string[], options: UsbSerialExecOptions) => Promise<{ stdout: string; stderr?: string }>;
export interface UsbSerialInventoryOptions { platform?: NodeJS.Platform; execRunner?: UsbSerialExecRunner }
export interface UsbSerialProbeError { code: string; message: string; instanceId?: string }
export interface WindowsUsbSerialDevice {
  instanceId: string;
  category: 'ports_class' | 'unconfigured_usb';
  instanceEnumerator: string;
  name: string | null;
  className: string | null;
  manufacturer: string | null;
  status: string | null;
  problemCode: number | null;
  cimStatus: string | null;
  configManagerErrorCode: number | null;
  service: string | null;
  hardwareIds: string[];
  vid: string | null;
  pid: string | null;
  portName: string | null;
  portNameSource: 'device_parameters' | 'win32_serial_port' | null;
  registryPortName: string | null;
  serialPortName: string | null;
  driver: { provider: string | null; version: string | null; date: string | null; infName: string | null; isSigned: boolean | null };
}
export interface UsbSerialInventoryResult {
  supported: boolean;
  status: 'ok' | 'partial' | 'error' | 'unsupported';
  platform: string;
  observedAt: string;
  devices: WindowsUsbSerialDevice[];
  errors: UsbSerialProbeError[];
  limitations: string[];
}

// Fixed OS metadata queries only. No caller text, serial handles, driver installation,
// device-property changes, serial commands, or firmware/network probing enter this script.
const USB_SERIAL_INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$present = @(); $entities = @(); $serial = @(); $drivers = @(); $portNames = @(); $errors = @(); $presentOk = $false
try {
  $present = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object {
    $_.Class -eq 'Ports' -or ($_.InstanceId -like 'USB\*' -and ([string]::IsNullOrWhiteSpace($_.Class) -or [int]$_.Problem -ne 0 -or $_.Status -eq 'Error'))
  } | Select-Object InstanceId,FriendlyName,Class,Status,Problem)
  $presentOk = $true
} catch { $errors += [pscustomobject]@{ Code='present_pnp_query_failed'; Message=$_.Exception.Message } }
$wanted = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($device in $present) { [void]$wanted.Add($device.InstanceId) }
if ($wanted.Count -gt 0) {
  try {
    $entities = @(Get-CimInstance -ClassName Win32_PnPEntity | Where-Object { $wanted.Contains($_.PNPDeviceID) } | Select-Object PNPDeviceID,Name,Manufacturer,PNPClass,Status,ConfigManagerErrorCode,HardwareID,Service)
  } catch { $errors += [pscustomobject]@{ Code='pnp_metadata_query_failed'; Message=$_.Exception.Message } }
  try {
    $serial = @(Get-CimInstance -ClassName Win32_SerialPort | Where-Object { $wanted.Contains($_.PNPDeviceID) } | Select-Object PNPDeviceID,DeviceID)
  } catch { $errors += [pscustomobject]@{ Code='serial_metadata_query_failed'; Message=$_.Exception.Message } }
  try {
    $drivers = @(Get-CimInstance -ClassName Win32_PnPSignedDriver | Where-Object { $wanted.Contains($_.DeviceID) } | Select-Object DeviceID,DriverProviderName,DriverVersion,InfName,IsSigned,@{Name='DriverDate';Expression={if($_.DriverDate){$_.DriverDate.ToUniversalTime().ToString('o')}else{$null}}})
  } catch { $errors += [pscustomobject]@{ Code='driver_metadata_query_failed'; Message=$_.Exception.Message } }
  foreach ($device in $present) {
    $portName = $null; $key = $null
    try {
      $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(('SYSTEM\CurrentControlSet\Enum\' + $device.InstanceId + '\Device Parameters'), $false)
      if ($null -ne $key) { $portName = $key.GetValue('PortName', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    } catch { $errors += [pscustomobject]@{ Code='port_name_query_failed'; InstanceId=$device.InstanceId; Message=$_.Exception.Message } }
    finally { if ($null -ne $key) { $key.Dispose() } }
    $portNames += [pscustomobject]@{ InstanceId=$device.InstanceId; PortName=$portName }
  }
}
[pscustomobject]@{ PresentOnlySucceeded=$presentOk; PresentDevices=$present; PnpEntities=$entities; SerialPorts=$serial; Drivers=$drivers; PortNames=$portNames; Errors=$errors } | ConvertTo-Json -Depth 6 -Compress
`;

const defaultRunner: UsbSerialExecRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr }));
    else resolve({ stdout, stderr });
  });
});
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
function rows(value: unknown): Row[] {
  if (value === null || value === undefined) return [];
  const result = Array.isArray(value) ? value : [value];
  if (!result.every(record)) throw new Error('Expected USB metadata objects');
  return result;
}
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const code = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const message = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, 500);
function byInstance(value: unknown, field: string): Map<string, Row> {
  return new Map(rows(value).map(row => {
    const id = text(row[field]);
    if (!id) throw new Error('Missing PnP instance identity');
    return [id.toUpperCase(), row];
  }));
}
function hardwareIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.every(item => typeof item === 'string')) throw new Error('Invalid hardware IDs');
  return values;
}
function processError(error: unknown): UsbSerialProbeError {
  const value = record(error) ? error : {};
  if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { code: 'probe_output_limit', message: 'Windows USB/serial query exceeded the output limit.' };
  if (value.killed === true || value.code === 'ETIMEDOUT') return { code: 'probe_timeout', message: 'Windows USB/serial query timed out.' };
  return { code: 'probe_failed', message: message(value.stderr, 'Windows USB/serial query failed.') };
}

/** Current Ports-class devices plus unconfigured USB candidates; no port is opened. */
export async function readUsbSerialInventory(options: UsbSerialInventoryOptions = {}): Promise<UsbSerialInventoryResult> {
  const platform = options.platform ?? process.platform;
  const result: UsbSerialInventoryResult = {
    supported: platform === 'win32', status: platform === 'win32' ? 'error' : 'unsupported',
    platform, observedAt: new Date().toISOString(), devices: [], errors: [], limitations: [USB_SERIAL_OBSERVATION_LIMIT],
  };
  if (!result.supported) return result;
  let output: { stdout: string; stderr?: string };
  try {
    output = await (options.execRunner ?? defaultRunner)(WINDOWS_USB_SERIAL_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', USB_SERIAL_INVENTORY_SCRIPT],
      { encoding: 'utf8', timeout: USB_SERIAL_PROBE_TIMEOUT_MS, maxBuffer: USB_SERIAL_PROBE_MAX_BYTES, windowsHide: true });
  } catch (error) { result.errors.push(processError(error)); return result; }
  if (typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout, 'utf8') > USB_SERIAL_PROBE_MAX_BYTES
    || (typeof output.stderr === 'string' && Buffer.byteLength(output.stderr, 'utf8') > USB_SERIAL_PROBE_MAX_BYTES)) {
    result.errors.push({ code: 'probe_output_limit', message: 'Windows USB/serial query exceeded the output limit.' }); return result;
  }
  try {
    const raw: unknown = JSON.parse(output.stdout.replace(/^\uFEFF/, ''));
    if (!record(raw) || typeof raw.PresentOnlySucceeded !== 'boolean'
      || !['PresentDevices', 'PnpEntities', 'SerialPorts', 'Drivers', 'PortNames', 'Errors'].every(key => key in raw)) throw new Error('Missing USB metadata sections');
    result.errors = rows(raw.Errors).map(row => ({ code: message(row.Code, 'query_failed'), message: message(row.Message, 'USB metadata unavailable.'),
      ...(text(row.InstanceId) ? { instanceId: text(row.InstanceId)! } : {}) }));
    if (!raw.PresentOnlySucceeded) {
      if (!result.errors.some(row => row.code === 'present_pnp_query_failed')) result.errors.push({ code: 'present_pnp_query_failed', message: 'Current device presence could not be established.' });
      return result;
    }
    const entities = byInstance(raw.PnpEntities, 'PNPDeviceID');
    const serialPorts = byInstance(raw.SerialPorts, 'PNPDeviceID');
    const drivers = byInstance(raw.Drivers, 'DeviceID');
    const portNames = byInstance(raw.PortNames, 'InstanceId');
    const devices = new Map<string, WindowsUsbSerialDevice>();
    for (const present of rows(raw.PresentDevices)) {
      const instanceId = text(present.InstanceId);
      if (!instanceId) throw new Error('Present device has no PnP identity');
      const key = instanceId.toUpperCase(), entity = entities.get(key) ?? {}, serial = serialPorts.get(key) ?? {}, driver = drivers.get(key) ?? {};
      const className = text(present.Class), status = text(present.Status), problemCode = code(present.Problem);
      const isUsb = /^USB\\/i.test(instanceId), isPortsClass = className?.toLowerCase() === 'ports';
      if (!isPortsClass && !(isUsb && (!className || (problemCode !== null && problemCode !== 0) || status?.toLowerCase() === 'error'))) continue;
      const ids = hardwareIds(entity.HardwareID), usbId = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(instanceId);
      const registryPortName = text(portNames.get(key)?.PortName), serialPortName = text(serial.DeviceID);
      devices.set(key, {
        instanceId, category: isPortsClass ? 'ports_class' : 'unconfigured_usb', instanceEnumerator: instanceId.split('\\')[0],
        name: text(present.FriendlyName) ?? text(entity.Name), className,
        manufacturer: text(entity.Manufacturer), status, problemCode,
        cimStatus: text(entity.Status), configManagerErrorCode: code(entity.ConfigManagerErrorCode), service: text(entity.Service),
        hardwareIds: ids, vid: usbId?.[1].toUpperCase() ?? null, pid: usbId?.[2].toUpperCase() ?? null,
        portName: registryPortName ?? serialPortName, portNameSource: registryPortName ? 'device_parameters' : serialPortName ? 'win32_serial_port' : null,
        registryPortName, serialPortName,
        driver: { provider: text(driver.DriverProviderName), version: text(driver.DriverVersion), date: text(driver.DriverDate), infName: text(driver.InfName), isSigned: typeof driver.IsSigned === 'boolean' ? driver.IsSigned : null },
      });
    }
    result.devices = [...devices.values()];
    if (output.stderr?.trim()) result.errors.push({ code: 'probe_warning', message: message(output.stderr, 'Windows USB/serial query reported a warning.') });
    result.status = result.errors.length ? 'partial' : 'ok';
  } catch {
    result.devices = []; result.status = 'error';
    result.errors = [{ code: 'invalid_probe_output', message: 'Windows USB/serial query returned invalid metadata.' }];
  }
  return result;
}
