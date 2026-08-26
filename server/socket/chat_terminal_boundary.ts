/**
 * Commit the durable state owned by a terminal chat turn before publishing it.
 *
 * Socket delivery is intentionally outside the persistence try/catch: a
 * transport failure after the durability fence must not be misreported as a
 * database failure, and a reconnect can recover the already-persisted turn.
 */
export async function commitChatTerminalBoundary<T>(input: {
  persistTerminalState: () => T;
  persistAssistantMessage: () => void;
  flush: () => Promise<void>;
  /**
   * Persist the request-scoped recovery receipt after the primary database
   * fence. `true` grants this caller publication ownership; `false` means a
   * concurrent/idempotent owner already committed it.
   */
  persistTerminalReceipt: (terminalState: T) => Promise<boolean>;
  /**
   * Persist (or at least in-memory quarantine) a safe unknown terminal. The
   * boolean is publication ownership, matching the success receipt contract.
   */
  persistUnknownReceipt: () => Promise<boolean>;
  publishCommitted: (terminalState: T) => void;
  publishUnknown: () => void;
  onPersistenceError?: (error: unknown) => void;
}): Promise<boolean> {
  let terminalState: T;
  try {
    terminalState = input.persistTerminalState();
    input.persistAssistantMessage();
    await input.flush();
    const ownsPublication = await input.persistTerminalReceipt(terminalState);
    if (!ownsPublication) return false;
  } catch (error) {
    input.onPersistenceError?.(error);
    try {
      const ownsUnknownPublication = await input.persistUnknownReceipt();
      if (!ownsUnknownPublication) return false;
    } catch (unknownError) {
      input.onPersistenceError?.(unknownError);
    }
    input.publishUnknown();
    return false;
  }

  input.publishCommitted(terminalState);
  return true;
}
