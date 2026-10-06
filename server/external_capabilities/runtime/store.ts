import { cloneDatabaseValue } from "../../db/snapshot_changes";
import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { ExternalCapabilityPackageRow, ExternalCapabilityReceiptRow } from './contracts';

export function arrays(): {
  db: ReturnType<typeof readDatabaseTables<'externalCapabilityPackages' | 'externalCapabilityReceipts'>>;
  packages: ExternalCapabilityPackageRow[];
  receipts: ExternalCapabilityReceiptRow[];
} {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","externalCapabilityPackages","externalCapabilityReceipts"]);
  if (!Array.isArray(db.externalCapabilityPackages)) db.externalCapabilityPackages = [];
  if (!Array.isArray(db.externalCapabilityReceipts)) db.externalCapabilityReceipts = [];
  return {
    db,
    packages: db.externalCapabilityPackages,
    receipts: db.externalCapabilityReceipts,
  };
}

export function persistRows(store: ReturnType<typeof arrays>): void {
  commitDatabaseTables(store.db);
}

export function snapshotExternalCapabilityStore(): {
  packages: ExternalCapabilityPackageRow[];
  receipts: ExternalCapabilityReceiptRow[];
} {
  const store = arrays();
  return {
    packages: cloneDatabaseValue(store.packages),
    receipts: cloneDatabaseValue(store.receipts),
  };
}

export function restoreExternalCapabilityStore(snapshot: {
  packages: ExternalCapabilityPackageRow[];
  receipts: ExternalCapabilityReceiptRow[];
}): void {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","externalCapabilityPackages","externalCapabilityReceipts"]);
  db.externalCapabilityPackages = cloneDatabaseValue(snapshot.packages);
  db.externalCapabilityReceipts = cloneDatabaseValue(snapshot.receipts);
  commitDatabaseTables(db);
}
