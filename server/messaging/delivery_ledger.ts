import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import type { MessagingPlatform } from './types';

interface DeliveryReceipt {
  key: string;
  receivedAt: string;
}

const LEDGER_PATH = getDataPath(path.join('messaging', 'delivery_receipts.json'));
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 5_000;
let receipts: DeliveryReceipt[] | null = null;

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
  if (current.some(item => item.key === key)) {
    receipts = current;
    return false;
  }
  current.push({ key, receivedAt: now.toISOString() });
  receipts = current.slice(-MAX_RECEIPTS);
  persistReceipts(receipts);
  return true;
}

export function resetDeliveryLedgerForTest(): void {
  receipts = [];
  try { fs.rmSync(LEDGER_PATH, { force: true }); } catch {}
}

export function reloadDeliveryLedgerForTest(): void {
  receipts = null;
}
