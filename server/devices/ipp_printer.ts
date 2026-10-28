import { randomInt } from 'node:crypto';
import { requestIppHttp, type IppHttpTransport } from './ipp_http';
import { getPhysicalLanInterfaces, isOnLan, type LanDiscoveryInterface } from './lan_discovery';

export type IppPrinterTarget = { address: string; port: number; resourcePath: string };
type AttributeValue = string | number | boolean;
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUESTED_ATTRIBUTES = [
  'printer-name', 'printer-info', 'printer-make-and-model', 'printer-uuid',
  'printer-state', 'printer-state-reasons', 'printer-is-accepting-jobs',
  'queued-job-count', 'document-format-supported', 'media-supported',
  'sides-supported', 'color-supported', 'operations-supported',
] as const;
const ATTRIBUTE_TAGS: Record<string, readonly number[]> = {
  'printer-name': [0x42, 0x36], 'printer-info': [0x41, 0x35],
  'printer-make-and-model': [0x41, 0x35], 'printer-uuid': [0x45],
  'printer-state': [0x23], 'printer-state-reasons': [0x44],
  'printer-is-accepting-jobs': [0x22], 'queued-job-count': [0x21],
  'document-format-supported': [0x49], 'media-supported': [0x44],
  'sides-supported': [0x44], 'color-supported': [0x22], 'operations-supported': [0x23],
};

function attribute(tag: number, name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const valueBytes = Buffer.from(value, 'utf8');
  const header = Buffer.alloc(3);
  header[0] = tag;
  header.writeUInt16BE(nameBytes.length, 1);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(valueBytes.length);
  return Buffer.concat([header, nameBytes, length, valueBytes]);
}

/** RFC 8010 / RFC 8011: operation 0x000b only, no document/job payload. */
export function encodePrinterAttributesRequest(uri: string, requestId: number): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header[1] = 1;
  header.writeUInt16BE(0x000b, 2);
  header.writeInt32BE(requestId, 4);
  return Buffer.concat([
    header, Buffer.from([0x01]),
    attribute(0x47, 'attributes-charset', 'utf-8'),
    attribute(0x48, 'attributes-natural-language', 'en'),
    attribute(0x45, 'printer-uri', uri),
    ...REQUESTED_ATTRIBUTES.map((name, index) => attribute(0x44, index === 0 ? 'requested-attributes' : '', name)),
    Buffer.from([0x03]),
  ]);
}

function decodeValue(tag: number, value: Buffer): AttributeValue | undefined {
  if ((tag === 0x21 || tag === 0x23) && value.length === 4) return value.readInt32BE();
  if (tag === 0x22 && value.length === 1 && value[0] <= 1) return value[0] === 1;
  if ([0x41, 0x42, 0x44, 0x45, 0x49].includes(tag)) return value.toString('utf8');
  if ((tag === 0x35 || tag === 0x36) && value.length >= 4) {
    const languageLength = value.readUInt16BE(0);
    const textOffset = 2 + languageLength;
    if (textOffset + 2 > value.length) throw new Error('Malformed IPP language value');
    const textLength = value.readUInt16BE(textOffset);
    if (textOffset + 2 + textLength !== value.length) throw new Error('Malformed IPP text length');
    return value.subarray(textOffset + 2).toString('utf8');
  }
  return undefined;
}

export function decodePrinterAttributesResponse(body: Buffer, requestId: number) {
  if (body.length < 9 || body.length > MAX_RESPONSE_BYTES) throw new Error('Invalid IPP response size');
  if (![1, 2].includes(body[0])) throw new Error('Unsupported IPP response version');
  if (body.readInt32BE(4) !== requestId) throw new Error('IPP request-id mismatch');
  const statusCode = body.readUInt16BE(2);
  const attributes: Record<string, AttributeValue[]> = {};
  let offset = 8;
  let group = 0;
  let name = '';
  let collectionDepth = 0;
  let ended = false;
  let fields = 0;
  while (offset < body.length) {
    const tag = body[offset++];
    if (tag === 0x03) { ended = true; break; }
    if (tag < 0x10) {
      if (collectionDepth) throw new Error('Unclosed IPP collection');
      group = tag; name = ''; continue;
    }
    if (++fields > 4096 || tag === 0x7f || offset + 2 > body.length) throw new Error('Malformed IPP attribute');
    const nameLength = body.readUInt16BE(offset); offset += 2;
    if (nameLength > 255 || offset + nameLength + 2 > body.length) throw new Error('Malformed IPP attribute name');
    const fieldName = body.subarray(offset, offset + nameLength).toString('ascii'); offset += nameLength;
    const valueLength = body.readUInt16BE(offset); offset += 2;
    if (offset + valueLength > body.length) throw new Error('Truncated IPP attribute');
    const bytes = body.subarray(offset, offset + valueLength); offset += valueLength;
    if (tag === 0x34) { collectionDepth++; if (nameLength && collectionDepth === 1) name = fieldName; continue; }
    if (tag === 0x37) { if (!collectionDepth) throw new Error('Unexpected IPP collection end'); collectionDepth--; if (!collectionDepth) name = ''; continue; }
    if (collectionDepth) continue;
    if (nameLength) name = fieldName;
    else if (!name) throw new Error('IPP value without attribute name');
    if (group !== 0x04 || !Object.hasOwn(ATTRIBUTE_TAGS, name) || !ATTRIBUTE_TAGS[name].includes(tag)) continue;
    const value = decodeValue(tag, bytes);
    if (value === undefined) throw new Error('Invalid IPP value type');
    (attributes[name] ??= []).push(value);
  }
  if (!ended || collectionDepth || offset !== body.length) throw new Error('Incomplete IPP attributes response');
  return { statusCode, attributes };
}

