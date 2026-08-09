export function isCurrentVoiceInputSource(input: {
  sessionActive: boolean;
  currentSessionId: string;
  callbackSessionId: string;
  currentSttSession: unknown;
  callbackSttSession: unknown;
}): boolean {
  return input.sessionActive
    && Boolean(input.currentSessionId)
    && input.currentSessionId === input.callbackSessionId
    && input.currentSttSession === input.callbackSttSession;
}

export function isRepeatedVoiceFinal(input: {
  commandKey: string;
  lastCommandKey: string;
  currentChunkAt: number;
  lastAcceptedChunkAt: number;
  lastAcceptedAt: number;
  now?: number;
  laneActive: boolean;
}): boolean {
  if (!input.commandKey || input.commandKey !== input.lastCommandKey) return false;
  const noNewAudio = input.lastAcceptedChunkAt > 0
    && input.currentChunkAt <= input.lastAcceptedChunkAt;
  const rapidWhileActive = input.laneActive
    && (input.now ?? Date.now()) - input.lastAcceptedAt <= 2_500;
  return noNewAudio || rapidWhileActive;
}
