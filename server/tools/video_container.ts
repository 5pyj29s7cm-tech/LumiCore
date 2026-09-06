/** Bounded structural validation, not codec decoding or a visual quality test. */
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ITEMS = 100_000;
const MAX_SAMPLES = 1_000_000;

export interface VerifiedVideoContainer {
  extension: 'mp4' | 'webm';
  verification: { strategy: 'container_and_video_samples'; videoTracks: number; videoSamples: number; decoded: false };
}

function invalid(detail: string): never {
  throw new Error(`Generated video container validation failed: ${detail}`);
}
function requireVideo(condition: unknown, detail: string): asserts condition {
  if (!condition) invalid(detail);
}
function integer64(bytes: Buffer, offset: number): number {
  requireVideo(offset >= 0 && offset + 8 <= bytes.length, 'truncated 64-bit value');
  const value = bytes.readBigUInt64BE(offset);
  requireVideo(value <= BigInt(Number.MAX_SAFE_INTEGER), 'out-of-range 64-bit value');
  return Number(value);
}

interface Box { type: string; start: number; data: number; end: number }
function validateMp4(bytes: Buffer): VerifiedVideoContainer {
  let items = 0;
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    for (let position = start; position < end;) {
      requireVideo(++items <= MAX_ITEMS && position + 8 <= end, 'truncated or excessive MP4 boxes');
      let size = bytes.readUInt32BE(position);
      const type = bytes.toString('ascii', position + 4, position + 8);
      let header = 8;
      if (size === 1) { requireVideo(position + 16 <= end, 'truncated extended MP4 box'); size = integer64(bytes, position + 8); header = 16; }
      else if (size === 0) size = end - position;
      requireVideo(size >= header && position + size <= end, `invalid ${type} box length`);
      result.push({ type, start: position, data: position + header, end: position + size });
      position += size;
    }
    return result;
  }
  function child(parent: Box, type: string, required = true): Box | undefined {
    const matches = boxes(parent.data, parent.end).filter(box => box.type === type);
    requireVideo(matches.length <= 1 && (!required || matches.length === 1), `missing or duplicate ${type} box`);
    return matches[0];
  }
  function field(box: Box, relative: number, length = 4): number {
    requireVideo(relative >= 0 && box.data + relative + length <= box.end, `truncated ${box.type} field`);
    return box.data + relative;
  }
  function table(box: Box, width: number): { count: number; start: number } {
    const count = bytes.readUInt32BE(field(box, 4));
    requireVideo(count <= MAX_SAMPLES && box.data + 8 + count * width === box.end, `invalid ${box.type} table`);
    return { count, start: box.data + 8 };
  }
  const top = boxes(0, bytes.length);
  const ftyp = top.filter(box => box.type === 'ftyp');
  requireVideo(ftyp.length === 1 && ftyp[0].end - ftyp[0].data >= 8, 'missing file type');
  const movies = top.filter(box => box.type === 'moov');
  requireVideo(movies.length === 1, 'missing or duplicate movie metadata');
  const media = top.filter(box => box.type === 'mdat');
  requireVideo(media.length > 0, 'missing sample data');
  function sampleRange(start: number, size: number): void {
    requireVideo(Number.isSafeInteger(start) && size > 0 && Number.isSafeInteger(size)
      && media.some(box => start >= box.data && start + size <= box.end), 'video sample is outside media data');
  }
  const videoTracks = new Map<number, { descriptions: number; samples: number }>();
  const tracks = boxes(movies[0].data, movies[0].end).filter(box => box.type === 'trak');
  requireVideo(tracks.length > 0 && tracks.length <= 64, 'missing or excessive tracks');
  for (const track of tracks) {
    const mdia = child(track, 'mdia')!;
    const hdlr = child(mdia, 'hdlr')!;
    if (bytes.toString('ascii', field(hdlr, 8), hdlr.data + 12) !== 'vide') continue;
    const tkhd = child(track, 'tkhd')!;
    const tkhdVersion = bytes[field(tkhd, 0, 1)];
    requireVideo(tkhdVersion <= 1, 'unsupported track header version');
    const id = bytes.readUInt32BE(field(tkhd, tkhdVersion === 1 ? 20 : 12));
    requireVideo(id > 0 && !videoTracks.has(id), 'invalid video track identity');
    const mdhd = child(mdia, 'mdhd')!;
    const version = bytes[field(mdhd, 0, 1)];
    requireVideo(version <= 1 && bytes.readUInt32BE(field(mdhd, version === 1 ? 20 : 12)) > 0, 'invalid video timescale');
    const minf = child(mdia, 'minf')!;
    const dref = child(child(minf, 'dinf')!, 'dref')!;
    const references = boxes(dref.data + 8, dref.end);
    requireVideo(bytes.readUInt32BE(field(dref, 4)) === references.length && references.length > 0, 'invalid sample data references');
    const stbl = child(minf, 'stbl')!;
    const stsd = child(stbl, 'stsd')!;
    const descriptions = bytes.readUInt32BE(field(stsd, 4));
    const entries = boxes(stsd.data + 8, stsd.end);
    requireVideo(descriptions > 0 && descriptions <= 32 && entries.length === descriptions, 'invalid video descriptions');
    for (const entry of entries) {
      requireVideo(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp08', 'vp09', 'av01'].includes(entry.type), `unsupported video codec ${entry.type}`);
      const referenceIndex = bytes.readUInt16BE(field(entry, 6, 2));
      const reference = references[referenceIndex - 1];
      requireVideo(reference?.type === 'url ' && (bytes.readUInt32BE(field(reference, 0)) & 1) === 1, 'external video data references are unsupported');
      const width = bytes.readUInt16BE(field(entry, 24, 2));
      const height = bytes.readUInt16BE(field(entry, 26, 2));
      requireVideo(width > 0 && height > 0 && width <= 16384 && height <= 16384, 'invalid video dimensions');
      field(entry, 0, 78);
      const config = boxes(entry.data + 78, entry.end);
      const requiredConfig = /^(avc)/.test(entry.type) ? 'avcC' : /^(hvc|hev)/.test(entry.type) ? 'hvcC'
        : entry.type === 'mp4v' ? 'esds' : entry.type === 'av01' ? 'av1C' : 'vpcC';
      const minimum = requiredConfig === 'avcC' ? 7 : requiredConfig === 'hvcC' ? 23 : requiredConfig === 'esds' ? 5 : 4;
      requireVideo(config.some(box => box.type === requiredConfig && box.end - box.data >= minimum), 'missing video decoder configuration');
    }
    const stsz = child(stbl, 'stsz')!;
    const commonSize = bytes.readUInt32BE(field(stsz, 4));
    const sampleCount = bytes.readUInt32BE(field(stsz, 8));
    requireVideo(sampleCount <= MAX_SAMPLES && stsz.data + 12 + (commonSize ? 0 : sampleCount * 4) === stsz.end, 'invalid sample size table');
    const sizes = (index: number) => commonSize || bytes.readUInt32BE(stsz.data + 12 + index * 4);
    const stts = child(stbl, 'stts')!;
    const timing = table(stts, 8);
    let timedSamples = 0;
    for (let index = 0; index < timing.count; index++) {
      const count = bytes.readUInt32BE(timing.start + index * 8);
      requireVideo(count > 0 && bytes.readUInt32BE(timing.start + index * 8 + 4) > 0, 'invalid sample timing');
      timedSamples += count;
    }
    requireVideo(timedSamples === sampleCount, 'sample timing count mismatch');
    const stsc = child(stbl, 'stsc')!;
    const mapping = table(stsc, 12);
    const stco = child(stbl, 'stco', false);
    const co64 = child(stbl, 'co64', false);
    requireVideo(Boolean(stco) !== Boolean(co64), 'missing or ambiguous chunk offsets');
    const offsets = table((stco || co64)!, stco ? 4 : 8);
    let nextSample = 0;
    let mapIndex = 0;
    let priorFirst = 0;
    for (let index = 0; index < mapping.count; index++) {
      const first = bytes.readUInt32BE(mapping.start + index * 12);
      const perChunk = bytes.readUInt32BE(mapping.start + index * 12 + 4);
      const description = bytes.readUInt32BE(mapping.start + index * 12 + 8);
      requireVideo(first > priorFirst && first <= offsets.count && perChunk > 0 && description > 0 && description <= descriptions, 'invalid sample-to-chunk map');
      if (index === 0) requireVideo(first === 1, 'chunk map does not start at first chunk');
      priorFirst = first;
    }
    requireVideo(sampleCount === 0 ? offsets.count === 0 && mapping.count === 0 : offsets.count > 0 && mapping.count > 0, 'missing video chunk mapping');
    for (let chunk = 1; chunk <= offsets.count; chunk++) {
      while (mapIndex + 1 < mapping.count && bytes.readUInt32BE(mapping.start + (mapIndex + 1) * 12) <= chunk) mapIndex++;
      const perChunk = bytes.readUInt32BE(mapping.start + mapIndex * 12 + 4);
      let offset = stco ? bytes.readUInt32BE(offsets.start + (chunk - 1) * 4) : integer64(bytes, offsets.start + (chunk - 1) * 8);
      requireVideo(nextSample + perChunk <= sampleCount, 'too many chunk samples');
      for (let index = 0; index < perChunk; index++) { const size = sizes(nextSample++); sampleRange(offset, size); offset += size; }
    }
    requireVideo(nextSample === sampleCount, 'unreferenced video samples');
    videoTracks.set(id, { descriptions, samples: sampleCount });
  }
  requireVideo(videoTracks.size > 0, 'no video track');

  const defaults = new Map<number, { description: number; duration: number; size: number }>();
  const mvex = child(movies[0], 'mvex', false);
  if (mvex) for (const box of boxes(mvex.data, mvex.end).filter(box => box.type === 'trex')) {
    const id = bytes.readUInt32BE(field(box, 4));
    requireVideo(!defaults.has(id), 'duplicate fragment defaults');
    defaults.set(id, { description: bytes.readUInt32BE(field(box, 8)), duration: bytes.readUInt32BE(field(box, 12)), size: bytes.readUInt32BE(field(box, 16)) });
  }
  for (const moof of top.filter(box => box.type === 'moof')) {
    requireVideo(mvex, 'fragment without movie extension');
    for (const [trafIndex, traf] of boxes(moof.data, moof.end).filter(box => box.type === 'traf').entries()) {
      const tfhd = child(traf, 'tfhd')!;
      const flags = bytes.readUInt32BE(field(tfhd, 0)) & 0xffffff;
      const id = bytes.readUInt32BE(field(tfhd, 4));
      const track = videoTracks.get(id);
      if (!track) continue;
      requireVideo(flags & 1 || flags & 0x020000 || trafIndex === 0, 'implicit base addressing after another track fragment is unsupported');
      const defaultValues = defaults.get(id);
      requireVideo(defaultValues, 'missing video fragment defaults');
      let cursor = 8;
      const base = flags & 1 ? integer64(bytes, field(tfhd, cursor, 8)) : moof.start;
      if (flags & 1) cursor += 8;
      const description = flags & 2 ? bytes.readUInt32BE(field(tfhd, cursor)) : defaultValues.description;
      if (flags & 2) cursor += 4;
      const duration = flags & 8 ? bytes.readUInt32BE(field(tfhd, cursor)) : defaultValues.duration;
      if (flags & 8) cursor += 4;
      const size = flags & 16 ? bytes.readUInt32BE(field(tfhd, cursor)) : defaultValues.size;
      if (flags & 16) cursor += 4;
      if (flags & 32) { field(tfhd, cursor); cursor += 4; }
      requireVideo(tfhd.data + cursor === tfhd.end && description > 0 && description <= track.descriptions, 'invalid fragment header');
      let previousEnd: number | undefined;
      for (const trun of boxes(traf.data, traf.end).filter(box => box.type === 'trun')) {
        const runFlags = bytes.readUInt32BE(field(trun, 0)) & 0xffffff;
        const count = bytes.readUInt32BE(field(trun, 4));
        requireVideo(count <= MAX_SAMPLES && track.samples + count <= MAX_SAMPLES, 'excessive fragment samples');
        let position = 8;
        let offset = runFlags & 1 ? base + bytes.readInt32BE(field(trun, position)) : previousEnd ?? base;
        if (runFlags & 1) position += 4;
        if (runFlags & 4) { field(trun, position); position += 4; }
        for (let index = 0; index < count; index++) {
          const sampleDuration = runFlags & 0x100 ? bytes.readUInt32BE(field(trun, position)) : duration;
          if (runFlags & 0x100) position += 4;
          const sampleSize = runFlags & 0x200 ? bytes.readUInt32BE(field(trun, position)) : size;
          if (runFlags & 0x200) position += 4;
          if (runFlags & 0x400) { field(trun, position); position += 4; }
          if (runFlags & 0x800) { field(trun, position); position += 4; }
          requireVideo(sampleDuration > 0, 'invalid fragment sample duration');
          sampleRange(offset, sampleSize); offset += sampleSize;
        }
        requireVideo(trun.data + position === trun.end, 'invalid fragment run length');
        track.samples += count; previousEnd = offset;
      }
    }
  }
  const videoSamples = [...videoTracks.values()].reduce((sum, track) => sum + track.samples, 0);
  requireVideo(videoSamples > 0, 'no video samples');
  return { extension: 'mp4', verification: { strategy: 'container_and_video_samples', videoTracks: videoTracks.size, videoSamples, decoded: false } };
}

