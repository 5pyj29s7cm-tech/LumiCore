import { describe, expect, it, vi } from 'vitest';
import {
  readUsbSerialInventory, USB_SERIAL_PROBE_MAX_BYTES, USB_SERIAL_PROBE_TIMEOUT_MS, WINDOWS_USB_SERIAL_POWERSHELL,
  type UsbSerialExecRunner,
} from '../server/devices/usb_serial_inventory';

const bridge = 'USB\\VID_1234&PID_ABCD\\port-a';
const unconfigured = 'USB\\VID_4321&PID_DCBA\\port-b';
const motherboard = 'ACPI\\PNP0501\\0';
function fixture() {
  return {
    PresentOnlySucceeded: true,
    PresentDevices: [
      { InstanceId: bridge, FriendlyName: 'Lab USB serial (COM7)', Class: 'Ports', Status: 'OK', Problem: 0 },
      { InstanceId: unconfigured, FriendlyName: 'USB device without driver', Class: null, Status: 'Error', Problem: 28 },
      { InstanceId: motherboard, FriendlyName: 'Communications port (COM1)', Class: 'Ports', Status: 'OK', Problem: 0 },
    ],
    PnpEntities: [
      { PNPDeviceID: bridge, Name: 'USB serial device', Manufacturer: 'Example bridge maker', Status: 'OK', ConfigManagerErrorCode: 0, Service: 'ExampleSerial', HardwareID: ['USB\\VID_1234&PID_ABCD&REV_0100', 'USB\\VID_1234&PID_ABCD'] },
      { PNPDeviceID: unconfigured, Status: 'Error', ConfigManagerErrorCode: 28, Service: null, HardwareID: ['USB\\VID_4321&PID_DCBA'] },
      { PNPDeviceID: motherboard, Status: 'OK', ConfigManagerErrorCode: 0, Service: 'Serial', HardwareID: ['ACPI\\PNP0501'] },
      { PNPDeviceID: 'USB\\VID_9999&PID_9999\\removed', Status: 'OK', ConfigManagerErrorCode: 0, HardwareID: [] },
    ],
    // A valid USB driver need not appear in Win32_SerialPort.
    SerialPorts: [{ PNPDeviceID: motherboard, DeviceID: 'COM1' }],
    PortNames: [{ InstanceId: bridge, PortName: 'COM7' }, { InstanceId: unconfigured, PortName: null }],
    Drivers: [{ DeviceID: bridge.toLowerCase(), DriverProviderName: 'Example provider', DriverVersion: '2.1.0', DriverDate: '2026-01-02T00:00:00Z', InfName: 'oem42.inf', IsSigned: true }],
    Errors: [],
  };
}
const runnerFor = (value: unknown) => vi.fn<UsbSerialExecRunner>().mockResolvedValue({ stdout: JSON.stringify(value), stderr: '' });