export type IppPrinterDependencies = {
  interfaces?: () => Promise<LanDiscoveryInterface[]>;
  request?: IppHttpTransport;
  requestId?: () => number;
};

export async function readNetworkPrinterStatus(target: IppPrinterTarget, deps: IppPrinterDependencies = {}) {
  const observedAt = new Date().toISOString();
  let phase: 'request' | 'headers' | 'body' | 'decode' = 'request';
  let timeoutPhase: 'headers' | 'body' | undefined;
  const limitations = ['Read-only Get-Printer-Attributes; this does not prove a print job can complete.', 'Network printer state is separate from installed Windows queue state. A failed query does not establish that the physical device is offline.'];
  try {
    if (!target || typeof target.address !== 'string' || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
      || typeof target.resourcePath !== 'string' || !target.resourcePath.startsWith('/') || target.resourcePath.startsWith('//')
      || target.resourcePath.length > 1024 || /[\s\\?#\u0000-\u001f\u007f]/.test(target.resourcePath)) {
      throw new Error('Use the literal LAN IPv4 address, port and resource path supplied by discovery or the user');
    }
    const interfaces = await (deps.interfaces ?? getPhysicalLanInterfaces)();
    if (!isOnLan(target.address, interfaces)) throw new Error('Printer address is not a peer on a physical private LAN interface');
    const httpUrl = new URL('http://' + target.address + ':' + target.port + target.resourcePath);
    const printerUri = 'ipp://' + httpUrl.host + httpUrl.pathname;
    const requestId = (deps.requestId ?? (() => randomInt(1, 0x7fffffff)))();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timeoutPhase = phase === 'body' ? 'body' : 'headers';
      controller.abort();
    }, 5000);
    try {
      phase = 'headers';
      const response = await (deps.request ?? requestIppHttp)(httpUrl, encodePrinterAttributesRequest(printerUri, requestId), controller.signal);
      phase = 'body';
      const contentType = response.headers.get('content-type');
      if (response.status !== 200 || (contentType !== null && !/^application\/ipp(?:\s*;|$)/i.test(contentType))) {
        await response.body?.cancel();
        throw new Error('Printer returned HTTP ' + response.status + ' without a valid IPP response');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty IPP response');
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error('IPP response exceeds size limit'); }
          chunks.push(Buffer.from(item.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      phase = 'decode';
      const parsed = decodePrinterAttributesResponse(Buffer.concat(chunks), requestId);
      // Some endpoints omit MIME metadata. Only a complete, strictly decoded IPP response can compensate for it.
      const warnings = contentType === null ? [{ code: 'missing_content_type', message: 'Printer response omitted Content-Type; accepted only after complete HTTP body and IPP request-id validation.' }] : [];
      if (parsed.statusCode >= 0x0100) {
        return { ok: false, status: 'query_failed', scope: 'control_center_lan', observedAt, target, ippStatusCode: parsed.statusCode, warnings, limitations };
      }
      const stateValue = parsed.attributes['printer-state']?.[0];
      const state = ({ 3: 'idle', 4: 'processing', 5: 'stopped' } as Record<number, string>)[Number(stateValue)] ?? 'unknown';
      return { ok: true, status: 'observed', scope: 'control_center_lan', observedAt, target, ippStatusCode: parsed.statusCode, state, attributes: parsed.attributes, warnings, limitations };
    } finally { clearTimeout(timer); }
  } catch (error) {
    const errorCode = timeoutPhase ? timeoutPhase + '_timeout'
      : phase === 'request' || phase === 'headers' ? 'request_failed' : 'response_invalid';
    const message = timeoutPhase
      ? 'IPP query timed out after 5000ms while ' + (timeoutPhase === 'headers' ? 'waiting for response headers' : 'reading response body')
      : error instanceof Error ? error.message : String(error);
    return { ok: false, status: 'unavailable', scope: 'control_center_lan', observedAt, target,
      phase, errorCode, error: message, limitations };
  }
}
