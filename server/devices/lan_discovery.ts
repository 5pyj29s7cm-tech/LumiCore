import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { runHostProbeCommand, runWindowsPowerShellJson } from '../adapters/host_probe';

export type LanDiscoveryProtocol = 'mdns' | 'ssdp';
export interface LanDiscoveryInterface { name: string; address: string; netmask: string }
export interface LanDeviceCandidate {
  id: string;
  kind: 'tv' | 'printer';
  protocol: LanDiscoveryProtocol;
  serviceType: string;
  name: string;
  addresses: string[];
  host?: string;
  port?: number;
  path?: string;
  txt?: Record<string, string>;
  location?: string;
  usn?: string;
  server?: string;
  source: { interfaceName: string; localAddress: string; responderAddress: string };
  paired: false;
}
export interface LanDiscoveryOptions { timeoutMs?: number; protocols?: LanDiscoveryProtocol[] }
export interface LanDiscoveryResult {
  ok: boolean;
  status: 'completed' | 'partial' | 'unavailable';
  startedAt: string;
  finishedAt: string;
  timeoutMs: number;
  interfaces: LanDiscoveryInterface[];
  candidates: LanDeviceCandidate[];
  truncated: boolean;
  errors: Array<{ interfaceName?: string; protocol?: LanDiscoveryProtocol; code: string; message: string }>;
  limitations: string[];
}

const MDNS_SERVICES: Record<string, LanDeviceCandidate['kind']> = {
  '_ipp._tcp.local': 'printer', '_ipps._tcp.local': 'printer',
  '_printer._tcp.local': 'printer', '_googlecast._tcp.local': 'tv', '_airplay._tcp.local': 'tv',
};
const SSDP_TARGETS: Record<string, LanDeviceCandidate['kind']> = {
  'urn:schemas-upnp-org:device:MediaRenderer:1': 'tv',
  'urn:dial-multiscreen-org:service:dial:1': 'tv',
  'urn:schemas-upnp-org:device:Printer:1': 'printer',
};
const MAX_PACKETS = 256;
const MAX_RECORDS = 512;
const MAX_CANDIDATES = 64;
const MAX_MDNS_FOLLOWUP_QUESTIONS = 192;
const MDNS_QUESTIONS_PER_PACKET = 32;
const VIRTUAL_INTERFACE = /loopback|tunnel|\btun\d*\b|\btap\d*\b|vpn|virtual|vethernet|hyper-v|vmware|vbox|docker|\bwsl\b|tailscale|zerotier|utun|bridge/iu;
const canonicalName = (value: string) => value.replace(/\.$/u, '').toLowerCase();

function ipv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255)) return null;
  return parts.reduce((address, part) => (address * 256 + Number(part)) >>> 0, 0);
}
function privateIpv4(value: string): boolean {
  const address = ipv4(value);
  return address !== null && ((address >>> 24) === 10 || (address >>> 20) === 0xac1 || (address >>> 16) === 0xc0a8);
}
function sameSubnet(address: string, local: LanDiscoveryInterface): boolean {
  const remote = ipv4(address), own = ipv4(local.address), mask = ipv4(local.netmask);
  return remote !== null && own !== null && mask !== null && mask !== 0
    && privateIpv4(address) && (remote & mask) === (own & mask) && remote !== own
    && remote !== ((own & mask) >>> 0) && remote !== (((own & mask) | ~mask) >>> 0);
}

/** Physical adapter evidence is required; interface names alone are not hardware proof. */
export function selectLanDiscoveryInterfaces(
  interfaces: ReturnType<typeof os.networkInterfaces>, physicalNames: readonly string[],
): LanDiscoveryInterface[] {
  const physical = new Set(physicalNames);
  const selected: LanDiscoveryInterface[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!physical.has(name) || VIRTUAL_INTERFACE.test(name)) continue;
    for (const info of addresses || []) {
      if (info.family !== 'IPv4' || info.internal || !privateIpv4(info.address) || ipv4(info.netmask) === null) continue;
      const mask = ipv4(info.netmask)!;
      if (!mask || ((~mask >>> 0) & ((~mask >>> 0) + 1)) !== 0) continue;
      if (!selected.some(item => item.address === info.address)) selected.push({ name, address: info.address, netmask: info.netmask });
    }
  }
  return selected;
}

