import crypto from "node:crypto";
import { readDatabaseTables } from "../../../db_layer";
import type { ExtensionArrays, ExtensionRevision, ExtensionActivationReceipt } from './contracts';

export function nowIso(): string {
  return new Date().toISOString();
}

export function arrays(db = readDatabaseTables(["extensionActivationReceipts","extensionPublishers","extensionRevisions"])): ExtensionArrays {
  if (!Array.isArray(db.extensionPublishers)) db.extensionPublishers = [];
  if (!Array.isArray(db.extensionRevisions)) db.extensionRevisions = [];
  if (!Array.isArray(db.extensionActivationReceipts)) db.extensionActivationReceipts = [];
  return {
    publishers: db.extensionPublishers,
    revisions: db.extensionRevisions,
    receipts: db.extensionActivationReceipts,
  };
}

export function receipt(
  revision: ExtensionRevision,
  status: string,
  previousRevisionId: string,
  error?: string,
): ExtensionActivationReceipt {
  return {
    id: `extension_receipt_${crypto.randomUUID()}`,
    extensionId: revision.extensionId,
    revisionId: revision.id,
    userId: revision.userId,
    status,
    manifestDigest: revision.manifestDigest,
    signerFingerprint: revision.signerFingerprint,
    previousRevisionId,
    toolNames: [...revision.toolNames],
    providerId: revision.manifest.provider?.id || '',
    compatibility: revision.compatibility,
    ...(error ? { error } : {}),
    createdAt: nowIso(),
  };
}

export function pushReceipt(store: ExtensionArrays, value: ExtensionActivationReceipt): void {
  store.receipts.push(value);
  if (store.receipts.length > 1_000) store.receipts.splice(0, store.receipts.length - 1_000);
}
