import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { downloadPublicMedia } from '../tools/media_artifact';
import type { ChatSongLine, ChatSongReactionCandidate, ChatSongReactionSearch } from '../../shared/chat_song';

type Scope = { userId: string; projectId: string; revision: number };
type Image = { bytes: Buffer; sha256: string; width: number; height: number; expires: number };
type Candidate = { scope: Scope; lineHash: string; imageKey: string; value: ChatSongReactionCandidate; expires: number };
const images = new Map<string, Image>(), candidates = new Map<string, Candidate>();
const TTL = 15 * 60_000, MAX_CACHE_BYTES = 32 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const lineHash = (line: ChatSongLine) => hash(JSON.stringify(line));
const sameScope = (a: Scope, b: Scope) => a.userId === b.userId && a.projectId === b.projectId && a.revision === b.revision;
const plain = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const matchText = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function trimCache() {
  for (const [key, item] of images) if (item.expires < Date.now()) images.delete(key);
  let size = [...images.values()].reduce((sum, item) => sum + item.bytes.length, 0);
  for (const [key, item] of images) { if (size <= MAX_CACHE_BYTES) break; images.delete(key); size -= item.bytes.length; }
  for (const [key, item] of candidates) if (item.expires < Date.now() || !images.has(item.imageKey)) candidates.delete(key);
  while (candidates.size > 256) candidates.delete(candidates.keys().next().value!);
}

/** Parse only the fixed public site's picture cards, with literal query/title agreement. */
export function parseChatSongReactionResults(html: string, query: string) {
  const result: { title: string; sourceUrl: string; imageUrl: string }[] = [];
  for (const card of html.matchAll(/<a\b[^>]*href="(\/picture\/\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const image = card[2].match(/<img\b[^>]*>/)?.[0], title = plain(image?.match(/\balt="([^"]*)"/)?.[1] || '').trim();
    const imageUrl = plain(image?.match(/\bsrc="([^"]*)"/)?.[1] || '');
    if (!title || !matchText(query) || !matchText(title).includes(matchText(query))) continue;
    let url: URL; try { url = new URL(imageUrl); } catch { continue; }
    if (url.origin !== 'https://img.adoutu.com' || !/^\/picture\/[\w.-]+\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname) || url.search || url.hash) continue;
    if (!result.some(item => item.imageUrl === imageUrl)) result.push({ title: title.slice(0, 200), sourceUrl: 'https://www.adoutu.com' + card[1], imageUrl });
    if (result.length === 3) break;
  }
  return result;
}

async function verifiedImage(url: string, signal: AbortSignal): Promise<Image> {
  const cached = images.get(url); if (cached && cached.expires > Date.now()) return cached;
  const downloaded = await downloadPublicMedia(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 8_000, signal,
    headers: { Referer: 'https://www.adoutu.com/', 'User-Agent': 'Mozilla/5.0' } });
  if (!/^image\/(?:png|jpe?g|webp|gif)(?:;|$)/i.test(downloaded.contentType)) throw new Error('The search result is not an image.');
  const image = (sharp as any)(downloaded.bytes, { limitInputPixels: 4_000_000, animated: false });
  const metadata = await image.metadata();
  if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format || '') || !metadata.width || !metadata.height) throw new Error('The search image could not be decoded.');
  const normalized = await image.rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  signal.throwIfAborted();
  const value = { bytes: normalized.data, sha256: hash(normalized.data), width: normalized.info.width, height: normalized.info.height, expires: Date.now() + TTL };
  images.set(url, value); trimCache(); return value;
}

export async function searchChatSongReactions(scope: Scope, lines: ChatSongLine[], options: { signal?: AbortSignal; blocked?: boolean; skip?: boolean } = {}): Promise<ChatSongReactionSearch[]> {
  options.signal?.throwIfAborted(); trimCache();
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(20_000)]);
  const searches = new Map<string, Promise<{ rows: Awaited<ReturnType<typeof verifiedRows>>; unavailable: boolean }>>();
  const downloads = new Map<string, Promise<Image>>();
  async function verifiedRows(query: string) {
    const response = await downloadPublicMedia('https://www.adoutu.com/search?keyword=' + encodeURIComponent(query), { maxBytes: 1_048_576, timeoutMs: 8_000, signal });
    if (!response.contentType.includes('text/html')) throw new Error('The search response was not HTML.');
    const rows = [], foundRows = parseChatSongReactionResults(response.bytes.toString('utf8'), query);
    for (const found of foundRows) {
      try {
        let operation = downloads.get(found.imageUrl); if (!operation) { operation = verifiedImage(found.imageUrl, signal); downloads.set(found.imageUrl, operation); }
        rows.push({ ...found, image: await operation });
      } catch { options.signal?.throwIfAborted(); }
      if (rows.length === 2) break;
    }
    if (foundRows.length && !rows.length) throw new Error('Search matches had no retrievable decoded image.');
    return rows;
  }
  const results: ChatSongReactionSearch[] = new Array(lines.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, lines.length) }, async () => {
    while (next < lines.length) {
      const index = next++, line = lines[index], query = line.reaction.trim();
      const result: ChatSongReactionSearch = { lineId: line.id, query, status: !query ? 'empty' : options.skip ? 'skipped' : options.blocked ? 'privacy_blocked' : 'no_match', candidates: [] };
      results[index] = result;
      if (result.status !== 'no_match') continue;
      if (query.length > 48) { result.status = 'no_match'; continue; }
      let operation = searches.get(query);
      if (!operation) { operation = verifiedRows(query).then(rows => ({ rows, unavailable: false })).catch(() => ({ rows: [], unavailable: true })); searches.set(query, operation); }
      const found = await operation; options.signal?.throwIfAborted();
      if (!found.rows.length) { result.status = found.unavailable ? 'unavailable' : 'no_match'; continue; }
      for (const row of found.rows) {
        const id = hash(JSON.stringify([scope, lineHash(line), row.sourceUrl, row.imageUrl, row.image.sha256]));
        const value: ChatSongReactionCandidate = { id, lineId: line.id, title: row.title, query, sourceUrl: row.sourceUrl, imageUrl: row.imageUrl,
          previewUrl: `/api/creative/chat-songs/${scope.projectId}/reactions/${id}/preview`, width: row.image.width, height: row.image.height, sha256: row.image.sha256 };
        candidates.set(id, { scope: { ...scope }, lineHash: lineHash(line), imageKey: row.imageUrl, value, expires: Date.now() + TTL });
        result.candidates.push(value);
      }
      result.status = 'matched';
    }
  }));
  trimCache(); return results;
}

export function chatSongReactionCandidate(scope: Scope, id: unknown, line?: ChatSongLine) {
  trimCache(); if (typeof id !== 'string') return null;
  const candidate = candidates.get(id), image = candidate && images.get(candidate.imageKey);
  if (!candidate || !image || !sameScope(scope, candidate.scope) || (line && candidate.lineHash !== lineHash(line))) return null;
  return { candidate: { ...candidate.value }, bytes: image.bytes };
}
