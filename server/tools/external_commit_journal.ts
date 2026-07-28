export type ExternalCommitJournalState = 'running' | 'verified' | 'unknown';

export interface ExternalCommitJournalEntry {
  idempotencyKey: string;
  taskId: string;
  userId: string;
  toolName: string;
  inputDigest: string;
  state: ExternalCommitJournalState;
  replayResult: string;
  claimToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalCommitJournalClaim {
  claimed: boolean;
  entry: ExternalCommitJournalEntry;
}

export interface ExternalCommitJournalAdapter {
  claim(entry: ExternalCommitJournalEntry): Promise<ExternalCommitJournalClaim>;
  settle(input: {
    idempotencyKey: string;
    claimToken: string;
    state: Exclude<ExternalCommitJournalState, 'running'>;
    replayResult: string;
    updatedAt: string;
    recoverExisting?: boolean;
  }): Promise<boolean>;
}

let durableAdapter: ExternalCommitJournalAdapter | null = null;
const volatileEntries = new Map<string, ExternalCommitJournalEntry>();

/** Installed by the database runtime after SQLite is ready. */
export function configureExternalCommitJournal(
  adapter: ExternalCommitJournalAdapter | null,
): void {
  durableAdapter = adapter;
}

export async function claimExternalCommitAttempt(
  entry: ExternalCommitJournalEntry,
): Promise<ExternalCommitJournalClaim> {
  if (durableAdapter) return durableAdapter.claim(entry);
  const existing = volatileEntries.get(entry.idempotencyKey);
  if (existing) return { claimed: false, entry: { ...existing } };
  volatileEntries.set(entry.idempotencyKey, { ...entry });
  return { claimed: true, entry: { ...entry } };
}

export async function settleExternalCommitAttempt(input: {
  idempotencyKey: string;
  claimToken: string;
  state: Exclude<ExternalCommitJournalState, 'running'>;
  replayResult: string;
  updatedAt: string;
  recoverExisting?: boolean;
}): Promise<boolean> {
  if (durableAdapter) return durableAdapter.settle(input);
  const existing = volatileEntries.get(input.idempotencyKey);
  if (!existing) return false;
  if (!input.recoverExisting && existing.claimToken !== input.claimToken) return false;
  volatileEntries.set(input.idempotencyKey, {
    ...existing,
    state: input.state,
    replayResult: input.replayResult,
    updatedAt: input.updatedAt,
  });
  return true;
}

/** Test isolation only; durable adapters own their own storage lifecycle. */
export function resetVolatileExternalCommitJournalForTests(): void {
  volatileEntries.clear();
}
