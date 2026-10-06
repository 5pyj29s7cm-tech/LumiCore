

/**
 * Scheduler work is user-scoped and must never treat arbitrary actor IDs from
 * memories/interactions (agent IDs, MCP actors, "unknown", and similar
 * provenance labels) as Lumi users. Registered users are the authoritative
 * identity source. The anonymous fallback is retained only for pre-account
 * local installations that have not created a user record yet.
 */
export function resolveScheduledUserIds(db: any): string[] {
  const registered = new Set<string>();
  for (const user of Array.isArray(db?.users) ? db.users : []) {
    const uid = String(user?.uid || '').trim();
    if (uid) registered.add(uid);
  }
  return registered.size > 0 ? [...registered] : ['anonymous'];
}
