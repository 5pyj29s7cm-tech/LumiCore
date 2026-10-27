import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanDiscoveryDependencies } from '../server/devices/lan_discovery';
import { buildMdnsDiscoveryQuery, decodeDnsName, discoverLanDevices, getPhysicalLanInterfaces, isOnLan, parseMdnsPacket, parseSsdpResponse, selectLanDiscoveryInterfaces } from '../server/devices/lan_discovery';

const name = (value: string) => Buffer.concat([...value.split('.').map(label => {
  const bytes = Buffer.from(label); return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}), Buffer.from([0])]);
const pointer = (offset: number) => Buffer.from([0xc0 | (offset >> 8), offset & 255]);
function record(owner: Buffer, type: number, data: Buffer, ttl = 120) {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0); header.writeUInt16BE(0x8001, 2); header.writeUInt32BE(ttl, 4); header.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, header, data]);
}
function response(records: Buffer[], question?: Buffer) {
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(question ? 1 : 0, 4); header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...(question ? [question] : []), ...records]);
}
function questions(packet: Buffer) {
  let offset = 12;
  return Array.from({ length: packet.readUInt16BE(4) }, () => {
    const decoded = decodeDnsName(packet, offset);
    const question = { name: decoded.name, type: packet.readUInt16BE(decoded.nextOffset), recordClass: packet.readUInt16BE(decoded.nextOffset + 2) };
    offset = decoded.nextOffset + 4;
    return question;
  });
}
function serviceRecord(instance = 'Proxy Printer._ipp._tcp.local', target = 'actual-printer.local') {
  const srv = Buffer.alloc(6); srv.writeUInt16BE(631, 4);
  return record(name(instance), 33, Buffer.concat([srv, name(target)]));
}
function printerPacket(ttl = 120) {
  const service = '_ipp._tcp.local';
  const question = Buffer.concat([name(service), Buffer.from([0, 12, 0, 1])]);
  const instanceOffset = 12 + question.length + 12;
  const instance = Buffer.concat([Buffer.from([15]), Buffer.from('Fixture Printer'), pointer(12)]);
  const srv = Buffer.alloc(6); srv.writeUInt16BE(631, 4);
  const txt = ['rp=ipp/print', 'ty=Fixture model', 'note=Keep\nsource wording'].map(value => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)]));
  return response([
    record(pointer(12), 12, instance, ttl),
    record(pointer(instanceOffset), 33, Buffer.concat([srv, name('fixture-printer.local')]), ttl),
    record(name('unsupported.local'), 28, Buffer.alloc(16), ttl),
    record(name('fixture-printer.local'), 1, Buffer.from([10, 42, 0, 50]), ttl),
    record(pointer(instanceOffset), 16, Buffer.concat(txt), ttl),
  ], question);
}
const ssdp = (target = 'urn:schemas-upnp-org:device:MediaRenderer:1', location = 'http://10.42.0.60:8000/description.xml') => Buffer.from(
  `HTTP/1.1 200 OK\r\nST: ${target}\r\nUSN: uuid:fixture-renderer::${target}\r\nSERVER: FixtureOS/1.0 UPnP/1.0\r\nLOCATION: ${location}\r\n\r\n`,
);
const address = (value: string, netmask = '255.255.255.0') => ({ address: value, netmask, family: 'IPv4' as const, internal: false, mac: '02:00:00:00:00:01', cidr: value + '/24' });
const interfaces = { Ethernet: [address('10.42.0.8')], Tunnel: [address('198.19.0.1')], 'vEthernet (fixture)': [address('172.23.0.1')] };