interface Element { id: number; data: number; end: number }
function validateWebm(bytes: Buffer): VerifiedVideoContainer {
  let items = 0;
  function vint(position: number, end: number, identifier = false): { value: number; width: number; unknown: boolean } {
    requireVideo(position < end && bytes[position] !== 0, 'truncated EBML integer');
    let width = 1;
    while (width <= 8 && !(bytes[position] & (1 << (8 - width)))) width++;
    requireVideo(width <= (identifier ? 4 : 8) && position + width <= end, 'invalid EBML integer');
    let value = BigInt(identifier ? bytes[position] : bytes[position] & ((1 << (8 - width)) - 1));
    for (let index = 1; index < width; index++) value = (value << 8n) | BigInt(bytes[position + index]);
    const unknown = !identifier && value === (1n << BigInt(7 * width)) - 1n;
    requireVideo(unknown || value <= BigInt(Number.MAX_SAFE_INTEGER), 'out-of-range EBML integer');
    return { value: unknown && width === 8 ? 0 : Number(value), width, unknown };
  }
  function elements(start: number, end: number, segmentUnknown = false): Element[] {
    const result: Element[] = [];
    for (let cursor = start; cursor < end;) {
      requireVideo(++items <= MAX_ITEMS, 'excessive EBML elements');
      const id = vint(cursor, end, true); cursor += id.width;
      const size = vint(cursor, end); cursor += size.width;
      requireVideo(!size.unknown || segmentUnknown && id.value === 0x18538067, 'unsupported unknown EBML element length');
      const limit = size.unknown ? end : cursor + size.value;
      requireVideo(limit <= end, 'truncated EBML element');
      result.push({ id: id.value, data: cursor, end: limit }); cursor = limit;
    }
    return result;
  }
  function only(list: Element[], id: number): Element {
    const result = list.filter(element => element.id === id);
    requireVideo(result.length === 1, `missing or duplicate EBML ${id.toString(16)}`);
    return result[0];
  }
  function uint(element: Element): number {
    const size = element.end - element.data;
    requireVideo(size > 0 && size <= 6, 'invalid EBML unsigned value');
    return bytes.readUIntBE(element.data, size);
  }
  const roots = elements(0, bytes.length, true);
  const ebml = only(roots, 0x1a45dfa3);
  const docType = only(elements(ebml.data, ebml.end), 0x4282);
  requireVideo(bytes.toString('ascii', docType.data, docType.end) === 'webm', 'unsupported EBML document type');
  const segment = only(roots, 0x18538067);
  const children = elements(segment.data, segment.end);
  const tracksElement = only(children, 0x1654ae6b);
  const tracks = new Map<number, boolean>();
  for (const entry of elements(tracksElement.data, tracksElement.end).filter(element => element.id === 0xae)) {
    const fields = elements(entry.data, entry.end);
    const number = uint(only(fields, 0xd7));
    requireVideo(number > 0 && tracks.size < 64 && !tracks.has(number), 'invalid WebM track identity');
    const isVideo = uint(only(fields, 0x83)) === 1;
    tracks.set(number, isVideo);
    if (!isVideo) continue;
    const codec = only(fields, 0x86);
    requireVideo(['V_VP8', 'V_VP9', 'V_AV1'].includes(bytes.toString('ascii', codec.data, codec.end)), 'unsupported WebM video codec');
    const video = only(fields, 0xe0);
    const parameters = elements(video.data, video.end);
    const width = uint(only(parameters, 0xb0)); const height = uint(only(parameters, 0xba));
    requireVideo(width > 0 && height > 0 && width <= 16384 && height <= 16384, 'invalid WebM video dimensions');
  }
  const videoTracks = [...tracks.values()].filter(Boolean).length;
  requireVideo(videoTracks > 0, 'no WebM video track');
  let videoSamples = 0;
  function block(element: Element): void {
    const track = vint(element.data, element.end);
    requireVideo(tracks.has(track.value), 'unknown block track');
    let cursor = element.data + track.width;
    requireVideo(cursor + 3 < element.end, 'empty or truncated video block');
    const flags = bytes[cursor + 2]; cursor += 3;
    const lacing = (flags >> 1) & 3;
    let count = 1;
    if (lacing) {
      count = bytes[cursor++] + 1;
      requireVideo(count > 1 && cursor < element.end, 'invalid block lace count');
      if (lacing === 2) requireVideo((element.end - cursor) % count === 0 && element.end - cursor >= count, 'invalid fixed-size lacing');
      else {
        let total = 0;
        let previous = 0;
        for (let index = 0; index < count - 1; index++) {
          let size = 0;
          if (lacing === 1) {
            let value: number;
            do { requireVideo(cursor < element.end, 'truncated Xiph lacing'); value = bytes[cursor++]; size += value; } while (value === 255);
          } else {
            const value = vint(cursor, element.end); cursor += value.width;
            requireVideo(value.width <= 6, 'invalid EBML lacing');
            size = index === 0 ? value.value : previous + value.value - (2 ** (7 * value.width - 1) - 1);
          }
          requireVideo(size > 0, 'empty lace frame'); previous = size; total += size;
        }
        requireVideo(total < element.end - cursor, 'lace frames exceed block data');
      }
    }
    if (tracks.get(track.value)) { videoSamples += count; requireVideo(videoSamples <= MAX_SAMPLES, 'excessive video frames'); }
  }
  for (const cluster of children.filter(element => element.id === 0x1f43b675)) {
    const entries = elements(cluster.data, cluster.end);
    uint(only(entries, 0xe7));
    for (const entry of entries) {
      if (entry.id === 0xa3) block(entry);
      else if (entry.id === 0xa0) block(only(elements(entry.data, entry.end), 0xa1));
    }
  }
  requireVideo(videoSamples > 0, 'no WebM video frames');
  return { extension: 'webm', verification: { strategy: 'container_and_video_samples', videoTracks, videoSamples, decoded: false } };
}

export function validateVideoContainer(bytes: Buffer): VerifiedVideoContainer {
  requireVideo(bytes.length > 0 && bytes.length <= MAX_BYTES, 'empty or oversized result');
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return validateWebm(bytes);
  return validateMp4(bytes);
}
