import { describe, expect, it, vi } from 'vitest';
import { sanitizeToolRecordsForPersistence } from '../server/cognition/user_output_protection';
import { recordsToTaskReceipts, normalizeConversationTaskReceipt, taskReceiptsToRecords } from '../server/cognition/task_execution_ledger';
import { formatToolRecordForModel } from '../server/llm/tool_loop/receipts';
import { toolRecordTerminalPayload } from '../server/tools/receipt_payload';
import { readPrinterInventory, readPrinterStatus, type PrinterExecRunner } from '../server/devices/printer_inventory';

const physicalId = 'a1111111-2222-4333-8444-555555555555';
const queueNode = 'SWD\\PRINTENUM\\{a2222222-3333-4444-8555-666666666666}';
const printNode = 'SWD\\PRINTENUM\\WSD-logical-port';
const parentNode = 'SWD\\IPP\\' + physicalId;
function fixture() { return {
  CimPrinters: [{ Name: 'Fixture WSD queue', PortName: 'WSD-logical-port', DriverName: 'Generic compatibility driver', PNPDeviceID: null as string | null }],
  Queues: [{ Name: 'Fixture WSD queue', PrinterStatus: 'Normal', JobCount: 0, Jobs: [] }],
  Ports: [{ Name: 'WSD-logical-port', HostAddress: null, DeviceURL: null }],
  PnpDevices: [
    { InstanceId: queueNode, Class: 'PrintQueue', FriendlyName: 'Fixture WSD queue', ContainerId: physicalId, ParentInstanceId: printNode, IsPresent: true },
    { InstanceId: printNode, Class: 'Printer', FriendlyName: 'Another OS label', ContainerId: physicalId, ParentInstanceId: parentNode, IsPresent: true },
    { InstanceId: parentNode, Class: 'SoftwareDevice', FriendlyName: 'Protocol model label', ContainerId: physicalId, AssociationEndpointId: 'IPP#' + physicalId, AssociationEndpointAddress: 'http://10.42.0.12:631/ipp/print', IsPresent: true },
  ], PnpErrors: [], Errors: [],
}; }
const runner = (value: unknown) => vi.fn<PrinterExecRunner>().mockResolvedValue({ stdout: JSON.stringify(value) });

describe('source-bound Windows printer identity observations', () => {
  it('retains the exact queue-parent-container chain and labels endpoint values as cached OS metadata', async () => {
    const execRunner = runner(fixture());
    const result = await readPrinterInventory({ platform: 'win32', execRunner });
    expect(result.status).toBe('ok');
    expect(result.printers[0].pnpIdentity).toEqual({ status: 'associated', matchSource: 'Get-PnpDevice.PrintQueue.FriendlyName', instanceIds: [queueNode] });
    expect(result.deviceIdentity).toMatchObject({ source: 'windows_pnp_cached_metadata', scope: 'windows_device_registration', networkReachability: 'not_tested', status: 'observed', cacheUpdatedAt: null,
      nodes: [{ instanceId: queueNode, parentInstanceId: printNode }, { instanceId: printNode, parentInstanceId: parentNode },
        { instanceId: parentNode, containerId: physicalId, associationEndpointId: 'IPP#' + physicalId, cachedAssociationEndpointAddress: 'http://10.42.0.12:631/ipp/print' }] });
    expect(result.deviceIdentity?.observedAt).toBe(result.observedAt);
    expect(result.deviceIdentity!.nodes.every(node => !Object.hasOwn(node, 'associationEndpointAddress'))).toBe(true);
    const body = JSON.stringify(result);
    const persisted = sanitizeToolRecordsForPersistence([{ id: 'source-scope-call', name: 'printer_list', arguments: {}, result: body,
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'OS inventory returned.' } }])![0];
    const receipt = recordsToTaskReceipts([persisted])[0];
    const restored = taskReceiptsToRecords([normalizeConversationTaskReceipt(JSON.parse(JSON.stringify(receipt)))!])[0];
    expect(toolRecordTerminalPayload(restored)).toEqual(result);
    expect(JSON.parse(restored.result!).deviceIdentity).toEqual(result.deviceIdentity);
    expect(formatToolRecordForModel(restored)).toContain('\"networkReachability\":\"not_tested\"');
    expect(formatToolRecordForModel(restored)).toContain('cachedAssociationEndpointAddress');
    expect(receipt.receipt).toBeUndefined();
    expect(result.ports[0].hostAddress).toBeNull();
    expect(result).not.toHaveProperty('physicalOnline');
    const script = execRunner.mock.calls[0][1][4];
    expect(script).toContain('Get-PnpDevice -Class Printer,PrintQueue -PresentOnly');
    expect(script).toContain('Get-PnpDeviceProperty -InstanceId $id');
    expect(script).toContain('DEVPKEY_Device_Parent');
    expect(script).not.toMatch(/Set-|Remove-|Add-Printer|Out-Printer|Start-Process/);
  });

  it('keeps two same-driver queues and their distinct identity sources separate', async () => {
    const value = fixture();
    value.CimPrinters.push({ Name: 'Second queue', PortName: 'USB009', DriverName: 'Generic compatibility driver', PNPDeviceID: 'USBPRINT\\fixture-device' });
    value.Queues.push({ Name: 'Second queue', PrinterStatus: 'Normal', JobCount: 0, Jobs: [] });
    value.PnpDevices.push({ InstanceId: 'USBPRINT\\fixture-device', Class: 'Printer', FriendlyName: 'Different label', ContainerId: 'b1111111-2222-4333-8444-555555555555', ParentInstanceId: '', IsPresent: false });
    const result = await readPrinterInventory({ platform: 'win32', execRunner: runner(value) });
    expect(result.printers[0].pnpIdentity?.instanceIds).toEqual([queueNode]);
    expect(result.printers[1].pnpIdentity).toEqual({ status: 'associated', matchSource: 'Win32_Printer.PNPDeviceID', instanceIds: ['USBPRINT\\fixture-device'] });
    expect(result.deviceIdentity?.nodes.at(-1)).toMatchObject({ isPresent: false, containerId: 'b1111111-2222-4333-8444-555555555555' });
  });

  it('retains ambiguous exact queue matches without selecting a physical device by driver or name', async () => {
    const value = fixture();
    value.PnpDevices.push({ ...value.PnpDevices[0], InstanceId: 'SWD\\PRINTENUM\\second-queue-node' });
    const result = await readPrinterInventory({ platform: 'win32', execRunner: runner(value) });
    expect(result.printers[0].pnpIdentity).toMatchObject({ status: 'ambiguous', instanceIds: [queueNode, 'SWD\\PRINTENUM\\second-queue-node'] });
  });

  it('preserves spooler data and actual identity-query failure rather than converting nulls to a negative identity', async () => {
    const value: any = fixture(); value.PnpDevices = []; value.PnpErrors = [{ Code: 'pnp_query_failed', Message: 'PnP access denied' }];
    const result = await readPrinterStatus('Fixture WSD queue', { platform: 'win32', execRunner: runner(value) });
    expect(result).toMatchObject({ status: 'ok', printer: { name: 'Fixture WSD queue', pnpIdentity: { status: 'unavailable', instanceIds: [] } },
      deviceIdentity: { status: 'unavailable', errors: [{ code: 'pnp_query_failed', message: 'PnP access denied' }] } });
    expect(result.ports[0]).toMatchObject({ hostAddress: null, deviceUrl: null });
    expect(JSON.stringify(result)).not.toMatch(/different_device|not_same_device|unbound_ip/);
  });
});