class FakeSocket extends EventEmitter {
  sent: Array<{ packet: Buffer; port: number; address: string }> = [];
  closed = false;
  constructor(private reply: (socket: FakeSocket, port: number) => void = () => {}) { super(); }
  bind = vi.fn((_options: unknown, callback: () => void) => { queueMicrotask(() => callback()); return this; });
  send = vi.fn((packet: Buffer, port: number, destination: string, callback: (error: Error | null) => void) => {
    this.sent.push({ packet, port, address: destination });
    this.reply(this, port); callback(null);
  });
  close = vi.fn(() => { if (!this.closed) { this.closed = true; this.emit('close'); } return this; });
  setMulticastInterface = vi.fn(() => this);
  setMulticastTTL = vi.fn(() => this);
  setMulticastLoopback = vi.fn(() => this);
  receive(packet: Buffer, ip = '10.42.0.50') { this.emit('message', packet, { address: ip, port: 5353, family: 'IPv4', size: packet.length }); }
}
function harness(reply?: (socket: FakeSocket, port: number) => void) {
  const sockets: FakeSocket[] = [];
  const dependencies: LanDiscoveryDependencies = {
    networkInterfaces: () => interfaces,
    physicalInterfaceNames: () => ['Ethernet', 'Tunnel', 'vEthernet (fixture)'],
    createSocket: () => {
      const socket = new FakeSocket(reply); sockets.push(socket);
      return socket as unknown as ReturnType<NonNullable<LanDiscoveryDependencies['createSocket']>>;
    },
  };
  return { dependencies, sockets };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded LAN DNS parsing', () => {
  it('decodes compressed PTR/SRV names, TXT and A without carrying data across record types', () => {
    const records = parseMdnsPacket(printerPacket());
    expect(records.map(item => item.type)).toEqual(['PTR', 'SRV', 'A', 'TXT']);
    expect(records[0]).toEqual({ name: '_ipp._tcp.local', type: 'PTR', ttl: 120, target: 'Fixture Printer._ipp._tcp.local' });
    expect(records[1]).toEqual({ name: 'Fixture Printer._ipp._tcp.local', type: 'SRV', ttl: 120, target: 'fixture-printer.local', port: 631 });
    expect(records[2]).toEqual({ name: 'fixture-printer.local', type: 'A', ttl: 120, address: '10.42.0.50' });
    expect(records[3]).toEqual({ name: 'Fixture Printer._ipp._tcp.local', type: 'TXT', ttl: 120, values: { rp: 'ipp/print', ty: 'Fixture model', note: 'Keep\nsource wording' } });
    expect(records[2]).not.toHaveProperty('target'); expect(records[3]).not.toHaveProperty('address');
  });
  it('rejects pointer loops, out-of-range pointers, malformed TXT/SRV and oversized counts', () => {
    const loop = response([record(pointer(12), 12, pointer(12))]);
    expect(parseMdnsPacket(loop)).toEqual([]);
    expect(() => decodeDnsName(Buffer.from([0xff, 0xff]), 0)).toThrow();
    expect(parseMdnsPacket(response([record(name('x.local'), 16, Buffer.from([5, 1]))]))).toEqual([]);
    expect(parseMdnsPacket(response([record(name('x.local'), 33, Buffer.alloc(6))]))).toEqual([]);
    const excessive = Buffer.alloc(12); excessive.writeUInt16BE(0x8000, 2); excessive.writeUInt16BE(257, 6);
    expect(parseMdnsPacket(excessive)).toEqual([]);
    expect(parseMdnsPacket(Buffer.alloc(65_536))).toEqual([]);
    expect(parseMdnsPacket(printerPacket().subarray(0, -1))).toEqual([]);
    const labels = Buffer.concat(Array.from({ length: 32 }, () => Buffer.from([1, 97])));
    expect(decodeDnsName(Buffer.concat([labels, pointer(labels.length + 2), Buffer.from([0])]), 0).name).toBe(Array(32).fill('a').join('.'));
    const chain = Buffer.concat([...Array.from({ length: 33 }, (_, index) => pointer((index + 1) * 2)), Buffer.from([0])]);
    expect(() => decodeDnsName(chain, 0)).toThrow();
    const longLabel = Buffer.concat([Buffer.from([63]), Buffer.alloc(63, 97)]);
    expect(() => decodeDnsName(Buffer.concat([longLabel, longLabel, longLabel, Buffer.from([61]), Buffer.alloc(61, 98), Buffer.from([0])]), 0)).not.toThrow();
    expect(() => decodeDnsName(Buffer.concat([longLabel, longLabel, longLabel, Buffer.from([62]), Buffer.alloc(62, 98), Buffer.from([0])]), 0)).toThrow();
  });
  it('queries only the bounded TV and printer service types and requests unicast answers', () => {
    const query = buildMdnsDiscoveryQuery();
    expect(query.readUInt16BE(4)).toBe(5);
    let offset = 12; const queried: string[] = [];
    for (let index = 0; index < 5; index++) {
      const decoded = decodeDnsName(query, offset); queried.push(decoded.name);
      expect(query.readUInt16BE(decoded.nextOffset)).toBe(12);
      expect(query.readUInt16BE(decoded.nextOffset + 2)).toBe(0x8001);
      offset = decoded.nextOffset + 4;
    }
    expect(queried).toEqual(['_ipp._tcp.local', '_ipps._tcp.local', '_printer._tcp.local', '_googlecast._tcp.local', '_airplay._tcp.local']);
    expect(parseMdnsPacket(query)).toEqual([]);
  });
});

