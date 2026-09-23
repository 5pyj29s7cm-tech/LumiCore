import {
  ECOMMERCE_REPORT_ROW_LIMIT,
  parseDelimitedReport,
  parseReviewPaste,
  type EcommerceTable,
  type EcommerceTableRow,
} from './workbench';

export const REVIEW_SOURCE_SCHEMA_VERSION = '1.0';
export const REVIEW_SOURCE_PAGE_LIMIT = 500;

export type ReviewSourceFormat = 'auto' | 'csv' | 'tsv' | 'json' | 'jsonl' | 'plain';
export type ReviewReplyStatus = 'replied' | 'unreplied' | 'unknown';

export interface ReviewSourceColumnMapping {
  reviewId?: string;
  platform?: string;
  storeId?: string;
  productId?: string;
  sku?: string;
  rating?: string;
  content?: string;
  createdAt?: string;
  verifiedPurchase?: string;
  replyStatus?: string;
  sourceUrl?: string;
  helpfulCount?: string;
}

export interface ReviewSourceNormalizeArgs {
  sourceText?: string;
  sourceFormat?: ReviewSourceFormat;
  platform?: string;
  storeId?: string;
  mapping?: ReviewSourceColumnMapping;
  cursor?: number;
  limit?: number;
}

export interface NormalizedReviewRecord {
  schemaVersion: typeof REVIEW_SOURCE_SCHEMA_VERSION;
  dedupeKey: string;
  reviewId: string;
  platform: string;
  storeId: string;
  productId: string;
  sku: string;
  rating: number | null;
  content: string;
  createdAt: string | null;
  verifiedPurchase: boolean | null;
  replyStatus: ReviewReplyStatus;
  sourceUrl: string | null;
  helpfulCount: number;
}

export interface ReviewSourceNormalization {
  records: NormalizedReviewRecord[];
  source: {
    requestedFormat: ReviewSourceFormat;
    detectedFormat: Exclude<ReviewSourceFormat, 'auto'>;
    importedCount: number;
    normalizedCount: number;
    deduplicatedCount: number;
    rejectedCount: number;
    piiMaskedCount: number;
    generatedIdCount: number;
    mappedFields: string[];
    platform: string;
    storeId: string;
  };
  warnings: string[];
}

type JsonRecord = Record<string, unknown>;

interface ParsedSource {
  format: Exclude<ReviewSourceFormat, 'auto'>;
  records: JsonRecord[];
}

interface FieldDefinition {
  aliases: string[];
}

const REVIEW_SOURCE_FIELDS: Record<keyof ReviewSourceColumnMapping, FieldDefinition> = {
  reviewId: { aliases: ['review_id', 'review id', 'comment_id', 'comment id', '评价id', '评论id', '评价编号', '评论编号', 'id'] }, // i18n-allow -- marketplace field aliases
  platform: { aliases: ['platform', 'channel', 'marketplace', '平台', '渠道'] }, // i18n-allow -- marketplace field aliases
  storeId: { aliases: ['store_id', 'store id', 'shop_id', 'shop id', '店铺id', '门店id', '店铺编号'] }, // i18n-allow -- marketplace field aliases
  productId: { aliases: ['product_id', 'product id', 'item_id', 'item id', 'goods_id', 'goods id', '商品id', '商品编号'] }, // i18n-allow -- marketplace field aliases
  sku: { aliases: ['sku', 'sku_id', 'merchant sku', 'variant sku', '商家编码', '商品sku', '规格编码', '商品编码', '货号'] }, // i18n-allow -- marketplace field aliases
  rating: { aliases: ['rating', 'stars', 'star rating', 'score', '评分', '星级', '商品评分', '评价星级', '评论星级'] }, // i18n-allow -- marketplace field aliases
  content: { aliases: ['content', 'body', 'text', 'review', 'comment', 'review content', 'comment content', '评价内容', '评论内容', '买家评价', '用户评价', '评价', '评论'] }, // i18n-allow -- marketplace field aliases
  createdAt: { aliases: ['created_at', 'created at', 'review date', 'comment date', 'date', 'time', '评价时间', '评论时间', '创建时间', '提交时间'] }, // i18n-allow -- marketplace field aliases
  verifiedPurchase: { aliases: ['verified_purchase', 'verified purchase', 'verified', 'is_verified', '已购', '已验证购买', '真实购买'] }, // i18n-allow -- marketplace field aliases
  replyStatus: { aliases: ['reply_status', 'reply status', 'response_status', 'response status', 'replied', '回复状态', '商家回复状态', '是否回复'] }, // i18n-allow -- marketplace field aliases
  sourceUrl: { aliases: ['source_url', 'source url', 'review_url', 'review url', 'url', 'link', '评价链接', '评论链接', '来源链接'] }, // i18n-allow -- marketplace field aliases
  helpfulCount: { aliases: ['helpful_count', 'helpful count', 'helpful', 'likes', 'like count', '点赞数', '有用数', '赞数'] }, // i18n-allow -- marketplace field aliases
};

