export function voiceDurabilityUnknownText(): string {
  return 'Lumi could not durably confirm this voice result. Refresh the conversation state before retrying.';
}

export function sanitizeVoiceAgentErrorPayload(): {
  code: 'VOICE_EXECUTION_FAILED';
  message: string;
} {
  return {
    code: 'VOICE_EXECUTION_FAILED',
    message: 'The voice request could not be completed.',
  };
}
