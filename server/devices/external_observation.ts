import { readUsbSerialInventory, type UsbSerialInventoryResult } from './usb_serial_inventory';
import { readPrinterInventory, type PrinterInventoryResult } from './printer_inventory';
import { discoverLanDevices, type LanDiscoveryOptions, type LanDiscoveryResult } from './lan_discovery';
import type { ExternalDeviceSourceFailure, ExternalDevicesSnapshot } from '../../shared/external_devices';

export interface ExternalObservationAdapters {
  usb: () => Promise<UsbSerialInventoryResult>;
  printers: () => Promise<PrinterInventoryResult>;
  lan: (options: LanDiscoveryOptions) => Promise<LanDiscoveryResult>;
}

async function observeSource<T>(read: () => Promise<T>): Promise<T | ExternalDeviceSourceFailure> {
  try {
    return await read();
  } catch (error) {
    return {
      ok: false,
      status: 'unavailable',
      observedAt: new Date().toISOString(),
      errors: [{ code: 'observation_failed', message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/** Local observations only: no registration, pairing, serial I/O or print submission. */
export async function observeExternalDevices(
  adapters: Partial<ExternalObservationAdapters> = {},
): Promise<ExternalDevicesSnapshot> {
  const [usb, printers, lan] = await Promise.all([
    observeSource(() => (adapters.usb ?? readUsbSerialInventory)()),
    observeSource(() => (adapters.printers ?? readPrinterInventory)()),
    observeSource(() => (adapters.lan ?? discoverLanDevices)({ timeoutMs: 2000, protocols: ['mdns', 'ssdp'] })),
  ]);
  return { observedAt: new Date().toISOString(), usb, printers, lan };
}