function normalizeKey(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_.\-/\\()[\]{}:：]+/g, '');
}

function flattenRecord(value: unknown, prefix = '', output: JsonRecord = {}, depth = 0): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return output;
  for (const [key, nested] of Object.entries(value as JsonRecord)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (nested === null || ['string', 'number', 'boolean'].includes(typeof nested)) {
      output[path] = nested;
    } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      flattenRecord(nested, path, output, depth + 1);
    }
  }
  return output;
}

function looksLikeReviewRecord(value: JsonRecord): boolean {
  const keys = Object.keys(flattenRecord(value)).map(normalizeKey);
  return ['content', 'body', 'text', 'review', 'comment', '评价内容', '评论内容', 'rating', '评分'] // i18n-allow -- review input field recognition
    .some(alias => keys.includes(normalizeKey(alias)));
}

function recordsFromJson(value: unknown, depth = 0): JsonRecord[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as JsonRecord[];
  if (!value || typeof value !== 'object') return [];
  const record = value as JsonRecord;
  for (const key of ['reviews', 'items', 'records', 'results', 'comments', 'data']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const nested = recordsFromJson(record[key], depth + 1);
    if (nested.length > 0) return nested;
  }
  return looksLikeReviewRecord(record) ? [record] : [];
}

function parseJsonLines(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of text.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
    const parsed = JSON.parse(line) as unknown;
    const extracted = recordsFromJson(parsed);
    if (extracted.length === 0) throw new Error('Each JSONL line must contain a review object.');
    records.push(...extracted);
  }
  return records;
}

function tableRecords(table: EcommerceTable): JsonRecord[] {
  return table.rows.map(row => ({ ...row }));
}

function parseSource(text: string, requested: ReviewSourceFormat): ParsedSource {
  const trimmed = text.trim();
  const parseJson = (): JsonRecord[] => {
    const records = recordsFromJson(JSON.parse(trimmed) as unknown);
    if (records.length === 0) throw new Error('JSON must contain a review array or a recognized reviews/items/records/results/data envelope.');
    return records;
  };

  if (requested === 'json') return { format: 'json', records: parseJson() };
  if (requested === 'jsonl') return { format: 'jsonl', records: parseJsonLines(trimmed) };
  if (requested === 'csv' || requested === 'tsv') {
    return { format: requested, records: tableRecords(parseDelimitedReport(trimmed)) };
  }
  if (requested === 'plain') return { format: 'plain', records: tableRecords(parseReviewPaste(trimmed)) };

  if (/^[\[{]/.test(trimmed)) {
    try {
      return { format: 'json', records: parseJson() };
    } catch {
      try {
        return { format: 'jsonl', records: parseJsonLines(trimmed) };
      } catch {
        return { format: 'plain', records: tableRecords(parseReviewPaste(trimmed)) };
      }
    }
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0] || '';
  const tableLike = /\t|;/.test(firstLine)
    || (firstLine.includes(',') && /(sku|评价|评论|review|comment|rating|评分|星级)/i.test(firstLine)); // i18n-allow -- pasted-header recognition
  if (tableLike) {
    const delimiter = firstLine.includes('\t') ? 'tsv' : 'csv';
    return { format: delimiter, records: tableRecords(parseDelimitedReport(trimmed)) };
  }
  return { format: 'plain', records: tableRecords(parseReviewPaste(trimmed)) };
}

function resolveMapping(records: JsonRecord[], overrides: ReviewSourceColumnMapping): ReviewSourceColumnMapping {
  const available = Array.from(new Set(records.slice(0, 100).flatMap(record => Object.keys(flattenRecord(record)))));
  const normalizedAvailable = available.map(key => ({ key, normalized: normalizeKey(key) }));
  return Object.fromEntries((Object.keys(REVIEW_SOURCE_FIELDS) as Array<keyof ReviewSourceColumnMapping>).map(field => {
    const override = overrides[field];
    if (override) return [field, available.includes(override) ? override : undefined];
    const aliases = REVIEW_SOURCE_FIELDS[field].aliases.map(normalizeKey).sort((left, right) => right.length - left.length);
    const exact = normalizedAvailable.find(item => aliases.includes(item.normalized));
    if (exact) return [field, exact.key];
    const prefixed = normalizedAvailable.find(item => aliases.some(alias => alias.length >= 4 && item.normalized.endsWith(alias)));
    return [field, prefixed?.key];
  }).filter(([, value]) => Boolean(value))) as ReviewSourceColumnMapping;
}

function valueAt(record: JsonRecord, mappedKey: string | undefined): unknown {
  if (!mappedKey) return undefined;
  return flattenRecord(record)[mappedKey];
}

function cleanIdentifier(value: unknown, fallback: string): string {
  const text = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (text || fallback).slice(0, 160);
}

function maskReviewContent(value: unknown): { content: string; masked: boolean } {
  const original = String(value ?? '').normalize('NFKC');
  const privacyMasked = original
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/g, '[phone]')
    .replace(/(?:微信(?:号)?|wechat|wx|qq)\s*[:：]?\s*[a-z][-_a-z0-9]{5,19}/gi, '[contact]') // i18n-allow -- privacy input recognition
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\+?\d[\d()\s.-]{6,}\d/g, match => {
      const digits = match.replace(/\D/g, '');
      const dateLike = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(match.trim());
      return !dateLike && digits.length >= 8 && digits.length <= 15 ? '[phone]' : match;
    })
    .replace(/(?:收货地址|详细地址|地址|寄到|送到)\s*[:：]?\s*[\p{Script=Han}\dA-Za-z\-]{4,48}(?=$|[，。；,;])/gu, '[address]') // i18n-allow -- privacy input recognition
    .replace(/\b\d{8,}\b/g, '[id]');
  const content = privacyMasked
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = content.length > 2_000 ? `${content.slice(0, 1_997)}...` : content;
  return { content: clipped, masked: privacyMasked !== original };
}

