export interface VoiceCompletionOptions {
  completedReason: string;
  interruptedReason: string;
  afterPlayback?: () => void;
  onCommitted?: () => void;
}

/** Finish after durable publication; a cancelled playback cannot teach or own release. */
export function createVoiceTerminalCompletion<Input extends { blocked: boolean }>(deps: {
  commit: (input: Input) => Promise<boolean>;
  drainSpeech: () => Promise<unknown>;
  isCurrent: () => boolean;
  release: (reason: string) => Promise<unknown>;
}) {
  return async (input: Input, options: VoiceCompletionOptions): Promise<boolean> => {
    const committed = await deps.commit(input);
    await deps.drainSpeech();
    if (!deps.isCurrent()) {
      await deps.release(options.interruptedReason);
      return false;
    }
    options.afterPlayback?.();
    if (committed && !input.blocked) options.onCommitted?.();
    await deps.release(options.completedReason);
    return committed;
  };
}
