import { describe, expect, it, vi } from 'vitest';
import { registerLocalDeviceTools, type LocalDeviceAdapters } from '../server/tools/definitions/local_device_tools';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';
import { getAdapterRetryPolicy } from '../server/tools/adapter_resilience';
import { verifyCapabilityReceipt } from '../server/tools/capability_verification';
import { readPrinterJobStatus } from '../server/devices/printer_jobs';

const native: ToolContext = { userId: 'local-device-test', authenticated: true, localExecution: true, executionBoundary: 'trusted_local' };
function fixture() {
  const adapters = {
    discover: vi.fn(async () => ({ ok: true, status: 'completed', startedAt: 'test-start', finishedAt: 'test-end', interfaces: [], candidates: [], errors: [], limitations: [], truncated: false, timeoutMs: 500 })),
    printers: vi.fn(async () => ({ supported: true, status: 'ok', platform: 'win32', observedAt: 'test-time', printers: [], ports: [], errors: [] })),
    printerStatus: vi.fn(async () => ({ supported: true, status: 'ok', platform: 'win32', observedAt: 'test-time', printer: { name: 'Test queue', workOffline: true, queueStatus: 'Normal' }, ports: [], errors: [] })),
    networkPrinterStatus: vi.fn(async () => ({ ok: false, status: 'unavailable', observedAt: 'test-time', error: 'Timed out' })),
    submitTestPage: vi.fn(async () => ({ ok: true, status: 'submitted', observedAt: 'test-time', printerName: 'Test queue', jobId: 73, physicalCompletionVerified: false, submission: { endDocSucceeded: true } })),
    jobStatus: vi.fn(async () => ({ ok: true, status: 'not_observed', observedAt: 'test-time', printerName: 'Test queue', jobId: 73, job: null, physicalCompletionVerified: false })),
    usbSerial: vi.fn(async () => ({ supported: true, status: 'ok', platform: 'win32', observedAt: 'test-time', devices: [], errors: [], limitations: ['A USB bridge does not prove an MCP connection.'] })),
  };
  const registry = new ToolRegistry();
  registerLocalDeviceTools(registry, adapters as unknown as LocalDeviceAdapters);
  return { adapters, registry, tools: registry.list() };
}

