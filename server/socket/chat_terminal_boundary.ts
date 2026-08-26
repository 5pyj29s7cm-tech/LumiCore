import {
  commitConversationTerminalDurabilityStage,
  quarantineConversationTerminalDurabilityStage,
  runWithConversationTerminalDurabilityStage,
  type ConversationTerminalPersistenceUnknownProjection,
} from '../conversation/manager';

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
  persistenceUnknownProjection?: ConversationTerminalPersistenceUnknownProjection;
  onPersistenceError?: (error: unknown) => void;
}): Promise<boolean> {
  return runWithConversationTerminalDurabilityStage(async stage => {
    let terminalState: T;
    try {
      terminalState = input.persistTerminalState();
      input.persistAssistantMessage();
      await input.flush();
      const ownsPublication = await input.persistTerminalReceipt(terminalState);
      // A slow/failing receipt must not open the request lane. Once the shared
      // barrier resolves, both the publication owner and an idempotent waiter
      // know that this request has a durable terminal; either may safely
      // settle its local stage, while only the owner publishes.
      commitConversationTerminalDurabilityStage(stage);
      if (!ownsPublication) return false;
    } catch (error) {
      try { input.onPersistenceError?.(error); } catch {}
      const quarantined = quarantineConversationTerminalDurabilityStage(
        stage,
        input.persistenceUnknownProjection || {
          text: 'The terminal persistence outcome is unknown.',
          reason: 'Terminal persistence outcome is unknown.',
        },
      );
      // Quarantine is installed synchronously before this retry. Even when
      // SQLite remains unavailable, every later debounced snapshot can now
      // persist only the unknown projection, never the staged success.
      if (quarantined > 0) {
        try {
          await input.flush();
        } catch (quarantineError) {
          try { input.onPersistenceError?.(quarantineError); } catch {}
        }
      }
      let ownsUnknownPublication = true;
      try {
        ownsUnknownPublication = await input.persistUnknownReceipt();
      } catch (unknownError) {
        try { input.onPersistenceError?.(unknownError); } catch {}
      }
      // Some legacy call sites create the safe unknown assistant only inside
      // persistUnknownReceipt when the original assistant staging itself
      // failed. Capture and quarantine that late row before it can release the
      // turn as an ordinary terminal.
      if (quarantined === 0) {
        const lateQuarantine = quarantineConversationTerminalDurabilityStage(
          stage,
          input.persistenceUnknownProjection || {
            text: 'The terminal persistence outcome is unknown.',
            reason: 'Terminal persistence outcome is unknown.',
          },
        );
        if (lateQuarantine > 0) {
          try {
            await input.flush();
          } catch (lateQuarantineError) {
            try { input.onPersistenceError?.(lateQuarantineError); } catch {}
          }
        }
      }
      if (!ownsUnknownPublication) return false;
      input.publishUnknown();
      return false;
    }

    input.publishCommitted(terminalState);
    return true;
  });
}