function physicalInterfaceNames(interfaces: ReturnType<typeof os.networkInterfaces>): string[] {
  if (process.platform === 'win32') {
    const value = runWindowsPowerShellJson('Get-NetAdapter -Physical | Where-Object { $_.Status -eq "Up" } | Select-Object Name | ConvertTo-Json -Compress', 1500);
    return (Array.isArray(value) ? value : value ? [value] : []).flatMap(row => typeof row?.Name === 'string' ? [row.Name] : []);
  }
  if (process.platform === 'linux') return Object.keys(interfaces).filter(name => fs.existsSync(`/sys/class/net/${name}/device`));
  if (process.platform === 'darwin') {
    return Array.from(runHostProbeCommand('networksetup -listallhardwareports', 1500).matchAll(/^Device:\s*(\S+)\s*$/gmu), match => match[1]);
  }
  return [];
}

export type MdnsRecord = { name: string; ttl: number } & (
  { type: 'PTR'; target: string } | { type: 'SRV'; target: string; port: number }
  | { type: 'TXT'; values: Record<string, string> } | { type: 'A'; address: string }
);
const mdnsTargetWireNames = new WeakMap<MdnsRecord, Buffer>();
const wireNameKey = (wire: Buffer) => Buffer.from(wire.map(byte => byte >= 65 && byte <= 90 ? byte + 32 : byte)).toString('hex');

/** Decode a DNS name with bounded pointer traversal, including names inside RDATA. */
function readDnsName(packet: Buffer, start: number): { name: string; nextOffset: number; wire: Buffer } {
  const visited = new Set<number>();
  const labels: Buffer[] = [];
  let cursor = start, nextOffset = -1, total = 1, pointerHops = 0;
  for (let steps = 0; steps < 128; steps++) {
    if (cursor < 0 || cursor >= packet.length || visited.has(cursor)) throw Error('Invalid DNS name pointer');
    visited.add(cursor);
    const length = packet[cursor];
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= packet.length || ++pointerHops > 32) throw Error('Invalid DNS compression');
      if (nextOffset < 0) nextOffset = cursor + 2;
      cursor = ((length & 0x3f) << 8) | packet[cursor + 1];
      continue;
    }
    if (length & 0xc0) throw Error('Unsupported DNS label');
    cursor++;
    if (!length) return {
      name: labels.map(label => label.toString('utf8')).join('.'), nextOffset: nextOffset < 0 ? cursor : nextOffset,
      wire: Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([label.length]), label])), Buffer.from([0])]),
    };
    if (cursor + length > packet.length || (total += length + 1) > 255) throw Error('DNS label exceeds packet');
    labels.push(packet.subarray(cursor, cursor + length));
    cursor += length;
  }
  throw Error('DNS name traversal limit');
}
export function decodeDnsName(packet: Buffer, start: number): { name: string; nextOffset: number } {
  const { name, nextOffset } = readDnsName(packet, start);
  return { name, nextOffset };
}

export function parseMdnsPacket(packet: Buffer): MdnsRecord[] {
  if (packet.length < 12 || packet.length > 65_535 || !(packet.readUInt16BE(2) & 0x8000)) return [];
  const questions = packet.readUInt16BE(4);
  const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (questions > 32 || count > 256) return [];
  const records: MdnsRecord[] = [];
  let offset = 12;
  try {
    for (let index = 0; index < questions; index++) {
      offset = decodeDnsName(packet, offset).nextOffset + 4;
      if (offset > packet.length) throw Error('Truncated DNS question');
    }
    for (let index = 0; index < count; index++) {
      const owner = readDnsName(packet, offset); offset = owner.nextOffset;
      if (offset + 10 > packet.length) throw Error('Truncated DNS record');
      const type = packet.readUInt16BE(offset), recordClass = packet.readUInt16BE(offset + 2) & 0x7fff;
      const ttl = packet.readUInt32BE(offset + 4), length = packet.readUInt16BE(offset + 8);
      offset += 10;
      const end = offset + length;
      if (end > packet.length) throw Error('Truncated DNS data');
      const base = { name: owner.name, ttl };
      const remember = (record: MdnsRecord, target?: Buffer) => {
        records.push(record); if (target) mdnsTargetWireNames.set(record, target);
      };
      // Each branch constructs a new typed record. Unsupported types never inherit prior RDATA.
      if (recordClass === 1 && type === 1 && length === 4) {
        remember({ ...base, type: 'A', address: [...packet.subarray(offset, end)].join('.') });
      } else if (recordClass === 1 && type === 12) {
        const target = readDnsName(packet, offset);
        if (target.nextOffset !== end) throw Error('Invalid PTR data');
        remember({ ...base, type: 'PTR', target: target.name }, target.wire);
      } else if (recordClass === 1 && type === 33 && length >= 7) {
        const target = readDnsName(packet, offset + 6);
        if (target.nextOffset !== end) throw Error('Invalid SRV data');
        remember({ ...base, type: 'SRV', port: packet.readUInt16BE(offset + 4), target: target.name }, target.wire);
      } else if (recordClass === 1 && type === 16) {
        const values: Record<string, string> = {};
        let position = offset, entries = 0;
        while (position < end) {
          const size = packet[position++];
          if (position + size > end || ++entries > 64) throw Error('Invalid TXT data');
          const text = packet.subarray(position, position + size).toString('utf8'); position += size;
          const separator = text.indexOf('=');
          const key = (separator < 0 ? text : text.slice(0, separator)).toLowerCase();
          if (/^[a-z0-9_-]{1,64}$/u.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)) {
            values[key] = separator < 0 ? '' : text.slice(separator + 1);
          }
        }
        remember({ ...base, type: 'TXT', values });
      }
      offset = end;
    }
  } catch { return []; }
  return records;
}

