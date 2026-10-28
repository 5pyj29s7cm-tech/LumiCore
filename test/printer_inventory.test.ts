import { describe, expect, it, vi } from 'vitest';
import {
  PRINTER_PROBE_MAX_BYTES,
  PRINTER_PROBE_TIMEOUT_MS,
  WINDOWS_PRINTER_POWERSHELL,
  readPrinterInventory,
  readPrinterStatus,
  type PrinterExecRunner,
} from '../server/devices/printer_inventory';

function fixture() {
  return {
    CimPrinters: [{
      Name: 'Lab USB queue', Default: false, WorkOffline: true, PrinterStatus: 2,
      DetectedErrorState: 0, PortName: 'USB001', DriverName: 'Test driver',
      Local: true, Network: false, Shared: false,
    }, {
      Name: 'Lab WSD queue', Default: true, WorkOffline: false, PrinterStatus: 3,
      PortName: 'WSD-sample', Network: false,
    }],
    Queues: [{
      Name: 'Lab USB queue', PrinterStatus: 'Normal', PortName: 'USB001',
      Type: 'Local', Shared: false, JobCount: 1,
      Jobs: [{ ID: 4, JobStatus: 0, Size: 261085, TotalPages: 1, PagesPrinted: 0,
        DocumentName: 'PRIVATE DOCUMENT', UserName: 'PRIVATE USER' }], JobsError: null,
    }, {
      Name: 'Lab WSD queue', PrinterStatus: 'Normal', JobCount: 0, Jobs: [], JobsError: null,
    }],
    Ports: [{ Name: 'USB001', Description: 'Local Port', PortMonitor: 'USB Monitor' }, {
      Name: 'WSD-sample', Description: 'WSD Port', PortMonitor: 'WSD Port Monitor',
      PrinterHostAddress: null, DeviceURL: null, DeviceURI: null,
      HostAddress: null, PortNumber: null, Protocol: null,
    }],
    Errors: [],
  };
}
function runnerFor(value: unknown) {
  return vi.fn<PrinterExecRunner>().mockResolvedValue({ stdout: JSON.stringify(value), stderr: '' });
}

