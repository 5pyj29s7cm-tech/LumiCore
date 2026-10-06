import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import { reviewApprovals } from './review_approval';

let persistenceOverride: (() => Promise<void>) | null = null;

export async function persistStrict(): Promise<void> {
  await (persistenceOverride || flushDBOrThrow)();
}

export function resetExternalCapabilityRegistryForTests(options: { clearPersisted?: boolean } = {}): void {
  reviewApprovals.clear();
  persistenceOverride = null;
  if (!options.clearPersisted) return;
  try {
    const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","externalCapabilityPackages","externalCapabilityReceipts"]);
    db.externalCapabilityPackages = [];
    db.externalCapabilityReceipts = [];
    commitDatabaseTables(db);
  } catch {}
}

export function configureExternalCapabilityRegistryForTests(
  options: { persist?: () => Promise<void> } | null,
): void {
  persistenceOverride = options?.persist || null;
}