function encodedName(name: string): Buffer {
  const labels = name.split('.').map(label => Buffer.from(label));
  if (labels.some(label => !label.length || label.length > 63) || labels.reduce((size, label) => size + label.length + 1, 1) > 255) throw Error('Invalid DNS query name');
  return Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([label.length]), label])), Buffer.from([0])]);
}
function mdnsQuery(questions: Buffer[]): Buffer {
  const header = Buffer.alloc(12); header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([header, ...questions]);
}
export function buildMdnsDiscoveryQuery(): Buffer {
  return mdnsQuery(Object.keys(MDNS_SERVICES).map(name => Buffer.concat([encodedName(name), Buffer.from([0, 12, 0x80, 1])])));
}

export interface SsdpAdvertisement { serviceType: string; usn: string; server?: string; location?: string }
export function parseSsdpResponse(packet: Buffer): SsdpAdvertisement | null {
  if (!packet.length || packet.length > 8192) return null;
  const lines = packet.toString('utf8').split(/\r?\n/u);
  if (!/^HTTP\/1\.[01] 200(?:\s|$)/u.test(lines.shift() || '')) return null;
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) break;
    const colon = line.indexOf(':');
    if (colon < 1 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line)) return null;
    const key = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (value.length > 2048 || (headers.has(key) && headers.get(key) !== value)) return null;
    headers.set(key, value);
  }
  const serviceType = headers.get('st') || '', usn = headers.get('usn') || '';
  if (!Object.keys(SSDP_TARGETS).some(target => target.toLowerCase() === serviceType.toLowerCase()) || !usn || usn.length > 512) return null;
  return { serviceType, usn, ...(headers.get('server') ? { server: headers.get('server') } : {}), ...(headers.get('location') ? { location: headers.get('location') } : {}) };
}

type DiscoverySocket = Pick<dgram.Socket, 'on' | 'once' | 'bind' | 'send' | 'close' | 'setMulticastInterface' | 'setMulticastTTL' | 'setMulticastLoopback'>;
export interface LanDiscoveryDependencies {
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
  physicalInterfaceNames?: (interfaces: ReturnType<typeof os.networkInterfaces>) => readonly string[] | Promise<readonly string[]>;
  createSocket?: () => DiscoverySocket;
}

export async function getPhysicalLanInterfaces(
  dependencies: Pick<LanDiscoveryDependencies, 'networkInterfaces' | 'physicalInterfaceNames'> = {},
): Promise<LanDiscoveryInterface[]> {
  const interfaces = (dependencies.networkInterfaces || os.networkInterfaces)();
  const names = await (dependencies.physicalInterfaceNames || physicalInterfaceNames)(interfaces);
  return selectLanDiscoveryInterfaces(interfaces, names);
}

export function isOnLan(address: string, interfaces: readonly LanDiscoveryInterface[]): boolean {
  return interfaces.some(local => sameSubnet(address, local));
}
function candidateId(value: Pick<LanDeviceCandidate, 'protocol' | 'serviceType' | 'name' | 'source'>): string {
  return 'lan_' + createHash('sha256').update(JSON.stringify([value.protocol, value.serviceType, value.name, value.source.interfaceName, value.source.responderAddress])).digest('hex').slice(0, 20);
}