describe('Windows readonly printer inventory', () => {
  it('uses the fixed, hidden, bounded PowerShell query and preserves contradictory queue observations', async () => {
    const execRunner = runnerFor(fixture());
    const result = await readPrinterInventory({ platform: 'win32', execRunner });
    expect(result.status).toBe('ok');
    expect(result.printers).toHaveLength(2);
    expect(result.printers[0]).toMatchObject({
      name: 'Lab USB queue', isDefault: false, workOffline: true, cimPrinterStatus: 2,
      queueStatus: 'Normal', detectedErrorState: 0, portName: 'USB001', driverName: 'Test driver',
      isLocal: true, isNetwork: false, isShared: false, queueType: 'Local', jobCount: 1, jobsError: null,
      jobs: [{ id: 4, status: 0, sizeBytes: 261085, totalPages: 1, pagesPrinted: 0 }],
    });
    expect(result.printers[1]).toMatchObject({ name: 'Lab WSD queue', isDefault: true, isNetwork: false });
    expect(result.ports[1]).toMatchObject({ name: 'WSD-sample', monitor: 'WSD Port Monitor', deviceUrl: null, printerHostAddress: null });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|physicalOnline|"online"/);
    const [executable, args, options] = execRunner.mock.calls[0];
    expect(executable).toBe(WINDOWS_PRINTER_POWERSHELL);
    expect(options).toEqual({ encoding: 'utf8', timeout: PRINTER_PROBE_TIMEOUT_MS, maxBuffer: PRINTER_PROBE_MAX_BYTES, windowsHide: true });
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(args[4]).toContain('Get-PrintJob -PrinterName $q.Name');
    expect(args[4]).toContain('Select-Object ID,JobStatus,Size,TotalPages,PagesPrinted');
    expect(args[4]).not.toMatch(/Document|UserName|Remove-|Set-|Add-|Out-Printer|Start-Process/);
    expect(execRunner).toHaveBeenCalledTimes(1);
  });

  it('handles PowerShell singleton objects and retains only the declared metadata fields', async () => {
    const value = fixture();
    const raw = {
      CimPrinters: value.CimPrinters[0],
      Queues: { ...value.Queues[0], Jobs: value.Queues[0].Jobs[0] },
      Ports: { ...value.Ports[0], DeviceURL: 'ipps://user:secret@192.0.2.10:631/ipp/print?token=secret#secret', VendorSecret: 'PRIVATE' },
    };
    const result = await readPrinterInventory({ platform: 'win32', execRunner: runnerFor(raw) });
    expect(result.status).toBe('ok');
    expect(result.printers).toHaveLength(1);
    expect(result.printers[0].jobs).toHaveLength(1);
    expect(result.ports[0].deviceUrl).toBe('ipps://192.0.2.10:631/ipp/print');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|secret/);
  });

  it('reports partial queue/job failures without treating unknown job count as zero or dropping CIM queues', async () => {
    const value = fixture();
    const result = await readPrinterInventory({ platform: 'win32', execRunner: runnerFor({
      CimPrinters: value.CimPrinters,
      Queues: { ...value.Queues[0], JobCount: 0, JobsError: 'Print job access denied' }, Ports: [],
      Errors: { Code: 'queue_query_failed', Message: 'Some queue metadata unavailable' },
    }) });
    expect(result.status).toBe('partial');
    expect(result.errors).toEqual([
      { code: 'queue_query_failed', message: 'Some queue metadata unavailable' },
      { code: 'jobs_query_failed', printerName: 'Lab USB queue', message: 'Print job access denied' },
    ]);
    expect(result.printers[0]).toMatchObject({ jobCount: null, jobs: [], jobsError: 'Print job access denied' });
    expect(result.printers[1]).toMatchObject({ name: 'Lab WSD queue', queueStatus: null, jobCount: null });
  });

  it('returns unsupported without executing an OS command on another platform', async () => {
    const execRunner = runnerFor(fixture());
    const result = await readPrinterInventory({ platform: 'darwin', execRunner });
    expect(result).toMatchObject({ supported: false, status: 'unsupported', platform: 'darwin', printers: [], ports: [] });
    expect(execRunner).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 1, stderr: 'Access to PrintManagement denied' }, 'probe_failed', 'Access to PrintManagement denied'],
    [{ killed: true, signal: 'SIGTERM' }, 'probe_timeout', 'timed out'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'probe_output_limit', 'output limit'],
  ])('returns a structured process failure and never exposes partial stdout', async (failure, code, message) => {
    const execRunner = vi.fn<PrinterExecRunner>().mockRejectedValue({ ...failure, stdout: JSON.stringify(fixture()) });
    const result = await readPrinterInventory({ platform: 'win32', execRunner });
    expect(result).toMatchObject({ supported: true, status: 'error', printers: [], ports: [], errors: [{ code }] });
    expect(result.errors[0].message).toContain(message);
  });

  it.each(['not json', JSON.stringify({ CimPrinters: [], Queues: [] }), JSON.stringify({ CimPrinters: [3], Queues: [], Ports: [] })])(
    'rejects malformed metadata instead of claiming an empty successful inventory', async stdout => {
      const result = await readPrinterInventory({ platform: 'win32', execRunner: vi.fn<PrinterExecRunner>().mockResolvedValue({ stdout }) });
      expect(result.status).toBe('error');
      expect(result.errors[0].code).toBe('invalid_probe_output');
    },
  );

  it('bounds even an injected runner output, including multibyte text', async () => {
    const result = await readPrinterInventory({
      platform: 'win32', execRunner: vi.fn<PrinterExecRunner>().mockResolvedValue({ stdout: '中'.repeat(Math.ceil(PRINTER_PROBE_MAX_BYTES / 3)) }),
    });
    expect(result.errors[0].code).toBe('probe_output_limit');
    expect(result.printers).toEqual([]);
  });

  it('looks up only the installed queue name without passing caller text to PowerShell', async () => {
    const execRunner = runnerFor(fixture());
    const existing = await readPrinterStatus('lab usb queue', { platform: 'win32', execRunner });
    expect(existing).toMatchObject({ status: 'ok', printer: { name: 'Lab USB queue', workOffline: true, queueStatus: 'Normal' } });
    const missing = await readPrinterStatus('unknown\x27; Remove-Printer -Name anything; #', { platform: 'win32', execRunner });
    expect(missing).toMatchObject({ status: 'error', printer: null, errors: [{ code: 'printer_not_found' }] });
    expect(execRunner.mock.calls[1][1]).toEqual(execRunner.mock.calls[0][1]);
    const invalid = await readPrinterStatus('bad\nname', { platform: 'win32', execRunner });
    expect(invalid.errors[0].code).toBe('invalid_printer_name');
    expect(execRunner).toHaveBeenCalledTimes(2);
  });
});