function parseRating(value: unknown): number | null {
  if (typeof value === 'number') return value >= 1 && value <= 5 ? Math.round(value * 10) / 10 : null;
  const match = String(value ?? '').normalize('NFKC').match(/(?:^|\D)([1-5](?:\.\d+)?)(?:\D|$)/);
  if (!match) return null;
  const rating = Number(match[1]);
  return rating >= 1 && rating <= 5 ? Math.round(rating * 10) / 10 : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const text = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (!text) return null;
  if (/^(?:true|yes|y|1|verified|已购|是|已验证|真实购买)$/.test(text)) return true; // i18n-allow -- source value recognition
  if (/^(?:false|no|n|0|unverified|否|未验证|非购买)$/.test(text)) return false; // i18n-allow -- source value recognition
  return null;
}

function parseReplyStatus(value: unknown): ReviewReplyStatus {
  if (typeof value === 'boolean') return value ? 'replied' : 'unreplied';
  const text = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (!text) return 'unknown';
  if (/未回复|待回复|unreplied|not replied|pending|^no$|^false$|^0$/i.test(text)) return 'unreplied'; // i18n-allow -- source value recognition
  if (/已回复|已答复|replied|answered|responded|^yes$|^true$|^1$/i.test(text)) return 'replied'; // i18n-allow -- source value recognition
  return 'unknown';
}

function parseDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = String(value).normalize('NFKC').trim();
  const dateOnly = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?$/); // i18n-allow -- localized date input recognition
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2].padStart(2, '0')}-${dateOnly[3].padStart(2, '0')}`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeSourceUrl(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function parseCount(value: unknown): number {
  const match = String(value ?? '').normalize('NFKC').replace(/[,，\s]/g, '').match(/-?\d+(?:\.\d+)?/);
  return Math.max(0, Math.round(match ? Number(match[0]) : 0));
}

function stableHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

/** Normalize a supplied export only. This function performs no file, network, account, or platform writes. */
export function normalizeReviewSourceRecords(args: ReviewSourceNormalizeArgs): ReviewSourceNormalization {
  const sourceText = String(args.sourceText ?? '').trim();
  if (!sourceText) throw new Error('sourceText must contain CSV, TSV, JSON, JSONL, or one review per line.');
  const requestedFormat = args.sourceFormat || 'auto';
  const parsed = parseSource(sourceText, requestedFormat);
  const importedRecords = parsed.records.slice(0, ECOMMERCE_REPORT_ROW_LIMIT);
  const mapping = resolveMapping(importedRecords, args.mapping || {});
  if (!mapping.content && !mapping.rating) throw new Error('Could not locate review content or rating. Provide an explicit column mapping.');

  const normalized: NormalizedReviewRecord[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  let deduplicatedCount = 0;
  let piiMaskedCount = 0;
  let generatedIdCount = 0;
  for (const sourceRecord of importedRecords) {
    const flat = flattenRecord(sourceRecord);
    const contentResult = maskReviewContent(valueAt(flat, mapping.content));
    const rating = parseRating(valueAt(flat, mapping.rating));
    if (!contentResult.content && rating === null) {
      rejectedCount += 1;
      continue;
    }
    if (contentResult.masked) piiMaskedCount += 1;
    const platform = cleanIdentifier(args.platform || valueAt(flat, mapping.platform), 'unknown');
    const storeId = cleanIdentifier(args.storeId || valueAt(flat, mapping.storeId), 'unknown');
    const productId = cleanIdentifier(valueAt(flat, mapping.productId), '');
    const sku = cleanIdentifier(valueAt(flat, mapping.sku), '');
    const createdAt = parseDate(valueAt(flat, mapping.createdAt));
    const sourceReviewId = cleanIdentifier(valueAt(flat, mapping.reviewId), '');
    const fingerprint = stableHash([
      platform,
      storeId,
      productId,
      sku,
      rating ?? '',
      contentResult.content,
      createdAt ?? '',
    ].join('\u001f'));
    const reviewId = sourceReviewId || `generated:${fingerprint}`;
    if (!sourceReviewId) generatedIdCount += 1;
    const dedupeKey = stableHash(`${platform}\u001f${storeId}\u001f${reviewId}`);
    if (seen.has(dedupeKey)) {
      deduplicatedCount += 1;
      continue;
    }
    seen.add(dedupeKey);
    normalized.push({
      schemaVersion: REVIEW_SOURCE_SCHEMA_VERSION,
      dedupeKey,
      reviewId,
      platform,
      storeId,
      productId,
      sku,
      rating,
      content: contentResult.content,
      createdAt,
      verifiedPurchase: parseBoolean(valueAt(flat, mapping.verifiedPurchase)),
      replyStatus: parseReplyStatus(valueAt(flat, mapping.replyStatus)),
      sourceUrl: safeSourceUrl(valueAt(flat, mapping.sourceUrl)),
      helpfulCount: parseCount(valueAt(flat, mapping.helpfulCount)),
    });
  }

  const warnings: string[] = [];
  if (parsed.records.length > ECOMMERCE_REPORT_ROW_LIMIT) warnings.push(`Only the first ${ECOMMERCE_REPORT_ROW_LIMIT} rows were processed.`);
  if (normalized.some(record => record.platform === 'unknown')) warnings.push('Platform is unknown for one or more reviews; provide platform for cross-source reporting.');
  if (normalized.some(record => record.storeId === 'unknown')) warnings.push('Store ID is unknown for one or more reviews; provide storeId for multi-store isolation.');
  if (generatedIdCount > 0) warnings.push('Some review IDs were generated from sanitized content because the source did not provide stable IDs.');

  return {
    records: normalized,
    source: {
      requestedFormat,
      detectedFormat: parsed.format,
      importedCount: importedRecords.length,
      normalizedCount: normalized.length,
      deduplicatedCount,
      rejectedCount,
      piiMaskedCount,
      generatedIdCount,
      mappedFields: Object.keys(mapping),
      platform: cleanIdentifier(args.platform, 'mixed-or-unknown'),
      storeId: cleanIdentifier(args.storeId, 'mixed-or-unknown'),
    },
    warnings,
  };
}

export function paginateNormalizedReviews(normalized: ReviewSourceNormalization, args: Pick<ReviewSourceNormalizeArgs, 'cursor' | 'limit'>) {
  const cursor = Math.max(0, Math.floor(Number(args.cursor) || 0));
  const limit = Math.min(REVIEW_SOURCE_PAGE_LIMIT, Math.max(1, Math.floor(Number(args.limit) || 100)));
  const records = normalized.records.slice(cursor, cursor + limit);
  const nextCursor = cursor + records.length < normalized.records.length ? cursor + records.length : null;
  return {
    cursor,
    limit,
    returnedCount: records.length,
    nextCursor,
    records,
  };
}

export function normalizedReviewsToTable(records: NormalizedReviewRecord[]): EcommerceTable {
  const headers = [
    'review_id', 'platform', 'store_id', 'product_id', 'sku', 'rating', 'content', 'created_at',
    'verified_purchase', 'reply_status', 'source_url', 'helpful_count',
  ];
  const rows: EcommerceTableRow[] = records.map(record => ({
    review_id: record.reviewId,
    platform: record.platform,
    store_id: record.storeId,
    product_id: record.productId,
    sku: record.sku,
    rating: record.rating ?? '',
    content: record.content,
    created_at: record.createdAt ?? '',
    verified_purchase: record.verifiedPurchase === null ? '' : String(record.verifiedPurchase),
    reply_status: record.replyStatus,
    source_url: record.sourceUrl ?? '',
    helpful_count: record.helpfulCount,
  }));
  return { headers, rows };
}