/** Bounded advertisement discovery, with no port sweep, pairing, control, or LOCATION fetch. */
export async function discoverLanDevices(options: LanDiscoveryOptions = {}, dependencies: LanDiscoveryDependencies = {}): Promise<LanDiscoveryResult> {
  const startedAt = new Date().toISOString();
  const requested = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requested) ? Math.max(500, Math.min(8000, Math.trunc(requested))) : 3000;
  const protocols = [...new Set(options.protocols || ['mdns', 'ssdp'])].filter((value): value is LanDiscoveryProtocol => value === 'mdns' || value === 'ssdp');
  const result: LanDiscoveryResult = { ok: false, status: 'unavailable', startedAt, finishedAt: startedAt, timeoutMs, interfaces: [], candidates: [], truncated: false, errors: [], limitations: [
    'Advertisements identify candidate services, not authenticated or paired devices. Silent devices and disabled discovery services will not appear.',
    'Only confirmed physical private IPv4 interfaces are queried. No subnet port scan, device control, printing, or HTTP LOCATION retrieval is performed.',
  ] };
  let eligible: LanDiscoveryInterface[] = [];
  try { eligible = await getPhysicalLanInterfaces(dependencies); }
  catch { result.errors.push({ code: 'physical_interface_probe_failed', message: 'Physical network adapters could not be verified.' }); }
  result.interfaces = eligible.slice(0, 4);
  result.truncated = eligible.length > result.interfaces.length;
  if (!result.interfaces.length || !protocols.length) {
    result.errors.push({ code: result.interfaces.length ? 'no_protocols' : 'no_physical_private_ipv4', message: 'No eligible physical private IPv4 interface or discovery protocol is available.' });
    result.finishedAt = new Date().toISOString(); return result;
  }
  const candidates = new Map<string, LanDeviceCandidate>();
  let completed = 0;
  const addCandidate = (candidate: Omit<LanDeviceCandidate, 'id'>) => {
    const id = candidateId(candidate);
    if (candidates.has(id) || candidates.size < MAX_CANDIDATES) candidates.set(id, { id, ...candidate });
    else result.truncated = true;
    return id;
  };
  await Promise.all(result.interfaces.flatMap(local => protocols.map(protocol => new Promise<void>(resolve => {
    let socket: DiscoverySocket;
    let done = false, packets = 0;
    const records = new Map<string, { record: MdnsRecord; responderAddress: string }>();
    const mdnsCandidateIds = new Set<string>();
    const followupQuestions = new Set<string>();
    const finish = (error?: { code: string; message: string }) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) result.errors.push({ interfaceName: local.name, protocol, ...error }); else completed++;
      try { socket?.close(); } catch {}
      resolve();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      socket = dependencies.createSocket?.() || dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', () => finish({ code: 'discovery_socket_error', message: 'The local discovery socket could not complete its query.' }));
      socket.once('close', () => finish());
      socket.on('message', (packet: Buffer, remote: dgram.RemoteInfo) => {
        if (done || !sameSubnet(remote.address, local)) return;
        if (++packets > MAX_PACKETS) { result.truncated = true; finish(); return; }
        if (protocol === 'ssdp') {
          const advertisement = parseSsdpResponse(packet); if (!advertisement) return;
          const serviceType = Object.keys(SSDP_TARGETS).find(target => target.toLowerCase() === advertisement.serviceType.toLowerCase())!;
          let location: string | undefined;
          try {
            const url = new URL(advertisement.location || '');
            if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.hostname === remote.address) location = url.href;
          } catch {}
          addCandidate({ kind: SSDP_TARGETS[serviceType], protocol, serviceType, name: advertisement.usn, addresses: [remote.address], usn: advertisement.usn, server: advertisement.server,
            ...(location ? { location } : {}), source: { interfaceName: local.name, localAddress: local.address, responderAddress: remote.address }, paired: false });
          return;
        }
        for (const record of parseMdnsPacket(packet)) {
          const key = JSON.stringify([canonicalName(record.name), record.type, record.type === 'A' ? record.address : record.type === 'PTR' ? canonicalName(record.target) : '']);
          if (!record.ttl) records.delete(key);
          else if (records.has(key) || records.size < MAX_RECORDS) records.set(key, { record, responderAddress: remote.address });
          else result.truncated = true;
        }
        for (const id of mdnsCandidateIds) candidates.delete(id);
        mdnsCandidateIds.clear();
        const pendingQuestions = new Map<string, { name: string; type: 1 | 16 | 33; wire?: Buffer }>();
        const requestRecord = (name: string, type: 1 | 16 | 33, wire?: Buffer) => {
          if (!name) return;
          if (![...records.values()].some(item => canonicalName(item.record.name) === canonicalName(name) && item.record.type === ({ 1: 'A', 16: 'TXT', 33: 'SRV' } as const)[type])) {
            pendingQuestions.set(JSON.stringify([wire ? wireNameKey(wire) : canonicalName(name), type]), { name, type, wire });
          }
        };
        for (const { record: pointer } of records.values()) {
          if (pointer.type !== 'PTR') continue;
          const serviceType = canonicalName(pointer.name), kind = MDNS_SERVICES[serviceType]; if (!kind) continue;
          const instance = canonicalName(pointer.target);
          if (!instance.endsWith('.' + serviceType)) continue;
          requestRecord(pointer.target, 33, mdnsTargetWireNames.get(pointer)); requestRecord(pointer.target, 16, mdnsTargetWireNames.get(pointer));
          const service = [...records.values()].find(item => item.record.type === 'SRV' && canonicalName(item.record.name) === instance);
          if (!service || service.record.type !== 'SRV' || !service.record.port) continue;
          const srv = service.record;
          requestRecord(srv.target, 1, mdnsTargetWireNames.get(srv));
          const textRecord = [...records.values()].find(item => item.record.type === 'TXT' && canonicalName(item.record.name) === instance)?.record;
          const txt = textRecord?.type === 'TXT' ? textRecord.values : {};
          const addresses = [...records.values()].flatMap(item => item.record.type === 'A' && canonicalName(item.record.name) === canonicalName(srv.target) && sameSubnet(item.record.address, local) ? [item.record.address] : []);
          mdnsCandidateIds.add(addCandidate({ kind, protocol, serviceType, name: pointer.target, addresses: [...new Set(addresses)], host: srv.target, port: srv.port,
            ...(kind === 'printer' && txt.rp ? { path: '/' + txt.rp.replace(/^\/+/, '') } : {}), txt,
            source: { interfaceName: local.name, localAddress: local.address, responderAddress: service.responderAddress }, paired: false }));
        }
        const questions: Buffer[] = [];
        for (const [key, question] of pendingQuestions) {
          if (followupQuestions.has(key)) continue;
          if (followupQuestions.size >= MAX_MDNS_FOLLOWUP_QUESTIONS) { result.truncated = true; continue; }
          let wireName: Buffer;
          // Retain label boundaries and bytes; a literal dot inside one label is not a separator.
          try { wireName = question.wire || encodedName(question.name); } catch { continue; }
          const suffix = Buffer.alloc(4); suffix.writeUInt16BE(question.type); suffix.writeUInt16BE(0x8001, 2);
          // Reserve the whole batch before send: injected sockets may reply synchronously.
          followupQuestions.add(key); questions.push(Buffer.concat([wireName, suffix]));
        }
        for (let index = 0; index < questions.length && !done; index += MDNS_QUESTIONS_PER_PACKET) {
          try {
            socket.send(mdnsQuery(questions.slice(index, index + MDNS_QUESTIONS_PER_PACKET)), 5353, '224.0.0.251', error => {
              if (error) finish({ code: 'discovery_send_failed', message: 'A bounded multicast discovery query could not be sent.' });
            });
          } catch { finish({ code: 'discovery_send_failed', message: 'A bounded multicast discovery query could not be sent.' }); }
        }
      });
      socket.bind({ address: local.address, port: 0 }, () => {
        if (done) return;
        try {
          socket.setMulticastInterface(local.address); socket.setMulticastTTL(protocol === 'mdns' ? 255 : 2); socket.setMulticastLoopback(false);
          const queries = protocol === 'mdns' ? [buildMdnsDiscoveryQuery()] : Object.keys(SSDP_TARGETS).map(target => Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`));
          for (const query of queries) {
            if (done) break;
            socket.send(query, protocol === 'mdns' ? 5353 : 1900, protocol === 'mdns' ? '224.0.0.251' : '239.255.255.250', error => {
              if (error) finish({ code: 'discovery_send_failed', message: 'A bounded multicast discovery query could not be sent.' });
            });
          }
        } catch { finish({ code: 'discovery_send_failed', message: 'A bounded multicast discovery query could not be sent.' }); }
      });
    } catch { finish({ code: 'discovery_socket_error', message: 'A discovery socket could not be opened on this physical interface.' }); }
  }))));
  result.candidates = [...candidates.values()];
  result.ok = completed > 0;
  result.status = !result.ok ? 'unavailable' : result.errors.length || result.truncated ? 'partial' : 'completed';
  result.finishedAt = new Date().toISOString();
  return result;
}