describe('LAN interface and SSDP boundaries', () => {
  it('requires physical evidence and private IPv4 while excluding tunnel/virtual and invalid masks', async () => {
    const inventory = { ...interfaces, Wifi: [address('192.168.40.8')], Public: [address('203.0.113.4')], BadMask: [address('10.7.1.8', '255.0.255.0')] };
    expect(selectLanDiscoveryInterfaces(inventory, ['Ethernet', 'Tunnel', 'vEthernet (fixture)', 'Public', 'BadMask'])).toEqual([{ name: 'Ethernet', address: '10.42.0.8', netmask: '255.255.255.0' }]);
    expect(await getPhysicalLanInterfaces({ networkInterfaces: () => inventory, physicalInterfaceNames: () => ['Wifi'] })).toEqual([{ name: 'Wifi', address: '192.168.40.8', netmask: '255.255.255.0' }]);
    const selected = selectLanDiscoveryInterfaces(interfaces, ['Ethernet']);
    expect(isOnLan('10.42.0.50', selected)).toBe(true);
    for (const ip of ['10.42.0.8', '10.42.0.0', '10.42.0.255', '10.43.0.50', '198.19.0.20', '203.0.113.9', '127.0.0.1', '10.42.0.050', 'device.local']) expect(isOnLan(ip, selected)).toBe(false);
  });
  it('accepts typed SSDP responses, preserves fields and ignores routers or ambiguous headers', () => {
    expect(parseSsdpResponse(ssdp())).toMatchObject({ serviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1', usn: expect.stringContaining('uuid:fixture-renderer'), server: 'FixtureOS/1.0 UPnP/1.0', location: 'http://10.42.0.60:8000/description.xml' });
    expect(parseSsdpResponse(ssdp('urn:schemas-upnp-org:device:InternetGatewayDevice:1'))).toBeNull();
    expect(parseSsdpResponse(Buffer.from('NOTIFY * HTTP/1.1\r\nST: x\r\n\r\n'))).toBeNull();
    expect(parseSsdpResponse(Buffer.from(ssdp().toString().replace('USN:', 'ST: conflicting\r\nUSN:')))).toBeNull();
    expect(parseSsdpResponse(Buffer.alloc(8193))).toBeNull();
  });
});

describe('read-only bounded multicast discovery', () => {
  it('keeps a proxy responder as provenance without treating it as an unresolved SRV target address', async () => {
    vi.useFakeTimers();
    const h = harness((socket, port) => {
      if (port !== 5353 || socket.sent.length !== 1) return;
      socket.receive(response([
        record(name('_ipp._tcp.local'), 12, name('Proxy Printer._ipp._tcp.local')),
        serviceRecord(),
        record(name('proxy.local'), 1, Buffer.from([10, 42, 0, 50])),
      ]));
    });
    const pending = discoverLanDevices({ protocols: ['mdns'], timeoutMs: 500 }, h.dependencies);
    await vi.runAllTimersAsync(); const result = await pending;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ addresses: [], host: 'actual-printer.local', source: { responderAddress: '10.42.0.50' } });
  });
  it('resolves split PTR, SRV, TXT and A responses with deduplicated multicast follow-up questions', async () => {
    vi.useFakeTimers();
    const instance = 'Proxy Printer._ipp._tcp.local', host = 'actual-printer.local';
    const ptr = response([record(name('_ipp._tcp.local'), 12, name(instance))]);
    const srv = response([serviceRecord(instance, host)]);
    const h = harness((socket, port) => {
      if (port !== 5353) return;
      const query = questions(socket.sent.at(-1)!.packet);
      if (socket.sent.length === 1) { socket.receive(ptr); return; }
      for (const question of query) {
        if (question.name === instance && question.type === 33) {
          socket.receive(ptr); socket.receive(srv); socket.receive(srv);
        } else if (question.name === instance && question.type === 16) {
          socket.receive(response([record(name(instance), 16, Buffer.from([12, ...Buffer.from('rp=ipp/queue')]))]));
        } else if (question.name === host && question.type === 1) {
          socket.receive(response([record(name(host), 1, Buffer.from([10, 42, 0, 77]))]), '10.42.0.77');
        }
      }
    });
    const pending = discoverLanDevices({ protocols: ['mdns'], timeoutMs: 500 }, h.dependencies);
    await vi.runAllTimersAsync(); const result = await pending;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ addresses: ['10.42.0.77'], host, port: 631, path: '/ipp/queue', source: { responderAddress: '10.42.0.50' } });
    expect(h.sockets[0].sent.slice(1).flatMap(item => questions(item.packet))).toEqual([
      { name: instance, type: 33, recordClass: 0x8001 },
      { name: instance, type: 16, recordClass: 0x8001 },
      { name: host, type: 1, recordClass: 0x8001 },
    ]);
    expect(h.sockets[0].sent.every(item => item.port === 5353 && item.address === '224.0.0.251')).toBe(true);
    expect(h.sockets[0].closed).toBe(true);
  });
  it('caps follow-up questions per interface and deduplicates repeated names and types', async () => {
    vi.useFakeTimers();
    const packet = response(Array.from({ length: 100 }, (_, index) => record(name('_ipp._tcp.local'), 12, name(`Printer ${index}._ipp._tcp.local`))));
    const h = harness((socket, port) => {
      if (port === 5353 && socket.sent.length === 1) { socket.receive(packet); socket.receive(packet); }
    });
    const pending = discoverLanDevices({ protocols: ['mdns'], timeoutMs: 500 }, h.dependencies);
    await vi.runAllTimersAsync(); const result = await pending;
    const sent = h.sockets[0].sent.slice(1).map(item => questions(item.packet));
    expect(sent.flat()).toHaveLength(192);
    expect(new Set(sent.flat().map(item => `${item.name.toLowerCase()}/${item.type}`)).size).toBe(192);
    expect(sent.every(batch => batch.length <= 32)).toBe(true);
    expect(result.truncated).toBe(true); expect(result.status).toBe('partial');
    expect(h.sockets[0].closed).toBe(true);
  });
  it('preserves a literal dot within an instance label when sending follow-up questions', async () => {
    vi.useFakeTimers();
    const label = Buffer.from('Fixture v1.2');
    const instance = Buffer.concat([Buffer.from([label.length]), label, name('_ipp._tcp.local')]);
    const h = harness((socket, port) => {
      if (port === 5353 && socket.sent.length === 1) socket.receive(response([record(name('_ipp._tcp.local'), 12, instance)]));
    });
    const pending = discoverLanDevices({ protocols: ['mdns'], timeoutMs: 500 }, h.dependencies);
    await vi.runAllTimersAsync(); await pending;
    const followup = h.sockets[0].sent[1].packet;
    expect(followup.subarray(12, 12 + instance.length)).toEqual(instance);
    expect(questions(followup).map(item => item.type)).toEqual([33, 16]);
  });
  it('uses out-of-order cached SRV, TXT and A only once a service PTR anchors the instance', async () => {
    vi.useFakeTimers();
    const instance = 'Cached Printer._ipp._tcp.local';
    const h = harness((socket, port) => {
      if (port !== 5353 || socket.sent.length !== 1) return;
      socket.receive(response([
        serviceRecord(instance),
        record(name(instance), 16, Buffer.from([12, ...Buffer.from('rp=ipp/queue')])),
        record(name('actual-printer.local'), 1, Buffer.from([10, 42, 0, 77])),
      ]));
      socket.receive(response([record(name('_ipp._tcp.local'), 12, name(instance))]));
    });
    const pending = discoverLanDevices({ protocols: ['mdns'], timeoutMs: 500 }, h.dependencies);
    await vi.runAllTimersAsync(); const result = await pending;
    expect(h.sockets[0].sent).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ addresses: ['10.42.0.77'], path: '/ipp/queue' });
  });
  it('collects printer and TV advertisements with provenance, closes sockets and never fetches LOCATION', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const h = harness((socket, port) => {
      if (socket.sent.length !== 1) return;
      if (port === 5353) socket.receive(printerPacket());
      else {
        socket.receive(ssdp(), '10.42.0.60');
        socket.receive(ssdp('urn:schemas-upnp-org:device:InternetGatewayDevice:1'), '10.42.0.1');
        socket.receive(ssdp(), '198.19.0.9');
      }
    });
    const pending = discoverLanDevices({ timeoutMs: 750 }, h.dependencies);
    await vi.runAllTimersAsync(); const result = await pending;
    expect(result.status).toBe('completed'); expect(result.candidates).toHaveLength(2);
    expect(result.candidates.find(item => item.kind === 'printer')).toMatchObject({ protocol: 'mdns', addresses: ['10.42.0.50'], host: 'fixture-printer.local', port: 631, path: '/ipp/print', paired: false,
      source: { interfaceName: 'Ethernet', localAddress: '10.42.0.8', responderAddress: '10.42.0.50' } });
    expect(result.candidates.find(item => item.kind === 'tv')).toMatchObject({ protocol: 'ssdp', location: 'http://10.42.0.60:8000/description.xml', paired: false });
    expect(fetch).not.toHaveBeenCalled(); expect(h.sockets).toHaveLength(2);
    expect(h.sockets.every(socket => socket.closed)).toBe(true);
    expect(h.sockets[0].setMulticastTTL).toHaveBeenCalledWith(255); expect(h.sockets[1].setMulticastTTL).toHaveBeenCalledWith(2);
    expect(h.sockets.flatMap(socket => socket.sent).map(item => item.address)).toEqual(['224.0.0.251', '239.255.255.250', '239.255.255.250', '239.255.255.250']);
    expect(h.sockets.flatMap(socket => socket.sent).some(item => item.packet.toString().includes('ssdp:all'))).toBe(false);
  });
  it('does not open sockets when physical interfaces cannot be verified', async () => {
    const createSocket = vi.fn();
    const result = await discoverLanDevices({}, { networkInterfaces: () => interfaces, physicalInterfaceNames: () => [], createSocket });
    expect(result.status).toBe('unavailable'); expect(createSocket).not.toHaveBeenCalled(); expect(result.candidates).toEqual([]);
  });
  it('honors goodbye TTL records and never carries removed PTR data into later packets', async () => {
    vi.useFakeTimers();
    const h = harness((socket, port) => { if (port === 5353) { socket.receive(printerPacket()); socket.receive(printerPacket(0)); } });
    const pending = discoverLanDevices({ protocols: ['mdns'], timeoutMs: 500 }, h.dependencies);
    await vi.runAllTimersAsync(); expect((await pending).candidates).toEqual([]);
  });
  it('does not expose off-responder LOCATION and returns partial findings on socket errors', async () => {
    vi.useFakeTimers();
    const h = harness((socket, port) => {
      if (port === 5353) socket.emit('error', Error('Synthetic bind failure'));
      else socket.receive(ssdp(undefined, 'http://203.0.113.20/remote.xml'), '10.42.0.60');
    });
    const pending = discoverLanDevices({ timeoutMs: 1_000_000 }, h.dependencies);
    await vi.runAllTimersAsync(); const result = await pending;
    expect(result.timeoutMs).toBe(8000); expect(result.status).toBe('partial'); expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).not.toHaveProperty('location'); expect(h.sockets.every(socket => socket.closed)).toBe(true);
  });
  it('bounds packet floods while retaining already observed candidates', async () => {
    vi.useFakeTimers();
    const h = harness((socket, port) => { if (port === 5353) for (let index = 0; index < 300; index++) socket.receive(printerPacket()); });
    const pending = discoverLanDevices({ protocols: ['mdns'], timeoutMs: 10 }, h.dependencies);
    await vi.runAllTimersAsync(); const result = await pending;
    expect(result.timeoutMs).toBe(500); expect(result.truncated).toBe(true); expect(result.candidates).toHaveLength(1);
    expect(result.status).toBe('partial'); expect(h.sockets[0].closed).toBe(true);
  });
});
