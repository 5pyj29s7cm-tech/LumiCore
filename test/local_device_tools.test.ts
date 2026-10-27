import { describe, expect, it, vi } from 'vitest';
import { registerLocalDeviceTools, type LocalDeviceAdapters } from '../server/tools/definitions/local_device_tools';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';

const native: ToolContext = { userId: 'local-device-test', authenticated: true, localExecution: true, executionBoundary: 'trusted_local' };
function fixture() {
  const adapters = {
    discover: vi.fn(async () => ({ ok: true, status: 'completed', startedAt: 'test-start', finishedAt: 'test-end', interfaces: [], candidates: [], errors: [], limitations: [], truncated: false, timeoutMs: 500 })),
    printers: vi.fn(async () => ({ supported: true, status: 'ok', platform: 'win32', observedAt: 'test-time', printers: [], ports: [], errors: [] })),
    printerStatus: vi.fn(async () => ({ supported: true, status: 'ok', platform: 'win32', observedAt: 'test-time', printer: { name: 'Test queue', workOffline: true, queueStatus: 'Normal' }, ports: [], errors: [] })),
    networkPrinterStatus: vi.fn(async () => ({ ok: false, status: 'unavailable', observedAt: 'test-time', error: 'Timed out' })),
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
    expect(manifest).toHaveLength(4);
    for (const entry of manifest) {
      expect(entry).toMatchObject({ family: 'devices', operation: 'observe', permission: 'user', assurance: 'observed', risk: 'low' });
      expect(entry.sideEffects.every(effect => ['local_read', 'network_read'].includes(effect.type))).toBe(true);
      expect(entry.verification.requiredFields).toContain('executionHost');
    }
    await expect(registry.execute('printer_list', {}, { ...native, executionBoundary: 'remote_restricted', source: 'rest_chat' })).rejects.toThrow(/remote execution/);
    expect(adapters.printers).not.toHaveBeenCalled();
  });
  it('does not convert partial inventory into successful full status', async () => {
    const { tools, adapters } = fixture();
    adapters.printers.mockResolvedValueOnce({ supported: true, status: 'partial', platform: 'win32', observedAt: 'test-time', printers: [], ports: [], errors: [{ code: 'job_read_failed' }] } as never);
    const result = JSON.parse(await tools.find(x => x.name === 'printer_list')!.handler({}, native));
    expect(result).toMatchObject({ ok: false, status: 'partial', errors: [{ code: 'job_read_failed' }] });
  });
});
