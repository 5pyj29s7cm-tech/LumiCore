import { readDatabaseTables, commitDatabaseTables } from "../../db_layer";
import type { LLMUsage } from "../tools/types";
import { cloneDatabaseValue } from '../db/snapshot_changes';

export interface TokenUsageRow extends LLMUsage {
  id: string;
  userId: string;
  provider: string;
  model: string;
  mode: string;
  interactionId: string;
  timestamp: string;
}

/** Anonymous is a literal owner, never a wildcard for the whole instance. */
export function listTokenUsageRows(userId: string): TokenUsageRow[] {
  return userId ? cloneDatabaseValue((readDatabaseTables(["tokenUsage"]).tokenUsage || []).filter(row => row.userId === userId)) : [];
}

export function recordTokenUsage(
  userId: string,
  provider: string,
  model: string,
  usage: LLMUsage | undefined,
  interactionId: string,
  mode: string = 'chat',
): void {
  if (!usage || (usage.promptTokens === 0 && usage.completionTokens === 0)) return;
  const db = readDatabaseTables(["tokenUsage"]);
  const row: TokenUsageRow = {
    id: crypto.randomUUID(),
    userId,
    provider,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    mode,
    interactionId,
    timestamp: new Date().toISOString(),
  };
  commitDatabaseTables({ ...db, tokenUsage: [...(db.tokenUsage || []), row] });
}
