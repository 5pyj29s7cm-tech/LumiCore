export interface VoiceCompletionOptions {
  afterPlayback?: () => void;
  onCommitted?: () => void;
}

/** Delivery waits for durability and playback; the turn's outer finally owns resource release. */
export function createVoiceTerminalCompletion<Input extends { blocked: boolean }>(deps: {
  commit: (input: Input) => Promise<boolean>;
  drainSpeech: () => Promise<unknown>;
  isCurrent: () => boolean;
}) {
  return async (input: Input, options: VoiceCompletionOptions = {}): Promise<boolean> => {
    const committed = await deps.commit(input);
    await deps.drainSpeech();
    if (!deps.isCurrent()) return false;
    options.afterPlayback?.();
    if (committed && !input.blocked) options.onCommitted?.();
    return committed;
  };
}
