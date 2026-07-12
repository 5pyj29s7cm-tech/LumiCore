import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import type { MessagingPlatform } from './types';

interface DeliveryReceipt {
  key: string;
  receivedAt: string;
  updatedAt?: string;
  status?: 'processing' | 'completed';
  runtimeId?: string;
}

const LEDGER_PATH = getDataPath(path.join('messaging', 'delivery_receipts.json'));
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 5_000;
let receipts: DeliveryReceipt[] | null = null;
const deliveryRuntimeId = randomUUID();

function loadReceipts(): DeliveryReceipt[] {
  if (receipts) return receipts;
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    receipts = Array.isArray(parsed)
      ? parsed.filter(item => typeof item?.key === 'string' && typeof item?.receivedAt === 'string')
      : [];
  } catch {
    receipts = [];
  }
  return receipts;
}

function persistReceipts(items: DeliveryReceipt[]): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const tempPath = `${LEDGER_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tempPath, LEDGER_PATH);
}

export function acceptMessageOnce(platform: MessagingPlatform, messageId: string, now = new Date()): boolean {
  const normalizedId = String(messageId || '').trim();
  if (!normalizedId) return false;
  const cutoff = now.getTime() - RECEIPT_TTL_MS;
  const current = loadReceipts().filter(item => {
    const timestamp = Date.parse(item.receivedAt);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
  const key = `${platform}:${normalizedId}`;
  const existingIndex = current.findIndex(item => item.key === key);
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    // Legacy records and completed records are durable deduplication receipts.
    if (!existing.status || existing.status === 'completed' || existing.runtimeId === deliveryRuntimeId) {
      receipts = current;
      return false;
    }
    // A processing receipt from an older server runtime is an interrupted lease.
    current[existingIndex] = {
      key,
      receivedAt: existing.receivedAt || now.toISOString(),
      updatedAt: now.toISOString(),
      status: 'processing',
      runtimeId: deliveryRuntimeId,
    };
    receipts = current;
    persistReceipts(receipts);
    return true;
  }
  current.push({
    key,
    receivedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: 'processing',
    runtimeId: deliveryRuntimeId,
  });
  receipts = current.slice(-MAX_RECEIPTS);
  persistReceipts(receipts);
  return true;
}

export function completeMessageDelivery(platform: MessagingPlatform, messageId: string, now = new Date()): void {
  const key = `${platform}:${String(messageId || '').trim()}`;
  const current = loadReceipts();
  const receipt = current.find(item => item.key === key && item.runtimeId === deliveryRuntimeId);
  if (!receipt) return;
  receipt.status = 'completed';
  receipt.updatedAt = now.toISOString();
  persistReceipts(current);
}

export function releaseMessageDelivery(platform: MessagingPlatform, messageId: string): void {
  const key = `${platform}:${String(messageId || '').trim()}`;
  const current = loadReceipts();
  const next = current.filter(item => !(item.key === key && item.status === 'processing' && item.runtimeId === deliveryRuntimeId));
  if (next.length === current.length) return;
  receipts = next;
  persistReceipts(next);
}

export function resetDeliveryLedgerForTest(): void {
  receipts = [];
  try { fs.rmSync(LEDGER_PATH, { force: true }); } catch {}
}

export function reloadDeliveryLedgerForTest(): void {
  receipts = null;
}