describe('Lumi control-center device tools', () => {
  it.each([
    undefined,
    { ...native, authenticated: false }, { ...native, userId: '' },
    { ...native, localExecution: false }, { ...native, localExecution: undefined },
    { ...native, executionBoundary: 'remote_restricted' }, { ...native, executionBoundary: undefined },
  ])('rejects missing/native-forged admission before any hardware reads: %j', async context => {
    const { adapters, tools } = fixture();
    for (const tool of tools) {
      await expect(tool.handler({ userId: native.userId, authenticated: true, localExecution: true, executionBoundary: 'trusted_local' }, context as ToolContext)).rejects.toThrow(/native desktop session/);
    }
    for (const adapter of Object.values(adapters)) expect(adapter).not.toHaveBeenCalled();
  });
  it('returns empty discovery as an observation, not absence or control proof', async () => {
    const { tools } = fixture();
    const result = JSON.parse(await tools.find(x => x.name === 'lan_discover_devices')!.handler({ timeoutMs: 500 }, native));
    expect(result).toMatchObject({ ok: true, status: 'completed', executionHost: 'lumi_backend_host', candidates: [] });
    expect(result).not.toHaveProperty('controlled'); expect(result).not.toHaveProperty('paired');
  });
  it('keeps spooler raw flags distinct from the network query failure', async () => {
    const { tools } = fixture();
    const queue = JSON.parse(await tools.find(x => x.name === 'printer_status')!.handler({ printerName: 'Test queue' }, native));
    expect(queue).toMatchObject({ source: 'windows_spooler', printer: { workOffline: true, queueStatus: 'Normal' } });
    const net = JSON.parse(await tools.find(x => x.name === 'printer_network_status')!.handler({ address: '10.42.0.20', port: 631, resourcePath: '/ipp/print' }, native));
    expect(net).toMatchObject({ ok: false, status: 'unavailable', source: 'ipp_get_printer_attributes' });
    expect(net).not.toHaveProperty('printer');
  });
  it('preserves source and metadata contracts without granting remote access', async () => {
    const { registry, adapters } = fixture();
    const manifest = registry.getCapabilityManifest();
    expect(manifest).toHaveLength(7);
    for (const entry of manifest.filter(item => item.toolName !== 'printer_print_test_page')) {
      expect(entry).toMatchObject({ family: 'devices', operation: 'observe', permission: 'user', assurance: 'observed', risk: 'low' });
      expect(entry.sideEffects.every(effect => ['local_read', 'network_read'].includes(effect.type))).toBe(true);
      expect(entry.verification.requiredFields).toContain('executionHost');
    }
    await expect(registry.execute('printer_list', {}, { ...native, executionBoundary: 'remote_restricted', source: 'rest_chat' })).rejects.toThrow(/remote execution/);
    expect(adapters.printers).not.toHaveBeenCalled();
    await expect(registry.execute('usb_serial_list', {}, { ...native, executionBoundary: 'remote_restricted', source: 'rest_chat' })).rejects.toThrow(/remote execution/);
    expect(adapters.usbSerial).not.toHaveBeenCalled();
  });
  it('does not convert partial inventory into successful full status', async () => {
    const { tools, adapters } = fixture();
    adapters.printers.mockResolvedValueOnce({ supported: true, status: 'partial', platform: 'win32', observedAt: 'test-time', printers: [], ports: [], errors: [{ code: 'job_read_failed' }] } as never);
    const result = JSON.parse(await tools.find(x => x.name === 'printer_list')!.handler({}, native));
    expect(result).toMatchObject({ ok: false, status: 'partial', errors: [{ code: 'job_read_failed' }] });
  });
  it('returns USB metadata without converting COM presence into firmware or MCP connection proof', async () => {
    const { tools, adapters } = fixture();
    adapters.usbSerial.mockResolvedValueOnce({ supported: true, status: 'ok', platform: 'win32', observedAt: 'test-time', devices: [
      { instanceId: 'USB\\VID_1234&PID_ABCD\\sample', portName: 'COM7', problemCode: 0, configManagerErrorCode: 28 },
    ], errors: [], limitations: ['A USB bridge does not prove an MCP connection.'] } as never);
    const tool = tools.find(item => item.name === 'usb_serial_list')!;
    const result = JSON.parse(await tool.handler({}, native));
    expect(result).toMatchObject({ ok: true, status: 'ok', executionHost: 'lumi_backend_host', source: 'windows_pnp_serial',
      devices: [{ portName: 'COM7', problemCode: 0, configManagerErrorCode: 28 }] });
    expect(result).not.toHaveProperty('connected');
    expect(result).not.toHaveProperty('firmware');
    expect(result).not.toHaveProperty('mcp');
    expect(tool.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool.capability?.verification?.limitations).toEqual(result.limitations.length ? expect.arrayContaining([expect.stringMatching(/does not.*MCP/)]) : []);
    expect(adapters.usbSerial).toHaveBeenCalledTimes(1);
  });
  it('keeps partial USB metadata and its source error visible without marking it complete', async () => {
    const { tools, adapters } = fixture();
    adapters.usbSerial.mockResolvedValueOnce({ supported: true, status: 'partial', platform: 'win32', observedAt: 'test-time',
      devices: [], errors: [{ code: 'port_name_query_failed', message: 'Access denied' }], limitations: [] } as never);
    const result = JSON.parse(await tools.find(item => item.name === 'usb_serial_list')!.handler({}, native));
    expect(result).toMatchObject({ ok: false, status: 'partial', source: 'windows_pnp_serial', errors: [{ code: 'port_name_query_failed' }] });
  });

  it('exposes a confirmed physical print action with no automatic retry and a separate read-only job lookup', async () => {
    const { tools, registry, adapters } = fixture();
    const submit = tools.find(tool => tool.name === 'printer_print_test_page')!;
    expect(submit.securityLevel).toBe('confirm');
    expect(submit.capability).toMatchObject({ operation: 'create', risk: 'medium', sideEffects: [{ type: 'external_state_change', reversible: false }] });
    const manifest = registry.getCapabilityManifestEntry(submit.name)!;
    expect(getAdapterRetryPolicy(submit.name, manifest).maxAttempts).toBe(1);
    await expect(registry.execute(submit.name, { printerName: 'Test queue' }, native)).rejects.toThrow(/confirmation/i);
    expect(adapters.submitTestPage).not.toHaveBeenCalled();
    const receipt = JSON.parse(await submit.handler({ printerName: 'Test queue' }, native));
    expect(receipt).toMatchObject({ ok: true, status: 'submitted', jobId: 73, physicalCompletionVerified: false, executionHost: 'lumi_backend_host' });
    expect(adapters.submitTestPage).toHaveBeenCalledExactlyOnceWith('Test queue');
    const status = JSON.parse(await tools.find(tool => tool.name === 'printer_job_status')!.handler({ printerName: 'Test queue', jobId: 73 }, native));
    expect(status).toMatchObject({ ok: true, status: 'not_observed', job: null, physicalCompletionVerified: false });
    expect(adapters.jobStatus).toHaveBeenCalledExactlyOnceWith('Test queue', 73);
  });

  it.each([2,87])('verifies the exact native missing-job observation through the existing generic contract (Win32 %j)', async code => {
    const { registry, tools, adapters } = fixture();
    const execRunner=vi.fn(async()=>({stdout:JSON.stringify({Queue:{Name:'Test queue',DriverName:'Fixture driver',PortName:'WSD-fixture'},Submission:null,Error:null,Job:{Found:false,JobId:73,Win32ErrorCode:code}}),stderr:''}));
    adapters.jobStatus.mockImplementationOnce((async()=>readPrinterJobStatus('Test queue',73,{platform:'win32',execRunner})) as never);
    const result=await tools.find(tool=>tool.name==='printer_job_status')!.handler({printerName:'Test queue',jobId:73},native);
    expect(JSON.parse(result)).toMatchObject({ok:true,status:'not_observed',job:null,win32ResultCode:code,errors:[],physicalCompletionVerified:false});
    expect(verifyCapabilityReceipt(registry.getCapabilityManifestEntry('printer_job_status'),{result})).toMatchObject({status:'verified'});
    expect(execRunner).toHaveBeenCalledOnce();
    expect(adapters.submitTestPage).not.toHaveBeenCalled();
  });
  it('keeps an actual native query failure failed under the same contract', async()=>{
    const {registry,tools,adapters}=fixture();
    const execRunner=vi.fn(async()=>({stdout:JSON.stringify({Queue:{Name:'Test queue',DriverName:'Fixture driver',PortName:'WSD-fixture'},Submission:null,Job:null,Error:'GetJob access denied'}),stderr:''}));
    adapters.jobStatus.mockImplementationOnce((async()=>readPrinterJobStatus('Test queue',73,{platform:'win32',execRunner})) as never);
    const result=await tools.find(tool=>tool.name==='printer_job_status')!.handler({printerName:'Test queue',jobId:73},native);
    expect(JSON.parse(result)).toMatchObject({ok:false,status:'unavailable',job:null,physicalCompletionVerified:false,errors:[{code:'job_query_failed'}]});
    expect(verifyCapabilityReceipt(registry.getCapabilityManifestEntry('printer_job_status'),{result})).toMatchObject({status:'failed'});
    expect(adapters.submitTestPage).not.toHaveBeenCalled();
  });

});
