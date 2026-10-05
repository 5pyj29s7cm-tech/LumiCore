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

/** Commit one model segment's usage together instead of copying the table for every call. */
export function recordTokenUsageBatch(
  userId: string,
  records: readonly (LLMUsage & { provider: string; model: string })[],
  interactionId: string | (() => string),
  mode = 'chat',
): number {
  const rows: TokenUsageRow[] = [];
  let totalTokens = 0;
  for (const usage of records) {
    totalTokens += usage.totalTokens || 0;
    if (usage.promptTokens === 0 && usage.completionTokens === 0) continue;
    rows.push({
      id: crypto.randomUUID(), userId, provider: usage.provider, model: usage.model,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
      mode, interactionId: typeof interactionId === 'function' ? interactionId() : interactionId,
      timestamp: new Date().toISOString(),
    });
  }
  if (rows.length) {
    const db = readDatabaseTables(["tokenUsage"]);
    commitDatabaseTables({ ...db, tokenUsage: [...(db.tokenUsage || []), ...rows] });
  }
  return totalTokens;
}

export function recordTokenUsage(
  userId: string, provider: string, model: string, usage: LLMUsage | undefined,
  interactionId: string, mode = 'chat',
): void {
  if (usage) recordTokenUsageBatch(userId, [{ ...usage, provider, model }], interactionId, mode);
}