describe('Windows current USB and serial inventory', () => {
  it('maps a present USB port via exact-instance Device Parameters when the serial CIM class omits it', async () => {
    const execRunner = runnerFor(fixture());
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner });
    expect(result.status).toBe('ok');
    expect(result.devices).toHaveLength(3);
    expect(result.devices[0]).toMatchObject({ instanceId: bridge, category: 'ports_class', instanceEnumerator: 'USB', vid: '1234', pid: 'ABCD',
      portName: 'COM7', portNameSource: 'device_parameters', registryPortName: 'COM7', serialPortName: null, problemCode: 0, configManagerErrorCode: 0,
      driver: { provider: 'Example provider', version: '2.1.0', infName: 'oem42.inf', isSigned: true } });
    expect(result.devices[1]).toMatchObject({ instanceId: unconfigured, category: 'unconfigured_usb', portName: null, problemCode: 28, configManagerErrorCode: 28,
      driver: { provider: null, version: null, isSigned: null } });
    expect(result.devices[2]).toMatchObject({ instanceId: motherboard, instanceEnumerator: 'ACPI', portName: 'COM1', portNameSource: 'win32_serial_port', vid: null, pid: null });
    expect(result.devices.map(item => item.instanceId)).not.toContain('USB\\VID_9999&PID_9999\\removed');
    expect(result.limitations.join(' ')).toMatch(/does not.*MCP/);
    expect(JSON.stringify(result.devices)).not.toMatch(/firmware|mcp|paired|connected/i);
    const [executable, args, options] = execRunner.mock.calls[0];
    expect(executable).toBe(WINDOWS_USB_SERIAL_POWERSHELL);
    expect(options).toEqual({ encoding: 'utf8', timeout: USB_SERIAL_PROBE_TIMEOUT_MS, maxBuffer: USB_SERIAL_PROBE_MAX_BYTES, windowsHide: true });
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(args[4]).toContain('Get-PnpDevice -PresentOnly');
    expect(args[4]).toContain(".GetValue('PortName'");
    expect(args[4]).toContain("'\\Device Parameters'), $false)");
    expect(args[4]).not.toMatch(/System\.IO\.Ports|SerialPort::|CreateFile|Set-Pnp|Install-|pnputil|Start-Process|Invoke-Expression|IEX\b/);
    expect(execRunner).toHaveBeenCalledTimes(1);
  });

  it('preserves contradictory source problem and COM values, false driver signatures, and zero codes', async () => {
    const raw = fixture();
    raw.PnpEntities[0].ConfigManagerErrorCode = 28;
    raw.PnpEntities[0].Status = 'Error';
    raw.SerialPorts.push({ PNPDeviceID: bridge.toLowerCase(), DeviceID: 'COM9' });
    raw.Drivers[0].IsSigned = false;
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: runnerFor(raw) });
    expect(result.devices[0]).toMatchObject({ status: 'OK', problemCode: 0, cimStatus: 'Error', configManagerErrorCode: 28,
      registryPortName: 'COM7', serialPortName: 'COM9', portName: 'COM7', driver: { isSigned: false } });
  });

  it('keeps only present Ports-class or unconfigured USB rows and never infers serial roles from names', async () => {
    const raw = fixture();
    raw.PresentDevices.push({ InstanceId: 'USB\\VID_1111&PID_2222\\healthy', FriendlyName: 'Serial MCP firmware ready', Class: 'HIDClass', Status: 'OK', Problem: 0 });
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: runnerFor(raw) });
    expect(result.devices).toHaveLength(3);
    expect(result.devices.some(item => item.instanceId.includes('healthy'))).toBe(false);
  });

  it('handles singleton records without returning undeclared device or driver fields', async () => {
    const raw = fixture();
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: runnerFor({ ...raw,
      PresentDevices: raw.PresentDevices[0], PnpEntities: { ...raw.PnpEntities[0], FirmwareToken: 'PRIVATE' },
      PortNames: raw.PortNames[0], SerialPorts: null, Drivers: { ...raw.Drivers[0], DriverSecret: 'PRIVATE' },
    }) });
    expect(result.status).toBe('ok'); expect(result.devices).toHaveLength(1);
    expect(result.devices[0].hardwareIds).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('reports missing secondary metadata as partial while retaining present devices and per-device errors', async () => {
    const raw = fixture();
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: runnerFor({ ...raw, Drivers: [],
      Errors: [{ Code: 'driver_metadata_query_failed', Message: 'Driver provider unavailable' },
        { Code: 'port_name_query_failed', InstanceId: bridge, Message: 'Registry read denied' }], PortNames: [],
    }) });
    expect(result.status).toBe('partial'); expect(result.devices).toHaveLength(3);
    expect(result.devices[0]).toMatchObject({ portName: null, driver: { version: null } });
    expect(result.errors[1]).toMatchObject({ code: 'port_name_query_failed', instanceId: bridge });
  });

  it('does not claim current presence from a stale CIM snapshot when PresentOnly fails', async () => {
    const raw = fixture();
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: runnerFor({ ...raw, PresentOnlySucceeded: false, Errors: [] }) });
    expect(result).toMatchObject({ status: 'error', devices: [], errors: [{ code: 'present_pnp_query_failed' }] });
  });

  it('returns a successful empty snapshot only after successful present-device enumeration', async () => {
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: runnerFor({ PresentOnlySucceeded: true, PresentDevices: [], PnpEntities: [], SerialPorts: [], Drivers: [], PortNames: [], Errors: [] }) });
    expect(result).toMatchObject({ status: 'ok', devices: [], errors: [] });
  });

  it('does not run a Windows probe on another platform', async () => {
    const execRunner = runnerFor(fixture());
    expect(await readUsbSerialInventory({ platform: 'linux', execRunner })).toMatchObject({ supported: false, status: 'unsupported', devices: [] });
    expect(execRunner).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'partial' }, 'probe_output_limit'],
    [{ killed: true, stdout: 'partial' }, 'probe_timeout'],
    [{ code: 1, stderr: 'Access denied', stdout: 'partial' }, 'probe_failed'],
  ])('preserves process failure and does not parse partial stdout', async (failure, errorCode) => {
    const execRunner = vi.fn<UsbSerialExecRunner>().mockRejectedValue(failure);
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner });
    expect(result).toMatchObject({ status: 'error', devices: [], errors: [{ code: errorCode }] });
  });

  it.each(['not json', JSON.stringify({ PresentDevices: [] }), JSON.stringify({ ...fixture(), PresentDevices: [3] })])('rejects malformed metadata instead of an empty success', async stdout => {
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: vi.fn<UsbSerialExecRunner>().mockResolvedValue({ stdout }) });
    expect(result).toMatchObject({ status: 'error', devices: [], errors: [{ code: 'invalid_probe_output' }] });
  });

  it('enforces the process output limit on even an injected multibyte response', async () => {
    const result = await readUsbSerialInventory({ platform: 'win32', execRunner: vi.fn<UsbSerialExecRunner>().mockResolvedValue({ stdout: '中'.repeat(Math.ceil(USB_SERIAL_PROBE_MAX_BYTES / 3)) }) });
    expect(result).toMatchObject({ status: 'error', devices: [], errors: [{ code: 'probe_output_limit' }] });
  });
});
