import type { ExternalDevicesSnapshot } from '../../shared/external_devices';

type UsbSource = ExternalDevicesSnapshot['usb'];
type LanSource = ExternalDevicesSnapshot['lan'];
export type LanCandidate = Extract<LanSource, { candidates: unknown }>['candidates'][number];
export type LanServiceGroup = { key: string; name: string; services: LanCandidate[] };

export function mainUsbDevices(source?: UsbSource) {
  return source && 'devices' in source ? source.devices.filter(device => device.instanceEnumerator.toUpperCase() === 'USB') : [];
}

export function printerProtocol(candidate: LanCandidate): 'ipp' | 'ipps' | null {
  if (candidate.protocol !== 'mdns' || candidate.kind !== 'printer') return null;
  const service = candidate.serviceType.toLowerCase().replace(/\.$/, '');
  return service === '_ipp._tcp.local' ? 'ipp' : service === '_ipps._tcp.local' ? 'ipps' : null;
}

function uuid(candidate: LanCandidate): string | undefined {
  return Object.entries(candidate.txt ?? {}).find(([name]) => name.toLowerCase() === 'uuid')?.[1];
}

function serviceName(candidate: LanCandidate): string {
  const suffix = '.' + candidate.serviceType.replace(/\.$/, '');
  const name = candidate.name.replace(/\.$/, '');
  return candidate.protocol === 'mdns' && name.toLowerCase().endsWith(suffix.toLowerCase()) ? name.slice(0, -suffix.length) : candidate.name;
}

/** Presentation of advertised endpoints only; this grouping does not authenticate a device identity. */
export function groupLanServices(source?: LanSource): LanServiceGroup[] {
  if (!source || !('candidates' in source)) return [];
  const groups: Array<LanServiceGroup & { endpoint?: string; uuid?: string }> = [];
  for (const candidate of source.candidates) {
    const protocol = printerProtocol(candidate);
    const endpoint = protocol && candidate.host && candidate.path
      ? JSON.stringify([candidate.source.interfaceName, candidate.source.localAddress, candidate.host.toLowerCase().replace(/\.$/, ''), candidate.path, serviceName(candidate).toLowerCase()]) : undefined;
    const advertisedUuid = uuid(candidate);
    const group = endpoint ? groups.find(item => item.endpoint === endpoint && item.services.length === 1
      && printerProtocol(item.services[0]) !== protocol
      && !(advertisedUuid && item.uuid && advertisedUuid !== item.uuid)
      && (!candidate.addresses.length || !item.services[0].addresses.length || candidate.addresses.some(address => item.services[0].addresses.includes(address)))) : undefined;
    if (group) {
      const hasResolvedIpp = group.services.some(service => printerProtocol(service) === 'ipp' && service.addresses.length);
      group.services.push(candidate); group.uuid ??= advertisedUuid;
      if (!hasResolvedIpp && printerProtocol(candidate) === 'ipp' && candidate.addresses.length) group.name = serviceName(candidate);
    } else groups.push({ key: JSON.stringify([candidate.id, endpoint]), name: serviceName(candidate), services: [candidate], endpoint, uuid: advertisedUuid });
  }
  return groups;
}

export function printerStatusTarget(group: LanServiceGroup) {
  for (const candidate of group.services) {
    if (printerProtocol(candidate) !== 'ipp' || !candidate.addresses.length || !Number.isInteger(candidate.port)
      || candidate.port! < 1 || candidate.port! > 65535 || !candidate.path?.startsWith('/') || candidate.path.startsWith('//')) continue;
    // Use one exact original IPP endpoint. Never borrow an IPPS address, port or path.
    return { address: candidate.addresses[0], port: candidate.port!, resourcePath: candidate.path };
  }
  return null;
}
