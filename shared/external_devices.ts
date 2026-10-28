import type { UsbSerialInventoryResult } from '../server/devices/usb_serial_inventory';
import type { PrinterInventoryResult } from '../server/devices/printer_inventory';
import type { LanDiscoveryResult } from '../server/devices/lan_discovery';
import type { IppPrinterTarget, readNetworkPrinterStatus } from '../server/devices/ipp_printer';

/** An owner that threw did not observe an empty inventory. */
export interface ExternalDeviceSourceFailure {
  ok: false;
  status: 'unavailable';
  observedAt: string;
  errors: Array<{ code: 'observation_failed'; message: string }>;
}
export interface ExternalDevicesSnapshot {
  observedAt: string;
  usb: UsbSerialInventoryResult | ExternalDeviceSourceFailure;
  printers: PrinterInventoryResult | ExternalDeviceSourceFailure;
  lan: LanDiscoveryResult | ExternalDeviceSourceFailure;
}
export type ExternalDeviceSnapshot = ExternalDevicesSnapshot;
export type NetworkPrinterStatusRequest = IppPrinterTarget;
export type NetworkPrinterStatusResult = Awaited<ReturnType<typeof readNetworkPrinterStatus>>;
